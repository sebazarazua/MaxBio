'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DeliveryNoteView, PrintTemplate, PrintCalibration } from '@maxbio/contracts';
import { printingPdf, downloadPrintPdf } from '../../lib/printing-api.ts';
import { PdfPreview } from './pdf-preview.tsx';
import { printErrorMessage } from './print-labels.ts';

export function PrintTrialDialog({
  template,
  calibration,
  note,
  children,
  onClose,
}: {
  template: PrintTemplate;
  calibration: PrintCalibration | null;
  note?: DeliveryNoteView;
  children?: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const guard = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; bytes: Uint8Array }>();
  const key = JSON.stringify({
    templateRevisionId: template.id,
    calibrationId: calibration?.id ?? null,
    ...(note ? { document: { id: note.id, expectedVersion: note.version } } : {}),
  });
  useEffect(() => {
    const target = dialog.current;
    const previousFocus = document.activeElement;
    const overflow = document.body.style.overflow;
    target?.showModal();
    document.body.style.overflow = 'hidden';
    return () => {
      target?.close();
      document.body.style.overflow = overflow;
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void printingPdf('print-test-preview', JSON.parse(key), controller.signal)
      .then((bytes) => {
        if (!controller.signal.aborted) {
          setPreview({ key, bytes });
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(printErrorMessage(e));
      });
    return () => controller.abort();
  }, [key]);
  async function download() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      downloadPrintPdf(await printingPdf('print-test', JSON.parse(key)));
    } catch (e) {
      setError(printErrorMessage(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="remito-expanded-dialog"
      aria-labelledby="print-trial-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="print-trial-title">Prueba de impresión</h2>
        <button type="button" className="secondary-button" onClick={onClose}>
          Cerrar
        </button>
      </header>
      <p>
        La vista muestra el formulario y los datos. La descarga contiene solo los datos variables
        para imprimir al 100 % sobre papel preimpreso.
      </p>
      {children}
      {error && <p role="alert">{error}</p>}
      {preview?.key === key ? (
        <PdfPreview bytes={preview.bytes} fit />
      ) : (
        <p role="status">Preparando vista previa…</p>
      )}
      <button
        type="button"
        className="primary-button"
        disabled={busy || preview?.key !== key}
        onClick={() => void download()}
      >
        {busy ? 'Preparando impresión…' : 'Descargar impresión de prueba'}
      </button>
    </dialog>
  );
}

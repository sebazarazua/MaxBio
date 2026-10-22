'use client';
import { useEffect, useState, type ReactNode } from 'react';
import {
  printConfigSchema,
  printDraftPreviewSchema,
  printDraftPreviewInputSchema,
  type PrintDraftPreviewInput,
} from '@maxbio/contracts';
import { printingJson } from '../../lib/printing-api.ts';
import { PdfPreview } from './pdf-preview.tsx';
import { printIssueMessage } from './print-labels.ts';

export function LiveDeliveryPreview({
  input,
  configurationLink,
  onValidation,
}: {
  input: PrintDraftPreviewInput;
  configurationLink?: ReactNode;
  onValidation: (ready: boolean) => void;
}) {
  const [config, setConfig] = useState<ReturnType<typeof printConfigSchema.parse>>();
  const [preview, setPreview] = useState<{
    key: string;
    bytes: Uint8Array;
    data: ReturnType<typeof printDraftPreviewSchema.parse>;
  }>();
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const key = JSON.stringify(input);
  const validInput = printDraftPreviewInputSchema.safeParse(input).success;
  useEffect(() => {
    const controller = new AbortController();
    void printingJson('config', printConfigSchema, undefined, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setConfig(value);
          setError('');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('No pudimos cargar la vista del remito. Podés seguir completándolo.');
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    onValidation(false);
    if (!config) return;
    if (!config.activeTemplate) {
      onValidation(true);
      return;
    }
    const parsed = printDraftPreviewInputSchema.safeParse(JSON.parse(key));
    if (!parsed.success) return;
    const timer = setTimeout(() => {
      void printingJson('draft-preview', printDraftPreviewSchema, parsed.data, controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setPreview({
            key,
            data,
            bytes: Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0)),
          });
          setError('');
          onValidation(data.evaluation.state !== 'BLOCKED');
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              'No pudimos actualizar la vista. Puede mostrar datos anteriores; podés seguir completando el remito.',
            );
        });
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, onValidation, config]);
  const template = config?.activeTemplate;
  const current = preview?.key === key;
  return (
    <aside
      className={'catalog-panel delivery-live-preview' + (expanded ? ' preview-expanded' : '')}
      aria-label="Vista del remito"
    >
      <div className="print-panel-heading">
        <h2>Vista del remito</h2>
        <button type="button" className="secondary-button" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Reducir' : 'Ampliar'}
        </button>
      </div>
      <p className="muted">Los datos aparecen mientras completás el remito.</p>
      {error && <p role="alert">{error}</p>}
      {!validInput && (
        <p role="status">
          Revisá la fecha, el número del talonario y las cantidades para actualizar la vista.
        </p>
      )}
      {config && !template ? (
        <p>Todavía no hay una plantilla de remito lista para usar. {configurationLink}</p>
      ) : (
        <>
          {!preview && template && (
            <div
              className="live-background"
              style={{
                aspectRatio: `${template.pageWidthMm} / ${template.pageHeightMm}`,
                backgroundImage: `url(/api/printing/assets/${template.backgroundAssetId})`,
              }}
              role="img"
              aria-label="Formulario de remito vacío"
            />
          )}
          {!preview && !template && <p role="status">Cargando formulario…</p>}
          {preview && <PdfPreview bytes={preview.bytes} fit />}
          {!current && validInput && !error && template && (
            <p className="muted" role="status">
              Actualizando vista…
            </p>
          )}
          {current && template && preview.data.evaluation.issues.length > 0 && (
            <ul className="print-human-issues">
              {[
                ...new Set(
                  preview.data.evaluation.issues.map((issue) => printIssueMessage(issue, template)),
                ),
              ].map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </aside>
  );
}

'use client';
import { useEffect, useRef, useState } from 'react';
import {
  printConfigSchema,
  printEvaluationSchema,
  printArtifactListSchema,
  printArtifactSchema,
  type DeliveryNoteView,
  type PrintTemplate,
  type PrintEvaluation,
  type PrintArtifactView,
} from '@maxbio/contracts';
import { printingJson, printingPdf, downloadPrintPdf, PrintRequestError } from '@/lib/printing-api';
import { printIssueMessage, printErrorMessage } from './print-labels';
import { PdfPreview } from './pdf-preview';

export function DeliveryPrintPanel({
  doc,
  onValidation,
  templateOverride,
}: {
  doc: DeliveryNoteView;
  onValidation?: (ready: boolean) => void;
  templateOverride?: PrintTemplate;
}) {
  const [config, setConfig] = useState<ReturnType<typeof printConfigSchema.parse>>();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [calibrationId, setCalibrationId] = useState(''),
    [guides, setGuides] = useState(false);
  const [evaluation, setEvaluation] = useState<{ key: string; value: PrintEvaluation }>();
  const [preview, setPreview] = useState<{ key: string; bytes: Uint8Array }>();
  const [artifacts, setArtifacts] = useState<PrintArtifactView[]>([]),
    [numberChecked, setNumberChecked] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const guard = useRef(false);
  const attempt = useRef<{ id: string; source?: string; body: unknown } | null>(null);
  const template = templateOverride ?? config?.activeTemplate;
  const key = [doc.id, doc.version, template?.id, calibrationId].join(':');
  const previewKey = key + ':' + guides;
  const body = template
    ? {
        templateRevisionId: template.id,
        calibrationId: calibrationId || null,
        expectedVersion: doc.version,
        guides,
      }
    : null;
  const state = evaluation?.key === key ? evaluation.value : undefined;
  useEffect(() => {
    let alive = true;
    void printingJson('config', printConfigSchema)
      .then((c) => {
        if (!alive) return;
        setConfig(c);
        if (!c.activeTemplate && !templateOverride) onValidation?.(true);
      })
      .catch((e) => {
        if (alive) {
          setError(printErrorMessage(e));
          onValidation?.(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [onValidation, templateOverride]);
  useEffect(() => {
    if (!template) return;
    let alive = true;
    void printingJson(`delivery-notes/${doc.id}/evaluate`, printEvaluationSchema, {
      templateRevisionId: template.id,
      calibrationId: calibrationId || null,
      expectedVersion: doc.version,
      guides: false,
    })
      .then((value) => {
        if (alive) {
          setEvaluation({ key, value });
          onValidation?.(value.state !== 'BLOCKED');
        }
      })
      .catch((e) => {
        if (alive) {
          setError(printErrorMessage(e));
          onValidation?.(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.version, template, calibrationId, key, onValidation]);
  useEffect(() => {
    if (doc.status !== 'CONFIRMED') return;
    let alive = true;
    void printingJson(`delivery-notes/${doc.id}/artifacts`, printArtifactListSchema)
      .then((r) => {
        if (alive) setArtifacts(r.items);
      })
      .catch((e) => {
        if (alive) setError(printErrorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.status]);
  useEffect(() => {
    if (!template) return;
    const controller = new AbortController();
    void printingPdf(
      `delivery-notes/${doc.id}/preview`,
      {
        templateRevisionId: template.id,
        calibrationId: calibrationId || null,
        expectedVersion: doc.version,
        guides,
      },
      controller.signal,
    )
      .then((bytes) => {
        if (!controller.signal.aborted) setPreview({ key: previewKey, bytes });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('No pudimos mostrar el remito. Podés reintentar la vista.');
      });
    return () => controller.abort();
  }, [doc.id, doc.version, template, calibrationId, guides, previewKey]);
  async function showPreview() {
    if (!body || guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      setPreview({
        key: previewKey,
        bytes: await printingPdf(`delivery-notes/${doc.id}/preview`, body),
      });
    } catch (e) {
      setError(printErrorMessage(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function generate(source?: string) {
    if (guard.current || (!source && (!body || state?.state === 'BLOCKED'))) return;
    if (!attempt.current) {
      const id = crypto.randomUUID();
      attempt.current = {
        id,
        source,
        body: {
          id,
          templateRevisionId: template?.id,
          calibrationId: calibrationId || null,
          expectedVersion: doc.version,
        },
      };
    }
    const current = attempt.current;
    let registered = false;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      const artifact = current.source
        ? await printingJson(`artifacts/${current.source}/reprint`, printArtifactSchema, {
            id: current.id,
          })
        : await printingJson(
            `delivery-notes/${doc.id}/artifacts`,
            printArtifactSchema,
            current.body,
          );
      registered = true;
      attempt.current = null;
      setUncertain(false);
      setArtifacts((previous) =>
        [artifact, ...previous.filter((a) => a.id !== artifact.id)].slice(0, 100),
      );
      downloadPrintPdf(await printingPdf(`artifacts/${artifact.id}/pdf`));
    } catch (e) {
      if (e instanceof PrintRequestError && e.status < 500) attempt.current = null;
      setUncertain(Boolean(attempt.current));
      setError(
        printErrorMessage(e) +
          (attempt.current
            ? ' Reintentá el mismo envío; no confirma nuevamente el remito.'
            : registered
              ? ' El archivo está registrado y puede descargarse desde el historial.'
              : ''),
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="catalog-panel print-panel" aria-label="Impresión del remito">
      <div className="print-panel-heading">
        <h2>{templateOverride ? 'Modo de prueba' : 'Remito e impresión'}</h2>
      </div>
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      {!config && <p role="status">Consultando la configuración de impresión…</p>}
      {config && !template && <p>Todavía no hay una plantilla de remito lista para usar.</p>}
      {doc.status === 'CONFIRMED' && (
        <div className="print-number-check">
          <p className="print-number">
            Colocá el remito {doc.documentPrefix}-{doc.documentNumber}
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={numberChecked}
              onChange={(e) => setNumberChecked(e.target.checked)}
            />
            Verifiqué el número del talonario y la configuración de impresión.
          </label>
        </div>
      )}
      {template && (
        <>
          <p>
            <strong>{template.name}</strong> · Papel: {template.pageWidthMm} ×{' '}
            {template.pageHeightMm} mm
          </p>
          {template.status === 'DRAFT' && (
            <p className="catalog-error">
              Modo de prueba: esta plantilla todavía no está lista para imprimir remitos.
            </p>
          )}
          <div className="print-controls">
            <label>
              Impresora
              <select
                disabled={busy || uncertain}
                value={calibrationId}
                onChange={(e) => {
                  onValidation?.(false);
                  setCalibrationId(e.target.value);
                }}
              >
                <option value="">Impresora sin ajuste</option>
                {config?.calibrations
                  .filter((c) => c.templateRevisionId === template.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            </label>
            {templateOverride && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={guides}
                  disabled={busy}
                  onChange={(e) => setGuides(e.target.checked)}
                />
                Mostrar área posible de cada texto
              </label>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void showPreview()}
            >
              Actualizar vista
            </button>
          </div>
          {state && state.issues.length > 0 && (
            <ul className="print-human-issues">
              {[...new Set(state.issues.map((issue) => printIssueMessage(issue, template)))].map(
                (message) => (
                  <li key={message}>{message}</li>
                ),
              )}
            </ul>
          )}
          {!state && <p role="status">Revisando el remito…</p>}
          {preview?.key === previewKey && (
            <>
              <p>
                <strong>
                  {doc.status === 'DRAFT'
                    ? 'Borrador / vista previa'
                    : 'Vista previa del confirmado'}
                </strong>
              </p>
              <PdfPreview bytes={preview.bytes} fit />
            </>
          )}
          {doc.status === 'DRAFT' && (
            <p>
              La vista previa no reserva stock. Guardá y revisá los datos antes de confirmar la
              salida.
            </p>
          )}
          {doc.status === 'CONFIRMED' && template.status === 'PUBLISHED' && (
            <div className="print-operative">
              <p>
                Seleccioná el papel personalizado, la bandeja correcta y tamaño real / 100 %. El PDF
                contiene solamente datos variables.
              </p>
              <button
                type="button"
                className="primary-button"
                disabled={busy || !numberChecked || !state || state.state === 'BLOCKED'}
                onClick={() => void generate()}
              >
                {uncertain ? 'Reintentar el mismo envío' : 'Generar para imprimir'}
              </button>
              <p>
                Generar o reimprimir no descuenta stock. MaxBio registra el archivo, no el éxito
                físico de la impresora.
              </p>
            </div>
          )}
        </>
      )}
      {doc.status === 'CONFIRMED' && artifacts.length > 0 && (
        <div>
          <h3>Generaciones y reimpresiones</h3>
          <ul className="print-artifacts">
            {artifacts.map((a) => (
              <li key={a.id}>
                <span>
                  {new Date(a.generatedAt).toLocaleString('es-AR')} ·{' '}
                  {a.reprintOfId ? 'Reimpresión exacta' : 'Archivo para imprimir'}
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void printingPdf(`artifacts/${a.id}/pdf`)
                      .then(downloadPrintPdf)
                      .catch((e) => setError(printErrorMessage(e)))
                  }
                >
                  Descargar nuevamente
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || uncertain || !numberChecked}
                  onClick={() => void generate(a.id)}
                >
                  Registrar reimpresión
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

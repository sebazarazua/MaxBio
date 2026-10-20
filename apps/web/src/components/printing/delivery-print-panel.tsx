'use client';
import Link from 'next/link';
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
import { useWorkspace } from '../workspace';
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
  const { isAdmin } = useWorkspace();
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
          setError(String(e.message));
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
          setError(String(e.message));
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
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
    };
  }, [doc.id, doc.status]);
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
      setError(e instanceof Error ? e.message : 'No pudimos generar la vista previa.');
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
        (e instanceof Error ? e.message : 'No pudimos generar el overlay.') +
          (attempt.current
            ? ' Reintentá el mismo envío; no confirma nuevamente el remito.'
            : ' El archivo está registrado y puede descargarse desde el historial.'),
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="catalog-panel print-panel" aria-label="Impresión del remito">
      <div className="print-panel-heading">
        <h2>Formulario e impresión</h2>
        {isAdmin && <Link href="/remitos/impresion">Configurar plantillas y calibración</Link>}
      </div>
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      {!config && <p role="status">Consultando la configuración de impresión…</p>}
      {config && !template && (
        <p>
          No hay una plantilla activa. Un administrador debe preparar el formulario real y sus
          medidas.
        </p>
      )}
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
            <strong>{template.name}</strong> · revisión {template.revision} · {template.pageWidthMm}{' '}
            × {template.pageHeightMm} mm
          </p>
          {template.status === 'DRAFT' && (
            <p className="catalog-error">
              Plantilla de prueba sin publicar. No habilita overlay operativo.
            </p>
          )}
          <div className="print-controls">
            <label>
              Posición del overlay
              <select
                disabled={busy || uncertain}
                value={calibrationId}
                onChange={(e) => {
                  onValidation?.(false);
                  setCalibrationId(e.target.value);
                }}
              >
                <option value="">Nominal · sin corrección</option>
                {config?.calibrations
                  .filter((c) => c.templateRevisionId === template.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · r{c.revision} · X {c.offsetXmm} / Y {c.offsetYmm} mm
                    </option>
                  ))}
              </select>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                checked={guides}
                disabled={busy}
                onChange={(e) => setGuides(e.target.checked)}
              />
              Mostrar cajas, zonas seguras y tolerancia
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void showPreview()}
            >
              Abrir vista previa
            </button>
          </div>
          {state ? (
            <div role="status" className={'print-status print-status-' + state.state.toLowerCase()}>
              <strong>
                {
                  {
                    SAFE: 'Contenido dentro de la zona segura',
                    WARNING: 'Revisar: contenido cerca del límite',
                    BLOCKED: 'Impresión bloqueada',
                  }[state.state]
                }
              </strong>
              <p>
                {state.rowCount} filas físicas / {state.maxRows} disponibles
              </p>
              {state.issues.length > 0 && (
                <ul>
                  {state.issues.map((i, index) => (
                    <li key={index}>{i.message}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <p role="status">Validando la geometría…</p>
          )}
          {preview?.key === previewKey && (
            <>
              <p>
                <strong>
                  {doc.status === 'DRAFT'
                    ? 'Borrador / vista previa'
                    : 'Vista previa del confirmado'}
                </strong>
              </p>
              <PdfPreview bytes={preview.bytes} />
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
                {uncertain ? 'Reintentar el mismo envío' : 'Generar y descargar overlay'}
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
                  {a.reprintOfId ? 'Reimpresión exacta' : 'Overlay generado'}
                </span>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() =>
                    void printingPdf(`artifacts/${a.id}/pdf`)
                      .then(downloadPrintPdf)
                      .catch((e) => setError(String(e.message)))
                  }
                >
                  Descargar archivo
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || uncertain || !numberChecked}
                  onClick={() => void generate(a.id)}
                >
                  Registrar reimpresión exacta
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

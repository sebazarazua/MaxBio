'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  printConfigSchema,
  printTemplateListSchema,
  printTemplateSchema,
  printTemplateCreateSchema,
  printCalibrationSchema,
  printAssetSchema,
  deliveryNoteSchema,
  bourbonProvisionalTemplate,
  type PrintTemplate,
  type DeliveryNoteView,
} from '@maxbio/contracts';
import { printingJson, printingPdf, downloadPrintPdf } from '@/lib/printing-api';
import { catalogFetch } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { Field } from '../catalog/common';
import { DeliveryPrintPanel } from './delivery-print-panel';
import { TestDeliveryNotePicker } from './test-delivery-note-picker';
import { PrintGeometryEditor } from './geometry-editor';
import { printErrorMessage } from './print-labels';

export function PrintTemplateManager() {
  const { isAdmin } = useWorkspace();
  const [templates, setTemplates] = useState<PrintTemplate[]>([]);
  const [config, setConfig] = useState<ReturnType<typeof printConfigSchema.parse>>();
  const [selected, setSelected] = useState('');
  const [mode, setMode] = useState<'adjust' | 'test' | 'change' | 'printer' | null>(null);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [note, setNote] = useState<DeliveryNoteView>();
  const [width, setWidth] = useState('203'),
    [height, setHeight] = useState('271');
  const [name, setName] = useState('Plantilla Bourbon');
  const [calibrationId, setCalibrationId] = useState('');
  const [calName, setCalName] = useState('Impresora habitual'),
    [printer, setPrinter] = useState(''),
    [tray, setTray] = useState('');
  const [dx, setDx] = useState(0),
    [dy, setDy] = useState(0);
  const [technical, setTechnical] = useState('');
  const guard = useRef(false);
  const editorSection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode) editorSection.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [mode, selected]);
  const active = config?.activeTemplate;
  const template = templates.find((t) => t.id === selected) ?? active ?? templates[0];
  const calibration =
    config?.calibrations.find(
      (c) => c.id === calibrationId && c.templateRevisionId === template?.id,
    ) ?? null;
  async function reload() {
    const [list, current] = await Promise.all([
      printingJson('templates', printTemplateListSchema),
      printingJson('config', printConfigSchema),
    ]);
    setTemplates(list.items);
    setConfig(current);
  }
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    void Promise.all([
      printingJson('templates', printTemplateListSchema),
      printingJson('config', printConfigSchema),
    ])
      .then(([list, current]) => {
        if (alive) {
          setTemplates(list.items);
          setConfig(current);
        }
      })
      .catch(() => {
        if (alive) setError('No pudimos cargar la plantilla.');
      });
    return () => {
      alive = false;
    };
  }, [isAdmin]);
  async function run(fn: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(printErrorMessage(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function open(next: typeof mode) {
    if (template) {
      setWidth(String(template.pageWidthMm));
      setHeight(String(template.pageHeightMm));
      setName(template.name);
      setSelected(template.id);
      setTechnical(JSON.stringify(template.definition, null, 2));
    }
    setMode(next);
  }
  async function upload(file: File) {
    if (file.type !== 'image/png' || file.size > 4194304)
      throw new Error('Usá un PNG de hasta 4 MiB.');
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No pudimos leer la imagen.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(file);
    });
    const asset = await printingJson('assets', printAssetSchema, { pngBase64: encoded });
    const preset = bourbonProvisionalTemplate(crypto.randomUUID(), asset.id);
    const created = await printingJson(
      'templates',
      printTemplateSchema,
      printTemplateCreateSchema.parse({
        ...preset,
        id: crypto.randomUUID(),
        ...(template ? { sourceTemplateId: template.id } : {}),
        name,
        pageWidthMm: Number(width),
        pageHeightMm: Number(height),
        backgroundAssetId: asset.id,
        definition: template?.definition ?? preset.definition,
        safeToleranceXmm: template?.safeToleranceXmm ?? 4,
        safeToleranceYmm: template?.safeToleranceYmm ?? 3,
      }),
    );
    setTemplates((items) => [created, ...items]);
    setSelected(created.id);
    setCalibrationId('');
    setNote(undefined);
    setMode('adjust');
    setMessage(
      'Formulario cargado en un nuevo borrador. Arrastrá los textos y probalo antes de publicar.',
    );
  }
  async function publish(t: PrintTemplate) {
    await printingJson(`templates/${t.id}/publish`, printTemplateSchema, { activate: true });
    await reload();
    setMessage('Plantilla lista para usar. Comprobá la impresión sobre una hoja de prueba.');
  }
  if (!isAdmin) return <p role="alert">La configuración de impresión requiere un administrador.</p>;
  return (
    <>
      <Link href="/remitos">← Remitos</Link>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Configuración</p>
          <h1>Plantilla actual</h1>
          <p>Ajustá los textos sobre el papel y probá la impresión antes de publicar.</p>
        </div>
      </header>
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="catalog-panel template-current">
        <div>
          {active ? (
            <>
              <h2>{active.name}</h2>
              <p>
                Lista para usar · Papel: {active.pageWidthMm} × {active.pageHeightMm} mm
              </p>
              <div
                className="template-background"
                style={{
                  aspectRatio: `${active.pageWidthMm} / ${active.pageHeightMm}`,
                  backgroundImage: `url(/api/printing/assets/${active.backgroundAssetId})`,
                }}
                role="img"
                aria-label="Formulario actual del remito"
              />
            </>
          ) : (
            <>
              <h2>Todavía no hay una plantilla de remito lista para usar.</h2>
              <p>Cargá el formulario Bourbon. Papel: 203 × 271 mm.</p>
            </>
          )}
        </div>
        <div className="template-actions">
          <button
            className="primary-button"
            type="button"
            disabled={busy || !template}
            onClick={() => open('adjust')}
          >
            Ajustar ubicación de textos
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !template}
            onClick={() => open('test')}
          >
            Probar impresión
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => open('change')}
          >
            Cambiar formulario
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busy || !active}
            onClick={() => {
              setSelected(active!.id);
              setMode('printer');
            }}
          >
            Ajustar impresora
          </button>
        </div>
      </section>
      <div ref={editorSection} />
      {mode === 'change' && (
        <section className="catalog-panel">
          <h2>Cambiar formulario</h2>
          <p>
            Elegí una imagen PNG del formulario vacío. Se conserva el historial y la plantilla
            actual sigue en uso hasta publicar.
          </p>
          <fieldset disabled={busy}>
            <Field label="Nombre de la plantilla">
              <input value={name} maxLength={160} onChange={(e) => setName(e.target.value)} />
            </Field>
            <p>
              Papel: {width} × {height} mm
            </p>
            <details>
              <summary>Cambiar tamaño del papel</summary>
              <div className="form-grid">
                <Field label="Ancho (mm)">
                  <input
                    type="number"
                    min="40"
                    max="1000"
                    step="0.001"
                    value={width}
                    onChange={(e) => setWidth(e.target.value)}
                  />
                </Field>
                <Field label="Alto (mm)">
                  <input
                    type="number"
                    min="40"
                    max="1000"
                    step="0.001"
                    value={height}
                    onChange={(e) => setHeight(e.target.value)}
                  />
                </Field>
              </div>
            </details>
            <Field label="Cargar nuevo formulario PNG">
              <input
                type="file"
                accept="image/png"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void run(() => upload(file));
                }}
              />
            </Field>
          </fieldset>
        </section>
      )}
      {template && (mode === 'adjust' || mode === 'test') && (
        <section className="catalog-panel">
          <h2>Modo de prueba</h2>
          <p>
            {template.name} ·{' '}
            {template.status === 'DRAFT'
              ? 'Borrador: todavía no se usa para hacer remitos.'
              : 'Plantilla publicada. Los ajustes se guardan en un nuevo borrador.'}
          </p>
          <details>
            <summary>Usar un remito guardado en la prueba</summary>
            <TestDeliveryNotePicker
              disabled={busy}
              selectedId={note?.id}
              onSelect={(id) =>
                void run(async () => {
                  setNote(await catalogFetch(id, deliveryNoteSchema, { scope: 'delivery-notes' }));
                })
              }
            />
            <button type="button" className="secondary-button" onClick={() => setNote(undefined)}>
              Volver a datos de ejemplo
            </button>
          </details>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                downloadPrintPdf(
                  await printingPdf('calibration-test', {
                    templateRevisionId: template.id,
                    calibrationId: calibration?.id ?? null,
                  }),
                ),
              )
            }
          >
            Descargar prueba de impresión
          </button>
          {config?.activeTemplate?.id !== template.id && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void run(() => publish(template))}
            >
              Publicar y usar esta plantilla
            </button>
          )}
          {mode === 'test' && !note && (
            <p>
              Los datos de ejemplo aparecen a continuación para comprobar la ubicación. Imprimí una
              prueba al 100 %.
            </p>
          )}
        </section>
      )}
      {template && (mode === 'adjust' || mode === 'test') && (
        <PrintGeometryEditor
          key={template.id + ':' + (note?.id ?? 'sample')}
          template={template}
          note={note}
          calibration={calibration}
          onSaved={(saved) => {
            setTemplates((items) => [saved, ...items]);
            setSelected(saved.id);
            setCalibrationId('');
            setTechnical(JSON.stringify(saved.definition, null, 2));
            setMessage('Cambios guardados en borrador. Probá esta plantilla antes de publicarla.');
          }}
        />
      )}
      {mode === 'test' && template && note && (
        <DeliveryPrintPanel doc={note} templateOverride={template} />
      )}
      {mode === 'printer' && template && (
        <section className="catalog-panel">
          <h2>Ajustar impresora</h2>
          <p>
            Si todos los datos salen corridos en la misma dirección, podés mover toda la impresión.
          </p>
          <Field label="Impresora guardada">
            <select
              value={calibrationId}
              disabled={busy}
              onChange={(e) => {
                setCalibrationId(e.target.value);
                const c = config?.calibrations.find((c) => c.id === e.target.value);
                setDx(c?.offsetXmm ?? 0);
                setDy(c?.offsetYmm ?? 0);
                setCalName(c?.name ?? 'Impresora habitual');
                setPrinter(c?.printerDescription ?? '');
                setTray(c?.trayDescription ?? '');
              }}
            >
              <option value="">Nueva / sin ajuste</option>
              {config?.calibrations
                .filter((c) => c.templateRevisionId === template.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </select>
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const c = await printingJson('calibrations', printCalibrationSchema, {
                  id: crypto.randomUUID(),
                  templateRevisionId: template.id,
                  ...(calibrationId ? { sourceCalibrationId: calibrationId } : {}),
                  name: calName,
                  printerDescription: printer || null,
                  trayDescription: tray || null,
                  offsetXmm: dx,
                  offsetYmm: dy,
                });
                await reload();
                setCalibrationId(c.id);
                setMessage('Ajuste de impresora guardado. Repetí la prueba en papel.');
              });
            }}
          >
            <fieldset disabled={busy}>
              <p>Mover impresión</p>
              <div className="actions">
                {(
                  [
                    ['←', -0.5, 0, 'Mover impresión a la izquierda'],
                    ['→', 0.5, 0, 'Mover impresión a la derecha'],
                    ['↑', 0, -0.5, 'Mover impresión hacia arriba'],
                    ['↓', 0, 0.5, 'Mover impresión hacia abajo'],
                  ] as const
                ).map(([arrow, x, y, label]) => (
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={label}
                    key={arrow}
                    onClick={() => {
                      setDx((v) => Math.max(-20, Math.min(20, v + x)));
                      setDy((v) => Math.max(-20, Math.min(20, v + y)));
                    }}
                  >
                    {arrow}
                  </button>
                ))}
              </div>
              <Field label="Nombre de la impresora">
                <input
                  value={calName}
                  required
                  maxLength={160}
                  onChange={(e) => setCalName(e.target.value)}
                />
              </Field>
              <details>
                <summary>Ajuste preciso</summary>
                <div className="form-grid">
                  <Field label="X (mm)">
                    <input
                      type="number"
                      min="-20"
                      max="20"
                      step="0.001"
                      value={dx}
                      onChange={(e) => setDx(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Y (mm)">
                    <input
                      type="number"
                      min="-20"
                      max="20"
                      step="0.001"
                      value={dy}
                      onChange={(e) => setDy(Number(e.target.value))}
                    />
                  </Field>
                  <Field label="Equipo (opcional)">
                    <input
                      value={printer}
                      maxLength={160}
                      onChange={(e) => setPrinter(e.target.value)}
                    />
                  </Field>
                  <Field label="Bandeja (opcional)">
                    <input value={tray} maxLength={160} onChange={(e) => setTray(e.target.value)} />
                  </Field>
                </div>
              </details>
              <button type="submit" className="primary-button">
                Guardar ajuste de impresora
              </button>
            </fieldset>
          </form>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () =>
                downloadPrintPdf(
                  await printingPdf('calibration-test', {
                    templateRevisionId: template.id,
                    calibrationId: calibration?.id ?? null,
                  }),
                ),
              )
            }
          >
            Probar ajuste guardado
          </button>
        </section>
      )}
      <details className="catalog-panel">
        <summary>Historial de cambios</summary>
        <p>Las versiones publicadas se conservan. Cada ajuste crea un nuevo borrador.</p>
        <ul className="print-artifacts">
          {templates.map((t) => (
            <li key={t.id}>
              <span>
                {t.name} · Versión {t.revision} ·{' '}
                {t.status === 'PUBLISHED' ? 'Publicada' : 'Borrador'}
              </span>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => {
                  setSelected(t.id);
                  setCalibrationId('');
                  setTechnical(JSON.stringify(t.definition, null, 2));
                  setMode('adjust');
                }}
              >
                Probar esta plantilla
              </button>
            </li>
          ))}
        </ul>
      </details>
      {template && (
        <details className="catalog-panel">
          <summary>Opciones técnicas</summary>
          <p>
            Papel: {template.pageWidthMm} × {template.pageHeightMm} mm · Tolerancia: X ±
            {template.safeToleranceXmm} mm / Y ±{template.safeToleranceYmm} mm
          </p>
          <Field label="Definición de campos (JSON)">
            <textarea
              className="print-json"
              rows={18}
              spellCheck={false}
              value={technical || JSON.stringify(template.definition, null, 2)}
              onChange={(e) => setTechnical(e.target.value)}
            />
          </Field>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const saved = await printingJson(
                  'templates',
                  printTemplateSchema,
                  printTemplateCreateSchema.parse({
                    id: crypto.randomUUID(),
                    sourceTemplateId: template.id,
                    name: template.name,
                    pageWidthMm: template.pageWidthMm,
                    pageHeightMm: template.pageHeightMm,
                    safeToleranceXmm: template.safeToleranceXmm,
                    safeToleranceYmm: template.safeToleranceYmm,
                    backgroundAssetId: template.backgroundAssetId,
                    definition: JSON.parse(technical || JSON.stringify(template.definition)),
                  }),
                );
                setTemplates((items) => [saved, ...items]);
                setSelected(saved.id);
                setMode('adjust');
                setMessage('Nuevo borrador técnico guardado.');
              })
            }
          >
            Guardar como nuevo borrador
          </button>
        </details>
      )}
    </>
  );
}

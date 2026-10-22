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

const emptyDefinition = JSON.stringify(
  {
    schemaVersion: 1,
    fields: [],
    productRegion: {
      xMm: 0,
      yMm: 0,
      widthMm: 0,
      heightMm: 0,
      rowHeightMm: 0,
      columns: [],
    },
  },
  null,
  2,
);
export function PrintTemplateManager() {
  const { isAdmin } = useWorkspace();
  const [revision, setRevision] = useState(0);
  const [templates, setTemplates] = useState<PrintTemplate[]>([]);
  const [config, setConfig] = useState<ReturnType<typeof printConfigSchema.parse>>();
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [name, setName] = useState(''),
    [width, setWidth] = useState(''),
    [height, setHeight] = useState('');
  const [tx, setTx] = useState(''),
    [ty, setTy] = useState(''),
    [assetId, setAssetId] = useState('');
  const [definition, setDefinition] = useState(emptyDefinition),
    [sourceId, setSourceId] = useState('');
  const [selected, setSelected] = useState(''),
    [calibrationId, setCalibrationId] = useState('');
  const [calName, setCalName] = useState(''),
    [printer, setPrinter] = useState(''),
    [tray, setTray] = useState('');
  const [dx, setDx] = useState('0'),
    [dy, setDy] = useState('0');
  const [note, setNote] = useState<DeliveryNoteView>();
  const [useSample, setUseSample] = useState(false);
  const guard = useRef(false);
  const template = templates.find((t) => t.id === selected);
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    void Promise.all([
      printingJson('templates', printTemplateListSchema),
      printingJson('config', printConfigSchema),
    ])
      .then(([list, c]) => {
        if (alive) {
          setTemplates(list.items);
          setConfig(c);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e.message));
      });
    return () => {
      alive = false;
    };
  }, [isAdmin, revision]);
  async function run(fn: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos guardar la configuración.');
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function copy(t: PrintTemplate) {
    setSourceId(t.id);
    setName(t.name);
    setWidth(String(t.pageWidthMm));
    setHeight(String(t.pageHeightMm));
    setTx(String(t.safeToleranceXmm));
    setTy(String(t.safeToleranceYmm));
    setAssetId(t.backgroundAssetId);
    setDefinition(JSON.stringify(t.definition, null, 2));
    setMessage('La copia se guardará como una nueva revisión.');
  }
  async function upload(file: File) {
    if (file.size > 4194304) throw new Error('Usá un PNG preparado de hasta 4 MiB.');
    const encoded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('No pudimos leer la imagen.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(file);
    });
    const asset = await printingJson('assets', printAssetSchema, { pngBase64: encoded });
    setAssetId(asset.id);
    setMessage('Fondo guardado en almacenamiento privado.');
  }
  if (!isAdmin) return <p role="alert">La configuración de impresión requiere un administrador.</p>;
  return (
    <>
      <Link href="/remitos">← Remitos</Link>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Configuración</p>
          <h1>Impresión sobre talonario</h1>
          <p>Prepará una revisión con las medidas reales del papel y calibrá la impresora.</p>
        </div>
      </header>
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <section className="catalog-panel">
        <h2>Revisiones del formulario</h2>
        <p>
          Activa:{' '}
          {config?.activeTemplate
            ? `${config.activeTemplate.name} · revisión ${config.activeTemplate.revision}`
            : 'Sin plantilla activa'}
          .
        </p>
        <p>Las revisiones publicadas no se editan. Copiá una revisión para ajustar su geometría.</p>
        <div className="reference-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Plantilla</th>
                <th>Revisión</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id}>
                  <td>
                    {t.name}
                    <br />
                    {t.pageWidthMm} × {t.pageHeightMm} mm
                  </td>
                  <td>{t.revision}</td>
                  <td>{t.status === 'PUBLISHED' ? 'Publicada' : 'Borrador'}</td>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => copy(t)}
                    >
                      Copiar como nueva revisión
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setSelected(t.id);
                        setCalibrationId('');
                      }}
                    >
                      Probar / calibrar
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        setSelected(t.id);
                        setCalibrationId('');
                        setMessage(
                          'Elegí un remito guardado para editar la geometría sobre el fondo.',
                        );
                      }}
                    >
                      Editar geometría
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || config?.activeTemplate?.id === t.id}
                      onClick={() =>
                        void run(async () => {
                          await printingJson(`templates/${t.id}/publish`, printTemplateSchema, {
                            activate: true,
                          });
                          setRevision((r) => r + 1);
                          setMessage(
                            'Revisión publicada y activa. Validá su impresión sobre una hoja de prueba.',
                          );
                        })
                      }
                    >
                      {t.status === 'PUBLISHED' ? 'Activar revisión' : 'Publicar y activar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!templates.length && <p>Todavía no hay revisiones. No se presupone un tamaño de papel.</p>}
      </section>
      <section className="catalog-panel">
        <h2>{sourceId ? 'Crear nueva revisión' : 'Preparar primer formulario'}</h2>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => {
            const preset = bourbonProvisionalTemplate(crypto.randomUUID(), crypto.randomUUID());
            setSourceId('');
            setAssetId('');
            setName(preset.name);
            setWidth('203');
            setHeight('271');
            setTx('4');
            setTy('3');
            setDefinition(JSON.stringify(preset.definition, null, 2));
            setMessage(
              'Base provisional Bourbon preparada. Cargá el PNG real y guardá el borrador. Las posiciones iniciales requieren revisión contra la imagen y prueba física.',
            );
          }}
        >
          Preparar Bourbon Remito 203x271 - Provisional
        </button>
        <p>
          Las cajas describen espacios en blanco disponibles. Incluí la tolerancia de alimentación y
          un margen interno. La configuración geométrica inicial es técnica.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (![width, height, tx, ty].every((v) => v.trim()))
                throw new Error(
                  'Ingresá las medidas y tolerancias explícitamente; cero es válido para tolerancia.',
                );
              let json: unknown;
              try {
                json = JSON.parse(definition);
              } catch {
                throw new Error('La definición JSON no es válida.');
              }
              const input = printTemplateCreateSchema.safeParse({
                id: crypto.randomUUID(),
                ...(sourceId ? { sourceTemplateId: sourceId } : {}),
                name,
                pageWidthMm: Number(width),
                pageHeightMm: Number(height),
                safeToleranceXmm: Number(tx),
                safeToleranceYmm: Number(ty),
                backgroundAssetId: assetId,
                definition: json,
              });
              if (!input.success)
                throw new Error(
                  input.error.issues
                    .slice(0, 4)
                    .map((i) => i.message)
                    .join(' '),
                );
              const created = await printingJson('templates', printTemplateSchema, input.data);
              setSelected(created.id);
              setRevision((r) => r + 1);
              setSourceId(created.id);
              setMessage('Borrador de plantilla guardado. Probalo antes de publicar.');
            });
          }}
        >
          <fieldset disabled={busy}>
            <div className="form-grid">
              <Field label="Nombre">
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field label="Ancho del papel (mm)">
                <input
                  required
                  type="number"
                  min="40"
                  max="1000"
                  step="0.001"
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                />
              </Field>
              <Field label="Alto del papel (mm)">
                <input
                  required
                  type="number"
                  min="40"
                  max="1000"
                  step="0.001"
                  value={height}
                  onChange={(e) => setHeight(e.target.value)}
                />
              </Field>
              <Field label="Tolerancia horizontal ± (mm)">
                <input
                  required
                  type="number"
                  min="0"
                  max="10"
                  step="0.001"
                  value={tx}
                  onChange={(e) => setTx(e.target.value)}
                />
              </Field>
              <Field label="Tolerancia vertical ± (mm)">
                <input
                  required
                  type="number"
                  min="0"
                  max="10"
                  step="0.001"
                  value={ty}
                  onChange={(e) => setTy(e.target.value)}
                />
              </Field>
              <Field label="PNG preparado del formulario">
                <input
                  type="file"
                  accept="image/png"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void run(() => upload(f));
                  }}
                />
              </Field>
            </div>
            <p>
              {assetId
                ? 'Fondo privado disponible para esta revisión.'
                : 'Cargá el PNG sin datos personales y con la misma proporción que el papel.'}
            </p>
            <Field label="Definición de campos y región repetible (JSON)">
              <textarea
                className="print-json"
                rows={18}
                value={definition}
                onChange={(e) => setDefinition(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <p className="muted">
              Bindings permitidos: document.number, document.date, document.dateDay,
              document.dateMonth, document.dateYear, customer.name, customer.legalName,
              customer.cuit, customer.taxCondition, customer.address, customer.addressLine,
              customer.locality, patient.name, patient.affiliateNumber, notes. Fuente: NotoSans;
              geometría en mm, tipografía e interlineado en pt.
            </p>
            <button className="primary-button" type="submit">
              Guardar revisión en borrador
            </button>
          </fieldset>
        </form>
      </section>
      <section className="catalog-panel">
        <h2>Prueba y calibración</h2>
        <Field label="Revisión a probar">
          <select
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              setCalibrationId('');
            }}
          >
            <option value="">Elegí una revisión</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · r{t.revision} · {t.status}
              </option>
            ))}
          </select>
        </Field>
        {template && (
          <>
            <p>
              Imprimí la prueba al 100 %, medí los desplazamientos y repetí. Positivo X mueve a la
              derecha; positivo Y, hacia abajo. La escala permanece en 1.
            </p>
            <Field label="Calibración guardada">
              <select
                disabled={busy}
                value={calibrationId}
                onChange={(e) => {
                  setCalibrationId(e.target.value);
                  const c = config?.calibrations.find((c) => c.id === e.target.value);
                  if (c) {
                    setCalName(c.name);
                    setPrinter(c.printerDescription ?? '');
                    setTray(c.trayDescription ?? '');
                    setDx(String(c.offsetXmm));
                    setDy(String(c.offsetYmm));
                  }
                }}
              >
                <option value="">Nominal / nueva calibración</option>
                {config?.calibrations
                  .filter((c) => c.templateRevisionId === template.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} · r{c.revision}
                    </option>
                  ))}
              </select>
            </Field>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() =>
                void run(async () =>
                  downloadPrintPdf(
                    await printingPdf('calibration-test', {
                      templateRevisionId: template.id,
                      calibrationId: calibrationId || null,
                    }),
                  ),
                )
              }
            >
              Descargar PDF de prueba
            </button>
            {template.status === 'PUBLISHED' ? (
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
                      offsetXmm: Number(dx),
                      offsetYmm: Number(dy),
                    });
                    setCalibrationId(c.id);
                    setRevision((r) => r + 1);
                    setMessage('Nueva revisión de calibración guardada. Repetí la prueba física.');
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <div className="form-grid">
                    <Field label="Nombre de calibración">
                      <input
                        required
                        value={calName}
                        maxLength={160}
                        onChange={(e) => setCalName(e.target.value)}
                      />
                    </Field>
                    <Field label="Impresora / equipo (opcional)">
                      <input
                        value={printer}
                        maxLength={160}
                        onChange={(e) => setPrinter(e.target.value)}
                      />
                    </Field>
                    <Field label="Bandeja / alimentación (opcional)">
                      <input
                        value={tray}
                        maxLength={160}
                        onChange={(e) => setTray(e.target.value)}
                      />
                    </Field>
                    <Field label="Corrección X (mm)">
                      <input
                        required
                        type="number"
                        min="-20"
                        max="20"
                        step="0.001"
                        value={dx}
                        onChange={(e) => setDx(e.target.value)}
                      />
                    </Field>
                    <Field label="Corrección Y (mm)">
                      <input
                        required
                        type="number"
                        min="-20"
                        max="20"
                        step="0.001"
                        value={dy}
                        onChange={(e) => setDy(e.target.value)}
                      />
                    </Field>
                  </div>
                  <button type="submit" className="primary-button">
                    Guardar nueva revisión de calibración
                  </button>
                </fieldset>
              </form>
            ) : (
              <p>Publicá esta revisión antes de guardar calibraciones.</p>
            )}
            <TestDeliveryNotePicker
              disabled={busy}
              selectedId={note?.id}
              onSelect={(id) =>
                void run(async () => {
                  setNote(undefined);
                  setUseSample(false);
                  setNote(await catalogFetch(id, deliveryNoteSchema, { scope: 'delivery-notes' }));
                })
              }
            />
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setNote(undefined);
                setUseSample(true);
              }}
            >
              Usar datos de prueba para editar geometría
            </button>
          </>
        )}
      </section>
      {template && (note || useSample) && (
        <PrintGeometryEditor
          key={'geometry:' + template.id + ':' + (note?.id ?? 'sample')}
          template={template}
          note={note}
          calibration={
            config?.calibrations.find(
              (c) => c.id === calibrationId && c.templateRevisionId === template.id,
            ) ?? null
          }
          onSaved={(saved) => {
            setTemplates((items) => [saved, ...items]);
            setSelected(saved.id);
            setCalibrationId('');
            setRevision((r) => r + 1);
            setMessage(
              'Geometría guardada como nueva revisión DRAFT. Calibración nominal 0 / 0; prueba física pendiente.',
            );
          }}
        />
      )}
      {template && note && (
        <DeliveryPrintPanel
          key={template.id + ':' + note.id}
          doc={note}
          templateOverride={template}
        />
      )}
    </>
  );
}

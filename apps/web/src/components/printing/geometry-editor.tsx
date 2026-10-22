'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  printGeometryPreviewSchema,
  printTemplateCreateSchema,
  printTemplateSchema,
  bourbonProvisionalName,
  type DeliveryNoteView,
  type PrintTemplate,
  type PrintDefinition,
  type PrintCalibration,
  type PrintGeometryPreview,
} from '@maxbio/contracts';
import { printingJson } from '../../lib/printing-api';
import { PdfPreview } from './pdf-preview';
import { moveGeometry, screenDeltaMm, selectedColumn } from './geometry-controls';

type Preview = {
  definition: PrintDefinition;
  calibrationId: string;
  data: PrintGeometryPreview;
  bytes: Uint8Array;
};
export function PrintGeometryEditor({
  template,
  note,
  calibration,
  onSaved,
}: {
  template: PrintTemplate;
  note?: DeliveryNoteView;
  calibration: PrintCalibration | null;
  onSaved: (template: PrintTemplate) => void;
}) {
  const [definition, setDefinition] = useState(template.definition);
  const [selected, setSelected] = useState(template.definition.fields[0]?.id ?? 'products');
  const [preview, setPreview] = useState<Preview>();
  const [rendered, setRendered] = useState<Uint8Array>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const saveGuard = useRef(false);
  const drag = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    region: string;
    definition: PrintDefinition;
  } | null>(null);
  const calibrationId = calibration?.id ?? '';
  const noteId = note?.id;
  const noteVersion = note?.version;
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      const path = noteId
        ? `delivery-notes/${noteId}/geometry-preview`
        : `templates/${template.id}/geometry-preview`;
      void printingJson(path, printGeometryPreviewSchema, {
        ...(noteId ? { templateRevisionId: template.id, expectedVersion: noteVersion } : {}),
        calibrationId: calibrationId || null,
        definition,
      })
        .then((data) => {
          if (alive) {
            setPreview({
              definition,
              calibrationId,
              data,
              bytes: Uint8Array.from(atob(data.pdfBase64), (c) => c.charCodeAt(0)),
            });
            setError('');
          }
        })
        .catch((e: unknown) => {
          if (alive)
            setError(e instanceof Error ? e.message : 'No pudimos recalcular la geometría.');
        });
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [definition, calibrationId, template.id, noteId, noteVersion]);
  const bytes = preview?.bytes;
  const onReady = useCallback(() => setRendered(bytes), [bytes]);
  const current =
    preview?.definition === definition &&
    preview?.calibrationId === calibrationId &&
    rendered === bytes;
  const columnIndex = selectedColumn(definition, selected);
  const field = definition.fields.find((f) => f.id === selected);
  const box = field ?? definition.productRegion;
  const style = field ?? definition.productRegion.columns[columnIndex];
  function updateBox(key: 'xMm' | 'yMm' | 'widthMm' | 'heightMm' | 'rowHeightMm', value: number) {
    const next = structuredClone(definition);
    const target = next.fields.find((f) => f.id === selected);
    if (target && key !== 'rowHeightMm') target[key] = value;
    else if (!target) next.productRegion[key] = value;
    setDefinition(next);
    setMessage('');
  }
  function updateStyle(
    key:
      | 'widthMm'
      | 'fontSizePt'
      | 'lineHeightPt'
      | 'maxLines'
      | 'paddingMm'
      | 'align'
      | 'verticalAlign',
    value: number | string,
  ) {
    const next = structuredClone(definition);
    const target =
      next.fields.find((f) => f.id === selected) ?? next.productRegion.columns[columnIndex];
    if (target) Object.assign(target, { [key]: value });
    setDefinition(next);
    setMessage('');
  }
  function number(label: string, value: number, change: (n: number) => void, step = 0.1) {
    return (
      <label>
        {label}
        <input
          type="number"
          value={value}
          step={step}
          min="0"
          onChange={(event) => {
            if (event.target.value !== '') change(Number(event.target.value));
          }}
        />
      </label>
    );
  }
  async function save() {
    if (saveGuard.current) return;
    saveGuard.current = true;
    setSaving(true);
    setError('');
    try {
      const input = printTemplateCreateSchema.parse({
        id: crypto.randomUUID(),
        sourceTemplateId: template.id,
        name: template.name,
        pageWidthMm: template.pageWidthMm,
        pageHeightMm: template.pageHeightMm,
        safeToleranceXmm: template.safeToleranceXmm,
        safeToleranceYmm: template.safeToleranceYmm,
        backgroundAssetId: template.backgroundAssetId,
        definition,
      });
      const saved = await printingJson('templates', printTemplateSchema, input);
      setMessage('Geometría guardada en una nueva revisión DRAFT.');
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos guardar la geometría.');
    } finally {
      saveGuard.current = false;
      setSaving(false);
    }
  }
  const status = current
    ? preview?.data.envelopes.find((e) => e.region === selected)?.state
    : undefined;
  return (
    <section className="catalog-panel">
      <h2>Editar geometría · {template.name}</h2>
      <p>
        {note
          ? `Remito ${note.documentPrefix}-${note.documentNumber} · ${note.customer.name}`
          : 'DATOS DE PRUEBA · No es un remito guardado'}{' '}
        · {template.pageWidthMm} × {template.pageHeightMm} mm
      </p>
      <p>
        Un recuadro por texto: área completa de posible caída. Verde SAFE, naranja WARNING, rojo
        BLOCKED. El formulario requiere revisión visual y prueba física. Tamaño personalizado,
        tamaño real / 100 %.
      </p>
      <p>
        Tolerancia provisional: X ±{template.safeToleranceXmm} mm / Y ±{template.safeToleranceYmm}{' '}
        mm. Calibración: {calibration?.offsetXmm ?? 0} / {calibration?.offsetYmm ?? 0} mm.
      </p>
      {template.name === bourbonProvisionalName && (
        <p className="print-status print-status-warning">
          Revisión del papel pendiente: con estas tolerancias, las envolventes del año y CUIT
          alcanzan líneas preimpresas. SAFE evalúa la geometría matemática; no certifica el espacio
          disponible en la imagen. Conservá esta plantilla como provisional hasta la prueba física.
        </p>
      )}
      {error && (
        <p role="alert" className="catalog-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={saving} className="print-geometry-controls">
        <label>
          Campo o región
          <select value={selected} onChange={(e) => setSelected(e.target.value)}>
            {definition.fields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.binding}
              </option>
            ))}
            <option value="products">Región de productos</option>
            {definition.productRegion.columns.map((c) => (
              <option key={c.binding} value={`row-1-${c.binding}`}>
                Columna: {c.binding}
              </option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          {number('X (mm)', box.xMm, (v) => updateBox('xMm', v))}
          {number('Y (mm)', box.yMm, (v) => updateBox('yMm', v))}
          {number('Ancho disponible de región (mm)', box.widthMm, (v) => updateBox('widthMm', v))}
          {number('Alto disponible de región (mm)', box.heightMm, (v) => updateBox('heightMm', v))}
          {!field &&
            number('Alto de fila (mm)', definition.productRegion.rowHeightMm, (v) =>
              updateBox('rowHeightMm', v),
            )}
          {columnIndex >= 0 &&
            style &&
            number('Ancho de columna (mm)', style.widthMm, (v) => updateStyle('widthMm', v))}
          {style && (
            <>
              {number('Fuente NotoSans (pt)', style.fontSizePt, (v) =>
                updateStyle('fontSizePt', v),
              )}
              {number('Interlineado (pt)', style.lineHeightPt, (v) =>
                updateStyle('lineHeightPt', v),
              )}
              {number('Máximo de líneas', style.maxLines, (v) => updateStyle('maxLines', v), 1)}
              {number('Padding (mm)', style.paddingMm, (v) => updateStyle('paddingMm', v))}
              <label>
                Alineación
                <select value={style.align} onChange={(e) => updateStyle('align', e.target.value)}>
                  <option value="left">Izquierda</option>
                  <option value="center">Centro</option>
                  <option value="right">Derecha</option>
                </select>
              </label>
              <label>
                Alineación vertical
                <select
                  value={style.verticalAlign}
                  onChange={(e) => updateStyle('verticalAlign', e.target.value)}
                >
                  <option value="top">Arriba</option>
                  <option value="middle">Centro</option>
                  <option value="bottom">Abajo</option>
                </select>
              </label>
            </>
          )}
        </div>
        <p>
          Estado del texto: {status ?? (current ? preview?.data.evaluation.state : 'Recalculando…')}
          .
        </p>
        {!field && (
          <p>
            Las filas comparten geometría. Arrastrar un texto de producto mueve toda la región;
            ancho y tipografía de columna se aplican a todas sus filas.
          </p>
        )}
        <button
          type="button"
          className="primary-button"
          onClick={() => void save()}
          disabled={!current}
        >
          Guardar geometría como nueva revisión en borrador
        </button>
      </fieldset>
      {!current && !error && (
        <p role="status">Recalculando texto y envolventes con el motor PDF…</p>
      )}
      {preview && (
        <>
          <p>
            Arrastrá un recuadro para moverlo. Flechas: 0,5 mm; Shift + flecha: 0,1 mm.
            Seleccionado:{' '}
            {field?.binding ?? (columnIndex >= 0 ? style?.binding : 'Región de productos')}.
          </p>
          <PdfPreview bytes={preview.bytes} onReady={onReady}>
            <svg
              className="print-geometry-hits"
              viewBox={`0 0 ${template.pageWidthMm} ${template.pageHeightMm}`}
              aria-label="Seleccionar y mover textos del remito"
              style={{ pointerEvents: current && !saving ? 'auto' : 'none' }}
              onPointerMove={(event) => {
                const start = drag.current;
                if (!start) return;
                setDefinition(
                  moveGeometry(
                    start.definition,
                    start.region,
                    screenDeltaMm(event.clientX - start.x, start.width, template.pageWidthMm),
                    screenDeltaMm(event.clientY - start.y, start.height, template.pageHeightMm),
                    template.pageWidthMm,
                    template.pageHeightMm,
                  ),
                );
              }}
              onPointerUp={(event) => {
                drag.current = null;
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => {
                drag.current = null;
              }}
            >
              {preview.data.envelopes.map(({ region, rect }) => (
                <rect
                  key={region}
                  x={rect.xMm}
                  y={rect.yMm}
                  width={rect.widthMm}
                  height={rect.heightMm}
                  fill="transparent"
                  stroke="none"
                  tabIndex={current ? 0 : -1}
                  role="button"
                  aria-label={`Mover ${region}`}
                  aria-pressed={selected === region}
                  onFocus={() => setSelected(region)}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    setSelected(region);
                    event.currentTarget.focus();
                    const svg = event.currentTarget.ownerSVGElement!;
                    const size = svg.getBoundingClientRect();
                    drag.current = {
                      x: event.clientX,
                      y: event.clientY,
                      width: size.width,
                      height: size.height,
                      region,
                      definition,
                    };
                    svg.setPointerCapture(event.pointerId);
                  }}
                  onKeyDown={(event) => {
                    const deltas: Record<string, [number, number]> = {
                      ArrowLeft: [-1, 0],
                      ArrowRight: [1, 0],
                      ArrowUp: [0, -1],
                      ArrowDown: [0, 1],
                    };
                    const delta = deltas[event.key];
                    if (!delta) return;
                    event.preventDefault();
                    const step = event.shiftKey ? 0.1 : 0.5;
                    setDefinition(
                      moveGeometry(
                        definition,
                        region,
                        delta[0] * step,
                        delta[1] * step,
                        template.pageWidthMm,
                        template.pageHeightMm,
                      ),
                    );
                  }}
                />
              ))}
            </svg>
          </PdfPreview>
          {current && (
            <ul>
              {preview.data.evaluation.issues.map((issue, index) => (
                <li key={index}>
                  {issue.region}: {issue.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

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
import {
  printLabels,
  printRegionLabel,
  printIssueMessage,
  printErrorMessage,
} from './print-labels.ts';
import { printingJson } from '../../lib/printing-api.ts';
import { PdfPreview } from './pdf-preview.tsx';
import { moveGeometry, screenDeltaMm, selectedColumn } from './geometry-controls.ts';

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
    resize?: boolean;
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
      setMessage('Ubicación guardada en un nuevo borrador. Probalo antes de publicar.');
      onSaved(saved);
    } catch (e) {
      setError(printErrorMessage(e));
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
      <h2>Ajustar ubicación de textos</h2>
      <p>
        Arrastrá los textos sobre el formulario. El recuadro muestra el espacio que puede ocupar
        cada dato.
      </p>
      <p className="muted">
        Modo de prueba · {template.name} · Papel: {template.pageWidthMm} × {template.pageHeightMm}{' '}
        mm
      </p>
      {template.name === bourbonProvisionalName && (
        <p className="print-status print-status-warning">
          Revisá especialmente el año y el CUIT: podrían tocar las líneas del papel. Hacé una prueba
          física antes de usar esta plantilla.
        </p>
      )}
      {error && (
        <p role="alert" className="catalog-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <div className="geometry-workspace">
        <div>
          {!current && !error && <p role="status">Actualizando vista…</p>}
          {preview && (
            <>
              <p>
                Arrastrá un recuadro para moverlo. Flechas: 0,5 mm; Shift + flecha: 0,1 mm.
                Seleccionado:{' '}
                {field
                  ? printLabels[field.binding]
                  : columnIndex >= 0
                    ? printLabels[style?.binding ?? '']
                    : 'Productos'}
                .
              </p>
              <PdfPreview bytes={preview.bytes} onReady={onReady} fit>
                <svg
                  className="print-geometry-hits"
                  viewBox={`0 0 ${template.pageWidthMm} ${template.pageHeightMm}`}
                  aria-label="Seleccionar y mover textos del remito"
                  style={{ pointerEvents: current && !saving ? 'auto' : 'none' }}
                  onPointerMove={(event) => {
                    const start = drag.current;
                    if (!start) return;
                    if (start.resize) {
                      const next = structuredClone(start.definition);
                      const r = next.productRegion;
                      const dx = screenDeltaMm(
                        event.clientX - start.x,
                        start.width,
                        template.pageWidthMm,
                      );
                      const dy = screenDeltaMm(
                        event.clientY - start.y,
                        start.height,
                        template.pageHeightMm,
                      );
                      r.widthMm = Math.min(
                        template.pageWidthMm - r.xMm,
                        Math.max(
                          r.columns.reduce((n, c) => n + c.widthMm, 0),
                          r.widthMm + dx,
                        ),
                      );
                      r.heightMm = Math.min(
                        template.pageHeightMm - r.yMm,
                        Math.max(r.rowHeightMm, r.heightMm + dy),
                      );
                      setDefinition(next);
                      return;
                    }
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
                  {selected === 'products' && (
                    <>
                      <rect
                        x={definition.productRegion.xMm}
                        y={definition.productRegion.yMm}
                        width={definition.productRegion.widthMm}
                        height={definition.productRegion.heightMm}
                        fill="transparent"
                        stroke="#1457b8"
                        strokeWidth="0.4"
                        strokeDasharray="2 1"
                      />
                      <circle
                        cx={definition.productRegion.xMm + definition.productRegion.widthMm}
                        cy={definition.productRegion.yMm + definition.productRegion.heightMm}
                        r="2"
                        fill="#1457b8"
                        role="button"
                        aria-label="Cambiar tamaño de Productos"
                        tabIndex={0}
                        onPointerDown={(event) => {
                          const svg = event.currentTarget.ownerSVGElement!;
                          const size = svg.getBoundingClientRect();
                          drag.current = {
                            x: event.clientX,
                            y: event.clientY,
                            width: size.width,
                            height: size.height,
                            region: 'products',
                            definition,
                            resize: true,
                          };
                          svg.setPointerCapture(event.pointerId);
                        }}
                      />
                    </>
                  )}
                  {preview.data.envelopes.map(({ region, rect }) => (
                    <rect
                      key={region}
                      x={rect.xMm}
                      y={rect.yMm}
                      width={rect.widthMm}
                      height={rect.heightMm}
                      fill="transparent"
                      stroke={selected === region ? '#1457b8' : 'none'}
                      strokeWidth={0.7}
                      tabIndex={current ? 0 : -1}
                      role="button"
                      aria-label={`Mover ${printRegionLabel(region, template)}`}
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
                    <li key={index}>{printIssueMessage(issue, template)}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
        <fieldset disabled={saving} className="print-geometry-controls">
          <label>
            Texto a ajustar
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              {definition.fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {printLabels[f.binding]}
                </option>
              ))}
              <option value="products">Productos</option>
              {definition.productRegion.columns.map((c) => (
                <option key={c.binding} value={`row-1-${c.binding}`}>
                  {printLabels[c.binding]}
                </option>
              ))}
            </select>
          </label>
          <div className="geometry-simple-controls">
            <p>
              <strong>
                {field
                  ? printLabels[field.binding]
                  : columnIndex >= 0
                    ? printLabels[style?.binding ?? '']
                    : 'Productos'}
              </strong>
            </p>
            <p>Posición</p>
            <div className="actions">
              {(
                [
                  ['←', -0.5, 0, 'Mover a la izquierda'],
                  ['→', 0.5, 0, 'Mover a la derecha'],
                  ['↑', 0, -0.5, 'Mover hacia arriba'],
                  ['↓', 0, 0.5, 'Mover hacia abajo'],
                ] as const
              ).map(([arrow, x, y, label]) => (
                <button
                  key={arrow}
                  type="button"
                  className="secondary-button"
                  aria-label={label}
                  onClick={() =>
                    setDefinition(
                      moveGeometry(
                        definition,
                        selected,
                        x,
                        y,
                        template.pageWidthMm,
                        template.pageHeightMm,
                      ),
                    )
                  }
                >
                  {arrow}
                </button>
              ))}
            </div>
            {style && (
              <>
                <p>Tamaño de letra</p>
                <div className="actions">
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="Reducir letra"
                    onClick={() => updateStyle('fontSizePt', Math.max(6, style.fontSizePt - 0.5))}
                  >
                    −
                  </button>
                  <span>{style.fontSizePt} pt</span>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label="Aumentar letra"
                    onClick={() => updateStyle('fontSizePt', Math.min(36, style.fontSizePt + 0.5))}
                  >
                    +
                  </button>
                </div>
                <label>
                  Alineación
                  <select
                    value={style.align}
                    onChange={(e) => updateStyle('align', e.target.value)}
                  >
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                  </select>
                </label>
              </>
            )}
          </div>
          <details>
            <summary>Ajuste preciso</summary>
            <div className="form-grid">
              {number('X (mm)', box.xMm, (v) => updateBox('xMm', v))}
              {number('Y (mm)', box.yMm, (v) => updateBox('yMm', v))}
              {number('Ancho disponible de región (mm)', box.widthMm, (v) =>
                updateBox('widthMm', v),
              )}
              {number('Alto disponible de región (mm)', box.heightMm, (v) =>
                updateBox('heightMm', v),
              )}
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
                    <select
                      value={style.align}
                      onChange={(e) => updateStyle('align', e.target.value)}
                    >
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
          </details>
          <p>
            Estado del texto:{' '}
            {status
              ? {
                  SAFE: 'Dentro del espacio',
                  WARNING: 'Revisar visualmente',
                  BLOCKED: 'Necesita ajuste',
                }[status]
              : 'Actualizando…'}
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
            Guardar cambios en borrador
          </button>
        </fieldset>
      </div>
    </section>
  );
}

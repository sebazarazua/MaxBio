'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { deliveryTraceHistorySchema, type DeliveryNoteView } from '@maxbio/contracts';
import { catalogFetch, humanError } from '../../lib/catalog-api.ts';
import type { DeclaredTrace } from '../../lib/delivery-traces.ts';
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="catalog-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function DocumentaryTraceEditor({
  traces,
  change,
}: {
  traces: DeclaredTrace[];
  change: (t: DeclaredTrace[]) => void;
}) {
  function edit(index: number, patch: Partial<DeclaredTrace>) {
    change(traces.map((t, i) => (i === index ? { ...t, ...patch, manualEdited: true } : t)));
  }
  return (
    <details open={traces.length > 0}>
      <summary>Datos físicos registrados solo en el Remito</summary>
      <p>
        Conservá lote, vencimiento o serie sin modificar Stock. Cada serie representa una unidad.
      </p>
      {traces.map((t, i) => (
        <div className="delivery-position" key={t.id}>
          <strong>Registrado solo en el Remito</strong>
          <div className="form-grid">
            <Field label="Cantidad documentada">
              <input
                inputMode="decimal"
                value={t.quantity}
                onChange={(e) => edit(i, { quantity: e.target.value.replace(',', '.') })}
              />
            </Field>
            <Field label="Lote">
              <input
                maxLength={128}
                value={t.lotNumber ?? ''}
                onChange={(e) => edit(i, { lotNumber: e.target.value || null })}
              />
            </Field>
            <Field label="Vencimiento">
              <input
                type="date"
                value={t.expirationDate ?? ''}
                onChange={(e) => edit(i, { expirationDate: e.target.value || null })}
              />
            </Field>
            <Field label="Serie">
              <input
                maxLength={128}
                value={t.serialNumber ?? ''}
                onChange={(e) => edit(i, { serialNumber: e.target.value || null })}
              />
            </Field>
          </div>
          <button
            type="button"
            className="text-button"
            onClick={() => change(traces.filter((_, n) => n !== i))}
          >
            Quitar datos físicos
          </button>
        </div>
      ))}
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          change([
            ...traces,
            {
              id: crypto.randomUUID(),
              quantity: '1',
              lotNumber: null,
              expirationDate: null,
              serialNumber: null,
            },
          ])
        }
      >
        Agregar lote / vencimiento / serie sin Stock
      </button>
    </details>
  );
}

export function SerialHistoryReview({
  doc,
  ready,
}: {
  doc: DeliveryNoteView;
  ready: (ids: string[] | null) => void;
}) {
  const [items, setItems] = useState<
    Array<{ traceId: string; documentNumber: string; customerName: string; deliveryNoteId: string }>
  >([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    ready(null);
    const serials = doc.lines.flatMap((l) =>
      l.physicalTraces
        .filter((t) => t.serialNumber)
        .map((t) => ({ productId: l.productId, serialNumber: t.serialNumber })),
    );
    void Promise.all(
      serials.map((body) =>
        catalogFetch('trace-history', deliveryTraceHistorySchema, {
          scope: 'delivery-notes',
          method: 'POST',
          body,
        }),
      ),
    )
      .then((results) => {
        if (!active) return;
        if (results.some((r) => r.truncated))
          throw new Error(
            'La serie requiere revisión administrativa por la cantidad de antecedentes.',
          );
        const found = results.flatMap((r) => r.items).filter((r) => r.deliveryNoteId !== doc.id);
        setItems(found);
        setLoaded(true);
        if (!found.length) ready([]);
      })
      .catch((e: unknown) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [doc, ready]);
  return (
    <div role="status" aria-live="polite">
      {!loaded && !error && <p>Revisando antecedentes de series…</p>}
      {error && <p role="alert">{error}</p>}
      {items.length > 0 && (
        <>
          <p>
            Esta serie ya figura en un Remito anterior. Revisá los antecedentes antes de confirmar.
          </p>
          <ul>
            {items.map((h) => (
              <li key={h.traceId}>
                <a href={'/remitos/' + h.deliveryNoteId} target="_blank" rel="noreferrer">
                  {h.documentNumber}
                </a>{' '}
                · {h.customerName}
              </li>
            ))}
          </ul>
          <label>
            <input
              type="checkbox"
              onChange={(e) => ready(e.target.checked ? items.map((h) => h.traceId) : null)}
            />{' '}
            Revisé los Remitos anteriores y corresponde documentar esta salida.
          </label>
        </>
      )}
    </div>
  );
}

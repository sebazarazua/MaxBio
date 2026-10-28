'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  invoiceDiscardedSchema,
  invoiceHistoryLabels,
  invoiceLineAmounts,
  invoiceSchema,
  invoiceStatusLabels,
  invoiceTotals,
  invoiceTypeLabels,
  invoiceTypeSchema,
  invoiceVatRateLabels,
  invoiceVatRateSchema,
  quantityLabels,
  type InvoiceVatRate,
  type InvoiceView,
} from '@maxbio/contracts';
import { catalogFetch, humanError } from '../../lib/catalog-api.ts';
import { displayDate } from '../../lib/traceability.ts';
import {
  formatMoney,
  internalReference,
  moneyInputText,
  parseMoneyInput,
} from '../../lib/invoicing.ts';
import { Feedback, Field, useMutation } from '../catalog/common.tsx';
import { InvoiceFiscalPanel } from './fiscal-panel.tsx';

type Draft = {
  invoiceType: InvoiceView['invoiceType'];
  issueDate: string;
  notes: string;
  lines: { id: string; description: string; price: string; vatRate: InvoiceVatRate | null }[];
};
const draftOf = (i: InvoiceView): Draft => ({
  invoiceType: i.invoiceType,
  issueDate: i.issueDate,
  notes: i.notes ?? '',
  lines: i.lines.map((l) => ({
    id: l.id,
    description: l.description,
    price: moneyInputText(l.unitPrice),
    vatRate: l.vatRate,
  })),
});

// Browser preview only; the API recalculates and is the authority.
export function previewLine(quantity: string, price: string, vatRate: InvoiceVatRate | null) {
  const unitPrice = parseMoneyInput(price);
  if (unitPrice === null || vatRate === null) return null;
  try {
    return invoiceLineAmounts(quantity, unitPrice, vatRate);
  } catch {
    return null;
  }
}
// First problem a person must fix before marking it ready, in plain words.
export function readyProblem(i: InvoiceView, d: Draft): string | null {
  if (!d.invoiceType) return 'Elegí el tipo de factura.';
  for (const [index, l] of d.lines.entries()) {
    const name = i.lines[index]?.description ?? '';
    if (!l.description.trim()) return 'Completá la descripción de cada línea.';
    if (parseMoneyInput(l.price) === null) return `Completá el precio unitario de “${name}”.`;
    if (!l.vatRate) return `Revisá el IVA de “${name}”.`;
  }
  return null;
}

export function InvoiceDetailView({
  id,
  isAdmin,
  discarded,
}: {
  id: string;
  isAdmin: boolean;
  discarded: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ key: string; data?: InvoiceView; error?: string }>({
    key: '',
  });
  const key = id + ':' + revision;
  useEffect(() => {
    const controller = new AbortController();
    void catalogFetch(id, invoiceSchema, { scope: 'invoices', signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ key, error: humanError(e) });
      });
    return () => controller.abort();
  }, [id, key]);
  const [current, setCurrent] = useState<InvoiceView | null>(null);
  const loaded = result.key === key ? result.data : undefined;
  const invoice =
    current && current.id === id && (!loaded || current.version >= loaded.version)
      ? current
      : loaded;
  return (
    <>
      <Link href="/facturacion">← Facturación</Link>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Facturación</p>
          <h1>
            {invoice?.fiscal?.status === 'AUTHORIZED'
              ? 'Factura autorizada en homologación'
              : invoice?.status === 'READY'
                ? 'Factura lista para autorizar'
                : 'Borrador de factura'}
          </h1>
          {invoice && <p className="muted">{internalReference(invoice.id)}</p>}
        </div>
      </header>
      <Feedback
        loading={result.key !== key}
        error={result.key === key ? result.error : undefined}
        data={invoice}
        reload={() => setRevision((v) => v + 1)}
      />
      {invoice && (
        <InvoiceBody
          key={invoice.id + ':' + invoice.version}
          invoice={invoice}
          isAdmin={isAdmin}
          changed={(next) => setCurrent(next)}
          reload={() => {
            setCurrent(null);
            setRevision((v) => v + 1);
          }}
          discarded={discarded}
        />
      )}
    </>
  );
}

function InvoiceBody({
  invoice: i,
  isAdmin,
  changed,
  reload,
  discarded,
}: {
  invoice: InvoiceView;
  isAdmin: boolean;
  changed: (i: InvoiceView) => void;
  reload: () => void;
  discarded: () => void;
}) {
  const editable = isAdmin && i.status === 'DRAFT';
  const [d, setD] = useState(() => draftOf(i));
  const [problem, setProblem] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const mutation = useMutation();
  // One operation id per transition attempt: a retry after a lost response is replayed.
  const operation = useRef<{ version: number; id: string } | null>(null);
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(i));
  const previews = i.lines.map((l, index) =>
    editable ? previewLine(l.quantity, d.lines[index]!.price, d.lines[index]!.vatRate) : l,
  );
  const totals = invoiceTotals(
    previews.map((p) => ({ netAmount: p?.netAmount ?? null, vatAmount: p?.vatAmount ?? null })),
  );
  function setLine(index: number, change: Partial<Draft['lines'][number]>) {
    setProblem('');
    setD((v) => ({ ...v, lines: v.lines.map((l, n) => (n === index ? { ...l, ...change } : l)) }));
  }
  function body() {
    for (const l of d.lines)
      if (l.price.trim() && parseMoneyInput(l.price) === null)
        return 'Revisá el precio unitario: usá números con hasta 2 decimales, por ejemplo 1234,50.';
    return {
      expectedVersion: i.version,
      invoiceType: d.invoiceType,
      issueDate: d.issueDate,
      notes: d.notes.trim() || null,
      lines: d.lines.map((l) => ({
        id: l.id,
        description: l.description.trim(),
        unitPrice: parseMoneyInput(l.price),
        vatRate: l.vatRate,
      })),
    };
  }
  async function save() {
    const payload = body();
    if (typeof payload === 'string') {
      setProblem(payload);
      return undefined;
    }
    const saved = await mutation.run(() =>
      catalogFetch(i.id, invoiceSchema, { scope: 'invoices', method: 'PATCH', body: payload }),
    );
    if (saved) changed(saved);
    return saved;
  }
  async function transition(action: 'ready' | 'reopen') {
    let target = i;
    if (action === 'ready') {
      const missing = readyProblem(i, d);
      if (missing) {
        setProblem(missing);
        return;
      }
      if (dirty) {
        const saved = await save();
        if (!saved) return;
        target = saved;
      }
    }
    if (operation.current?.version !== target.version)
      operation.current = { version: target.version, id: crypto.randomUUID() };
    const next = await mutation.run(() =>
      catalogFetch(`${target.id}/${action}`, invoiceSchema, {
        scope: 'invoices',
        method: 'POST',
        body: { expectedVersion: target.version, operationId: operation.current!.id },
      }),
    );
    if (next) changed(next);
  }
  async function discard() {
    const done = await mutation.run(() =>
      catalogFetch(`${i.id}/discard`, invoiceDiscardedSchema, {
        scope: 'invoices',
        method: 'POST',
        body: { expectedVersion: i.version },
      }),
    );
    if (done) discarded();
  }
  return (
    <>
      {i.status === 'READY' ? (
        i.fiscal ? null : (
          <p className="catalog-notice" role="status">
            <strong>Lista para autorizar.</strong> Validada internamente en MaxBio. Todavía no fue
            enviada ni autorizada por ARCA: no tiene CAE ni validez fiscal. Integración ARCA
            pendiente.
          </p>
        )
      ) : (
        <p className="catalog-notice">
          Borrador interno. Completá precio e IVA de cada línea y revisá los totales.
        </p>
      )}
      {i.fiscal && (
        <InvoiceFiscalPanel invoice={i} isAdmin={isAdmin} changed={changed} reload={reload} />
      )}
      <section className="catalog-panel">
        <h2>Cliente</h2>
        <p>
          <Link href={'/clientes/' + i.customer.id}>{i.customer.name}</Link>
          {i.customer.cuit ? ' · CUIT ' + i.customer.cuit : ' · Sin CUIT'}
          {i.customer.taxConditionText ? ' · ' + i.customer.taxConditionText : ''}
        </p>
        {i.status === 'READY' && (
          <p className="muted">Datos del cliente congelados al marcarla lista.</p>
        )}
        <h2>Remitos incluidos</h2>
        <ul>
          {i.deliveryNotes.map((r) => (
            <li key={r.id}>
              Remito {r.number} · {displayDate(r.documentDate)} ·{' '}
              <Link href={'/remitos/' + r.id}>Ver Remito</Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="catalog-panel">
        <h2>Datos de la factura</h2>
        {editable ? (
          <>
            <Field label="Tipo de factura">
              <select
                value={d.invoiceType ?? ''}
                onChange={(event) =>
                  setD((v) => ({
                    ...v,
                    invoiceType: event.target.value
                      ? invoiceTypeSchema.parse(event.target.value)
                      : null,
                  }))
                }
              >
                <option value="">Elegí el tipo</option>
                {invoiceTypeSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {invoiceTypeLabels[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Fecha de la factura">
              <input
                type="date"
                value={d.issueDate}
                onChange={(event) => setD((v) => ({ ...v, issueDate: event.target.value }))}
              />
            </Field>
            <Field label="Observaciones">
              <textarea
                maxLength={1000}
                value={d.notes}
                onChange={(event) => setD((v) => ({ ...v, notes: event.target.value }))}
              />
            </Field>
            <Field label="IVA para todas las líneas">
              <select
                value=""
                onChange={(event) => {
                  const rate = invoiceVatRateSchema.parse(event.target.value);
                  setD((v) => ({ ...v, lines: v.lines.map((l) => ({ ...l, vatRate: rate })) }));
                }}
              >
                <option value="">Elegí para aplicar a todas</option>
                {invoiceVatRateSchema.options.map((r) => (
                  <option key={r} value={r}>
                    {invoiceVatRateLabels[r]}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <dl className="data-grid">
            <div>
              <dt>Tipo</dt>
              <dd>{i.invoiceType ? invoiceTypeLabels[i.invoiceType] : 'Sin elegir'}</dd>
            </div>
            <div>
              <dt>Fecha</dt>
              <dd>{displayDate(i.issueDate)}</dd>
            </div>
            <div>
              <dt>Estado</dt>
              <dd>{invoiceStatusLabels[i.status]}</dd>
            </div>
            {i.notes && (
              <div>
                <dt>Observaciones</dt>
                <dd>{i.notes}</dd>
              </div>
            )}
          </dl>
        )}
      </section>
      <section className="catalog-panel" aria-label="Líneas de la factura">
        <h2>Líneas</h2>
        <p className="muted">Productos y cantidades salen de los Remitos y no se modifican.</p>
        <div className="reference-table-scroll">
          <table className="reference-table">
            <thead>
              <tr>
                <th>Producto / descripción</th>
                <th>Cantidad</th>
                <th>Precio unitario</th>
                <th>IVA</th>
                <th>Neto</th>
                <th>IVA $</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {i.lines.map((l, index) => {
                const line = d.lines[index]!;
                const p = previews[index];
                return (
                  <tr key={l.id}>
                    <td>
                      {editable ? (
                        <input
                          aria-label={'Descripción de ' + l.productName}
                          maxLength={500}
                          value={line.description}
                          onChange={(event) => setLine(index, { description: event.target.value })}
                        />
                      ) : (
                        l.description
                      )}
                      <br />
                      <small className="muted">
                        {l.productName}
                        {l.presentation ? ' · ' + l.presentation : ''}
                      </small>
                    </td>
                    <td>
                      {l.quantity} {quantityLabels[l.unitOfMeasure]}
                    </td>
                    <td>
                      {editable ? (
                        <input
                          aria-label={'Precio unitario de ' + l.productName}
                          inputMode="decimal"
                          placeholder="0,00"
                          value={line.price}
                          onChange={(event) => setLine(index, { price: event.target.value })}
                        />
                      ) : l.unitPrice ? (
                        formatMoney(l.unitPrice)
                      ) : (
                        'Sin precio'
                      )}
                    </td>
                    <td>
                      {editable ? (
                        <select
                          aria-label={'IVA de ' + l.productName}
                          value={line.vatRate ?? ''}
                          onChange={(event) =>
                            setLine(index, {
                              vatRate: event.target.value
                                ? invoiceVatRateSchema.parse(event.target.value)
                                : null,
                            })
                          }
                        >
                          <option value="">Elegí</option>
                          {invoiceVatRateSchema.options.map((r) => (
                            <option key={r} value={r}>
                              {invoiceVatRateLabels[r]}
                            </option>
                          ))}
                        </select>
                      ) : l.vatRate ? (
                        invoiceVatRateLabels[l.vatRate]
                      ) : (
                        'Sin IVA elegido'
                      )}
                    </td>
                    <td>{p?.netAmount ? formatMoney(p.netAmount) : '—'}</td>
                    <td>{p?.vatAmount ? formatMoney(p.vatAmount) : '—'}</td>
                    <td>{p?.totalAmount ? formatMoney(p.totalAmount) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="data-grid" aria-label="Resumen">
          <div>
            <dt>Neto</dt>
            <dd>{formatMoney(totals.netAmount)}</dd>
          </div>
          <div>
            <dt>IVA</dt>
            <dd>{formatMoney(totals.vatAmount)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd>
              <strong>{formatMoney(totals.totalAmount)}</strong>
            </dd>
          </div>
        </dl>
        {!totals.complete && <p className="muted">Faltan precios o IVA en algunas líneas.</p>}
      </section>
      {problem && (
        <p className="catalog-error" role="alert">
          {problem}
        </p>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
      {editable && (
        <div className="actions">
          <button
            type="button"
            className="secondary-button"
            disabled={mutation.busy || !dirty}
            onClick={() => void save()}
          >
            Guardar borrador
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={mutation.busy}
            onClick={() => void transition('ready')}
          >
            {dirty ? 'Guardar y marcar lista para autorizar' : 'Marcar lista para autorizar'}
          </button>
          {confirmDiscard ? (
            <>
              <span>¿Descartar este borrador? Los Remitos vuelven a Pendientes.</span>
              <button
                type="button"
                className="secondary-button"
                disabled={mutation.busy}
                onClick={() => void discard()}
              >
                Confirmar descarte
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => setConfirmDiscard(false)}
              >
                Cancelar
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-button"
              hidden={Boolean(i.fiscal?.attempts.length)}
              onClick={() => setConfirmDiscard(true)}
            >
              Descartar borrador
            </button>
          )}
        </div>
      )}
      {isAdmin &&
        i.status === 'READY' &&
        (!i.fiscal || ['NOT_SUBMITTED', 'REJECTED'].includes(i.fiscal.status)) && (
          <div className="actions">
            <button
              type="button"
              className="secondary-button"
              disabled={mutation.busy}
              onClick={() => void transition('reopen')}
            >
              {i.fiscal?.status === 'REJECTED' ? 'Corregir factura' : 'Volver a borrador'}
            </button>
          </div>
        )}
      {!isAdmin && <p className="muted">Solo un administrador puede modificar facturas.</p>}
      <section className="catalog-panel">
        <h2>Historial</h2>
        <ul>
          {i.history.map((h, n) => (
            <li key={n}>
              {invoiceHistoryLabels[h.action]} · {new Date(h.at).toLocaleString('es-AR')}
              {h.actor ? ' · ' + h.actor : ''}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

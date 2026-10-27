'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  invoiceListSchema,
  invoicePendingListSchema,
  invoiceSchema,
  invoiceStatusLabels,
  invoiceTypeLabels,
  type InvoiceList,
  type InvoicePendingList,
} from '@maxbio/contracts';
import { catalogFetch, humanError } from '../../lib/catalog-api.ts';
import { displayDate } from '../../lib/traceability.ts';
import { formatMoney, toggleSelection, type PendingSelection } from '../../lib/invoicing.ts';
import { Feedback, Field, Pagination, useMutation } from '../catalog/common.tsx';
import { FilterChoice } from '../traceability/traceability.tsx';

type Filters = {
  search: string;
  customerId: string;
  dateFrom: string;
  dateTo: string;
  page: number;
};
const empty: Filters = { search: '', customerId: '', dateFrom: '', dateTo: '', page: 1 };
const query = (f: Filters, extra: Record<string, string> = {}) => {
  const q = new URLSearchParams();
  for (const key of ['search', 'customerId', 'dateFrom', 'dateTo'] as const)
    if (f[key]) q.set(key, f[key]);
  for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
  if (f.page > 1) q.set('page', String(f.page));
  return q.toString();
};

const withQuery = (path: string, q: string) => (q ? path + '?' + q : path);
function useList<T>(path: string, schema: { parse(input: unknown): T }) {
  const [revision, setRevision] = useState(0);
  const key = path + ':' + revision;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  useEffect(() => {
    const controller = new AbortController();
    void catalogFetch(path, schema, { scope: 'invoices', signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ key, error: humanError(e) });
      });
    return () => controller.abort();
  }, [key, path, schema]);
  return {
    data: result.key === key ? result.data : undefined,
    loading: result.key !== key,
    error: result.key === key ? result.error : undefined,
    reload: () => setRevision((v) => v + 1),
  };
}

export function BillingView({
  isAdmin,
  open,
}: {
  isAdmin: boolean;
  open: (invoiceId: string) => void;
}) {
  const [tab, setTab] = useState<'pending' | 'invoices'>('pending');
  return (
    <>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1>Facturación</h1>
          <p>
            Elegí Remitos confirmados, completá precios e IVA y dejá la factura lista para
            autorizar.
          </p>
        </div>
      </header>
      <p className="catalog-notice">
        Facturas internas de MaxBio. Todavía no se envían a ARCA: no tienen CAE ni validez fiscal.
      </p>
      <div className="actions" role="tablist" aria-label="Secciones de facturación">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'pending'}
          className={tab === 'pending' ? 'primary-button' : 'secondary-button'}
          onClick={() => setTab('pending')}
        >
          Pendientes de facturar
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'invoices'}
          className={tab === 'invoices' ? 'primary-button' : 'secondary-button'}
          onClick={() => setTab('invoices')}
        >
          Facturas
        </button>
      </div>
      {tab === 'pending' ? <Pending isAdmin={isAdmin} open={open} /> : <Invoices />}
    </>
  );
}

function FiltersForm({
  filters,
  change,
  placeholder,
  customer,
}: {
  filters: Filters;
  change: (f: Partial<Filters>) => void;
  placeholder: string;
  customer: { id: string; name: string } | null;
}) {
  const [draft, setDraft] = useState(filters.search);
  function submit(event: FormEvent) {
    event.preventDefault();
    change({ search: draft.trim() });
  }
  return (
    <>
      <form className="search-bar" role="search" onSubmit={submit}>
        <div>
          <label htmlFor="billing-search">Buscar</label>
          <input
            id="billing-search"
            type="search"
            maxLength={128}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
          />
        </div>
        <button type="submit" className="primary-button">
          Buscar
        </button>
      </form>
      <details className="form-details">
        <summary>Más filtros</summary>
        <FilterChoice
          label="Cliente"
          kind="customers"
          value={
            filters.customerId
              ? (customer ?? { id: filters.customerId, name: 'Cliente elegido' })
              : null
          }
          change={(v) => change({ customerId: v?.id ?? '' })}
        />
        <Field label="Fecha desde">
          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) => change({ dateFrom: event.target.value })}
          />
        </Field>
        <Field label="Fecha hasta">
          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) => change({ dateTo: event.target.value })}
          />
        </Field>
      </details>
    </>
  );
}

function Pending({ isAdmin, open }: { isAdmin: boolean; open: (invoiceId: string) => void }) {
  const [filters, setFilters] = useState(empty);
  const [chosenCustomer, setChosenCustomer] = useState<{ id: string; name: string } | null>(null);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [warning, setWarning] = useState('');
  const resource = useList(
    withQuery('pending-delivery-notes', query(filters)),
    invoicePendingListSchema,
  );
  const mutation = useMutation();
  // Same id for retries of one selection: a double click never creates two invoices.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const data: InvoicePendingList | undefined = resource.data;
  function change(next: Partial<Filters>) {
    setFilters((f) => ({ ...f, page: 1, ...next }));
  }
  function toggle(note: InvoicePendingList['items'][number]) {
    const next = toggleSelection(selection, note);
    if (next === 'OTHER_CUSTOMER') {
      setWarning('Los Remitos seleccionados pertenecen a clientes distintos.');
      return;
    }
    setWarning('');
    setSelection(next);
  }
  async function create() {
    if (!selection) return;
    const key = [...selection.ids].sort().join(',');
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    const created = await mutation.run(() =>
      catalogFetch('', invoiceSchema, {
        scope: 'invoices',
        method: 'POST',
        body: { id: attempt.current!.id, deliveryNoteIds: selection.ids },
      }),
    );
    if (created) open(created.id);
    else resource.reload();
  }
  return (
    <section className="catalog-panel" aria-label="Pendientes de facturar">
      <h2>Pendientes de facturar</h2>
      <p>
        Remitos confirmados que todavía no están en ninguna factura. Elegí uno o varios del mismo
        cliente.
      </p>
      <FiltersForm
        filters={filters}
        change={(next) => {
          if (next.customerId !== undefined) setChosenCustomer(null);
          change(next);
        }}
        placeholder="Número de remito o cliente"
        customer={chosenCustomer ?? data?.customer ?? null}
      />
      {selection && (
        <div className="catalog-notice" role="status">
          <p>
            <strong>
              {selection.ids.length}{' '}
              {selection.ids.length === 1 ? 'Remito seleccionado' : 'Remitos seleccionados'}
            </strong>{' '}
            · Cliente {selection.customerName}
          </p>
          {isAdmin ? (
            <div className="actions">
              <button
                type="button"
                className="primary-button"
                disabled={mutation.busy}
                onClick={() => void create()}
              >
                {mutation.busy ? 'Creando…' : 'Crear factura'}
              </button>
              <button type="button" className="secondary-button" onClick={() => setSelection(null)}>
                Quitar selección
              </button>
            </div>
          ) : (
            <p>Solo un administrador puede crear facturas.</p>
          )}
        </div>
      )}
      {warning && (
        <p className="catalog-error" role="alert">
          {warning}
        </p>
      )}
      <Feedback error={mutation.error} />
      <Feedback {...resource} />
      {data &&
        (data.items.length ? (
          <div className="reference-table-scroll">
            <table className="reference-table">
              <thead>
                <tr>
                  <th>Elegir</th>
                  <th>Fecha</th>
                  <th>Remito</th>
                  <th>Cliente</th>
                  <th>Líneas</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((d) => {
                  const other = Boolean(selection && selection.customerId !== d.customer.id);
                  return (
                    <tr key={d.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={'Elegir Remito ' + d.number}
                          checked={selection?.ids.includes(d.id) ?? false}
                          disabled={other}
                          title={other ? 'Pertenece a otro cliente' : undefined}
                          onChange={() => toggle(d)}
                        />
                      </td>
                      <td>{displayDate(d.documentDate)}</td>
                      <td>
                        <Link href={'/remitos/' + d.id}>{d.number}</Link>
                      </td>
                      <td>
                        {d.customer.name}
                        {d.patientLinked && (
                          <>
                            <br />
                            <small className="muted">Paciente/Afiliado asociado</small>
                          </>
                        )}
                      </td>
                      <td>{d.lineCount}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p role="status">No hay Remitos pendientes de facturar.</p>
        ))}
      {data && data.total > 0 && (
        <Pagination {...data} change={(page) => setFilters((f) => ({ ...f, page }))} />
      )}
    </section>
  );
}

function Invoices() {
  const [filters, setFilters] = useState(empty);
  const [status, setStatus] = useState('');
  const resource = useList(withQuery('', query(filters, { status })), invoiceListSchema);
  const data: InvoiceList | undefined = resource.data;
  return (
    <section className="catalog-panel" aria-label="Facturas">
      <h2>Facturas</h2>
      <FiltersForm
        filters={filters}
        change={(next) => setFilters((f) => ({ ...f, page: 1, ...next }))}
        placeholder="Número de remito o cliente"
        customer={data?.customer ?? null}
      />
      <Field label="Estado">
        <select
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setFilters((f) => ({ ...f, page: 1 }));
          }}
        >
          <option value="">Todos</option>
          <option value="DRAFT">{invoiceStatusLabels.DRAFT}</option>
          <option value="READY">{invoiceStatusLabels.READY}</option>
        </select>
      </Field>
      <Feedback {...resource} />
      {data &&
        (data.items.length ? (
          <div className="reference-table-scroll">
            <table className="reference-table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Cliente</th>
                  <th>Remitos</th>
                  <th>Tipo</th>
                  <th>Estado</th>
                  <th>Total</th>
                  <th>Factura</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.id}>
                    <td>{displayDate(i.issueDate)}</td>
                    <td>{i.customer.name}</td>
                    <td>{i.deliveryNoteNumbers.join(', ')}</td>
                    <td>{i.invoiceType ? invoiceTypeLabels[i.invoiceType] : 'Sin elegir'}</td>
                    <td>
                      <span className={'status-tag' + (i.status === 'DRAFT' ? ' archived' : '')}>
                        {invoiceStatusLabels[i.status]}
                      </span>
                    </td>
                    <td>
                      {formatMoney(i.totalAmount)}
                      {!i.complete && (
                        <>
                          <br />
                          <small className="muted">Faltan precios o IVA</small>
                        </>
                      )}
                    </td>
                    <td>
                      <Link href={'/facturacion/' + i.id}>
                        {i.status === 'DRAFT' ? 'Abrir borrador' : 'Ver factura'}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p role="status">Todavía no hay facturas.</p>
        ))}
      {data && data.total > 0 && (
        <Pagination {...data} change={(page) => setFilters((f) => ({ ...f, page }))} />
      )}
    </section>
  );
}

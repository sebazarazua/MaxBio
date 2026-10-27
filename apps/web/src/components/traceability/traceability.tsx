'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  customerListSchema,
  productListSchema,
  quantityLabels,
  traceabilityDetailSchema,
  traceabilityListSchema,
  traceabilitySourceLabels,
  type TraceabilityDetail,
  type TraceabilityItem,
  type TraceabilityList,
} from '@maxbio/contracts';
import { catalogFetch, humanError } from '../../lib/catalog-api.ts';
import {
  displayDate,
  emptyTraceabilityParams,
  hasTraceabilityCriteria,
  traceabilityQuery,
  type TraceabilityParams,
} from '../../lib/traceability.ts';
import { Feedback, Field, Pagination } from '../catalog/common.tsx';
import { useWorkspace } from '../workspace.tsx';

type Choice = { id: string; name: string };
const captureLabels = { GS1: 'Escaneado', MANUAL: 'Manual', LEGACY: 'Histórico' } as const;

export function TraceabilitySearch({ initial }: { initial: TraceabilityParams }) {
  const { isAdmin } = useWorkspace();
  return <TraceabilityView initial={initial} isAdmin={isAdmin} />;
}

export function TraceabilityView({
  initial,
  isAdmin,
}: {
  initial: TraceabilityParams;
  isAdmin: boolean;
}) {
  const [params, setParams] = useState(initial);
  const [draft, setDraft] = useState(initial.search);
  const [chosen, setChosen] = useState<{ product?: Choice; customer?: Choice }>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const query = traceabilityQuery(params);
  const key = query + ':' + revision;
  const [result, setResult] = useState<{ key: string; data?: TraceabilityList; error?: string }>({
    key: '',
  });
  useEffect(() => {
    // The URL keeps the filters for "volver atrás" and links from Product/Remito.
    window.history.replaceState(null, '', '/trazabilidad' + (query ? '?' + query : ''));
    const controller = new AbortController();
    void catalogFetch(query ? '?' + query : '', traceabilityListSchema, {
      scope: 'traceability',
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ key, data });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ key, error: humanError(e) });
      });
    return () => controller.abort();
  }, [key, query]);
  const data = result.key === key ? result.data : undefined;
  const loading = result.key !== key;
  const error = result.key === key ? result.error : undefined;
  function apply(next: Partial<TraceabilityParams>) {
    setSelected(null);
    setParams((p) => ({ ...p, page: 1, ...next }));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    apply({ search: draft.trim() });
  }
  function clear() {
    setDraft('');
    setChosen({});
    apply(emptyTraceabilityParams);
  }
  const product =
    chosen.product?.id === params.productId ? chosen.product : (data?.filters.product ?? null);
  const customer =
    chosen.customer?.id === params.customerId ? chosen.customer : (data?.filters.customer ?? null);
  const filtered = Boolean(
    params.productId || params.customerId || params.source || params.dateFrom || params.dateTo,
  );
  return (
    <>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1>Trazabilidad</h1>
          <p>Buscá por producto, lote, serie, cliente o remito.</p>
        </div>
      </header>
      <form className="search-bar" role="search" onSubmit={submit}>
        <div>
          <label htmlFor="traceability-search">Buscar</label>
          <input
            id="traceability-search"
            type="search"
            maxLength={128}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Serie, lote, número de remito, producto o cliente"
          />
        </div>
        <button type="submit" className="primary-button">
          Buscar
        </button>
      </form>
      <details className="form-details" open={filtered || undefined}>
        <summary>Más filtros</summary>
        <FilterChoice
          label="Producto"
          kind="products"
          value={
            params.productId
              ? (product ?? { id: params.productId, name: 'Producto elegido' })
              : null
          }
          change={(v) => {
            setChosen((c) => ({ ...c, product: v ?? undefined }));
            apply({ productId: v?.id ?? '' });
          }}
        />
        <FilterChoice
          label="Cliente"
          kind="customers"
          value={
            params.customerId
              ? (customer ?? { id: params.customerId, name: 'Cliente elegido' })
              : null
          }
          change={(v) => {
            setChosen((c) => ({ ...c, customer: v ?? undefined }));
            apply({ customerId: v?.id ?? '' });
          }}
        />
        <Field label="Fecha del remito desde">
          <input
            type="date"
            value={params.dateFrom}
            max={params.dateTo || undefined}
            onChange={(event) => apply({ dateFrom: event.target.value })}
          />
        </Field>
        <Field label="Fecha del remito hasta">
          <input
            type="date"
            value={params.dateTo}
            min={params.dateFrom || undefined}
            onChange={(event) => apply({ dateTo: event.target.value })}
          />
        </Field>
        <Field label="Origen">
          <select
            value={params.source}
            onChange={(event) =>
              apply({ source: event.target.value as TraceabilityParams['source'] })
            }
          >
            <option value="">Todos</option>
            <option value="STOCK">{traceabilitySourceLabels.STOCK}</option>
            <option value="DOCUMENTARY">{traceabilitySourceLabels.DOCUMENTARY}</option>
          </select>
        </Field>
      </details>
      {hasTraceabilityCriteria(params) && (
        <p>
          <button type="button" className="secondary-button" onClick={clear}>
            Limpiar filtros
          </button>
        </p>
      )}
      <Feedback
        loading={loading}
        error={error}
        data={data}
        reload={() => setRevision((v) => v + 1)}
      />
      {data && (
        <section className="catalog-panel" aria-label="Resultados de trazabilidad">
          <h2>{hasTraceabilityCriteria(params) ? 'Resultados' : 'Registros más recientes'}</h2>
          {data.total > 0 && (
            <p role="status">
              {data.total} {data.total === 1 ? 'registro encontrado' : 'registros encontrados'}
              {data.match === 'EXACT' && ' · Coincidencia exacta de serie, lote, remito o GTIN.'}
              {data.match === 'TEXT' &&
                ' · Sin coincidencia exacta de serie, lote o remito: mostramos coincidencias por producto, cliente o lote.'}
            </p>
          )}
          {selected && (
            <TraceDetail id={selected} isAdmin={isAdmin} close={() => setSelected(null)} />
          )}
          {data.items.length > 0 ? (
            <div className="reference-table-scroll">
              <table className="reference-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Producto</th>
                    <th>Lote y vencimiento</th>
                    <th>Serie</th>
                    <th>Cantidad</th>
                    <th>Cliente</th>
                    <th>Remito</th>
                    <th>Origen</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((t) => (
                    <TraceRow
                      key={t.traceId}
                      trace={t}
                      selected={t.traceId === selected}
                      open={() => setSelected(t.traceId)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div role="status">
              <p>
                <strong>No encontramos trazabilidad con estos filtros.</strong>
              </p>
              <p>
                Revisá que la serie o el lote estén escritos exactamente como figuran en el Remito,
                o limpiá los filtros.
              </p>
            </div>
          )}
          {data.total > 0 && (
            <Pagination
              {...data}
              change={(page) => {
                setSelected(null);
                setParams((p) => ({ ...p, page }));
              }}
            />
          )}
        </section>
      )}
    </>
  );
}

function SourceTag({ source }: { source: TraceabilityItem['source'] }) {
  return (
    <span className={'status-tag' + (source === 'DOCUMENTARY' ? ' archived' : '')}>
      {traceabilitySourceLabels[source]}
    </span>
  );
}

function TraceRow({
  trace: t,
  selected,
  open,
}: {
  trace: TraceabilityItem;
  selected: boolean;
  open: () => void;
}) {
  return (
    <tr aria-selected={selected}>
      <td>{displayDate(t.deliveryNote.documentDate)}</td>
      <td>
        {t.product.name}
        {t.product.presentation && <small className="muted"> · {t.product.presentation}</small>}
      </td>
      <td>
        {t.lotNumber ? 'Lote ' + t.lotNumber : 'Sin lote'}
        {t.expirationDate && (
          <>
            <br />
            <small>Vence {displayDate(t.expirationDate)}</small>
          </>
        )}
      </td>
      <td>{t.serialNumber ?? '—'}</td>
      <td>
        {t.quantity} {quantityLabels[t.product.unitOfMeasure]}
      </td>
      <td>
        {t.customer.name}
        {t.patientLinked && (
          <>
            <br />
            <small className="muted">Paciente/Afiliado asociado</small>
          </>
        )}
      </td>
      <td>
        <Link href={'/remitos/' + t.deliveryNote.id}>{t.deliveryNote.number}</Link>
      </td>
      <td>
        <SourceTag source={t.source} />
      </td>
      <td>
        <button type="button" className="text-button" onClick={open}>
          Ver detalle
        </button>
      </td>
    </tr>
  );
}

function TraceDetail({ id, isAdmin, close }: { id: string; isAdmin: boolean; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ id: string; data?: TraceabilityDetail; error?: string }>({
    id: '',
  });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void catalogFetch(id, traceabilityDetailSchema, {
      scope: 'traceability',
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setResult({ id, data });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ id, error: humanError(e) });
      });
    return () => controller.abort();
  }, [id, revision]);
  useEffect(() => panel.current?.scrollIntoView?.({ block: 'nearest' }), [id]);
  const d = result.id === id ? result.data : undefined;
  const rows: [string, string | null][] = d
    ? [
        [
          'Producto',
          d.product.name + (d.product.presentation ? ' · ' + d.product.presentation : ''),
        ],
        [
          'Cantidad trazada',
          `${d.quantity} ${quantityLabels[d.product.unitOfMeasure]} (de ${d.documentQuantity} en el Remito)`,
        ],
        ['Lote', d.lotNumber ?? 'Sin lote'],
        ['Vencimiento', d.expirationDate ? displayDate(d.expirationDate) : 'Sin vencimiento'],
        ['Serie', d.serialNumber ?? 'Sin serie'],
        ['Remito', d.deliveryNote.number],
        ['Fecha del remito', displayDate(d.deliveryNote.documentDate)],
        ['Confirmado', new Date(d.deliveryNote.confirmedAt).toLocaleString('es-AR')],
        ['Cliente', d.customer.name],
        ['Paciente', d.patientName],
        ['N.º de afiliado', d.affiliateNumber],
        ['GTIN escaneado', d.scannedGtin],
        ['Origen de captura', d.captureMethod && isAdmin ? captureLabels[d.captureMethod] : null],
      ]
    : [];
  return (
    <div className="catalog-notice" ref={panel} role="region" aria-label="Detalle de trazabilidad">
      <h3>Detalle de trazabilidad</h3>
      <Feedback
        loading={result.id !== id}
        error={result.id === id ? result.error : undefined}
        reload={() => setRevision((v) => v + 1)}
      />
      {d && (
        <>
          <dl className="data-grid">
            {rows
              .filter((r): r is [string, string] => r[1] !== null)
              .map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
          {d.source === 'STOCK' ? (
            <div>
              <p>
                <SourceTag source="STOCK" />
              </p>
              <p>Esta cantidad salió del Stock registrado en MaxBio al confirmar el Remito.</p>
              {d.stock && (
                <p>
                  Ubicación de salida: {d.stock.location.name} ·{' '}
                  <Link href={'/stock/' + d.product.id + '#movimiento-' + d.stock.movementId}>
                    Ver movimiento de stock
                  </Link>
                </p>
              )}
            </div>
          ) : (
            <div>
              <p>
                <strong>Registrado solo en el Remito</strong>
              </p>
              <p>
                Estos datos fueron documentados en el Remito y no representan una salida registrada
                en Stock.
              </p>
            </div>
          )}
          <div className="actions">
            <Link className="primary-button" href={'/remitos/' + d.deliveryNote.id}>
              Ver Remito
            </Link>
            <Link className="secondary-button" href={'/productos/' + d.product.id}>
              Ver producto
            </Link>
            <button type="button" className="secondary-button" onClick={close}>
              Cerrar detalle
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// Picks a filter value with the existing catalog/customer searches; the trace query only gets the id.
export function FilterChoice({
  label,
  kind,
  value,
  change,
}: {
  label: string;
  kind: 'products' | 'customers';
  value: Choice | null;
  change: (value: Choice | null) => void;
}) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ q: string; items?: Choice[]; error?: string }>({ q: '' });
  const q = useDebounced(text.trim());
  useEffect(() => {
    if (!q) return;
    const controller = new AbortController();
    const search = new URLSearchParams({ q, limit: '8', includeArchived: 'true' }).toString();
    const request =
      kind === 'products'
        ? catalogFetch('products?' + search, productListSchema, { signal: controller.signal })
        : catalogFetch('?' + search, customerListSchema, {
            scope: 'customers',
            signal: controller.signal,
          });
    void request
      .then((data) => {
        if (!controller.signal.aborted)
          setResult({ q, items: data.items.map((i) => ({ id: i.id, name: i.name })) });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setResult({ q, error: humanError(e) });
      });
    return () => controller.abort();
  }, [q, kind]);
  if (value)
    return (
      <p>
        {label}: <strong>{value.name}</strong>{' '}
        <button type="button" className="text-button" onClick={() => change(null)}>
          Quitar {label.toLocaleLowerCase('es')}
        </button>
      </p>
    );
  const current = q && result.q === q ? result : undefined;
  return (
    <div className="choice-field">
      <Field label={'Buscar ' + label.toLocaleLowerCase('es')}>
        <input
          type="search"
          maxLength={128}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </Field>
      <Feedback loading={Boolean(q) && !current} error={current?.error} />
      {current?.items && (
        <div className="actions">
          {current.items.map((item) => (
            <button
              type="button"
              className="secondary-button"
              key={item.id}
              onClick={() => {
                setText('');
                change(item);
              }}
            >
              {item.name}
            </button>
          ))}
          {!current.items.length && <p>No encontramos coincidencias.</p>}
        </div>
      )}
    </div>
  );
}

function useDebounced(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

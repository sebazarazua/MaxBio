'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  customerListSchema,
  productListSchema,
  scanResultSchema,
  deliveryNoteSchema,
  deliveryNoteCreateSchema,
  deliveryNoteUpdateSchema,
  inventoryStockDetailSchema,
  type DeliveryNoteView,
  type DeliveryNoteCreate,
  type ProductView,
  type InventoryStockDetail,
} from '@maxbio/contracts';
import { catalogFetch, CatalogHttpError, humanError } from '@/lib/catalog-api';
import {
  Feedback,
  Field,
  Pagination,
  EntityChoice,
  useResource,
  useSearch,
} from '../catalog/common';
import { documentLabels, quantityLabels } from '../inventory/common';
import { useWorkspace } from '../workspace';
type Line = DeliveryNoteCreate['lines'][number] & {
  productName: string;
  unitOfMeasure: ProductView['unitOfMeasure'];
  presentation: string | null;
  physical: DeliveryNoteView['lines'][number]['allocations'];
};
type Customer = DeliveryNoteView['customer'];
const fetchNote = (path: string, options: Parameters<typeof catalogFetch>[2] = {}) =>
  catalogFetch(path, deliveryNoteSchema, { ...options, scope: 'delivery-notes' });

function CustomerChoice({
  selected,
  change,
}: {
  selected: Customer | null;
  change: (c: Customer) => void;
}) {
  const search = useSearch();
  const result = useResource('?' + search.query, customerListSchema, 'customers');
  return (
    <div>
      <Field label="Buscar cliente">
        <input
          type="search"
          maxLength={128}
          value={search.search}
          onChange={(e) => search.setSearch(e.target.value)}
        />
      </Field>
      {selected && (
        <p>
          <strong>{selected.name}</strong> ·{' '}
          {selected.kind === 'HEALTH_INSURER' ? 'Obra social' : 'Cliente'}{' '}
          {selected.cuit ? '· CUIT ' + selected.cuit : ''}
        </p>
      )}
      <Feedback {...result} reload={result.reload} />
      <ul className="delivery-choices">
        {result.data?.items.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => change(c)}
              aria-pressed={selected?.id === c.id}
            >
              {c.name}
              {c.cuit ? ' · ' + c.cuit : ''}
            </button>
          </li>
        ))}
      </ul>
      {result.data && <Pagination {...result.data} change={search.setPage} />}
    </div>
  );
}

function StockChoice({
  productId,
  value,
  change,
}: {
  productId: string;
  value: Line;
  change: (l: Line) => void;
}) {
  const [page, setPage] = useState(1);
  const result = useResource(
    `products/${productId}?page=${page}`,
    inventoryStockDetailSchema,
    'inventory',
  );
  const d = result.data;
  function select(p: InventoryStockDetail['positions'][number], qty: string) {
    const allocations = value.allocations.filter((a) => a.positionId !== p.id);
    const physical = value.physical.filter((a) => a.positionId !== p.id);
    if (qty && qty !== '0') {
      allocations.push({ positionId: p.id, quantity: qty.replace(',', '.') });
      physical.push({
        id: p.id,
        positionId: p.id,
        quantity: qty.replace(',', '.'),
        location: p.location,
        lotId: p.lotId,
        lotNumber: p.lotNumber,
        expirationDate: p.expirationDate,
        serialId: null,
        serialNumber: p.serialNumber,
        condition: p.condition,
      });
    }
    change({ ...value, allocations, physical });
  }
  return (
    <div>
      <Feedback {...result} reload={result.reload} />
      {d && (
        <>
          <p>
            Disponible:{' '}
            <strong>
              {d.summary.available} {quantityLabels[d.summary.product.unitOfMeasure]}
            </strong>
            . La selección no reserva stock.
          </p>
          {!d.policy && (
            <p role="alert">
              Un administrador debe revisar los datos físicos del producto antes de confirmar.
            </p>
          )}
          {d.summary.countInProgress && (
            <p role="alert">Producto en conteo. Esperá a que termine antes de confirmar.</p>
          )}
          {d.summary.available === '0' && <p>Sin stock disponible</p>}
          <p>
            Existencias ordenadas por vencimiento. Elegí el lote o la serie que tenés físicamente.
          </p>
          {d.positions.map((p) => {
            const eligible = !p.expired && p.condition === 'USABLE' && !d.summary.countInProgress;
            const a = value.allocations.find((a) => a.positionId === p.id);
            return (
              <div className="delivery-position" key={p.id}>
                <p>
                  {page === 1 &&
                  p.id === d.positions.find((p) => !p.expired && p.condition === 'USABLE')?.id &&
                  eligible
                    ? 'Sugerido: '
                    : ''}
                  {p.lotNumber ? 'Lote ' + p.lotNumber : 'Sin número de lote'} ·{' '}
                  {p.expirationDate
                    ? 'vence ' + p.expirationDate.split('-').reverse().join('/')
                    : 'Sin vencimiento'}
                  {p.serialNumber ? ' · Serie ' + p.serialNumber : ''}
                  <br />
                  {p.location.name} · Disponible en esta existencia: {eligible ? p.quantity : '0'}
                </p>
                {!eligible ? (
                  <p>
                    {p.expired
                      ? 'Vencido · no disponible para salida'
                      : 'No disponible para salida'}
                  </p>
                ) : p.serialNumber ? (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={Boolean(a)}
                      onChange={(e) => select(p, e.target.checked ? '1' : '')}
                    />{' '}
                    Elegir serie {p.serialNumber}
                  </label>
                ) : (
                  <Field
                    label={
                      'Cantidad de ' + (p.lotNumber ? 'lote ' + p.lotNumber : 'esta existencia')
                    }
                  >
                    <input
                      inputMode="decimal"
                      value={a?.quantity ?? ''}
                      onChange={(e) => select(p, e.target.value)}
                      placeholder="0"
                    />
                  </Field>
                )}
                {!eligible && a && (
                  <button type="button" className="text-button" onClick={() => select(p, '')}>
                    Quitar selección
                  </button>
                )}
              </div>
            );
          })}
          <Pagination {...d} change={setPage} />
          {value.allocations.length > 0 && (
            <div>
              <p>Seleccionadas: {value.allocations.length} existencias</p>
              <button
                type="button"
                className="text-button"
                onClick={() => change({ ...value, allocations: [], physical: [] })}
              >
                Limpiar selección
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProductCapture({ add, returnTo }: { add: (p: ProductView) => void; returnTo?: string }) {
  const search = useSearch();
  const products = useResource('products?' + search.query, productListSchema);
  const [reading, setReading] = useState(''),
    [message, setMessage] = useState(''),
    [unknown, setUnknown] = useState(false),
    [busy, setBusy] = useState(false);
  const [namespace, setNamespace] = useState<'AUTO' | 'INTERNAL_CODE'>('AUTO');
  const [supplier, setSupplier] = useState<{
    id: string;
    name: string;
    archivedAt: string | null;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null),
    guard = useRef(false);
  async function scan() {
    if (guard.current || !reading.trim()) return;
    guard.current = true;
    setBusy(true);
    setMessage('');
    setUnknown(false);
    try {
      const result = await catalogFetch('catalog-scans/resolve', scanResultSchema, {
        method: 'POST',
        body: { value: reading, namespace, ...(supplier ? { supplierId: supplier.id } : {}) },
      });
      if (result.status === 'KNOWN') {
        add(result.product);
        setMessage('Producto agregado. Elegí la existencia física.');
        setReading('');
      } else {
        setMessage(
          result.status === 'UNKNOWN'
            ? 'Este código todavía no está identificado.'
            : result.message,
        );
        setUnknown(['UNKNOWN', 'CANDIDATES'].includes(result.status));
      }
    } catch (e) {
      setMessage(humanError(e));
    } finally {
      guard.current = false;
      setBusy(false);
      input.current?.focus();
      input.current?.select();
    }
  }
  return (
    <div className="catalog-panel">
      <h3>Escanear o buscar producto</h3>
      <Field label="Código del producto">
        <input
          ref={input}
          value={reading}
          maxLength={512}
          disabled={busy}
          onChange={(e) => {
            setReading(e.target.value);
            setUnknown(false);
            setMessage('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void scan();
            }
          }}
          placeholder="Escaneá y presioná Enter"
        />
      </Field>
      <button
        type="button"
        className="secondary-button"
        onClick={() => void scan()}
        disabled={busy || !reading.trim()}
      >
        Resolver código
      </button>
      <details>
        <summary>Opciones de lectura</summary>
        <Field label="Tipo de código">
          <select
            value={namespace}
            disabled={busy}
            onChange={(e) => {
              setNamespace(e.target.value as typeof namespace);
              setUnknown(false);
              setMessage('');
            }}
          >
            <option value="AUTO">Código de barras</option>
            <option value="INTERNAL_CODE">Código interno</option>
          </select>
        </Field>
        <EntityChoice
          kind="suppliers"
          label="Proveedor del código externo"
          value={supplier}
          change={setSupplier}
          allowCreate={false}
        />
      </details>
      {message && <p role="status">{message}</p>}
      {unknown && returnTo && (
        <Link href={'/identificar?returnTo=' + encodeURIComponent(returnTo)}>
          Identificar producto
        </Link>
      )}
      {unknown && !returnTo && (
        <p>Guardá el borrador para ir a Identificar producto y poder volver al remito.</p>
      )}
      <Field label="Buscar producto por nombre o código">
        <input
          type="search"
          maxLength={128}
          value={search.search}
          onChange={(e) => search.setSearch(e.target.value)}
        />
      </Field>
      <Feedback {...products} reload={products.reload} />
      <ul className="delivery-choices">
        {products.data?.items.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => add(p)}
            >
              {p.name}
              {p.presentation ? ' · ' + p.presentation : ''} · Agregar
            </button>
          </li>
        ))}
      </ul>
      {products.data && <Pagination {...products.data} change={search.setPage} />}
    </div>
  );
}

function ReadOnly({ doc }: { doc: DeliveryNoteView }) {
  return (
    <section className="catalog-panel">
      <h2>
        {documentLabels[doc.status]} · {doc.documentPrefix}-{doc.documentNumber}
      </h2>
      <p>Fecha: {doc.documentDate.split('-').reverse().join('/')}</p>
      <h3>
        <Link href={'/clientes/' + doc.customer.id}>{doc.customer.name}</Link>
      </h3>
      <p>
        {doc.customer.legalName} {doc.customer.cuit ? '· CUIT ' + doc.customer.cuit : ''}{' '}
        {doc.customer.taxConditionText}
      </p>
      <p>
        {[
          doc.customer.addressLine,
          doc.customer.locality,
          doc.customer.province,
          doc.customer.postalCode,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {doc.patientName && <p>Paciente: {doc.patientName}</p>}
      {doc.affiliateNumber && <p>N.º afiliado: {doc.affiliateNumber}</p>}
      {doc.lines.map((l) => (
        <div className="delivery-position" key={l.id}>
          <h3>
            <Link href={'/productos/' + l.productId}>{l.productName}</Link>
          </h3>
          <p>
            {l.presentation} · {l.quantity} {quantityLabels[l.unitOfMeasure]}
          </p>
          {l.allocations.map((a) => (
            <p key={a.id}>
              {a.quantity} · {a.lotNumber ? 'Lote ' + a.lotNumber : 'Sin lote'} ·{' '}
              {a.expirationDate ? 'Vence ' + a.expirationDate : 'Sin vencimiento'}
              {a.serialNumber ? ' · Serie ' + a.serialNumber : ''} · {a.location.name}
            </p>
          ))}
          {doc.movementId && (
            <Link href={'/stock/' + l.productId + '#movimiento-' + doc.movementId}>
              Ver movimiento de stock relacionado
            </Link>
          )}
        </div>
      ))}
      {doc.notes && <p className="preserve-lines">Observaciones: {doc.notes}</p>}
      {doc.confirmedAt && (
        <p>
          Confirmó {doc.confirmedBy} · {new Date(doc.confirmedAt).toLocaleString('es-AR')}
        </p>
      )}
      {doc.status === 'CONFIRMED' && <p>Este remito ya fue confirmado y no puede modificarse.</p>}
    </section>
  );
}

function Editor({ doc, saved }: { doc?: DeliveryNoteView; saved: (d: DeliveryNoteView) => void }) {
  const { isAdmin } = useWorkspace();
  const [customer, setCustomer] = useState<Customer | null>(doc?.customer ?? null);
  const [date, setDate] = useState(
    doc?.documentDate ??
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Argentina/Buenos_Aires',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date()),
  );
  const [prefix, setPrefix] = useState(doc?.documentPrefix ?? ''),
    [number, setNumber] = useState(doc?.documentNumber ?? '');
  const [patient, setPatient] = useState(doc?.patientName ?? ''),
    [affiliate, setAffiliate] = useState(doc?.affiliateNumber ?? ''),
    [notes, setNotes] = useState(doc?.notes ?? '');
  const [lines, setLines] = useState<Line[]>(
    doc?.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      productName: l.productName,
      presentation: l.presentation,
      unitOfMeasure: l.unitOfMeasure,
      quantity: l.quantity,
      allocations: l.allocations.map((a) => ({ positionId: a.positionId, quantity: a.quantity })),
      physical: l.allocations,
    })) ?? [],
  );
  const [dirty, setDirty] = useState(!doc),
    [preview, setPreview] = useState(false),
    [review, setReview] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [conflict, setConflict] = useState(false);
  const guard = useRef(false),
    id = useRef(doc?.id ?? ''),
    attempt = useRef<{ path: string; method: 'POST' | 'PATCH'; body: unknown } | null>(null);
  const frozen = busy || uncertain || conflict;
  useEffect(() => {
    if (!dirty && !uncertain) return;
    const leave = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [dirty, uncertain]);
  function changeLine(index: number, l: Line) {
    setLines((previous) => previous.map((v, i) => (i === index ? l : v)));
    setDirty(true);
    setReview(false);
  }
  async function run() {
    if (guard.current || !attempt.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await fetchNote(attempt.current.path, {
        method: attempt.current.method,
        body: attempt.current.body,
      });
      attempt.current = null;
      setUncertain(false);
      setDirty(false);
      saved(result);
    } catch (e) {
      setError(humanError(e));
      if (e instanceof CatalogHttpError && e.status < 500) {
        attempt.current = null;
        setUncertain(false);
        setConflict(Boolean(doc) && e.status === 409);
      } else setUncertain(true);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function save() {
    if (frozen || guard.current) return;
    if (!id.current) id.current = crypto.randomUUID();
    const fields = {
      customerId: customer?.id,
      documentDate: date,
      documentPrefix: prefix || null,
      documentNumber: number || null,
      patientName: patient || null,
      affiliateNumber: affiliate || null,
      notes: notes || null,
      lines: lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        quantity: l.quantity.replace(',', '.'),
        allocations: l.allocations,
      })),
    };
    const parsed = doc
      ? deliveryNoteUpdateSchema.safeParse({ ...fields, expectedVersion: doc.version })
      : deliveryNoteCreateSchema.safeParse({ ...fields, id: id.current });
    if (!parsed.success) {
      setError(
        'Revisá el cliente, la fecha, las cantidades y ambas partes del número del talonario.',
      );
      return;
    }
    attempt.current = { path: doc?.id ?? '', method: doc ? 'PATCH' : 'POST', body: parsed.data };
    void run();
  }
  function confirm() {
    if (!doc || dirty || frozen || guard.current) return;
    attempt.current = {
      path: doc.id + '/confirm',
      method: 'POST',
      body: { operationId: crypto.randomUUID(), expectedVersion: doc.version },
    };
    void run();
  }
  async function check() {
    if (guard.current || !id.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const result = await fetchNote(id.current);
      attempt.current = null;
      setUncertain(false);
      setConflict(false);
      setDirty(false);
      saved(result);
    } catch (e) {
      setError(
        e instanceof CatalogHttpError && e.status === 404
          ? 'Todavía no encontramos el remito. Reintentá el mismo envío; no crees otro.'
          : humanError(e),
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <Feedback error={error} />
      {uncertain && (
        <div className="catalog-error" role="alert">
          <p>
            No sabemos si el servidor completó la operación. Conservamos el mismo intento para
            evitar duplicados.
          </p>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void run()}
          >
            Reintentar el mismo envío
          </button>{' '}
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => void check()}
          >
            Comprobar resultado
          </button>
        </div>
      )}
      {conflict && (
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => void check()}
        >
          Volver a cargar el remito
        </button>
      )}
      <fieldset disabled={frozen} className="delivery-editor">
        <section className="catalog-panel">
          <h2>Cliente</h2>
          <CustomerChoice
            selected={customer}
            change={(c) => {
              setCustomer(c);
              setDirty(true);
              setReview(false);
            }}
          />
        </section>
        <section className="catalog-panel">
          <h2>Datos del remito</h2>
          <div className="form-grid">
            <Field label="Fecha del documento">
              <input
                type="date"
                value={date}
                onChange={(e) => {
                  setDate(e.target.value);
                  setDirty(true);
                  setReview(false);
                }}
                required
              />
            </Field>
            <Field label="Prefijo del talonario">
              <input
                inputMode="numeric"
                maxLength={12}
                value={prefix}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  setDirty(true);
                  setReview(false);
                }}
                placeholder="00001"
              />
            </Field>
            <Field label="Número del talonario">
              <input
                inputMode="numeric"
                maxLength={12}
                value={number}
                onChange={(e) => {
                  setNumber(e.target.value);
                  setDirty(true);
                  setReview(false);
                }}
                placeholder="00003897"
              />
            </Field>
            <Field label="Paciente (opcional)">
              <input
                maxLength={160}
                value={patient}
                onChange={(e) => {
                  setPatient(e.target.value);
                  setDirty(true);
                  setReview(false);
                }}
              />
            </Field>
            <Field label="N.º afiliado (opcional)">
              <input
                maxLength={80}
                value={affiliate}
                onChange={(e) => {
                  setAffiliate(e.target.value);
                  setDirty(true);
                  setReview(false);
                }}
              />
            </Field>
          </div>
        </section>
        <section>
          <h2>Productos</h2>
          <ProductCapture
            returnTo={doc && !dirty ? '/remitos/' + doc.id : undefined}
            add={(p) => {
              setLines((previous) => [
                ...previous,
                {
                  id: crypto.randomUUID(),
                  productId: p.id,
                  productName: p.name,
                  presentation: p.presentation,
                  unitOfMeasure: p.unitOfMeasure,
                  quantity: '1',
                  allocations: [],
                  physical: [],
                },
              ]);
              setDirty(true);
              setReview(false);
            }}
          />
          {lines.map((l, i) => (
            <section className="catalog-panel" key={l.id}>
              <h3>{l.productName}</h3>
              <p>{l.presentation}</p>
              <Field label={'Cantidad · ' + quantityLabels[l.unitOfMeasure]}>
                <input
                  inputMode="decimal"
                  value={l.quantity}
                  onChange={(e) => changeLine(i, { ...l, quantity: e.target.value })}
                />
              </Field>
              <StockChoice
                productId={l.productId}
                value={l}
                change={(next) => changeLine(i, next)}
              />
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setLines((previous) => previous.filter((item) => item.id !== l.id));
                  setDirty(true);
                  setReview(false);
                }}
              >
                Quitar producto
              </button>
            </section>
          ))}
        </section>
        <Field label="Observaciones del remito">
          <textarea
            rows={3}
            maxLength={1000}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              setDirty(true);
              setReview(false);
            }}
          />
        </Field>
      </fieldset>
      <div className="actions">
        <button
          type="button"
          className="primary-button"
          disabled={frozen || !customer}
          onClick={save}
        >
          {busy ? 'Guardando…' : 'Guardar borrador'}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={() => setPreview(!preview)}
        >
          Previsualizar datos
        </button>
        {doc && (
          <button
            type="button"
            className="primary-button"
            disabled={frozen || dirty}
            onClick={() => setReview(true)}
          >
            Confirmar salida
          </button>
        )}
      </div>
      {dirty && (
        <p role="status">Hay cambios sin guardar. Guardá el borrador antes de confirmar o salir.</p>
      )}
      {preview && (
        <section className="catalog-panel">
          <h2>Previsualizar datos</h2>
          <p>Contenido documental; la disposición para impresión se agregará después.</p>
          <p>
            {customer?.name} · {prefix}-{number} · {date}
          </p>
          {patient && <p>Paciente: {patient}</p>}
          {affiliate && <p>N.º afiliado: {affiliate}</p>}
          {lines.map((l) => (
            <div key={l.id}>
              <strong>
                {l.productName} · {l.quantity} {quantityLabels[l.unitOfMeasure]}
              </strong>
              {l.physical.map((a) => (
                <p key={a.positionId}>
                  {a.quantity} · {a.lotNumber ? 'Lote ' + a.lotNumber : 'Sin lote'} ·{' '}
                  {a.expirationDate ?? 'Sin vencimiento'}
                  {a.serialNumber ? ' · Serie ' + a.serialNumber : ''}
                </p>
              ))}
            </div>
          ))}
          <p>{notes}</p>
        </section>
      )}
      {review && !dirty && (
        <section className="catalog-panel" role="region" aria-label="Revisar salida">
          <h2>Revisar y confirmar</h2>
          <p>
            Al confirmar, la mercadería se descontará del stock y el remito ya no podrá editarse.
          </p>
          <p>Comprobá el número del talonario y los lotes o series físicos elegidos.</p>
          {doc && <ReadOnly doc={doc} />}
          <button className="primary-button" type="button" disabled={frozen} onClick={confirm}>
            Sí, confirmar salida
          </button>{' '}
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => setReview(false)}
          >
            Seguir revisando
          </button>
        </section>
      )}
      {doc && isAdmin && (
        <details>
          <summary>Cancelar borrador</summary>
          <p>Se conservará el número asignado. No se modificará el stock.</p>
          <button
            type="button"
            className="secondary-button"
            disabled={frozen}
            onClick={() => {
              if (guard.current) return;
              attempt.current = {
                path: doc.id + '/cancel',
                method: 'POST',
                body: { expectedVersion: doc.version },
              };
              void run();
            }}
          >
            Confirmar cancelación del borrador
          </button>
        </details>
      )}
    </>
  );
}

export function DeliveryNoteDetail({ id }: { id?: string }) {
  const router = useRouter();
  const resource = useResource(id ?? null, deliveryNoteSchema, 'delivery-notes');
  const [updated, setUpdated] = useState<DeliveryNoteView | undefined>();
  const [editorRevision, setEditorRevision] = useState(0);
  const doc = updated && (!id || updated.id === id) ? updated : resource.data;
  function saved(d: DeliveryNoteView) {
    setUpdated(d);
    // A failed save can leave the server version unchanged. Reload must still
    // discard local edits before enabling confirmation again.
    setEditorRevision(value => value + 1);
    if (!id) router.replace('/remitos/' + d.id);
  }
  return (
    <>
      <Link href="/remitos">← Remitos</Link>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1>{id ? 'Remito' : 'Hacer remito'}</h1>
        </div>
      </header>
      {id && <Feedback {...resource} reload={resource.reload} />}
      {(!id || doc) &&
        (doc && doc.status !== 'DRAFT' ? (
          <ReadOnly doc={doc} />
        ) : (
          <Editor key={(doc ? doc.id + ':' + doc.version : 'new') + ':' + editorRevision} doc={doc} saved={saved} />
        ))}
    </>
  );
}

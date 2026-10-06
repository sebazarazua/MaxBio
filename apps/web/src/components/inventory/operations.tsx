'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import {
  inventoryDocumentSchema,
  inventoryDocumentListSchema,
  inventoryPolicySchema,
  scanResultSchema,
  productSchema,
  type InventoryDocument,
  type ProductView,
  type InventoryLineInput,
  type InventoryConfirm,
} from '@maxbio/contracts';
import { inventoryFetch } from '@/lib/inventory-api';
import { catalogFetch, CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { EntityChoice, Feedback, Field, Pagination } from '../catalog/common';
import {
  useInventoryMutation,
  useInventoryResource,
  InventoryPolicyEditor,
  conditionLabels,
  documentLabels,
  quantityLabels,
} from './common';
type Kind = 'receipts' | 'counts';
type Choice = { id: string; name: string; archivedAt: string | null };
const operationPath = (kind: Kind, id?: string) =>
  '/inventario/' + (kind === 'receipts' ? 'ingresos' : 'inicial') + (id ? '/' + id : '');

export function InventoryDocuments({ kind }: { kind: Kind }) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const resource = useInventoryResource(`${kind}?page=${page}`, inventoryDocumentListSchema);
  const mutation = useInventoryMutation();
  const [supplier, setSupplier] = useState<Choice | null>(null),
    [notes, setNotes] = useState('');
  const creation = useRef<{ id: string; supplierId?: string; notes: string } | null>(null);
  const [pending, setPending] = useState(false);
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!creation.current) {
      creation.current = {
        id: crypto.randomUUID(),
        ...(kind === 'receipts' ? { supplierId: supplier!.id } : {}),
        notes,
      };
      setPending(true);
    }
    const data = await mutation.run(
      () =>
        inventoryFetch(kind, inventoryDocumentSchema, { method: 'POST', body: creation.current }),
      (cause) => {
        if (cause instanceof CatalogHttpError && cause.status < 500) {
          creation.current = null;
          setPending(false);
        }
      },
    );
    if (data) router.push(operationPath(kind, data.id));
  }
  return (
    <>
      <p className="eyebrow">INVENTARIO</p>
      <h1>{kind === 'receipts' ? 'Ingresar productos' : 'Inventario inicial'}</h1>
      <p className="page-intro">
        {kind === 'receipts'
          ? 'Prepará varios productos y revisá el ingreso antes de confirmar.'
          : 'Contá gradualmente el depósito, en sesiones pequeñas. Cada producto incluido debe contarse completo.'}
      </p>
      <section className="catalog-panel">
        <h2>{kind === 'receipts' ? 'Nuevo ingreso' : 'Nueva sesión'}</h2>
        <form onSubmit={(e) => void create(e)}>
          <fieldset disabled={mutation.busy || pending}>
            {kind === 'receipts' && (
              <EntityChoice
                kind="suppliers"
                label="Proveedor"
                value={supplier}
                change={setSupplier}
                allowCreate={false}
              />
            )}
            <Field label="Notas (opcional)">
              <textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </fieldset>
          <button
            className="primary-button"
            disabled={mutation.busy || (kind === 'receipts' && !supplier)}
          >
            {mutation.busy
              ? 'Guardando…'
              : pending
                ? 'Reintentar la misma apertura'
                : kind === 'receipts'
                  ? 'Comenzar ingreso'
                  : 'Comenzar conteo'}
          </button>
          <Feedback error={mutation.error} />
        </form>
      </section>
      <section className="catalog-panel">
        <h2>{kind === 'receipts' ? 'Ingresos y borradores' : 'Sesiones guardadas'}</h2>
        <Feedback loading={resource.loading} error={resource.error} reload={resource.reload} />
        {resource.data && (
          <>
            <div className="reference-table-scroll">
              <table className="reference-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>{kind === 'receipts' ? 'Proveedor' : 'Productos'}</th>
                    <th>Estado</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {resource.data.items.map((d) => (
                    <tr key={d.id}>
                      <td>{new Date(d.createdAt).toLocaleDateString('es-AR')}</td>
                      <td>
                        {d.supplier?.name ??
                          (d.scopes.map((s) => s.productName).join(', ') ||
                            'Sin productos todavía')}
                      </td>
                      <td>{documentLabels[d.status]}</td>
                      <td>
                        <Link href={operationPath(kind, d.id)}>
                          {d.canEdit ? 'Retomar' : 'Ver'}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {resource.data.items.length === 0 && <p>Todavía no hay operaciones guardadas.</p>}
            <Pagination
              total={resource.data.total}
              page={page}
              limit={resource.data.limit}
              change={setPage}
            />
          </>
        )}
      </section>
    </>
  );
}

export function InventoryOperation({ kind, id }: { kind: Kind; id: string }) {
  const { isAdmin } = useWorkspace();
  const resource = useInventoryResource(`${kind}/${id}`, inventoryDocumentSchema);
  const mutation = useInventoryMutation();
  const [updated, setUpdated] = useState<InventoryDocument | null>(null);
  const doc = updated ?? resource.data;
  const scanner = useRef<HTMLInputElement>(null);
  const quantityInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState('');
  const [namespace, setNamespace] = useState<'AUTO' | 'INTERNAL_CODE'>('AUTO');
  const [codeSupplier, setCodeSupplier] = useState<Choice | null>(null);
  const [recognized, setRecognized] = useState<ProductView | null>(null);
  const [policy, setPolicy] = useState<ReturnType<typeof inventoryPolicySchema.parse> | null>(null);
  const [scanMessage, setScanMessage] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [qty, setQty] = useState('1'),
    [lot, setLot] = useState(''),
    [expiration, setExpiration] = useState(''),
    [series, setSeries] = useState('');
  const [condition, setCondition] = useState<'USABLE' | 'DAMAGED' | 'QUARANTINE'>('USABLE');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [review, setReview] = useState(false),
    [coverage, setCoverage] = useState(false),
    [lineLocked, setLineLocked] = useState(false);
  const lineAttempt = useRef<{ lineId: string; body: InventoryLineInput } | null>(null);
  const confirmation = useRef<InventoryConfirm | null>(null);
  function focus() {
    requestAnimationFrame(() => {
      scanner.current?.focus();
      scanner.current?.select();
    });
  }
  function resetReading() {
    setRecognized(null);
    setPolicy(null);
    setScanMessage('');
    setUnknown(false);
    setEditingId(null);
    setSelectedLotId(null);
    mutation.clear();
  }
  function resetCapture() {
    setQty('1');
    setLot('');
    setExpiration('');
    setSeries('');
    setCondition('USABLE');
    setEditingId(null);
    setSelectedLotId(null);
  }
  async function claim(productId: string, present: InventoryDocument) {
    if (kind === 'counts' && !present.scopes.some((s) => s.productId === productId)) {
      const next = await inventoryFetch(`counts/${id}/scopes`, inventoryDocumentSchema, {
        method: 'POST',
        body: { productId, expectedVersion: present.version },
      });
      setUpdated(next);
      return next;
    }
    return present;
  }
  async function scan(e: FormEvent) {
    e.preventDefault();
    if (!doc) return;
    resetReading();
    resetCapture();
    await mutation.run(async () => {
      const supplierId = doc.supplier?.id ?? codeSupplier?.id;
      const result = await catalogFetch('catalog-scans/resolve', scanResultSchema, {
        method: 'POST',
        body: { value: reading, namespace, ...(supplierId ? { supplierId } : {}) },
      });
      if (result.status !== 'KNOWN') {
        setScanMessage(result.message);
        setUnknown(result.status === 'UNKNOWN' || result.status === 'CANDIDATES');
        focus();
        return;
      }
      setRecognized(result.product);
      const p = await inventoryFetch(
        `products/${result.product.id}/policy`,
        inventoryPolicySchema.nullable(),
      );
      setPolicy(p);
      if (p) {
        await claim(result.product.id, doc);
        requestAnimationFrame(() => quantityInput.current?.focus());
      }
    });
  }
  async function savedPolicy(p: ReturnType<typeof inventoryPolicySchema.parse>) {
    setPolicy(p);
    if (doc && recognized) {
      const next = await mutation.run(() => claim(recognized.id, doc));
      if (next) setUpdated(next);
    }
  }
  async function add() {
    if (!doc || !recognized || !policy) return;
    if (!lineAttempt.current) {
      const serialNumbers = series
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      lineAttempt.current = {
        lineId: editingId ?? crypto.randomUUID(),
        body: {
          expectedVersion: doc.version,
          productId: recognized.id,
          unitOfMeasure: recognized.unitOfMeasure,
          quantity: policy.serialRequired
            ? String(serialNumbers.length)
            : qty.trim().replace(',', '.'),
          lotId: selectedLotId,
          lotNumber: lot.trim() || null,
          expirationDate: expiration || null,
          serialNumbers,
          condition,
        },
      };
      setLineLocked(true);
    }
    const attempt = lineAttempt.current;
    const next = await mutation.run(
      () =>
        inventoryFetch(`${kind}/${id}/lines/${attempt.lineId}`, inventoryDocumentSchema, {
          method: 'PUT',
          body: attempt.body,
        }),
      (cause) => {
        if (cause instanceof CatalogHttpError && cause.status < 500) {
          lineAttempt.current = null;
          setLineLocked(false);
        }
      },
    );
    if (next) {
      setUpdated(next);
      lineAttempt.current = null;
      setLineLocked(false);
      resetCapture();
      resetReading();
      setReading('');
      focus();
    }
  }
  async function edit(l: InventoryDocument['lines'][number]) {
    await mutation.run(async () => {
      const p = await catalogFetch(`products/${l.product.id}`, productSchema);
      const pol = await inventoryFetch(`products/${p.id}/policy`, inventoryPolicySchema.nullable());
      setRecognized(p);
      setPolicy(pol);
      setUnknown(false);
      setScanMessage('');
      setQty(l.quantity);
      setLot(l.lotNumber ?? '');
      setExpiration(l.expirationDate ?? '');
      setSeries(l.serialNumbers.join('\n'));
      setCondition(l.condition);
      setEditingId(l.id);
      setSelectedLotId(l.lotId);
    });
  }
  async function remove(lineId: string) {
    if (!doc) return;
    const result = await mutation.run(() =>
      inventoryFetch(`${kind}/${id}/lines/${lineId}`, inventoryDocumentSchema, {
        method: 'DELETE',
        body: { expectedVersion: doc.version },
      }),
    );
    if (result) {
      setUpdated(result);
      resetReading();
      resetCapture();
      focus();
    }
  }
  async function reload() {
    const result = await mutation.run(() =>
      inventoryFetch(`${kind}/${id}`, inventoryDocumentSchema),
    );
    if (result) {
      setUpdated(result);
      if (lineAttempt.current && result.lines.some((l) => l.id === lineAttempt.current!.lineId)) {
        lineAttempt.current = null;
        setLineLocked(false);
        resetReading();
        resetCapture();
      }
      if (result.status !== 'DRAFT') {
        confirmation.current = null;
        setReview(false);
      }
    }
  }
  async function finish() {
    if (!doc) return;
    if (!confirmation.current)
      confirmation.current = {
        operationId: crypto.randomUUID(),
        expectedVersion: doc.version,
        ...(kind === 'counts' ? { completeCoverage: true } : {}),
      };
    const result = await mutation.run(
      () =>
        inventoryFetch(`${kind}/${id}/confirm`, inventoryDocumentSchema, {
          method: 'POST',
          body: confirmation.current,
        }),
      (cause) => {
        if (cause instanceof CatalogHttpError && cause.status < 500) {
          confirmation.current = null;
        }
      },
    );
    if (result) {
      setUpdated(result);
      confirmation.current = null;
      setReview(false);
      resetReading();
      resetCapture();
    }
  }
  async function cancel() {
    if (!doc) return;
    const result = await mutation.run(() =>
      inventoryFetch(`${kind}/${id}/cancel`, inventoryDocumentSchema, {
        method: 'POST',
        body: { expectedVersion: doc.version },
      }),
    );
    if (result) {
      setUpdated(result);
      setReview(false);
      setRecognized(null);
    }
  }
  if (!doc)
    return <Feedback loading={resource.loading} error={resource.error} reload={resource.reload} />;
  const counted =
    kind === 'receipts' ||
    Boolean(recognized && doc.scopes.some((s) => s.productId === recognized.id));
  const captureQuantity = policy?.serialRequired
    ? String(series.split(/\r?\n/).filter((s) => s.trim()).length)
    : qty;
  const busy = mutation.busy;
  const disabled = busy || review || lineLocked;
  return (
    <>
      <p className="eyebrow">INVENTARIO</p>
      <h1>{kind === 'receipts' ? 'Ingresar productos' : 'Inventario inicial'}</h1>
      <p className="page-intro">
        {doc.supplier?.name ?? 'Sesión de conteo'} · {doc.location.name} ·{' '}
        {documentLabels[doc.status]}
      </p>
      <div className="actions">
        <Link href={operationPath(kind)}>Volver a las operaciones guardadas</Link>
        <button className="secondary-button" disabled={busy} onClick={() => void reload()}>
          Comprobar resultado / volver a cargar
        </button>
      </div>
      <Feedback error={mutation.error} />
      {doc.notes && <p>Notas: {doc.notes}</p>}
      {doc.status === 'CONFIRMED' && (
        <section className="catalog-panel" role="status">
          <h2>{kind === 'receipts' ? 'Ingreso confirmado' : 'Inventario inicial confirmado'}</h2>
          <p>
            La operación quedó registrada.{' '}
            {doc.replayed ? 'Se recuperó la misma confirmación sin duplicar stock.' : ''} Un error
            se corrige mediante un nuevo ajuste administrativo.
          </p>
          <Link href="/stock">Consultar stock</Link>
        </section>
      )}
      {doc.canEdit && !review && (
        <>
          {kind === 'counts' && (
            <p className="catalog-status">
              Contá todas las unidades de cada producto, incluyendo lotes, series, dañados y
              cuarentena. Pausá sus movimientos físicos mientras lo contás. Otros productos pueden
              seguir operando.
            </p>
          )}
          <section className="catalog-panel">
            <h2>Escaneá producto</h2>
            <form onSubmit={(e) => void scan(e)}>
              <fieldset disabled={disabled}>
                <Field label="Código leído">
                  <input
                    ref={scanner}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="scanner-input code"
                    value={reading}
                    maxLength={512}
                    required
                    onChange={(e) => {
                      setReading(e.target.value);
                      resetReading();
                    }}
                  />
                </Field>
                <Field label="Tipo de lectura">
                  <select
                    value={namespace}
                    onChange={(e) => {
                      setNamespace(e.target.value as 'AUTO' | 'INTERNAL_CODE');
                      resetReading();
                    }}
                  >
                    <option value="AUTO">Scanner: GTIN, MB- o código externo</option>
                    <option value="INTERNAL_CODE">Código interno (ingreso manual)</option>
                  </select>
                </Field>
                {kind === 'counts' && (
                  <EntityChoice
                    kind="suppliers"
                    label="Proveedor del código externo (opcional)"
                    value={codeSupplier}
                    change={(s) => {
                      setCodeSupplier(s);
                      resetReading();
                    }}
                    allowCreate={false}
                  />
                )}
              </fieldset>
              <button type="submit" className="secondary-button" disabled={disabled}>
                Reconocer código manual
              </button>
            </form>
            <div aria-live="polite" role="status">
              {scanMessage && <p>{scanMessage}</p>}
              {unknown && (
                <p>
                  Primero identificá este producto. El borrador está guardado.{' '}
                  <Link
                    href={'/identificar?returnTo=' + encodeURIComponent(operationPath(kind, id))}
                  >
                    Identificar producto
                  </Link>
                </p>
              )}
            </div>
          </section>
          {recognized && (
            <section className="catalog-panel">
              <h2>Producto reconocido</h2>
              <strong>{recognized.name}</strong>
              <p>
                {recognized.presentation || 'Sin presentación'} · Se cuenta en{' '}
                {quantityLabels[recognized.unitOfMeasure]}.
              </p>
              {!policy && (
                <InventoryPolicyEditor
                  key={recognized.id}
                  productId={recognized.id}
                  policy={null}
                  onSaved={savedPolicy}
                />
              )}
              {policy && (
                <>
                  <p>
                    {[
                      policy.lotRequired ? 'Lote obligatorio' : null,
                      policy.expirationRequired ? 'Vencimiento obligatorio' : null,
                      policy.serialRequired ? 'Serie por unidad' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Cantidad en unidad base; lote y vencimiento opcionales.'}
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void add();
                    }}
                  >
                    <fieldset disabled={disabled || !counted}>
                      <Field
                        label={'Cantidad (' + quantityLabels[recognized.unitOfMeasure] + ')'}
                        help={
                          recognized.presentation
                            ? recognized.unitOfMeasure === 'UNIT'
                              ? 'La presentación es descriptiva. Si recibís una caja de 100 unidades, ingresá 100 unidades.'
                              : 'Ingresá la cantidad en ' +
                                quantityLabels[recognized.unitOfMeasure] +
                                ', según la unidad del producto.'
                            : undefined
                        }
                      >
                        <input
                          ref={quantityInput}
                          inputMode="decimal"
                          value={captureQuantity}
                          readOnly={policy.serialRequired}
                          required
                          onChange={(e) => setQty(e.target.value)}
                        />
                      </Field>
                      <Field label={'Lote' + (policy.lotRequired ? '' : ' (opcional)')}>
                        <input
                          value={lot}
                          maxLength={128}
                          required={policy.lotRequired && captureQuantity !== '0'}
                          onChange={(e) => {
                            setLot(e.target.value);
                            setSelectedLotId(null);
                          }}
                        />
                      </Field>
                      <Field
                        label={'Vencimiento' + (policy.expirationRequired ? '' : ' (opcional)')}
                      >
                        <input
                          type="date"
                          value={expiration}
                          required={policy.expirationRequired && captureQuantity !== '0'}
                          onChange={(e) => {
                            setExpiration(e.target.value);
                            setSelectedLotId(null);
                          }}
                        />
                      </Field>
                      {policy.serialRequired && (
                        <Field
                          label="Series (una por línea)"
                          help="La cantidad se calcula a partir de las series. No ingreses una caja como una sola serie si contiene varias unidades individuales."
                        >
                          <textarea
                            value={series}
                            onChange={(e) => setSeries(e.target.value)}
                            maxLength={13000}
                            rows={5}
                          />
                        </Field>
                      )}
                      <Field label="Condición">
                        <select
                          value={condition}
                          onChange={(e) => setCondition(e.target.value as typeof condition)}
                        >
                          <option value="USABLE">Utilizable</option>
                          <option value="DAMAGED">Dañado</option>
                          <option value="QUARANTINE">En cuarentena</option>
                        </select>
                      </Field>
                    </fieldset>
                    {kind === 'counts' && captureQuantity === '0' && (
                      <p>
                        Agregar cero registra que revisaste este producto y no encontraste
                        existencias.
                      </p>
                    )}
                    <button className="primary-button" disabled={busy || !counted}>
                      {busy
                        ? 'Guardando…'
                        : lineLocked
                          ? 'Reintentar la misma línea'
                          : editingId
                            ? 'Guardar línea'
                            : 'Agregar'}
                    </button>
                  </form>
                </>
              )}
            </section>
          )}
        </>
      )}
      {doc.scopes.length > 0 && (
        <section className="catalog-panel">
          <h2>Productos incluidos en este conteo</h2>
          <ul>
            {doc.scopes.map((s) => (
              <li key={s.id}>
                {s.productName} ·{' '}
                {s.coverageConfirmed
                  ? 'Conteo completo confirmado'
                  : 'En conteo; completá todas sus existencias'}
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="catalog-panel">
        <h2>{review ? 'Revisá antes de confirmar' : 'Productos agregados'}</h2>
        <p>
          {doc.status === 'DRAFT'
            ? 'Estas líneas todavía no generan stock. El borrador se guarda al agregar o corregir una línea.'
            : 'Datos registrados de la operación.'}
        </p>
        <div className="reference-table-scroll">
          <table className="reference-table">
            <thead>
              <tr>
                <th>Producto</th>
                <th>Cantidad</th>
                <th>Lote</th>
                <th>Vencimiento</th>
                <th>Condición / series</th>
                {doc.canEdit && !review && <th>Acciones</th>}
              </tr>
            </thead>
            <tbody>
              {doc.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={'/stock/' + l.product.id}>{l.product.name}</Link>
                  </td>
                  <td>
                    {l.quantity} {quantityLabels[l.product.unitOfMeasure]}
                  </td>
                  <td>{l.lotNumber ?? (l.expirationDate ? 'Sin número de lote' : '—')}</td>
                  <td>
                    {l.expirationDate ?? 'No aplica'}
                    {l.expirationDate &&
                      l.expirationDate <
                        new Date().toLocaleDateString('en-CA', {
                          timeZone: 'America/Argentina/Buenos_Aires',
                        }) && <strong> · Vencido</strong>}
                  </td>
                  <td>
                    {conditionLabels[l.condition]}
                    {l.serialNumbers.length > 0 && (
                      <details>
                        <summary>{l.serialNumbers.length} series</summary>
                        <p className="code">{l.serialNumbers.join(', ')}</p>
                      </details>
                    )}
                  </td>
                  {doc.canEdit && !review && (
                    <td>
                      <div className="actions">
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || lineLocked}
                          onClick={() => void edit(l)}
                        >
                          Corregir
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy || lineLocked}
                          onClick={() => void remove(l.id)}
                        >
                          Quitar
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {doc.lines.length === 0 && <p>Todavía no agregaste productos.</p>}
        {doc.canEdit && (
          <div className="actions">
            {review ? (
              <>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => {
                    setReview(false);
                    confirmation.current = null;
                  }}
                >
                  Volver al borrador
                </button>
                {kind === 'counts' && (
                  <label className="check-field">
                    <input
                      type="checkbox"
                      checked={coverage}
                      disabled={busy}
                      onChange={(e) => setCoverage(e.target.checked)}
                    />{' '}
                    Conté todas las existencias de los productos incluidos, también las dañadas y en
                    cuarentena.
                  </label>
                )}
                <button
                  className="primary-button"
                  disabled={busy || (kind === 'counts' && !coverage)}
                  onClick={() => void finish()}
                >
                  {busy
                    ? 'Confirmando…'
                    : kind === 'receipts'
                      ? 'Confirmar ingreso'
                      : 'Confirmar inventario inicial'}
                </button>
              </>
            ) : (
              <button
                className="primary-button"
                disabled={busy || lineLocked || doc.lines.length === 0}
                onClick={() => {
                  setReview(true);
                  setCoverage(false);
                  confirmation.current = null;
                }}
              >
                {kind === 'receipts' ? 'Revisar ingreso' : 'Revisar inventario inicial'}
              </button>
            )}
          </div>
        )}
      </section>
      {doc.status === 'DRAFT' && (doc.canEdit || isAdmin) && (
        <section className="catalog-panel">
          <details>
            <summary>Cancelar este borrador</summary>
            <p>
              Descarta la operación sin cambiar stock. En inventario inicial también libera los
              productos para otro conteo.
            </p>
            <button
              className="secondary-button"
              disabled={busy || lineLocked}
              onClick={() => void cancel()}
            >
              Confirmar cancelación del borrador
            </button>
          </details>
        </section>
      )}
    </>
  );
}

'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  type ScanInput,
  type ScanInterpretation,
} from '@maxbio/contracts';
import { inventoryFetch } from '@/lib/inventory-api';
import { catalogFetch, CatalogHttpError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { EntityChoice, Feedback, Field, Pagination } from '../catalog/common';
import { ProductIdentification } from '../catalog/identification';
import { ScanDetails } from '../catalog/scan-details';
import {
  capturePlan,
  pastedReadingProblem,
  sameCaptureGroup,
  serialInOperation,
  serialList,
  type ReviewItem,
} from '@/lib/gs1-capture';
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
type Policy = ReturnType<typeof inventoryPolicySchema.parse>;
type Found = { product: ProductView; policy: Policy | null; scan?: ScanInterpretation };
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
  const [policy, setPolicy] = useState<Policy | null>(null);
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
  // GS1 capture state lives only in memory: never in URL, storage, cookies or analytics.
  const [lastScan, setLastScan] = useState<ScanInterpretation | undefined>(undefined);
  const [readingScan, setReadingScan] = useState<ScanInterpretation | undefined>(undefined);
  const [scanReview, setScanReview] = useState<ReviewItem[]>([]);
  const [scanNotes, setScanNotes] = useState<string[]>([]);
  const [discarded, setDiscarded] = useState(false);
  const [nextFound, setNextFound] = useState<Found | null>(null);
  const [pendingInput, setPendingInput] = useState<ScanInput | null>(null);
  const [identifying, setIdentifying] = useState<ScanInput | null>(null);
  const attempt = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  useEffect(() => () => inflight.current?.abort(), []);
  function focus() {
    requestAnimationFrame(() => {
      scanner.current?.focus();
      scanner.current?.select();
    });
  }
  // A new or edited reading invalidates its own resolution, never the capture still pending.
  function clearReadingResult() {
    attempt.current++;
    inflight.current?.abort();
    setScanMessage('');
    setUnknown(false);
    setReadingScan(undefined);
    setNextFound(null);
    setPendingInput(null);
    setIdentifying(null);
    mutation.clear();
  }
  function clearScanCapture() {
    setLastScan(undefined);
    setScanReview([]);
    setScanNotes([]);
    setDiscarded(false);
  }
  function resetReading() {
    clearReadingResult();
    clearScanCapture();
    setRecognized(null);
    setPolicy(null);
    setEditingId(null);
    setSelectedLotId(null);
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
  const captureDirty =
    Boolean(recognized) &&
    (editingId !== null ||
      serialList(series).length > 0 ||
      lot.trim() !== '' ||
      expiration !== '' ||
      qty.trim() !== '1' ||
      condition !== 'USABLE' ||
      scanReview.length > 0);
  function prefill(found: Found, p: Policy, present: InventoryDocument) {
    const plan = capturePlan(found.scan, p);
    setLot(plan.lot);
    setExpiration(plan.expiration);
    setScanReview(plan.review);
    setScanNotes(plan.notes);
    setDiscarded(false);
    if (plan.serial) {
      if (serialInOperation(plan.serial, '', present.lines, found.product.id, null))
        setScanMessage('Esta serie ya está en la operación.');
      else setSeries(plan.serial);
    }
  }
  async function apply(found: Found, present: InventoryDocument) {
    resetCapture();
    clearScanCapture();
    setRecognized(found.product);
    setPolicy(found.policy);
    setLastScan(found.scan);
    if (!found.policy) return;
    const next = await claim(found.product.id, present);
    prefill(found, found.policy, next);
    requestAnimationFrame(() => quantityInput.current?.focus());
  }
  // A repeated reading of the same group proposes, never adds or replaces, quantities by itself.
  function merge(found: Found, present: InventoryDocument) {
    const p = found.policy;
    const plan = p ? capturePlan(found.scan, p) : null;
    if (
      !recognized ||
      !p ||
      !plan ||
      editingId !== null ||
      !sameCaptureGroup(
        { productId: recognized.id, lot, expiration },
        { productId: found.product.id, plan },
      )
    ) {
      setNextFound(found);
      return;
    }
    if (!p.serialRequired) {
      setScanMessage('Este producto ya está en la captura. Revisá la cantidad y presioná Agregar.');
      requestAnimationFrame(() => quantityInput.current?.focus());
      return;
    }
    if (!plan.serial) setScanMessage('La lectura no trae serie. Ingresala desde la etiqueta.');
    else if (serialInOperation(plan.serial, series, present.lines, recognized.id, editingId))
      setScanMessage('Esta serie ya está en la operación.');
    else if (serialList(series).length >= 100)
      setScanMessage('La captura llegó a 100 series. Agregala antes de seguir escaneando.');
    else {
      setSeries([...serialList(series), plan.serial].join('\n'));
      setScanMessage(
        'Serie ' + plan.serial + ' agregada a la captura. Presioná Agregar para guardar el grupo.',
      );
    }
    focus();
  }
  async function resolveReading(input: ScanInput) {
    if (!doc) return;
    const present = doc;
    const current = ++attempt.current;
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]);
    setScanMessage('');
    setUnknown(false);
    setReadingScan(undefined);
    setNextFound(null);
    setPendingInput(null);
    setIdentifying(null);
    await mutation.run(async () => {
      const result = await catalogFetch('catalog-scans/resolve', scanResultSchema, {
        method: 'POST',
        body: input,
        signal,
      });
      // A late answer never fills a capture that belongs to a newer reading or context.
      if (current !== attempt.current) return;
      if (result.status !== 'KNOWN') {
        setScanMessage(result.message);
        if (result.status !== 'AMBIGUOUS') setReadingScan(result.scan);
        const associable = result.status === 'UNKNOWN' || result.status === 'CANDIDATES';
        setUnknown(associable);
        if (associable) setPendingInput(input);
        focus();
        return;
      }
      const p = await inventoryFetch(
        `products/${result.product.id}/policy`,
        inventoryPolicySchema.nullable(),
        { signal },
      );
      if (current !== attempt.current) return;
      const found = { product: result.product, policy: p, scan: result.scan };
      if (captureDirty) merge(found, present);
      else await apply(found, present);
    });
  }
  async function scan(e: FormEvent) {
    e.preventDefault();
    // Read the element itself: a scanner burst may finish after the last rendered state.
    const value = scanner.current?.value ?? reading;
    if (!doc || !value.trim()) return;
    const supplierId = doc.supplier?.id ?? codeSupplier?.id;
    await resolveReading({ value, namespace, ...(supplierId ? { supplierId } : {}) });
  }
  async function savedPolicy(p: Policy) {
    setPolicy(p);
    if (doc && recognized) {
      const next = await mutation.run(() => claim(recognized.id, doc));
      if (next) {
        setUpdated(next);
        if (lastScan) prefill({ product: recognized, policy: p, scan: lastScan }, p, next);
      }
    }
  }
  function discardScanned(item: ReviewItem) {
    setScanReview((items) => items.filter((i) => i.key !== item.key));
    if (item.key !== 'data') setDiscarded(true);
  }
  function resolveReview(key: ReviewItem['key'], value: string) {
    if (value.trim()) setScanReview((items) => items.filter((i) => i.key !== key));
  }
  async function add() {
    if (!doc || !recognized || !policy || scanReview.length) return;
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
      const pending = nextFound;
      resetCapture();
      resetReading();
      setReading('');
      focus();
      if (pending) await mutation.run(() => apply(pending, next));
    }
  }
  async function edit(l: InventoryDocument['lines'][number]) {
    await mutation.run(async () => {
      const p = await catalogFetch(`products/${l.product.id}`, productSchema);
      const pol = await inventoryFetch(`products/${p.id}/policy`, inventoryPolicySchema.nullable());
      clearReadingResult();
      clearScanCapture();
      setRecognized(p);
      setPolicy(pol);
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
                      clearReadingResult();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && e.nativeEvent.isComposing) e.preventDefault();
                    }}
                    onPaste={(e) => {
                      // Text inputs silently join pasted lines; refuse several readings at once.
                      const problem = pastedReadingProblem(e.clipboardData.getData('text'));
                      if (problem) {
                        e.preventDefault();
                        setScanMessage(problem);
                      }
                    }}
                  />
                </Field>
                <Field label="Tipo de lectura">
                  <select
                    value={namespace}
                    onChange={(e) => {
                      setNamespace(e.target.value as 'AUTO' | 'INTERNAL_CODE');
                      clearReadingResult();
                    }}
                  >
                    <option value="AUTO">Scanner: GTIN, GS1, MB- o código externo</option>
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
                      clearReadingResult();
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
              <ScanDetails scan={readingScan} />
              {unknown && pendingInput && !identifying && (
                <p>
                  Primero identificá este producto. El borrador
                  {captureDirty ? ' y la captura en curso se conservan.' : ' está guardado.'}{' '}
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => setIdentifying(pendingInput)}
                  >
                    Identificar producto
                  </button>
                </p>
              )}
              {nextFound && recognized && (
                <div className="catalog-notice">
                  <p>
                    Leíste {nextFound.product.name}, pero hay una captura sin agregar de{' '}
                    {recognized.name}. Agregala o descartala antes de continuar; no se borra sola.
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy || lineLocked}
                      onClick={() => {
                        const found = nextFound;
                        setNextFound(null);
                        void mutation.run(() => apply(found, doc));
                      }}
                    >
                      Descartar la captura actual y usar la nueva lectura
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => {
                        setNextFound(null);
                        requestAnimationFrame(() => quantityInput.current?.focus());
                      }}
                    >
                      Volver a la captura actual
                    </button>
                  </div>
                  <p>
                    Si presionás Agregar, la nueva lectura se carga después de guardar la actual.
                  </p>
                </div>
              )}
            </div>
          </section>
          {identifying && (
            <section className="catalog-panel">
              <h2>Identificar producto</h2>
              <p>
                El borrador y la captura en curso se conservan mientras identificás el producto. Si
                recargás la página tendrás que volver a escanear.
              </p>
              <ProductIdentification
                embedded={{
                  scan: identifying,
                  supplier:
                    kind === 'receipts' && doc.supplier
                      ? { ...doc.supplier, archivedAt: null }
                      : codeSupplier,
                  onIdentified: () => {
                    // The backend interprets the same reading again for the current draft.
                    const input = identifying;
                    setIdentifying(null);
                    void resolveReading(input);
                  },
                  onCancel: () => {
                    clearReadingResult();
                    focus();
                  },
                }}
              />
            </section>
          )}
          {recognized && (
            <section className="catalog-panel">
              <h2>
                {scanReview.length
                  ? 'Producto reconocido; revisá estos datos'
                  : lastScan
                    ? '✓ Producto reconocido'
                    : 'Producto reconocido'}
              </h2>
              <strong>{recognized.name}</strong>
              <p>
                {recognized.presentation || 'Sin presentación'} · Se cuenta en{' '}
                {quantityLabels[recognized.unitOfMeasure]}.
              </p>
              {!policy && (
                <>
                  {lastScan && (
                    <div>
                      <p>Datos leídos del código (se conservan mientras configurás el producto):</p>
                      <ScanDetails scan={lastScan} />
                    </div>
                  )}
                  <InventoryPolicyEditor
                    key={recognized.id}
                    productId={recognized.id}
                    policy={null}
                    onSaved={savedPolicy}
                  />
                </>
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
                  {scanNotes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                  {scanReview.map((item) => (
                    <div key={item.key} className="catalog-notice" role="status">
                      <p>{item.message}</p>
                      {item.key === 'serial' && !policy.serialRequired && (
                        <InventoryPolicyEditor
                          key={'review-' + policy.version}
                          productId={recognized.id}
                          policy={policy}
                          onSaved={savedPolicy}
                        />
                      )}
                      {item.canDiscard && (
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => discardScanned(item)}
                        >
                          {item.key === 'data'
                            ? 'Revisé la etiqueta'
                            : item.key === 'serial' && !policy.serialRequired
                              ? 'Descartar la serie para este ingreso'
                              : 'Descartar el dato leído'}
                        </button>
                      )}
                    </div>
                  ))}
                  {discarded && <p>Dato escaneado descartado en esta captura.</p>}
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
                            resolveReview('lot', e.target.value);
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
                            resolveReview('expiration', e.target.value);
                          }}
                        />
                      </Field>
                      {expiration &&
                        expiration <
                          new Date().toLocaleDateString('en-CA', {
                            timeZone: 'America/Argentina/Buenos_Aires',
                          }) && (
                          <p className="catalog-notice">
                            Este vencimiento ya pasó: se registra como existencia física, pero no
                            queda disponible.
                          </p>
                        )}
                      {policy.serialRequired && (
                        <Field
                          label="Series (una por línea)"
                          help="La cantidad se calcula a partir de las series. No ingreses una caja como una sola serie si contiene varias unidades individuales."
                        >
                          <textarea
                            value={series}
                            onChange={(e) => {
                              setSeries(e.target.value);
                              resolveReview('serial', e.target.value);
                            }}
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
                    {scanReview.length > 0 && <p>Revisá los datos leídos antes de agregar.</p>}
                    <button
                      className="primary-button"
                      disabled={busy || !counted || scanReview.length > 0}
                    >
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

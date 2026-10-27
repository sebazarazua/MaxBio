'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  customerListSchema,
  productListSchema,
  scanResultSchema,
  deliveryNoteSchema,
  deliveryNoteNumberingSchema,
  deliveryNoteCreateSchema,
  deliveryNoteUpdateSchema,
  inventoryStockDetailSchema,
  inventoryPhysicalMatchSchema,
  physicalMatchReasonMessages,
  type DeliveryNoteView,
  type DeliveryNoteCreate,
  type ProductView,
  type InventoryStockDetail,
  type InventoryPhysicalMatch,
  type ScanInput,
  type ScanInterpretation,
} from '@maxbio/contracts';
import { catalogFetch, CatalogHttpError, humanError } from '@/lib/catalog-api';
import { inventoryFetch } from '@/lib/inventory-api';
import { pastedReadingProblem } from '@/lib/gs1-capture';
import {
  scaled,
  allocatedByPosition,
  decimal,
  hasPhysicalData,
  matchCriteria,
  remaining,
  selectionAllocations,
  type Selection,
} from '@/lib/delivery-match';
import {
  Feedback,
  Field,
  Pagination,
  EntityChoice,
  useResource,
  useSearch,
} from '../catalog/common';
import { documentLabels, quantityLabels } from '../inventory/common';
import { DocumentaryTraceEditor, SerialHistoryReview } from './trace-editor';
import { scannedDeclaration, declaredFromView, splitDeclaration } from '../../lib/delivery-traces';
import { useWorkspace } from '../workspace';
import { DeliveryPrintPanel } from '../printing/delivery-print-panel';
import { LiveDeliveryPreview } from '../printing/live-delivery-preview';
import { humanPrintMessage } from '../printing/print-labels';
import { ProductIdentification } from '../catalog/identification';
import { ScanDetails } from '../catalog/scan-details';
type Line = DeliveryNoteCreate['lines'][number] & {
  productName: string;
  unitOfMeasure: ProductView['unitOfMeasure'];
  presentation: string | null;
  physical: DeliveryNoteView['lines'][number]['allocations'];
  savedTraceIds?: string[];
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
  const [changing, setChanging] = useState(false);
  const search = useSearch();
  const result = useResource('?' + search.query, customerListSchema, 'customers');
  if (selected && !changing)
    return (
      <div className="delivery-customer-card">
        <h3>{selected.name}</h3>
        {selected.cuit && <p>CUIT {selected.cuit}</p>}
        <p>{[selected.addressLine, selected.locality].filter(Boolean).join(' · ')}</p>
        <button type="button" className="secondary-button" onClick={() => setChanging(true)}>
          Cambiar cliente
        </button>
      </div>
    );
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
              onClick={() => {
                change(c);
                setChanging(false);
              }}
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
  const [choosing, setChoosing] = useState(false);
  const [declaredId, setDeclaredId] = useState('');
  const [linkError, setLinkError] = useState('');
  const result = useResource(
    `products/${productId}?page=${page}`,
    inventoryStockDetailSchema,
    'inventory',
  );
  const d = result.data;
  function select(p: InventoryStockDetail['positions'][number], qty: string) {
    setLinkError('');
    let declared = value.physicalTraces ?? [];
    const prior = value.allocations.find((a) => a.positionId === p.id);
    const existing = value.physical.find((a) => a.positionId === p.id);
    const allocations = value.allocations.filter((a) => a.positionId !== p.id);
    const physical = value.physical.filter((a) => a.positionId !== p.id);
    if (qty && qty !== '0') {
      const selected = declaredId && !prior ? declared.find((t) => t.id === declaredId) : undefined;
      let source: typeof selected;
      if (selected) {
        if (
          (selected.lotNumber && selected.lotNumber !== p.lotNumber) ||
          (selected.expirationDate && selected.expirationDate !== p.expirationDate) ||
          (selected.serialNumber && selected.serialNumber !== p.serialNumber)
        ) {
          setLinkError(
            'Los datos del Remito no coinciden con esta existencia. Revisalos antes de vincular.',
          );
          return;
        }
        try {
          const split = splitDeclaration(declared, selected.id, qty);
          declared = split.traces;
          source = split.source;
        } catch (e) {
          setLinkError(humanError(e));
          return;
        }
      }
      allocations.push({
        positionId: p.id,
        quantity: qty.replace(',', '.'),
        traceId: prior?.traceId ?? crypto.randomUUID(),
        ...(source && value.savedTraceIds?.includes(source.id) ? { sourceTraceId: source.id } : {}),
        scanValue: source?.scanValue ?? prior?.scanValue,
        preserveOnUnlink: Boolean(source || prior?.preserveOnUnlink),
      });
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
    } else if (prior?.preserveOnUnlink && existing) {
      declared = [
        ...declared,
        {
          id: prior.traceId ?? crypto.randomUUID(),
          quantity: prior.quantity,
          lotNumber: existing.lotNumber,
          expirationDate: existing.expirationDate,
          serialNumber: existing.serialNumber,
          scanValue: prior.scanValue,
        },
      ];
    }
    change({ ...value, allocations, physical, physicalTraces: declared });
  }
  if (!choosing)
    return (
      <div className="delivery-selected-stock">
        <p>
          <strong>Stock registrado en MaxBio · Opcional</strong>
        </p>
        {value.allocations.length === 0 && d?.summary.available === '0' && (
          <p>No hay stock registrado para este producto. Podés continuar con el remito.</p>
        )}
        {value.physical.map((a) => (
          <p key={a.positionId}>
            {a.quantity} · {a.lotNumber ? 'Lote ' + a.lotNumber : 'Sin lote'}
            {a.expirationDate ? ' · Vence ' + a.expirationDate.split('-').reverse().join('/') : ''}
            {a.serialNumber ? ' · Serie ' + a.serialNumber : ''}
          </p>
        ))}
        <button type="button" className="secondary-button" onClick={() => setChoosing(true)}>
          Vincular stock / lote / serie
        </button>
      </div>
    );
  return (
    <div>
      <h4>Stock registrado en MaxBio · Opcional</h4>
      {(value.physicalTraces ?? []).length > 0 && (
        <Field label="Vincular una cantidad ya documentada">
          <select value={declaredId} onChange={(e) => setDeclaredId(e.target.value)}>
            <option value="">Vincular cantidad sin detalle físico previo</option>
            {value.physicalTraces?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.quantity} · {t.lotNumber ?? 'Sin lote'} · {t.serialNumber ?? 'Sin serie'}
              </option>
            ))}
          </select>
        </Field>
      )}
      {linkError && <p role="alert">{linkError}</p>}
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
            <p>
              Para vincular stock, un administrador debe revisar los datos físicos del producto.
              Podés continuar sin vincular stock.
            </p>
          )}
          {d.summary.countInProgress && (
            <p>
              Producto en conteo. Podés continuar sin vincular stock; para usar estas existencias,
              esperá a que termine.
            </p>
          )}
          {d.summary.available === '0' && (
            <p>No hay stock registrado para este producto. Podés continuar con el remito.</p>
          )}
          <p>
            Existencias ordenadas por vencimiento. Elegí el lote o la serie que tenés físicamente.
          </p>
          {d.positions.map((p) => {
            const eligible =
              Boolean(d.policy) &&
              !p.expired &&
              p.condition === 'USABLE' &&
              !d.summary.countInProgress;
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
          {value.allocations.length > 0 && (
            <button type="button" className="secondary-button" onClick={() => setChoosing(false)}>
              Usar estas existencias
            </button>
          )}
          <Pagination {...d} change={setPage} />
          {value.allocations.length > 0 && (
            <div>
              <p>Seleccionadas: {value.allocations.length} existencias</p>
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  change({
                    ...value,
                    allocations: [],
                    physical: [],
                    physicalTraces: [
                      ...(value.physicalTraces ?? []),
                      ...value.allocations
                        .filter((a) => a.preserveOnUnlink)
                        .flatMap((a) => {
                          const p = value.physical.find((p) => p.positionId === a.positionId);
                          return p
                            ? [
                                {
                                  id: a.traceId ?? crypto.randomUUID(),
                                  quantity: a.quantity,
                                  lotNumber: p.lotNumber,
                                  expirationDate: p.expirationDate,
                                  serialNumber: p.serialNumber,
                                  scanValue: a.scanValue,
                                },
                              ]
                            : [];
                        }),
                    ],
                  })
                }
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

type Linked = Pick<Line, 'quantity' | 'allocations' | 'physical' | 'physicalTraces'>;
type Capture = {
  input: ScanInput;
  product: ProductView;
  scan?: ScanInterpretation;
  criteria: NonNullable<ReturnType<typeof matchCriteria>>;
  match: InventoryPhysicalMatch | null;
};
const reasonList = (codes: InventoryPhysicalMatch['reasonCodes']) => [
  ...new Set(codes.map((code) => physicalMatchReasonMessages[code])),
];
const positionText = (p: InventoryPhysicalMatch['positions'][number]) =>
  [
    p.lotNumber ? 'Lote ' + p.lotNumber : 'Sin lote',
    p.expirationDate ? 'Vence ' + p.expirationDate.split('-').reverse().join('/') : null,
    p.serialNumber ? 'Serie ' + p.serialNumber : null,
    p.location.name,
  ]
    .filter(Boolean)
    .join(' · ');

function ProductCapture({
  add,
  lines,
}: {
  add: (p: ProductView, linked?: Linked) => void;
  lines: Line[];
}) {
  const search = useSearch();
  const products = useResource('products?' + search.query, productListSchema);
  const [reading, setReading] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [namespace, setNamespace] = useState<'AUTO' | 'INTERNAL_CODE'>('AUTO');
  const [supplier, setSupplier] = useState<{
    id: string;
    name: string;
    archivedAt: string | null;
  } | null>(null);
  // Ephemeral GS1 capture: never in URL, storage, cookies or audit, and never persisted as raw text.
  const [readingScan, setReadingScan] = useState<ScanInterpretation | undefined>(undefined);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [selection, setSelection] = useState<Selection>({});
  const [selectionError, setSelectionError] = useState('');
  const [pendingInput, setPendingInput] = useState<ScanInput | null>(null);
  const [identifying, setIdentifying] = useState<ScanInput | null>(null);
  const input = useRef<HTMLInputElement>(null),
    guard = useRef(false),
    attempt = useRef(0);
  const allocated = allocatedByPosition(lines);
  function focus() {
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }
  function clearReading() {
    attempt.current++;
    setMessage('');
    setReadingScan(undefined);
    setPendingInput(null);
    setIdentifying(null);
  }
  function finish(text: string) {
    setCapture(null);
    setSelection({});
    setSelectionError('');
    setReading('');
    setMessage(text);
    focus();
  }
  async function match(product: ProductView, criteria: Capture['criteria'], page: number) {
    return inventoryFetch(`products/${product.id}/physical-match`, inventoryPhysicalMatchSchema, {
      method: 'POST',
      body: { ...criteria, page, limit: 20 },
    });
  }
  async function resolve(value: ScanInput) {
    if (guard.current) return;
    guard.current = true;
    const current = ++attempt.current;
    setBusy(true);
    setMessage('');
    setReadingScan(undefined);
    setPendingInput(null);
    setIdentifying(null);
    try {
      const result = await catalogFetch('catalog-scans/resolve', scanResultSchema, {
        method: 'POST',
        body: value,
      });
      if (current !== attempt.current) return;
      if (result.status !== 'KNOWN') {
        setMessage(
          result.status === 'UNKNOWN'
            ? 'Este código todavía no está identificado.'
            : result.message,
        );
        if (result.status !== 'AMBIGUOUS') setReadingScan(result.scan);
        if (result.status === 'UNKNOWN' || result.status === 'CANDIDATES') setPendingInput(value);
        return;
      }
      const criteria = matchCriteria(result.scan);
      if (!criteria) {
        // GTIN only (or month-only date): same flow as before, stock stays optional.
        add(result.product);
        setReadingScan(result.scan);
        finish(
          hasPhysicalData(result.scan)
            ? 'Producto agregado. Revisá los datos pendientes y completalos manualmente en el Remito.'
            : 'Producto agregado. Podés elegir la existencia física en Stock.',
        );
        return;
      }
      let found: InventoryPhysicalMatch | null = null;
      try {
        found = await match(result.product, criteria, 1);
      } catch (e) {
        setMessage(humanError(e) + ' Podés agregar el producto sin vincular Stock.');
      }
      if (current !== attempt.current) return;
      setSelection({});
      setSelectionError('');
      setCapture({
        input: value,
        product: result.product,
        scan: result.scan,
        criteria,
        match: found,
      });
    } catch (e) {
      setMessage(humanError(e));
    } finally {
      guard.current = false;
      setBusy(false);
      focus();
    }
  }
  async function scan() {
    // Read the element itself: a scanner burst may finish after the last rendered state.
    const value = input.current?.value ?? reading;
    if (!value.trim()) return;
    if (capture) {
      setMessage(
        'Resolvé la lectura anterior antes de escanear otra: vinculala, agregala sin vincular Stock o descartala.',
      );
      return;
    }
    await resolve({ value, namespace, ...(supplier ? { supplierId: supplier.id } : {}) });
  }
  async function page(next: number) {
    if (!capture || guard.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const found = await match(capture.product, capture.criteria, next);
      setCapture({ ...capture, match: found });
    } catch (e) {
      setMessage(humanError(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function link(selected: Selection) {
    if (!capture?.match) return;
    const built = selectionAllocations(
      capture.match.positions,
      selected,
      allocated,
      capture.product.unitOfMeasure,
    );
    if ('error' in built) {
      setSelectionError(built.error ?? '');
      return;
    }
    add(capture.product, {
      ...built,
      allocations: built.allocations.map((a) => ({
        ...a,
        scanValue: capture.scan?.canApplyPhysicalData ? capture.input.value : undefined,
        preserveOnUnlink: Boolean(
          capture.scan?.canApplyPhysicalData && hasPhysicalData(capture.scan),
        ),
      })),
    });
    finish(
      'Producto agregado con el Stock vinculado. La confirmación del Remito vuelve a validarlo.',
    );
  }
  function withoutStock() {
    if (!capture) return;
    const physicalTraces = scannedDeclaration(capture.scan, capture.input.value);
    add(capture.product, { quantity: '1', allocations: [], physical: [], physicalTraces });
    finish(
      physicalTraces.length
        ? 'Producto agregado. Los datos físicos quedan registrados solo en el Remito; no modifican Stock.'
        : 'Producto agregado sin vincular Stock. Revisá o completá manualmente los datos físicos pendientes.',
    );
  }
  const m = capture?.match;
  const exact = m?.status === 'EXACT' ? m.positions[0] : undefined;
  const exactLinked = exact ? remaining(exact, allocated) === 0n : false;
  return (
    <div className="catalog-panel">
      <h3>Escanear producto</h3>
      <Field label="Código del producto">
        <input
          ref={input}
          value={reading}
          maxLength={512}
          disabled={busy}
          autoComplete="off"
          spellCheck={false}
          className="scanner-input code"
          onChange={(e) => {
            setReading(e.target.value);
            clearReading();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (!e.nativeEvent.isComposing) void scan();
            }
          }}
          onPaste={(e) => {
            const problem = pastedReadingProblem(e.clipboardData.getData('text'));
            if (problem) {
              e.preventDefault();
              setMessage(problem);
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
              clearReading();
            }}
          >
            <option value="AUTO">Código de barras (GTIN, GS1, MB- o externo)</option>
            <option value="INTERNAL_CODE">Código interno</option>
          </select>
        </Field>
        <EntityChoice
          kind="suppliers"
          label="Proveedor del código externo"
          value={supplier}
          change={(s) => {
            setSupplier(s);
            clearReading();
          }}
          allowCreate={false}
        />
      </details>
      <div role="status" aria-live="polite">
        {message && <p>{message}</p>}
        <ScanDetails scan={readingScan} />
        {pendingInput && !identifying && (
          <p>
            Primero identificá este producto; el remito en curso se conserva.{' '}
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
      </div>
      {identifying && (
        <section className="catalog-panel">
          <h4>Identificar producto</h4>
          <p>
            El remito en curso se conserva mientras identificás el producto. Si recargás la página
            tendrás que volver a escanear.
          </p>
          <ProductIdentification
            embedded={{
              scan: identifying,
              supplier,
              onIdentified: () => {
                // The backend interprets the same reading again before matching Stock.
                const value = identifying;
                setIdentifying(null);
                void resolve(value);
              },
              onCancel: () => {
                clearReading();
                focus();
              },
            }}
          />
        </section>
      )}
      {capture && (
        <section className="identification-known" role="status" aria-live="polite">
          <h4>
            {capture.scan?.status === 'PARTIAL'
              ? 'Producto reconocido; revisá estos datos'
              : '✓ Producto reconocido'}
          </h4>
          <strong>{capture.product.name}</strong>
          <ScanDetails scan={capture.scan} />
          {m?.status === 'EXACT' && exact && (
            <div className="delivery-position">
              <p>
                <strong>
                  {exactLinked
                    ? 'Esta unidad ya está vinculada en este Remito.'
                    : 'Encontramos esta unidad en Stock.'}
                </strong>
              </p>
              <p>Registrado en Stock: {positionText(exact)}</p>
              {!exactLinked && (
                <button
                  type="button"
                  className="primary-button"
                  disabled={busy}
                  onClick={() => link({ [exact.positionId]: '1' })}
                >
                  Vincular al Remito
                </button>
              )}
            </div>
          )}
          {m?.status === 'CHOICES' && (
            <div>
              <p>
                <strong>
                  Encontramos {m.total}{' '}
                  {m.total === 1 ? 'existencia compatible' : 'existencias compatibles'} en Stock.
                </strong>{' '}
                Disponible: {m.availableQuantity} {quantityLabels[capture.product.unitOfMeasure]}.
                La selección no reserva stock.
              </p>
              {m.positions.map((p) => {
                const left = remaining(p, allocated);
                return (
                  <div className="delivery-position" key={p.positionId}>
                    <p>
                      {positionText(p)}
                      <br />
                      {p.eligible
                        ? 'Disponible para este remito: ' + decimal(left)
                        : physicalMatchReasonMessages[p.unavailableReason!]}
                    </p>
                    {p.eligible && left > 0n && p.serialId && (
                      <label className="check-field">
                        <input
                          type="checkbox"
                          checked={Boolean(selection[p.positionId])}
                          onChange={(e) =>
                            setSelection({
                              ...selection,
                              [p.positionId]: e.target.checked ? '1' : '',
                            })
                          }
                        />{' '}
                        Elegir serie {p.serialNumber}
                      </label>
                    )}
                    {p.eligible && left > 0n && !p.serialId && (
                      <Field
                        label={
                          'Cantidad de ' + (p.lotNumber ? 'lote ' + p.lotNumber : 'esta existencia')
                        }
                      >
                        <input
                          inputMode="decimal"
                          value={selection[p.positionId] ?? ''}
                          placeholder="0"
                          onChange={(e) =>
                            setSelection({ ...selection, [p.positionId]: e.target.value })
                          }
                        />
                      </Field>
                    )}
                    {p.eligible && left === 0n && <p>Ya vinculada en este Remito.</p>}
                  </div>
                );
              })}
              <Pagination
                total={m.total}
                page={m.page}
                limit={m.limit}
                change={(n) => void page(n)}
              />
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => link(selection)}
              >
                Agregar con las existencias elegidas
              </button>
              {selectionError && <p role="alert">{selectionError}</p>}
            </div>
          )}
          {m?.status === 'MISSING' && (
            <p>
              <strong>
                El producto fue reconocido, pero esta unidad no está registrada en Stock de MaxBio.
              </strong>{' '}
              {reasonList(m.reasonCodes).join(' ')} Podés agregarlo igualmente al Remito.
            </p>
          )}
          {m?.status === 'UNAVAILABLE' && (
            <>
              <p>
                <strong>La unidad está registrada, pero no está disponible para salida.</strong>{' '}
                {reasonList(m.reasonCodes).join(' ')}
              </p>
              {m.positions.map((p) => (
                <p key={p.positionId}>Registrado en Stock: {positionText(p)}</p>
              ))}
            </>
          )}
          {m?.status === 'CONFLICT' && (
            <>
              <p>
                <strong>Los datos escaneados no coinciden con los registrados en Stock.</strong>{' '}
                {reasonList(m.reasonCodes).join(' ')} Revisá la etiqueta; no se corrige ningún dato
                automáticamente.
              </p>
              {m.positions.map((p) => (
                <p key={p.positionId}>Registrado en Stock: {positionText(p)}</p>
              ))}
            </>
          )}
          <p className="muted">
            Los datos válidos de lote, vencimiento y serie quedarán registrados en el Remito, pero
            no modificarán Stock. Los datos pendientes de revisión deben completarse manualmente.
          </p>
          <div className="actions">
            <button
              type="button"
              className={m?.status === 'MISSING' ? 'primary-button' : 'secondary-button'}
              disabled={busy}
              onClick={withoutStock}
            >
              {m?.status === 'MISSING'
                ? 'Agregar igualmente al Remito'
                : 'Agregar sin vincular Stock'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => finish('Lectura descartada. No se agregó nada al Remito.')}
            >
              Descartar lectura
            </button>
          </div>
        </section>
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
          {l.physicalTraces.map((a) => (
            <p key={a.id}>
              {a.quantity} · {a.lotNumber ? 'Lote ' + a.lotNumber : 'Sin lote'} ·{' '}
              {a.expirationDate
                ? 'Vence ' + a.expirationDate.split('-').reverse().join('/')
                : 'Sin vencimiento'}
              {a.serialNumber ? ' · Serie ' + a.serialNumber : ''} ·{' '}
              {a.origin === 'INVENTORY' ? 'Vinculado a Stock' : 'Registrado solo en el Remito'}
            </p>
          ))}
          {doc.movementId && l.allocations.length > 0 && (
            <Link href={'/stock/' + l.productId + '#movimiento-' + doc.movementId}>
              Ver movimiento de stock relacionado
            </Link>
          )}
        </div>
      ))}
      {doc.status === 'CONFIRMED' && doc.lines.some((l) => l.physicalTraces.length > 0) && (
        <p>
          <Link
            href={
              '/trazabilidad?search=' +
              encodeURIComponent(doc.documentPrefix + '-' + doc.documentNumber)
            }
          >
            Ver en Trazabilidad
          </Link>
        </p>
      )}
      {doc.notes && <p className="preserve-lines">Observaciones: {doc.notes}</p>}
      {doc.confirmedAt && (
        <p>
          Confirmó {doc.confirmedBy} · {new Date(doc.confirmedAt).toLocaleString('es-AR')}
        </p>
      )}
      {doc.status === 'CONFIRMED' && !doc.movementId && (
        <p className="muted">Sin movimiento de stock asociado</p>
      )}
      {doc.status === 'CONFIRMED' && <p>Este remito ya fue confirmado y no puede modificarse.</p>}
    </section>
  );
}

function Editor({ doc, saved }: { doc?: DeliveryNoteView; saved: (d: DeliveryNoteView) => void }) {
  const { isAdmin } = useWorkspace();
  const [printReady, setPrintReady] = useState(false);
  const [reviewedHistory, setReviewedHistory] = useState<string[] | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(doc?.customer ?? null);
  const [date, setDate] = useState(doc?.documentDate ?? '');
  const numbering = useResource(
    doc?.documentNumber ? null : 'numbering',
    deliveryNoteNumberingSchema,
    'delivery-notes',
  );
  const prefix = doc?.documentPrefix ?? numbering.data?.prefix ?? '';
  const number = doc?.documentNumber ?? numbering.data?.suggestedNumber ?? '';
  const [patient, setPatient] = useState(doc?.patientName ?? ''),
    [affiliate, setAffiliate] = useState(doc?.affiliateNumber ?? ''),
    [notes, setNotes] = useState(doc?.notes ?? '');
  const [patientOpen, setPatientOpen] = useState(Boolean(doc?.patientName || doc?.affiliateNumber));
  const [lines, setLines] = useState<Line[]>(
    doc?.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      productName: l.productName,
      presentation: l.presentation,
      unitOfMeasure: l.unitOfMeasure,
      quantity: l.quantity,
      allocations: l.allocations.map((a) => {
        const t = l.physicalTraces.find((t) => t.inventoryAllocationId === a.id);
        return {
          positionId: a.positionId,
          quantity: a.quantity,
          traceId: t?.id,
          preserveOnUnlink: t?.preserveOnUnlink,
        };
      }),
      physicalTraces: l.physicalTraces.filter((t) => t.origin === 'DECLARED').map(declaredFromView),
      savedTraceIds: l.physicalTraces.map((t) => t.id),
      physical: l.allocations,
    })) ?? [],
  );
  const [dirty, setDirty] = useState(!doc),
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
      setError(humanPrintMessage(humanError(e)));
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
      patientName: patient || null,
      affiliateNumber: affiliate || null,
      notes: notes || null,
      lines: lines.map((l) => ({
        id: l.id,
        productId: l.productId,
        quantity: l.quantity.replace(',', '.'),
        allocations: l.allocations,
        physicalTraces: l.physicalTraces ?? [],
      })),
    };
    const parsed = doc
      ? deliveryNoteUpdateSchema.safeParse({ ...fields, expectedVersion: doc.version })
      : deliveryNoteCreateSchema.safeParse({ ...fields, id: id.current });
    if (!parsed.success) {
      setError('Revisá el cliente, la fecha y las cantidades.');
      return;
    }
    attempt.current = { path: doc?.id ?? '', method: doc ? 'PATCH' : 'POST', body: parsed.data };
    void run();
  }
  function confirm() {
    if (!doc || dirty || frozen || guard.current || !printReady || reviewedHistory === null) return;
    attempt.current = {
      path: doc.id + '/confirm',
      method: 'POST',
      body: {
        operationId: crypto.randomUUID(),
        expectedVersion: doc.version,
        ...(reviewedHistory?.length ? { reviewedPriorTraceIds: reviewedHistory } : {}),
      },
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
      <div className="delivery-workspace">
        <div className="delivery-entry">
          <fieldset disabled={frozen} className="delivery-editor">
            <section className="catalog-panel">
              <h2>1. Cliente</h2>
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
              <h2>2. Datos del remito</h2>
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
              </div>
              <details
                open={patientOpen}
                onToggle={(event) => setPatientOpen(event.currentTarget.open)}
              >
                <summary>Datos del paciente (opcional)</summary>
                <div className="form-grid">
                  <Field label="Paciente">
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
              </details>
              {!doc?.documentNumber && <Feedback {...numbering} reload={numbering.reload} />}
              {!number && numbering.data && (
                <p role="status">
                  {numbering.data.configured
                    ? 'Se agotó la numeración del talonario.'
                    : 'Un administrador debe configurar la numeración una sola vez.'}{' '}
                  {isAdmin && <Link href="/remitos#numeracion">Configurar numeración</Link>}
                </p>
              )}
              {(prefix || number) && (
                <p className="print-number">
                  Remito físico: {prefix || '…'}-{number || '…'}
                </p>
              )}
              <p className="muted">
                MaxBio asigna el número automáticamente.
                {!doc?.documentNumber && ' El número definitivo se asigna al guardar.'}
              </p>
            </section>
            <section>
              <h2>3. Productos</h2>
              <ProductCapture
                lines={lines}
                add={(p, linked) => {
                  setLines((previous) => [
                    ...previous,
                    {
                      id: crypto.randomUUID(),
                      productId: p.id,
                      productName: p.name,
                      presentation: p.presentation,
                      unitOfMeasure: p.unitOfMeasure,
                      quantity: linked?.quantity ?? '1',
                      allocations: linked?.allocations ?? [],
                      physical: linked?.physical ?? [],
                      physicalTraces: linked?.physicalTraces ?? [],
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
                  <p className="muted">
                    La vinculación de stock es opcional. Podés documentar toda la cantidad aunque no
                    esté registrada en MaxBio.
                  </p>
                  <DocumentaryTraceEditor
                    traces={l.physicalTraces ?? []}
                    change={(physicalTraces) => changeLine(i, { ...l, physicalTraces })}
                  />
                  <p>
                    Stock vinculado:{' '}
                    {decimal(l.allocations.reduce((n, a) => n + (scaled(a.quantity) ?? 0n), 0n))} ·
                    Registrado solo en el Remito:{' '}
                    {decimal(
                      (l.physicalTraces ?? []).reduce((n, t) => n + (scaled(t.quantity) ?? 0n), 0n),
                    )}{' '}
                    · Total: {l.quantity}
                  </p>
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
              disabled={frozen || !customer || (!doc?.documentNumber && !number)}
              onClick={save}
            >
              {busy ? 'Guardando…' : 'Guardar borrador'}
            </button>
            {doc && (
              <button
                type="button"
                className="primary-button"
                disabled={frozen || dirty || !printReady}
                onClick={() => setReview(true)}
              >
                Revisar y confirmar salida
              </button>
            )}
          </div>
          {dirty && (
            <p role="status">
              Hay cambios sin guardar. Guardá el borrador antes de confirmar o salir.
            </p>
          )}
          {review && !dirty && (
            <section className="catalog-panel" role="region" aria-label="Revisar salida">
              <h2>4. Revisar y confirmar salida</h2>
              <p>
                Al confirmar, solo las cantidades vinculadas se descontarán del stock. El remito ya
                no podrá editarse.
              </p>
              <p>Comprobá el número del talonario y los lotes o series físicos elegidos.</p>
              <p>
                <strong>
                  Remito físico: {prefix}-{number}
                </strong>{' '}
                · {customer?.name}
              </p>
              {lines.map((line) => (
                <div className="delivery-position" key={line.id}>
                  <strong>
                    {line.productName} · {line.quantity} {quantityLabels[line.unitOfMeasure]}
                  </strong>
                  {[...line.physical, ...(line.physicalTraces ?? [])].map((a) => (
                    <p key={'positionId' in a ? a.positionId : a.id}>
                      {a.quantity} · {a.lotNumber ? 'Lote ' + a.lotNumber : 'Sin lote'}
                      {a.expirationDate ? ' · Vence ' + a.expirationDate : ''}
                      {a.serialNumber ? ' · Serie ' + a.serialNumber : ''}
                    </p>
                  ))}
                </div>
              ))}
              <SerialHistoryReview doc={doc!} ready={setReviewedHistory} />
              <button
                className="primary-button"
                type="button"
                disabled={frozen || !printReady || reviewedHistory === null}
                onClick={confirm}
              >
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
        </div>
        <LiveDeliveryPreview
          configurationLink={
            isAdmin ? <Link href="/remitos/impresion">Preparar plantilla</Link> : undefined
          }
          onValidation={setPrintReady}
          input={{
            ...(customer ? { customerId: customer.id } : {}),
            ...(date ? { documentDate: date } : {}),
            documentPrefix: prefix || null,
            documentNumber: number || null,
            patientName: patient || null,
            affiliateNumber: affiliate || null,
            notes: notes || null,
            lines: lines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity.replace(',', '.'),
              allocations: l.allocations,
              physicalTraces: l.physicalTraces ?? [],
            })),
          }}
        />
      </div>
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
    setEditorRevision((value) => value + 1);
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
          <>
            <ReadOnly doc={doc} />
            {doc.status === 'CONFIRMED' && <DeliveryPrintPanel doc={doc} />}
          </>
        ) : (
          <Editor
            key={(doc ? doc.id + ':' + doc.version : 'new') + ':' + editorRevision}
            doc={doc}
            saved={saved}
          />
        ))}
    </>
  );
}

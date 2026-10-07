'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  identificationConfirmationSchema,
  identificationConfirmSchema,
  scanResultSchema,
  supplierCatalogListSchema,
  productListSchema,
  productSchema,
  identifierListSchema,
  supplierScanIdentifierListSchema,
  unitLabels,
  type UnitOfMeasure,
  type ProductView,
  type SupplierCatalogItemView,
  type ScanInput,
  type ScanResult,
  type IdentificationConfirm,
} from '@maxbio/contracts';
import { catalogFetch, humanError } from '@/lib/catalog-api';
import {
  EntityChoice,
  Feedback,
  Field,
  Pagination,
  SearchBar,
  useResource,
  useSearch,
} from './common';
import { ReferenceAssociation } from './supplier-catalog';

type Choice = { id: string; name: string; archivedAt: string | null };
function ProductComparison({ product }: { product: ProductView }) {
  const external = useResource(
    `products/${product.id}/supplier-scan-identifiers?limit=10`,
    supplierScanIdentifierListSchema,
  );
  const identifiers = useResource(
    `products/${product.id}/identifiers?limit=10`,
    identifierListSchema,
  );
  return (
    <div className="identification-comparison">
      <strong>{product.name}</strong>
      <p>
        {product.brand?.name || 'Sin marca'} · {product.model || 'Sin modelo'} ·{' '}
        {product.presentation || 'Sin presentación'} · {unitLabels[product.unitOfMeasure]}
      </p>
      <p>Códigos internos: {product.internalCodes.join(', ') || 'Sin códigos'}</p>
      <Feedback {...identifiers} reload={identifiers.reload} />
      {identifiers.data && (
        <p>
          Identificadores:{' '}
          {identifiers.data.items.map((item) => `${item.kind}: ${item.value}`).join(' · ') ||
            'Sin identificadores'}
          {identifiers.data.total > 10 && ' (primeros 10)'}
        </p>
      )}
      <Link href={'/productos/' + product.id} target="_blank" rel="noopener">
        Ver ficha completa
      </Link>
      <Feedback {...external} reload={external.reload} />
      {external.data && external.data.total > 0 && (
        <p>
          Códigos externos por proveedor:{' '}
          {external.data.items.map((item) => `${item.supplier.name}: ${item.value}`).join(' · ')}
          {external.data.total > 10 && ' (primeros 10)'}
        </p>
      )}
    </div>
  );
}
function ReferenceSearch({
  candidates,
  select,
  supplierId,
}: {
  candidates: SupplierCatalogItemView[];
  select: (item: SupplierCatalogItemView) => void;
  supplierId?: string;
}) {
  const search = useSearch();
  const references = useResource(
    'supplier-catalog-items?' + search.query + (supplierId ? '&supplierId=' + supplierId : ''),
    supplierCatalogListSchema,
  );
  const row = (item: SupplierCatalogItemView) => (
    <li key={item.id}>
      <div>
        <strong>
          {item.internalReferenceCode} · {item.supplier.name} · Código del proveedor:{' '}
          {item.supplierCode ?? '—'}
        </strong>
        <p>
          {item.description ?? '—'} · {item.brandText ?? '—'} · {item.presentationText ?? '—'}
        </p>
        <ReferenceAssociation item={item} />
      </div>
      <button
        type="button"
        className="secondary-button"
        disabled={Boolean(
          item.archivedAt ||
          item.supplier.archivedAt ||
          item.supplierProduct?.archivedAt ||
          item.supplierProduct?.product.archivedAt,
        )}
        onClick={() => select(item)}
      >
        Seleccionar {item.internalReferenceCode}
      </button>
    </li>
  );
  return (
    <section className="catalog-panel">
      <h2>1. Seleccionar referencia del proveedor</h2>
      {candidates.length > 0 && (
        <>
          <p>Coincidencias fuertes declaradas por el proveedor; requieren tu confirmación.</p>
          <ul className="identification-results">{candidates.map(row)}</ul>
        </>
      )}
      <SearchBar
        state={search}
        placeholder="Código, descripción, marca, presentación, GTIN o proveedor"
      />
      <Feedback {...references} reload={references.reload} />
      {references.data && (
        <>
          <ul className="identification-results">{references.data.items.map(row)}</ul>
          {!references.data.total && (
            <p>No hay referencias. Un administrador puede importar la lista desde Proveedores.</p>
          )}
          <Pagination {...references.data} change={search.setPage} />
        </>
      )}
    </section>
  );
}
function AssociationForm({
  reference,
  scan,
  completed,
  cancel,
  onBusy,
}: {
  reference: SupplierCatalogItemView;
  scan: ScanInput;
  completed: (product: ProductView) => void;
  cancel: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const search = useSearch();
  const products = useResource('products?' + search.query, productListSchema);
  const [selected, setSelected] = useState<ProductView | null>(null);
  const linked = useResource(
    reference.supplierProduct ? 'products/' + reference.supplierProduct.product.id : null,
    productSchema,
  );
  const [mode, setMode] = useState<'EXISTING' | 'NEW'>('EXISTING');
  const [name, setName] = useState(
    reference.description && reference.description.length <= 200 ? reference.description : '',
  );
  const [presentation, setPresentation] = useState(reference.presentationText ?? '');
  const [unit, setUnit] = useState<UnitOfMeasure>('UNIT');
  const [brand, setBrand] = useState<Choice | null>(null);
  const [category, setCategory] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<IdentificationConfirm | null>(null);
  const guard = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const effective = reference.supplierProduct ? linked.data : selected;
  function prepare(event: FormEvent) {
    event.preventDefault();
    setError('');
    const parsed = identificationConfirmSchema.safeParse({
      operationId: crypto.randomUUID(),
      scan,
      referenceId: reference.id,
      expectedReferenceVersion: reference.version,
      target:
        mode === 'NEW' && !reference.supplierProduct
          ? {
              mode,
              product: {
                name,
                unitOfMeasure: unit,
                presentation: presentation || null,
                brandId: brand?.id ?? null,
                categoryId: category?.id ?? null,
              },
            }
          : {
              mode: 'EXISTING',
              productId: effective?.id,
              expectedProductVersion: effective?.version,
            },
    });
    if (!parsed.success) {
      setError(
        'Seleccioná un producto existente o completá el nombre y la unidad del nuevo producto.',
      );
      return;
    }
    setReview(parsed.data);
  }
  async function confirm() {
    if (guard.current || !review) return;
    guard.current = true;
    onBusy(true);
    setBusy(true);
    setError('');
    try {
      const result = await catalogFetch(
        'catalog-identifications/confirm',
        identificationConfirmationSchema,
        { method: 'POST', body: review },
      );
      completed(result.product);
    } catch (cause) {
      setError(humanError(cause));
    } finally {
      guard.current = false;
      onBusy(false);
      setBusy(false);
    }
  }
  return (
    <section className="catalog-panel">
      <h2 ref={heading} tabIndex={-1}>
        2. Comparar y elegir producto
      </h2>
      <p>
        <strong>
          {reference.internalReferenceCode} · {reference.supplier.name} · Código del proveedor:{' '}
          {reference.supplierCode ?? '—'}
        </strong>{' '}
        — {reference.description ?? '—'}
      </p>
      <p>
        Marca declarada: {reference.brandText || 'Sin especificar'}. GTIN informado:{' '}
        {reference.reportedGtin || 'Sin especificar'}.
      </p>
      <ReferenceAssociation item={reference} />
      {reference.normalizedReportedGtin &&
        /^[0-9]+$/.test(scan.value.trim()) &&
        scan.value.trim().padStart(14, '0') !== reference.normalizedReportedGtin && (
          <p className="catalog-notice">
            El código leído difiere del GTIN declarado por el proveedor. Confirmá solamente si
            verificaste que corresponde al mismo producto.
          </p>
        )}
      {review ? (
        <div className="archive-confirm">
          <h3>3. Confirmar identificación</h3>
          <p>
            Lectura: <strong className="code">{scan.value}</strong>
            {scan.supplierId && ' · Proveedor: ' + reference.supplier.name}
          </p>
          <p>
            {review.target.mode === 'NEW'
              ? 'Crear producto: ' +
                review.target.product.name +
                ' · ' +
                unitLabels[review.target.product.unitOfMeasure] +
                ' · ' +
                (review.target.product.presentation || 'Sin presentación') +
                ' · Marca: ' +
                (brand?.name || 'Sin marca') +
                ' · Categoría: ' +
                (category?.name || 'Sin categoría')
              : 'Asociar al producto: ' + effective?.name}
          </p>
          <p>
            Se guardarán la referencia, el vínculo del proveedor y el identificador sobre este
            producto.
          </p>
          <div className="actions">
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy ? 'Confirmando…' : 'Confirmar identificación'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setReview(null)}
            >
              Volver a comparar
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={prepare}>
          {reference.supplierProduct ? (
            <>
              <p>
                Ya corresponde a este producto. La confirmación agrega el identificador y conserva
                la asociación.
              </p>
              <Feedback {...linked} reload={linked.reload} />
              {linked.data && <ProductComparison product={linked.data} />}
            </>
          ) : (
            <>
              <div className="actions">
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={mode === 'EXISTING'}
                  onClick={() => setMode('EXISTING')}
                >
                  Buscar producto existente
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  aria-pressed={mode === 'NEW'}
                  onClick={() => setMode('NEW')}
                >
                  Es un producto nuevo
                </button>
              </div>
              {mode === 'EXISTING' ? (
                <>
                  <SearchBar
                    state={search}
                    placeholder="Nombre, marca, modelo, presentación, código interno o GTIN"
                  />
                  <Feedback {...products} reload={products.reload} />
                  {products.data && (
                    <>
                      <ul className="identification-results">
                        {products.data.items.map((product) => (
                          <li key={product.id}>
                            <div>
                              <strong>{product.name}</strong>
                              <p>
                                {product.brand?.name || 'Sin marca'} ·{' '}
                                {product.model || 'Sin modelo'} ·{' '}
                                {product.presentation || 'Sin presentación'} ·{' '}
                                {product.internalCodes.join(', ')}
                              </p>
                            </div>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={Boolean(product.archivedAt)}
                              onClick={() => {
                                setSelected(product);
                              }}
                            >
                              Elegir {product.name}
                            </button>
                          </li>
                        ))}
                      </ul>
                      <Pagination {...products.data} change={search.setPage} />
                    </>
                  )}
                  {selected && <ProductComparison product={selected} />}
                </>
              ) : (
                <div className="form-grid">
                  <Field
                    label="Nombre"
                    help="Compará primero los productos existentes para evitar duplicados."
                  >
                    <input
                      value={name}
                      required
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
                    />
                  </Field>
                  <Field label="Unidad de medida">
                    <select
                      value={unit}
                      onChange={(event) => setUnit(event.target.value as UnitOfMeasure)}
                    >
                      {Object.entries(unitLabels).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Presentación">
                    <input
                      value={presentation}
                      maxLength={200}
                      onChange={(event) => setPresentation(event.target.value)}
                    />
                  </Field>
                  <EntityChoice
                    kind="brands"
                    label="Marca"
                    value={brand}
                    change={setBrand}
                    allowCreate={false}
                  />
                  <EntityChoice
                    kind="categories"
                    label="Categoría"
                    value={category}
                    change={setCategory}
                    allowCreate={false}
                  />
                  <p className="muted">
                    La marca declarada por el proveedor es una ayuda; elegí una marca interna si
                    corresponde.
                  </p>
                </div>
              )}
            </>
          )}
          <div className="actions">
            <button
              type="submit"
              className="primary-button"
              disabled={Boolean(reference.supplierProduct && !linked.data)}
            >
              Revisar confirmación
            </button>
            <button type="button" className="secondary-button" onClick={cancel}>
              Cambiar referencia
            </button>
          </div>
        </form>
      )}
      <Feedback error={error} />
      {error && review && (
        <p>
          Si falló la conexión, podés reintentar con la misma clave. Ante conflicto, volvé a
          seleccionar la referencia y el producto con sus datos actuales.
        </p>
      )}
    </section>
  );
}
export function ProductIdentification() {
  const [value, setValue] = useState('');
  const [namespace, setNamespace] = useState<ScanInput['namespace']>('AUTO');
  const [supplier, setSupplier] = useState<Choice | null>(null);
  const [scan, setScan] = useState<ScanInput | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [reference, setReference] = useState<SupplierCatalogItemView | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const guard = useRef(false);
  useEffect(() => {
    input.current?.focus();
  }, []);
  function focus() {
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }
  function changedReading() {
    setResult(null);
    setScan(null);
    setError('');
  }
  async function resolve(event: FormEvent) {
    event.preventDefault();
    if (guard.current || reference) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const reading: ScanInput = {
      value,
      namespace,
      ...(supplier ? { supplierId: supplier.id } : {}),
    };
    setScan(reading);
    try {
      setResult(
        await catalogFetch('catalog-scans/resolve', scanResultSchema, {
          method: 'POST',
          body: reading,
        }),
      );
    } catch (cause) {
      setError(humanError(cause));
    } finally {
      guard.current = false;
      setBusy(false);
      focus();
    }
  }
  const associable = result?.status === 'UNKNOWN' || result?.status === 'CANDIDATES';
  const requiresSupplier =
    associable && result.identity.kind === 'SUPPLIER_BARCODE' && !result.identity.supplierId;
  return (
    <>
      <p className="muted">
        Escaneá con un lector USB/Bluetooth HID o ingresá el código y presioná Enter.
      </p>
      <section className="catalog-panel">
        <form onSubmit={(event) => void resolve(event)}>
          <Field label="Código leído">
            <input
              ref={input}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="scanner-input code"
              value={value}
              maxLength={512}
              required
              readOnly={Boolean(reference)}
              disabled={busy || confirming}
              onChange={(event) => {
                setValue(event.target.value);
                changedReading();
              }}
            />
          </Field>
          <fieldset disabled={busy || Boolean(reference)} className="scanner-options">
            <Field label="Tipo de lectura">
              <select
                value={namespace}
                onChange={(event) => {
                  setNamespace(event.target.value as ScanInput['namespace']);
                  changedReading();
                }}
              >
                <option value="AUTO">Scanner: GTIN, MB- o código externo</option>
                <option value="INTERNAL_CODE">Código interno de MaxBio (ingreso manual)</option>
              </select>
            </Field>
            <EntityChoice
              kind="suppliers"
              label="Proveedor del código externo"
              value={supplier}
              change={(choice) => {
                setSupplier(choice);
                changedReading();
              }}
              allowCreate={false}
            />
          </fieldset>
          <div className="actions">
            <button className="primary-button" disabled={busy || Boolean(reference)}>
              {busy ? 'Reconociendo…' : 'Reconocer código'}
            </button>
            <button
              type="button"
              className="secondary-button"
              disabled={busy || confirming}
              onClick={() => {
                setReference(null);
                setResult(null);
                setScan(null);
                setValue('');
                setError('');
                focus();
              }}
            >
              Siguiente lectura
            </button>
          </div>
        </form>
        <Feedback error={error} />
        <div className="scanner-feedback" role="status" aria-live="polite">
          {result &&
            (result.status === 'KNOWN' ? (
              <div className="identification-known">
                <h2>Producto reconocido</h2>
                <strong>{result.product.name}</strong>
                <p>
                  {result.product.brand?.name} · {result.product.presentation || 'Sin presentación'}{' '}
                  · {unitLabels[result.product.unitOfMeasure]}
                </p>
                <Link href={'/productos/' + result.product.id}>Ver producto</Link>
              </div>
            ) : (
              <>
                <h2>
                  {
                    {
                      UNKNOWN: 'Código desconocido',
                      CANDIDATES: 'Referencias candidatas',
                      ARCHIVED: 'Identificador reservado · Archivado',
                      AMBIGUOUS: 'Se necesita contexto de proveedor',
                      INVALID: 'Lectura inválida',
                      UNSUPPORTED: 'Formato no soportado',
                    }[result.status]
                  }
                </h2>
                <p>{result.message}</p>
                {result.status === 'ARCHIVED' && (
                  <Link href={'/productos/' + result.product.id}>
                    {result.product.name} · Ver producto archivado
                  </Link>
                )}
              </>
            ))}
        </div>
      </section>
      {scan &&
        associable &&
        !requiresSupplier &&
        (reference ? (
          <AssociationForm
            key={reference.id}
            reference={reference}
            scan={scan}
            cancel={() => setReference(null)}
            onBusy={setConfirming}
            completed={(product) => {
              setReference(null);
              setResult({ status: 'KNOWN', identity: result.identity, product });
              setValue('');
              focus();
            }}
          />
        ) : (
          <ReferenceSearch
            supplierId={
              result.identity.kind === 'SUPPLIER_BARCODE'
                ? (result.identity.supplierId ?? undefined)
                : undefined
            }
            candidates={result.status === 'CANDIDATES' ? result.candidates : []}
            select={setReference}
          />
        ))}
      {requiresSupplier && (
        <p className="catalog-notice">
          Elegí el proveedor del código externo y presioná Reconocer código nuevamente.
        </p>
      )}
    </>
  );
}

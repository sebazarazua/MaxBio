'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import {
  identifierLabels,
  identifierListSchema,
  identifierMutationResultSchema,
  productSchema,
  supplierSchema,
  supplierProductListSchema,
  supplierProductMutationResultSchema,
  supplierScanIdentifierListSchema,
  unitLabels,
  type ProductView,
  type SupplierProductView,
} from '@maxbio/contracts';
import { catalogFetch } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { ReferenceCatalog } from './supplier-catalog';
import {
  ArchiveAction,
  EntityChoice,
  Feedback,
  Field,
  Pagination,
  SearchBar,
  Status,
  useMutation,
  useResource,
  useSearch,
} from './common';

export function ProductDetail({ id }: { id: string }) {
  const resource = useResource('products/' + id, productSchema);
  if (!resource.data) return <Feedback {...resource} />;
  return <ProductBody product={resource.data} reload={resource.reload} />;
}
function ProductBody({ product, reload }: { product: ProductView; reload: () => void }) {
  const { isAdmin } = useWorkspace();
  const mutation = useMutation();
  async function state() {
    const result = await mutation.run(() =>
      catalogFetch(
        'products/' + product.id + (product.archivedAt ? '/restore' : '/archive'),
        productSchema,
        { method: 'POST', body: { expectedVersion: product.version } },
      ),
    );
    if (result) reload();
  }
  return (
    <>
      <Link className="back-link" href="/productos">
        ← Productos
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">FICHA DE PRODUCTO</p>
          <h1>{product.name}</h1>
          <p className="code prominent-code">
            {product.internalCodes.join(' · ') || 'Sin código interno'}
          </p>
        </div>
        <Status archived={product.archivedAt} />
      </div>
      {isAdmin && (
        <div className="actions">
          {!product.archivedAt && (
            <Link className="primary-button" href={'/productos/' + product.id + '/editar'}>
              Editar producto
            </Link>
          )}
          <ArchiveAction
            archived={product.archivedAt}
            busy={mutation.busy}
            action={state}
            label="este producto"
          />
        </div>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
      {product.archivedAt && (
        <p className="catalog-notice">
          Este producto está archivado. Sus datos e identificadores se conservan.
        </p>
      )}
      <section className="catalog-panel">
        <h2>Datos del producto</h2>
        <dl className="data-grid">
          {[
            ['Marca', product.brand?.name],
            ['Categoría', product.category?.name],
            ['Presentación', product.presentation],
            ['Unidad de medida', unitLabels[product.unitOfMeasure]],
            ['Modelo', product.model],
            ['Fabricante', product.manufacturerName],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value || 'Sin especificar'}</dd>
            </div>
          ))}
        </dl>
        {product.description && (
          <div className="description">
            <h3>Descripción</h3>
            <p>{product.description}</p>
          </div>
        )}
      </section>
      <Identifiers product={product} reload={reload} />
      <SupplierScanIdentifiers productId={product.id} />
      <ProductSuppliers product={product} reload={reload} />
    </>
  );
}
function SupplierScanIdentifiers({ productId }: { productId: string }) {
  const search = useSearch();
  const resource = useResource(
    `products/${productId}/supplier-scan-identifiers?${search.query}`,
    supplierScanIdentifierListSchema,
  );
  return (
    <section className="catalog-panel">
      <h2>Códigos externos por proveedor</h2>
      <p className="muted">Para reconocerlos, elegí ese proveedor en Identificar producto.</p>
      <SearchBar state={search} placeholder="Código externo o proveedor" />
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <>
          <ul className="identification-results">
            {resource.data.items.map((item) => (
              <li key={item.id}>
                <span>
                  <strong className="code">{item.value}</strong> · {item.supplier.name}
                  {(item.archivedAt || item.linkArchivedAt || item.supplier.archivedAt) &&
                    ' · Archivado'}
                </span>
              </li>
            ))}
          </ul>
          {!resource.data.total && <p>Sin códigos externos registrados.</p>}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
    </section>
  );
}
function Identifiers({ product, reload }: { product: ProductView; reload: () => void }) {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const resource = useResource(
    'products/' + product.id + '/identifiers?' + search.query,
    identifierListSchema,
  );
  const mutation = useMutation();
  const [kind, setKind] = useState('INTERNAL_CODE');
  const [notice, setNotice] = useState('');
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await mutation.run(() =>
      catalogFetch('products/' + product.id + '/identifiers', identifierMutationResultSchema, {
        method: 'POST',
        body: {
          kind,
          value: String(data.get('value') ?? '').trim(),
          expectedVersion: product.version,
        },
      }),
    );
    if (result) {
      form.reset();
      setNotice('Identificador agregado.');
      reload();
    }
  }
  async function state(id: string, archived: string | null) {
    const result = await mutation.run(() =>
      catalogFetch(
        'products/' + product.id + '/identifiers/' + id + (archived ? '/restore' : '/archive'),
        identifierMutationResultSchema,
        { method: 'POST', body: { expectedVersion: product.version } },
      ),
    );
    if (result) reload();
  }
  return (
    <section className="catalog-panel">
      <h2>Códigos e identificadores</h2>
      <p className="muted">Los códigos archivados siguen reservados para este producto.</p>
      <SearchBar state={search} placeholder="Buscar identificador" />
      <Feedback {...resource} />
      {resource.data && (
        <>
          <ul className="association-list">
            {resource.data.items.map((item) => (
              <li key={item.id}>
                <div>
                  <strong className="code">{item.value}</strong>
                  <p className="muted">
                    {identifierLabels[item.kind]} · <Status archived={item.archivedAt} />
                  </p>
                </div>
                {isAdmin && (!product.archivedAt || !item.archivedAt) && (
                  <ArchiveAction
                    archived={item.archivedAt}
                    busy={mutation.busy}
                    action={() => state(item.id, item.archivedAt)}
                    label="este identificador"
                  />
                )}
              </li>
            ))}
          </ul>
          {!resource.data.items.length && (
            <p className="empty-copy">No hay identificadores para esta búsqueda.</p>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
      {isAdmin && !product.archivedAt && (
        <details className="form-details">
          <summary>+ Agregar identificador</summary>
          <form onSubmit={(event) => void add(event)}>
            <fieldset disabled={mutation.busy}>
              <div className="form-grid">
                <Field label="Tipo de identificador">
                  <select value={kind} onChange={(event) => setKind(event.target.value)}>
                    {Object.entries(identifierLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Valor"
                  help={
                    kind === 'GTIN'
                      ? '8, 12, 13 o 14 dígitos con control válido.'
                      : kind === 'INTERNAL_BARCODE'
                        ? 'Formato MB- seguido de letras mayúsculas, números, punto, guion o guion bajo.'
                        : 'Respetamos mayúsculas y ceros iniciales.'
                  }
                >
                  <input
                    name="value"
                    required
                    maxLength={128}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
              </div>
              <button className="secondary-button" disabled={mutation.busy}>
                Agregar identificador
              </button>
            </fieldset>
          </form>
        </details>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
function ProductSuppliers({ product, reload }: { product: ProductView; reload: () => void }) {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const resource = useResource(
    'products/' + product.id + '/supplier-products?' + search.query,
    supplierProductListSchema,
  );
  const mutation = useMutation();
  const [supplier, setSupplier] = useState<{
    id: string;
    name: string;
    archivedAt: string | null;
  } | null>(null);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supplier) return;
    const data = new FormData(event.currentTarget);
    const result = await mutation.run(() =>
      catalogFetch(
        'products/' + product.id + '/supplier-products',
        supplierProductMutationResultSchema,
        {
          method: 'POST',
          body: {
            supplierId: supplier.id,
            supplierCode: String(data.get('supplierCode') ?? '').trim() || null,
            supplierDescription: String(data.get('supplierDescription') ?? '').trim() || null,
            expectedVersion: product.version,
          },
        },
      ),
    );
    if (result) reload();
  }
  return (
    <section className="catalog-panel">
      <h2>Proveedores de este producto</h2>
      <p className="muted">Cómo lo identifica y ofrece cada proveedor.</p>
      <SearchBar state={search} placeholder="Proveedor o código de proveedor" />
      <Feedback {...resource} />
      {resource.data && (
        <>
          <ul className="association-list">
            {resource.data.items.map((link) => (
              <SupplierLink
                key={link.id}
                link={link}
                editable={isAdmin && !product.archivedAt}
                reload={reload}
              />
            ))}
          </ul>
          {!resource.data.items.length && (
            <p className="empty-copy">No hay proveedores asociados para esta búsqueda.</p>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
      {isAdmin && !product.archivedAt && (
        <details className="form-details">
          <summary>+ Asociar proveedor</summary>
          <form onSubmit={(event) => void add(event)}>
            <fieldset disabled={mutation.busy}>
              <EntityChoice
                kind="suppliers"
                label="Proveedor"
                value={supplier}
                change={setSupplier}
              />
              <div className="form-grid">
                <Field label="Código del proveedor">
                  <input name="supplierCode" maxLength={128} />
                </Field>
                <Field label="Descripción del proveedor">
                  <input name="supplierDescription" maxLength={1000} />
                </Field>
              </div>
              <button className="secondary-button" disabled={mutation.busy || !supplier}>
                Asociar proveedor
              </button>
            </fieldset>
          </form>
        </details>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
    </section>
  );
}
function SupplierLink({
  link,
  editable,
  reload,
}: {
  link: SupplierProductView;
  editable: boolean;
  reload: () => void;
}) {
  const mutation = useMutation();
  const [editing, setEditing] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await mutation.run(() =>
      catalogFetch('supplier-products/' + link.id, supplierProductMutationResultSchema, {
        method: 'PATCH',
        body: {
          supplierCode: String(data.get('supplierCode') ?? '').trim() || null,
          supplierDescription: String(data.get('supplierDescription') ?? '').trim() || null,
          expectedVersion: link.version,
        },
      }),
    );
    if (result) reload();
  }
  async function state() {
    const result = await mutation.run(() =>
      catalogFetch(
        'supplier-products/' + link.id + (link.archivedAt ? '/restore' : '/archive'),
        supplierProductMutationResultSchema,
        { method: 'POST', body: { expectedVersion: link.version } },
      ),
    );
    if (result) reload();
  }
  return (
    <li className="association-item">
      <div className="association-heading">
        <div>
          <Link href={'/proveedores/' + link.supplierId}>
            <strong>{link.supplier.name}</strong>
          </Link>
          <p className="code">{link.supplierCode || 'Sin código de proveedor'}</p>
          {link.supplierDescription && <p>{link.supplierDescription}</p>}
          <Status archived={link.archivedAt} />
          {link.supplier.archivedAt && <span className="muted"> · Proveedor archivado</span>}
        </div>
        {editable && (
          <div className="actions">
            {!link.archivedAt && !link.supplier.archivedAt && (
              <button
                className="secondary-button"
                disabled={mutation.busy}
                onClick={() => setEditing(!editing)}
              >
                {editing ? 'Cancelar edición' : 'Editar asociación'}
              </button>
            )}
            {(!link.archivedAt || !link.supplier.archivedAt) && (
              <ArchiveAction
                archived={link.archivedAt}
                busy={mutation.busy}
                action={state}
                label="esta asociación"
              />
            )}
          </div>
        )}
      </div>
      {editing && (
        <form className="inline-create" onSubmit={(event) => void save(event)}>
          <fieldset disabled={mutation.busy}>
            <Field label="Código del proveedor">
              <input name="supplierCode" maxLength={128} defaultValue={link.supplierCode ?? ''} />
            </Field>
            <Field label="Descripción del proveedor">
              <input
                name="supplierDescription"
                maxLength={1000}
                defaultValue={link.supplierDescription ?? ''}
              />
            </Field>
            <button className="secondary-button" disabled={mutation.busy}>
              Guardar asociación
            </button>
          </fieldset>
        </form>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
    </li>
  );
}
export function SupplierDetail({ id }: { id: string }) {
  const { isAdmin } = useWorkspace();
  const [tab, setTab] = useState<'data' | 'catalog'>('data');
  const resource = useResource('suppliers/' + id, supplierSchema);
  const search = useSearch();
  const links = useResource(
    resource.data ? 'suppliers/' + id + '/supplier-products?' + search.query : null,
    supplierProductListSchema,
  );
  const mutation = useMutation();
  async function state() {
    if (!resource.data) return;
    const result = await mutation.run(() =>
      catalogFetch(
        'suppliers/' + id + (resource.data?.archivedAt ? '/restore' : '/archive'),
        supplierSchema,
        { method: 'POST', body: { expectedVersion: resource.data?.version } },
      ),
    );
    if (result) resource.reload();
  }
  if (!resource.data) return <Feedback {...resource} />;
  const supplier = resource.data;
  return (
    <>
      <Link className="back-link" href="/proveedores">
        ← Proveedores
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">FICHA DE PROVEEDOR</p>
          <h1>{supplier.name}</h1>
        </div>
        <Status archived={supplier.archivedAt} />
      </div>
      {isAdmin && (
        <div className="actions">
          {!supplier.archivedAt && (
            <Link className="primary-button" href={'/proveedores/' + id + '/editar'}>
              Editar proveedor
            </Link>
          )}
          <ArchiveAction
            archived={supplier.archivedAt}
            busy={mutation.busy}
            action={state}
            label="este proveedor"
          />
        </div>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? resource.reload : undefined} />
      {supplier.archivedAt && (
        <p className="catalog-notice">
          Este proveedor está archivado. Sus asociaciones se conservan y quedan fuera de los
          listados normales.
        </p>
      )}
      <nav className="actions supplier-sections" aria-label="Secciones del proveedor">
        <button
          className={tab === 'data' ? 'primary-button' : 'secondary-button'}
          aria-pressed={tab === 'data'}
          onClick={() => setTab('data')}
        >
          Datos
        </button>
        <button
          className={tab === 'catalog' ? 'primary-button' : 'secondary-button'}
          aria-pressed={tab === 'catalog'}
          onClick={() => setTab('catalog')}
        >
          Catálogo
        </button>
      </nav>
      {tab === 'catalog' ? (
        <ReferenceCatalog supplier={supplier} />
      ) : (
        <>
          <section className="catalog-panel">
            <h2>Datos de contacto</h2>
            <dl className="data-grid">
              {[
                ['Contacto', supplier.contactName],
                ['Email', supplier.email],
                ['Teléfono', supplier.phone],
                ['Razón social', supplier.legalName],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value || 'Sin especificar'}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="catalog-panel">
            <h2>Productos de este proveedor</h2>
            <SearchBar state={search} placeholder="Producto o código del proveedor" />
            <Feedback {...links} />
            {links.data && (
              <>
                <ul className="association-list">
                  {links.data.items.map((link) => (
                    <li key={link.id}>
                      <div>
                        <Link href={'/productos/' + link.productId}>
                          <strong>{link.product.name}</strong>
                        </Link>
                        <p className="code">{link.supplierCode || 'Sin código de proveedor'}</p>
                        {link.supplierDescription && <p>{link.supplierDescription}</p>}
                        <Status archived={link.archivedAt} />
                        {link.product.archivedAt && (
                          <span className="muted"> · Producto archivado</span>
                        )}
                      </div>
                      <Link className="secondary-button" href={'/productos/' + link.productId}>
                        Ver producto
                      </Link>
                    </li>
                  ))}
                </ul>
                {!links.data.items.length && (
                  <p className="empty-copy">
                    No hay productos para esta búsqueda. Las asociaciones se administran desde la
                    ficha del producto.
                  </p>
                )}
                <Pagination {...links.data} change={search.setPage} />
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  productSchema,
  supplierSchema,
  unitLabels,
  type ProductView,
  type SupplierView,
} from '@maxbio/contracts';
import { catalogFetch } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import { EntityChoice, Feedback, Field, useMutation, useResource } from './common';

const formText = (data: FormData, name: string) => String(data.get(name) ?? '').trim() || null;
export function ProductEditor({ id }: { id?: string }) {
  const { isAdmin } = useWorkspace();
  const resource = useResource(id ? 'products/' + id : null, productSchema);
  if (!isAdmin)
    return (
      <>
        <h1>Consultar catálogo</h1>
        <p className="page-intro">
          Tu rol permite consultar productos. Un administrador puede modificar el catálogo.
        </p>
        <Link href="/productos">Volver a productos</Link>
      </>
    );
  if (id && !resource.data) return <Feedback {...resource} />;
  if (resource.data?.archivedAt)
    return (
      <>
        <h1>Producto archivado</h1>
        <p>Restaurá el producto desde su ficha antes de editarlo.</p>
        <Link href={'/productos/' + id}>Volver a la ficha</Link>
      </>
    );
  return (
    <ProductForm
      key={resource.data?.version ?? 'new'}
      product={resource.data}
      reload={resource.reload}
    />
  );
}
function ProductForm({ product, reload }: { product?: ProductView; reload: () => void }) {
  const router = useRouter();
  const mutation = useMutation();
  const [brand, setBrand] = useState(product?.brand ?? null);
  const [category, setCategory] = useState(product?.category ?? null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fields = {
      name: String(data.get('name') ?? '').trim(),
      presentation: formText(data, 'presentation'),
      unitOfMeasure: String(data.get('unitOfMeasure')),
      brandId: brand?.id ?? null,
      categoryId: category?.id ?? null,
      model: formText(data, 'model'),
      manufacturerName: formText(data, 'manufacturerName'),
      description: formText(data, 'description'),
    };
    const identifiers = [
      { kind: 'INTERNAL_CODE', value: formText(data, 'internalCode') },
      { kind: 'GTIN', value: formText(data, 'gtin') },
    ].filter((item) => item.value !== null);
    const result = await mutation.run(() =>
      catalogFetch(product ? 'products/' + product.id : 'products', productSchema, {
        method: product ? 'PATCH' : 'POST',
        body: product
          ? { ...fields, expectedVersion: product.version }
          : { ...fields, identifiers },
      }),
    );
    if (result) router.push('/productos/' + result.id);
  }
  return (
    <>
      <Link className="back-link" href={product ? '/productos/' + product.id : '/productos'}>
        ← {product ? 'Volver al producto' : 'Productos'}
      </Link>
      <p className="eyebrow">CATÁLOGO</p>
      <h1>{product ? 'Editar producto' : 'Nuevo producto'}</h1>
      <p className="page-intro">
        Nombre y unidad de medida son obligatorios. Podés completar los demás datos más adelante.
      </p>
      <form className="catalog-panel catalog-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={mutation.busy}>
          <Field label="Nombre del producto *">
            <input name="name" required maxLength={200} defaultValue={product?.name} autoFocus />
          </Field>
          {!product && (
            <Field
              label="Código interno"
              help="Tu código propio. Conservamos mayúsculas y ceros iniciales."
            >
              <input name="internalCode" maxLength={128} autoCapitalize="none" spellCheck={false} />
            </Field>
          )}
          <div className="form-grid">
            <EntityChoice kind="brands" label="Marca" value={brand} change={setBrand} />
            <EntityChoice
              kind="categories"
              label="Categoría"
              value={category}
              change={setCategory}
            />
          </div>
          <div className="form-grid">
            <Field label="Presentación" help="Por ejemplo: Caja x 100 unidades">
              <input
                name="presentation"
                maxLength={200}
                defaultValue={product?.presentation ?? ''}
              />
            </Field>
            <Field label="Unidad de medida *">
              <select name="unitOfMeasure" required defaultValue={product?.unitOfMeasure ?? 'UNIT'}>
                {Object.entries(unitLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <details className="form-details">
            <summary>Más datos del producto</summary>
            <div className="form-grid">
              <Field label="Modelo">
                <input name="model" maxLength={160} defaultValue={product?.model ?? ''} />
              </Field>
              <Field label="Fabricante">
                <input
                  name="manufacturerName"
                  maxLength={160}
                  defaultValue={product?.manufacturerName ?? ''}
                />
              </Field>
            </div>
            {!product && (
              <Field
                label="GTIN / EAN / UPC"
                help="8, 12, 13 o 14 dígitos, incluyendo el dígito de control."
              >
                <input name="gtin" inputMode="numeric" maxLength={14} />
              </Field>
            )}
            <Field label="Descripción">
              <textarea
                name="description"
                maxLength={4000}
                rows={4}
                defaultValue={product?.description ?? ''}
              />
            </Field>
          </details>
          {product && (
            <p className="muted">
              Los códigos e identificadores se administran en la ficha del producto.
            </p>
          )}
        </fieldset>
        <Feedback error={mutation.error} />
        {mutation.conflict && product && (
          <div className="catalog-notice">
            <p>
              Volvé a cargar la ficha antes de guardar. Se descartarán los cambios de este
              formulario.
            </p>
            <button type="button" className="secondary-button" onClick={reload}>
              Cargar información actual
            </button>
          </div>
        )}
        <div className="form-actions">
          <Link
            className="secondary-button"
            href={product ? '/productos/' + product.id : '/productos'}
          >
            Cancelar
          </Link>
          <button
            className="primary-button"
            type="submit"
            disabled={mutation.busy || (mutation.conflict && Boolean(product))}
          >
            {mutation.busy ? 'Guardando…' : 'Guardar producto'}
          </button>
        </div>
      </form>
    </>
  );
}
export function SupplierEditor({ id }: { id?: string }) {
  const { isAdmin } = useWorkspace();
  const resource = useResource(id ? 'suppliers/' + id : null, supplierSchema);
  if (!isAdmin)
    return (
      <>
        <h1>Consultar proveedores</h1>
        <p>Un administrador puede modificar el catálogo.</p>
        <Link href="/proveedores">Volver a proveedores</Link>
      </>
    );
  if (id && !resource.data) return <Feedback {...resource} />;
  if (resource.data?.archivedAt)
    return (
      <>
        <h1>Proveedor archivado</h1>
        <p>Restaurá el proveedor antes de editarlo.</p>
        <Link href={'/proveedores/' + id}>Volver a la ficha</Link>
      </>
    );
  return (
    <SupplierForm
      key={resource.data?.version ?? 'new'}
      supplier={resource.data}
      reload={resource.reload}
    />
  );
}
function SupplierForm({ supplier, reload }: { supplier?: SupplierView; reload: () => void }) {
  const router = useRouter();
  const mutation = useMutation();
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fields = {
      name: String(data.get('name') ?? '').trim(),
      contactName: formText(data, 'contactName'),
      phone: formText(data, 'phone'),
      email: formText(data, 'email'),
      legalName: formText(data, 'legalName'),
    };
    const result = await mutation.run(() =>
      catalogFetch(supplier ? 'suppliers/' + supplier.id : 'suppliers', supplierSchema, {
        method: supplier ? 'PATCH' : 'POST',
        body: supplier ? { ...fields, expectedVersion: supplier.version } : fields,
      }),
    );
    if (result) router.push('/proveedores/' + result.id);
  }
  return (
    <>
      <Link className="back-link" href={supplier ? '/proveedores/' + supplier.id : '/proveedores'}>
        ← Proveedores
      </Link>
      <p className="eyebrow">CATÁLOGO</p>
      <h1>{supplier ? 'Editar proveedor' : 'Nuevo proveedor'}</h1>
      <p className="page-intro">Completá su nombre y los datos de contacto que tengas.</p>
      <form className="catalog-panel catalog-form" onSubmit={(event) => void save(event)}>
        <fieldset disabled={mutation.busy}>
          <Field label="Nombre del proveedor *">
            <input name="name" required maxLength={200} defaultValue={supplier?.name} autoFocus />
          </Field>
          <Field label="Persona de contacto">
            <input name="contactName" maxLength={160} defaultValue={supplier?.contactName ?? ''} />
          </Field>
          <div className="form-grid">
            <Field label="Email">
              <input
                name="email"
                type="email"
                maxLength={254}
                defaultValue={supplier?.email ?? ''}
              />
            </Field>
            <Field label="Teléfono">
              <input name="phone" type="tel" maxLength={50} defaultValue={supplier?.phone ?? ''} />
            </Field>
          </div>
          <details className="form-details">
            <summary>Otros datos</summary>
            <Field label="Razón social">
              <input name="legalName" maxLength={200} defaultValue={supplier?.legalName ?? ''} />
            </Field>
          </details>
        </fieldset>
        <Feedback error={mutation.error} />
        {mutation.conflict && supplier && (
          <div className="catalog-notice">
            <p>Volvé a cargar la ficha. Se descartarán los cambios de este formulario.</p>
            <button type="button" className="secondary-button" onClick={reload}>
              Cargar información actual
            </button>
          </div>
        )}
        <div className="form-actions">
          <Link
            className="secondary-button"
            href={supplier ? '/proveedores/' + supplier.id : '/proveedores'}
          >
            Cancelar
          </Link>
          <button
            className="primary-button"
            type="submit"
            disabled={mutation.busy || (mutation.conflict && Boolean(supplier))}
          >
            {mutation.busy ? 'Guardando…' : 'Guardar proveedor'}
          </button>
        </div>
      </form>
    </>
  );
}

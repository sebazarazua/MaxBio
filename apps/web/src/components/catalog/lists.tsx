'use client';
import Link from 'next/link';
import { useState } from 'react';
import { productListSchema, supplierListSchema, unitLabels } from '@maxbio/contracts';
import { useWorkspace } from '../workspace';
import {
  EntityChoice,
  Feedback,
  Pagination,
  SearchBar,
  Status,
  useResource,
  useSearch,
} from './common';
type Choice = { id: string; name: string; archivedAt: string | null };
export function ProductsList() {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const [brand, setBrand] = useState<Choice | null>(null);
  const [category, setCategory] = useState<Choice | null>(null);
  const [supplier, setSupplier] = useState<Choice | null>(null);
  const filters = new URLSearchParams();
  if (brand) filters.set('brandId', brand.id);
  if (category) filters.set('categoryId', category.id);
  if (supplier) filters.set('supplierId', supplier.id);
  const resource = useResource('products?' + search.query + '&' + filters, productListSchema);
  function resetPage() {
    search.setPage(1);
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATÁLOGO</p>
          <h1>Productos</h1>
          <p className="page-intro">
            Buscá por nombre, código interno, GTIN, marca o código de proveedor.
          </p>
        </div>
        {isAdmin && (
          <Link href="/productos/nuevo" className="primary-button">
            + Nuevo producto
          </Link>
        )}
      </div>
      <SearchBar state={search} placeholder="Nombre o código del producto" />
      <details className="catalog-panel">
        <summary>Filtrar por marca, categoría o proveedor</summary>
        <div className="form-grid">
          <EntityChoice
            allowCreate={false}
            kind="brands"
            label="Marca"
            value={brand}
            change={(value) => {
              setBrand(value);
              resetPage();
            }}
          />
          <EntityChoice
            allowCreate={false}
            kind="categories"
            label="Categoría"
            value={category}
            change={(value) => {
              setCategory(value);
              resetPage();
            }}
          />
          <EntityChoice
            allowCreate={false}
            kind="suppliers"
            label="Proveedor"
            value={supplier}
            change={(value) => {
              setSupplier(value);
              resetPage();
            }}
          />
        </div>
      </details>
      <Feedback {...resource} />
      {resource.data && (
        <>
          <div className="record-list">
            {resource.data.items.map((product) => (
              <Link key={product.id} href={'/productos/' + product.id} className="record-row">
                <div>
                  <h2>{product.name}</h2>
                  <p className="code">
                    {product.internalCodes.join(' · ') || 'Sin código interno'}
                  </p>
                  <p className="muted">
                    {[
                      product.brand?.name,
                      product.category?.name,
                      product.presentation,
                      unitLabels[product.unitOfMeasure],
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <span>
                  <Status archived={product.archivedAt} />
                  <span className="row-arrow" aria-hidden="true">
                    →
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {resource.data.items.length === 0 && (
            <div className="empty-state">
              <h2>
                {search.q || brand || category || supplier
                  ? 'No encontramos productos'
                  : 'Tu catálogo empieza acá'}
              </h2>
              <p>
                {search.q || brand || category || supplier
                  ? 'Probá con otro nombre o código, cambiá los filtros o incluí archivados.'
                  : isAdmin
                    ? 'Creá el primer producto con su nombre y código interno.'
                    : 'Todavía no hay productos disponibles.'}
              </p>
              {isAdmin && !search.q && (
                <Link className="secondary-button" href="/productos/nuevo">
                  Crear producto
                </Link>
              )}
            </div>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
      {isAdmin && (
        <p className="secondary-navigation">
          <Link href="/catalogo">Administrar marcas y categorías</Link>
        </p>
      )}
    </>
  );
}
export function SuppliersList() {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const resource = useResource('suppliers?' + search.query, supplierListSchema);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATÁLOGO</p>
          <h1>Proveedores</h1>
          <p className="page-intro">Contactos y productos ofrecidos por cada proveedor.</p>
        </div>
        {isAdmin && (
          <Link href="/proveedores/nuevo" className="primary-button">
            + Nuevo proveedor
          </Link>
        )}
      </div>
      <SearchBar state={search} placeholder="Nombre, contacto o email" />
      <Feedback {...resource} />
      {resource.data && (
        <>
          <div className="record-list">
            {resource.data.items.map((supplier) => (
              <Link key={supplier.id} href={'/proveedores/' + supplier.id} className="record-row">
                <div>
                  <h2>{supplier.name}</h2>
                  <p className="muted">
                    {[supplier.contactName, supplier.email, supplier.phone]
                      .filter(Boolean)
                      .join(' · ') || 'Sin datos de contacto'}
                  </p>
                </div>
                <span>
                  <Status archived={supplier.archivedAt} />
                  <span className="row-arrow" aria-hidden="true">
                    →
                  </span>
                </span>
              </Link>
            ))}
          </div>
          {resource.data.items.length === 0 && (
            <div className="empty-state">
              <h2>{search.q ? 'No encontramos proveedores' : 'Todavía no hay proveedores'}</h2>
              <p>
                {search.q
                  ? 'Probá con otro dato o incluí archivados.'
                  : 'Podés crear un proveedor y asociarlo a tus productos.'}
              </p>
            </div>
          )}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
    </>
  );
}

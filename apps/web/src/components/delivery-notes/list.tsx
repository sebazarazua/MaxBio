'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { deliveryNoteListSchema } from '@maxbio/contracts';
import { catalogFetch, humanError } from '@/lib/catalog-api';
import { Feedback, Pagination, SearchBar, useSearch } from '../catalog/common';
import { documentLabels } from '../inventory/common';
export function DeliveryNotesList() {
  const search = useSearch();
  const [revision, setRevision] = useState(0);
  const key = search.query + ':' + revision;
  const [result, setResult] = useState<{
    key: string;
    data?: ReturnType<typeof deliveryNoteListSchema.parse>;
    error?: string;
  }>({ key: '' });
  const query = search.query;
  useEffect(() => {
    const controller = new AbortController();
    // Patient/affiliate searches travel in the body, never in browser/proxy URLs.
    void catalogFetch('search', deliveryNoteListSchema, {
      scope: 'delivery-notes',
      method: 'POST',
      body: Object.fromEntries(new URLSearchParams(query)),
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
  const resource = {
    data: result.key === key ? result.data : undefined,
    loading: result.key !== key,
    error: result.key === key ? result.error : undefined,
    reload: () => setRevision((v) => v + 1),
  };
  return (
    <>
      <header className="catalog-heading">
        <div>
          <p className="eyebrow">Operaciones</p>
          <h1>Remitos</h1>
          <p>Prepará la entrega y confirmá la salida de mercadería.</p>
        </div>
        <Link className="primary-button" href="/remitos/nuevo">
          + Hacer remito
        </Link>
      </header>
      <SearchBar
        state={search}
        placeholder="Número, cliente, CUIT, paciente, producto, lote o serie"
      />
      <Feedback {...resource} reload={resource.reload} />
      {resource.data && (
        <section className="catalog-panel">
          <div className="reference-table-scroll">
            <table className="reference-table">
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Cliente</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {resource.data.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link href={'/remitos/' + d.id}>
                        {d.documentNumber
                          ? d.documentPrefix + '-' + d.documentNumber
                          : 'Borrador sin número'}
                      </Link>
                    </td>
                    <td>{d.customerName}</td>
                    <td>{d.documentDate.split('-').reverse().join('/')}</td>
                    <td>{documentLabels[d.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!resource.data.items.length && <p>No hay remitos para esta búsqueda.</p>}
          <Pagination {...resource.data} change={search.setPage} />
        </section>
      )}
    </>
  );
}

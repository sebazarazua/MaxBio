'use client';

import { useEffect, useState } from 'react';
import { deliveryNoteListSchema } from '@maxbio/contracts';
import { catalogFetch, humanError } from '@/lib/catalog-api';
import { Feedback, Field, Pagination, useSearch } from '../catalog/common';
import { documentLabels } from '../inventory/common';

export function TestDeliveryNotePicker({
  disabled,
  selectedId,
  onSelect,
}: {
  disabled: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const search = useSearch();
  const [revision, setRevision] = useState(0);
  const query = search.query;
  const key = query + ':' + revision;
  const [result, setResult] = useState<{
    key: string;
    data?: ReturnType<typeof deliveryNoteListSchema.parse>;
    error?: string;
  }>({ key: '' });
  useEffect(() => {
    const abort = new AbortController();
    void catalogFetch('search', deliveryNoteListSchema, {
      scope: 'delivery-notes',
      method: 'POST',
      body: Object.fromEntries(new URLSearchParams(query)),
      signal: abort.signal,
    })
      .then((data) => {
        if (!abort.signal.aborted) setResult({ key, data });
      })
      .catch((error) => {
        if (!abort.signal.aborted) setResult({ key, error: humanError(error) });
      });
    return () => abort.abort();
  }, [query, key]);
  const data = result.key === key ? result.data : undefined;
  return (
    <fieldset disabled={disabled}>
      <legend>Remito guardado para probar la revisión</legend>
      <Field label="Buscar remito por número o cliente">
        <input
          type="search"
          maxLength={128}
          value={search.search}
          onChange={(event) => search.setSearch(event.target.value)}
          placeholder="Número, nombre del cliente o CUIT"
        />
      </Field>
      <Feedback
        loading={result.key !== key}
        error={result.key === key ? result.error : undefined}
        reload={() => setRevision((value) => value + 1)}
      />
      {data && (
        <>
          <div className="reference-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Cliente</th>
                  <th>Fecha</th>
                  <th>Estado</th>
                  <th>Prueba</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((note) => (
                  <tr key={note.id}>
                    <td>
                      {note.documentNumber
                        ? note.documentPrefix + '-' + note.documentNumber
                        : 'Borrador sin número'}
                    </td>
                    <td>{note.customerName}</td>
                    <td>{note.documentDate.split('-').reverse().join('/')}</td>
                    <td>{documentLabels[note.status]}</td>
                    <td>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={note.status === 'CANCELLED'}
                        aria-pressed={note.id === selectedId}
                        onClick={() => onSelect(note.id)}
                      >
                        {note.status === 'CANCELLED'
                          ? 'No disponible'
                          : note.id === selectedId
                            ? 'Volver a cargar remito'
                            : 'Probar con este remito'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.items.length && <p>No hay remitos para esta búsqueda.</p>}
          <Pagination {...data} change={search.setPage} />
        </>
      )}
    </fieldset>
  );
}

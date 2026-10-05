'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { namedEntitySchema, namedListSchema, type NamedEntity } from '@maxbio/contracts';
import { catalogFetch } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';
import {
  ArchiveAction,
  Feedback,
  Field,
  Pagination,
  SearchBar,
  Status,
  useMutation,
  useResource,
  useSearch,
} from './common';
export function Classifications() {
  return (
    <>
      <Link className="back-link" href="/productos">
        ← Productos
      </Link>
      <h1>Marcas y categorías</h1>
      <p className="page-intro">Opciones simples para organizar el catálogo de tu organización.</p>
      <div className="classification-grid">
        <NamedSection kind="brands" title="Marcas" />
        <NamedSection kind="categories" title="Categorías" />
      </div>
    </>
  );
}
function NamedSection({ kind, title }: { kind: 'brands' | 'categories'; title: string }) {
  const { isAdmin } = useWorkspace();
  const search = useSearch();
  const resource = useResource(kind + '?' + search.query, namedListSchema);
  const mutation = useMutation();
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const result = await mutation.run(() =>
      catalogFetch(kind, namedEntitySchema, {
        method: 'POST',
        body: { name: String(data.get('name') ?? '').trim() },
      }),
    );
    if (result) {
      form.reset();
      resource.reload();
    }
  }
  return (
    <section className="catalog-panel">
      <h2>{title}</h2>
      <SearchBar state={search} placeholder={'Buscar en ' + title.toLowerCase()} />
      <Feedback {...resource} />
      {resource.data && (
        <>
          <ul className="association-list">
            {resource.data.items.map((item) => (
              <NamedRow
                key={item.id + ':' + item.version}
                item={item}
                kind={kind}
                reload={resource.reload}
              />
            ))}
          </ul>
          {!resource.data.items.length && <p className="empty-copy">No hay resultados.</p>}
          <Pagination {...resource.data} change={search.setPage} />
        </>
      )}
      {isAdmin && (
        <form className="inline-create" onSubmit={(event) => void add(event)}>
          <Field label={kind === 'brands' ? 'Nueva marca' : 'Nueva categoría'}>
            <input name="name" required maxLength={160} disabled={mutation.busy} />
          </Field>
          <button className="secondary-button" disabled={mutation.busy}>
            Crear
          </button>
        </form>
      )}
      <Feedback error={mutation.error} />
    </section>
  );
}
function NamedRow({
  item,
  kind,
  reload,
}: {
  item: NamedEntity;
  kind: 'brands' | 'categories';
  reload: () => void;
}) {
  const { isAdmin } = useWorkspace();
  const mutation = useMutation();
  const [editing, setEditing] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const result = await mutation.run(() =>
      catalogFetch(kind + '/' + item.id, namedEntitySchema, {
        method: 'PATCH',
        body: { name: String(data.get('name') ?? '').trim(), expectedVersion: item.version },
      }),
    );
    if (result) reload();
  }
  async function state() {
    const result = await mutation.run(() =>
      catalogFetch(
        kind + '/' + item.id + (item.archivedAt ? '/restore' : '/archive'),
        namedEntitySchema,
        { method: 'POST', body: { expectedVersion: item.version } },
      ),
    );
    if (result) reload();
  }
  return (
    <li className="association-item">
      <div className="association-heading">
        <div>
          <strong>{item.name}</strong>
          <p>
            <Status archived={item.archivedAt} />
          </p>
        </div>
        {isAdmin && (
          <div className="actions">
            {!item.archivedAt && (
              <button
                className="secondary-button"
                onClick={() => setEditing(!editing)}
                disabled={mutation.busy}
              >
                {editing ? 'Cancelar' : 'Cambiar nombre'}
              </button>
            )}
            <ArchiveAction
              archived={item.archivedAt}
              busy={mutation.busy}
              action={state}
              label="esta opción"
            />
          </div>
        )}
      </div>
      {editing && (
        <form className="inline-create" onSubmit={(event) => void save(event)}>
          <Field label="Nombre">
            <input
              name="name"
              required
              maxLength={160}
              defaultValue={item.name}
              disabled={mutation.busy}
            />
          </Field>
          <button className="secondary-button" disabled={mutation.busy}>
            Guardar nombre
          </button>
        </form>
      )}
      <Feedback error={mutation.error} reload={mutation.conflict ? reload : undefined} />
    </li>
  );
}

'use client';
import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  namedEntitySchema,
  namedListSchema,
  supplierListSchema,
  supplierSchema,
} from '@maxbio/contracts';
import { catalogFetch, CatalogHttpError, humanError } from '@/lib/catalog-api';
import { useWorkspace } from '../workspace';

export function useResource<T>(path: string | null, schema: { parse(input: unknown): T }) {
  const [revision, setRevision] = useState(0);
  const key = path + ':' + revision;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>({ key: '' });
  useEffect(() => {
    if (path === null) return;
    const abort = new AbortController();
    void catalogFetch(path, schema, { signal: abort.signal })
      .then((data) => {
        if (!abort.signal.aborted) setResult({ key, data });
      })
      .catch((error) => {
        if (!abort.signal.aborted) setResult({ key, error: humanError(error) });
      });
    return () => abort.abort();
  }, [path, schema, key]);
  return {
    data: result.key === key ? result.data : undefined,
    error: result.key === key ? result.error : undefined,
    loading: path !== null && result.key !== key,
    reload: () => setRevision((value) => value + 1),
  };
}
export function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  async function run<T>(operation: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      return await operation();
    } catch (cause) {
      setError(humanError(cause));
      setConflict(cause instanceof CatalogHttpError && cause.status === 409);
    } finally {
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    conflict,
    run,
    clear: () => {
      setError('');
      setConflict(false);
    },
  };
}
export function Feedback({
  error,
  reload,
  loading,
}: {
  error?: string;
  reload?: () => void;
  loading?: boolean;
}) {
  if (loading)
    return (
      <p className="catalog-status" role="status">
        Cargando información…
      </p>
    );
  if (!error) return null;
  return (
    <div className="catalog-error" role="alert">
      <p>{error}</p>
      {reload && (
        <button type="button" className="secondary-button" onClick={reload}>
          Volver a cargar
        </button>
      )}
    </div>
  );
}
export function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <label className="catalog-field">
      <span>{label}</span>
      {children}
      {help && <small>{help}</small>}
    </label>
  );
}
export function Pagination({
  total,
  page,
  limit,
  change,
}: {
  total: number;
  page: number;
  limit: number;
  change: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span role="status">
        {total} {total === 1 ? 'resultado' : 'resultados'} · Página {page} de {pages}
      </span>
      <div className="actions">
        <button
          type="button"
          className="secondary-button"
          disabled={page <= 1}
          onClick={() => change(page - 1)}
        >
          Anterior
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={page >= pages}
          onClick={() => change(page + 1)}
        >
          Siguiente
        </button>
      </div>
    </div>
  );
}
export function useSearch() {
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  return {
    search,
    setSearch,
    q,
    page,
    setPage,
    archived,
    setArchived: (value: boolean) => {
      setArchived(value);
      setPage(1);
    },
    query: new URLSearchParams({
      q,
      page: String(page),
      includeArchived: String(archived),
    }).toString(),
  };
}
export function SearchBar({
  state,
  placeholder,
}: {
  state: ReturnType<typeof useSearch>;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="search-bar">
      <div>
        <label htmlFor={id}>Buscar</label>
        <input
          id={id}
          type="search"
          maxLength={128}
          value={state.search}
          onChange={(event) => state.setSearch(event.target.value)}
          placeholder={placeholder}
        />
      </div>
      <label className="check-field">
        <input
          type="checkbox"
          checked={state.archived}
          onChange={(event) => state.setArchived(event.target.checked)}
        />{' '}
        Incluir archivados
      </label>
    </div>
  );
}
export function Status({ archived }: { archived: string | null }) {
  return (
    <span className={'status-tag' + (archived ? ' archived' : '')}>
      {archived ? 'Archivado' : 'Activo'}
    </span>
  );
}
export function ArchiveAction({
  archived,
  busy,
  action,
  label,
}: {
  archived: string | null;
  busy: boolean;
  action: () => Promise<void>;
  label: string;
}) {
  const [confirm, setConfirm] = useState(false);
  if (confirm)
    return (
      <div className="archive-confirm">
        <p>
          ¿{archived ? 'Restaurar' : 'Archivar'} {label}?{' '}
          {archived
            ? 'Volverá a estar disponible.'
            : 'Se conservará su historial y dejará de aparecer por defecto.'}
        </p>
        <div className="actions">
          <button className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>
            Cancelar
          </button>
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => void action().then(() => setConfirm(false))}
          >
            {busy ? 'Guardando…' : archived ? 'Confirmar restauración' : 'Confirmar archivado'}
          </button>
        </div>
      </div>
    );
  return (
    <button
      type="button"
      className="secondary-button"
      disabled={busy}
      onClick={() => setConfirm(true)}
    >
      {archived ? 'Restaurar' : 'Archivar'}
    </button>
  );
}
type Choice = { id: string; name: string; archivedAt: string | null };
export function EntityChoice({
  kind,
  label,
  value,
  change,
  allowCreate = true,
}: {
  kind: 'brands' | 'categories' | 'suppliers';
  label: string;
  value: Choice | null;
  change: (value: Choice | null) => void;
  allowCreate?: boolean;
}) {
  const search = useSearch();
  const resource = useResource(
    kind + '?' + search.query,
    kind === 'suppliers' ? supplierListSchema : namedListSchema,
  );
  const mutation = useMutation();
  const { isAdmin } = useWorkspace();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const choices: Choice[] = resource.data?.items ?? [];
  const options =
    value && !choices.some((item) => item.id === value.id) ? [value, ...choices] : choices;
  async function create() {
    const created = await mutation.run(() =>
      catalogFetch(kind, kind === 'suppliers' ? supplierSchema : namedEntitySchema, {
        method: 'POST',
        body: { name: name.trim() },
      }),
    );
    if (created) {
      change(created);
      setCreating(false);
      setName('');
      resource.reload();
    }
  }
  return (
    <div className="choice-field">
      <Field label={label}>
        <select
          value={value?.id ?? ''}
          onChange={(event) =>
            change(options.find((item) => item.id === event.target.value) ?? null)
          }
          disabled={mutation.busy}
        >
          <option value="">Sin {label.toLocaleLowerCase('es')}</option>
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.archivedAt ? ' (archivada)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Feedback error={resource.error} reload={resource.reload} loading={resource.loading} />
      <details>
        <summary>Buscar {label.toLocaleLowerCase('es')}</summary>
        <Field label={'Buscar ' + label.toLocaleLowerCase('es')}>
          <input
            type="search"
            maxLength={128}
            value={search.search}
            onChange={(event) => search.setSearch(event.target.value)}
          />
        </Field>
        {resource.data && <Pagination {...resource.data} change={search.setPage} />}
      </details>
      {isAdmin && allowCreate && (
        <button type="button" className="text-button" onClick={() => setCreating(!creating)}>
          {creating ? 'Cancelar alta' : '+ Crear ' + label.toLocaleLowerCase('es')}
        </button>
      )}
      {creating && (
        <div className="inline-create">
          <Field label={'Nombre de ' + label.toLocaleLowerCase('es')}>
            <input
              maxLength={kind === 'suppliers' ? 200 : 160}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  if (name.trim() && !mutation.busy) void create();
                }
              }}
            />
          </Field>
          <button
            type="button"
            className="secondary-button"
            disabled={mutation.busy || !name.trim()}
            onClick={() => void create()}
          >
            {mutation.busy ? 'Creando…' : 'Crear y seleccionar'}
          </button>
        </div>
      )}
      <Feedback error={mutation.error} />
    </div>
  );
}

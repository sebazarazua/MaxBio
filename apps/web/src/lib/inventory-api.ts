import { catalogFetch } from './catalog-api';
export function inventoryFetch<T>(
  path: string,
  schema: { parse(input: unknown): T },
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
  } = {},
) {
  return catalogFetch(path, schema, { ...options, scope: 'inventory' });
}

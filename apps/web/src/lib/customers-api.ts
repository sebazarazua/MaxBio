import { catalogFetch } from './catalog-api';

export function customersFetch<T>(
  path: string,
  schema: { parse(input: unknown): T },
  options: Omit<NonNullable<Parameters<typeof catalogFetch>[2]>, 'scope'> = {},
) {
  return catalogFetch(path, schema, { ...options, scope: 'customers' });
}

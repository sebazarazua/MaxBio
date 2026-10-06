import { apiErrorSchema } from '@maxbio/contracts';

type ResponseParser<T> = { parse(input: unknown): T };
export class CatalogHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function catalogFetch<T>(
  path: string,
  schema: ResponseParser<T>,
  options: {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
    scope?: 'catalog' | 'inventory';
  } = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  let response: Response;
  try {
    response = await fetch(`/api/${options.scope ?? 'catalog'}/${path}`, {
      method,
      cache: 'no-store',
      signal: options.signal ?? AbortSignal.timeout(20000),
      ...(options.body !== undefined
        ? {
            headers: { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
            body: JSON.stringify(options.body),
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error('No pudimos conectar. Volvé a intentar en unos momentos.');
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('No pudimos leer la respuesta. Volvé a intentar.');
  }
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(data);
    if (!parsed.success) throw new Error('No pudimos completar la operación. Volvé a intentar.');
    const error = parsed.data;
    if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('maxbio-session-check'));
    throw new CatalogHttpError(response.status, error.message);
  }
  try {
    return schema.parse(data);
  } catch {
    throw new Error('No pudimos leer la información. Volvé a cargar la página.');
  }
}
export const humanError = (error: unknown) =>
  error instanceof Error ? error.message : 'No pudimos completar la operación. Volvé a intentar.';

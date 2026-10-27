import { apiErrorSchema } from '@maxbio/contracts';
const unreachable = 'No pudimos conectar. Volvé a intentar en unos momentos.';
export async function fiscalFetch<T>(
  path: string,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  let response: Response, data: unknown;
  try {
    response = await fetch('/api/fiscal/' + path, {
      method,
      cache: 'no-store',
      signal,
      headers:
        body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    data = await response.json();
  } catch (e) {
    // Aborts propagate untouched; network/HTML/non-JSON failures become a human message.
    if (signal?.aborted) throw e;
    throw new Error(unreachable);
  }
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('maxbio-session-check'));
    const parsed = apiErrorSchema.safeParse(data);
    throw new Error(
      parsed.success ? parsed.data.message : 'No pudimos completar la operación. Volvé a intentar.',
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new Error(
      'La respuesta del servidor no coincide con esta versión de MaxBio. Recargá la página.',
    );
  return parsed.data;
}

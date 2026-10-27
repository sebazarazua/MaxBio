import { apiErrorSchema } from '@maxbio/contracts';
export async function fiscalFetch<T>(
  path: string,
  schema: { parse(v: unknown): T },
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch('/api/fiscal/' + path, {
    method,
    cache: 'no-store',
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('maxbio-session-check'));
    const parsed = apiErrorSchema.safeParse(data);
    throw new Error(
      parsed.success ? parsed.data.message : 'No pudimos completar la operación. Volvé a intentar.',
    );
  }
  return schema.parse(data);
}

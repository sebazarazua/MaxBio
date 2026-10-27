import 'server-only';
import { randomUUID } from 'node:crypto';
import { apiErrorSchema, traceabilityRouteContract } from '@maxbio/contracts';

// Read-only BFF: explicit routes, GET only, strict query, validated response, no body.
export async function proxyTraceability(request: Request, parts: string[]) {
  const requestId = randomUUID();
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
  const failure = (status: number, message: string) =>
    Response.json(
      {
        statusCode: status,
        code:
          status === 400
            ? 'VALIDATION_ERROR'
            : status === 404
              ? 'NOT_FOUND'
              : 'SERVICE_UNAVAILABLE',
        message,
        requestId,
        timestamp: new Date().toISOString(),
        path: new URL(request.url).pathname,
      },
      { status, headers },
    );
  const path = ['traceability', ...parts].join('/');
  const contract = traceabilityRouteContract(path, request.method);
  if (!contract) return failure(404, 'No encontramos lo que buscás.');
  const search = new URL(request.url).searchParams;
  if (
    new Set(search.keys()).size !== [...search.keys()].length ||
    (contract.query
      ? !contract.query.safeParse(Object.fromEntries(search)).success
      : search.size > 0)
  )
    return failure(400, 'Revisá la búsqueda, las fechas y el tamaño de página (máximo 100).');
  try {
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error('Missing API URL');
    const url = new URL(`/api/v1/${path}`, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    url.search = search.toString();
    const cookie = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(
        (part) => part.startsWith('maxbio-session=') || part.startsWith('__Host-maxbio-session='),
      )
      .join('; ');
    const upstream = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: cookie ? { Cookie: cookie } : {},
    });
    const data: unknown = await upstream.json();
    if (upstream.ok) contract.response.parse(data);
    else apiErrorSchema.parse(data);
    for (const cookie of upstream.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
    headers.set('X-Request-Id', upstream.headers.get('x-request-id') ?? requestId);
    return Response.json(data, { status: upstream.status, headers });
  } catch {
    return failure(503, 'No pudimos conectar. Volvé a intentar en unos momentos.');
  }
}

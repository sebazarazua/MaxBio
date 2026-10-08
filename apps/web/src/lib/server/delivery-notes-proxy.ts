import 'server-only';
import { randomUUID } from 'node:crypto';
import { apiErrorSchema, deliveryNoteRouteContract } from '@maxbio/contracts';

export const dynamic = 'force-dynamic';
export async function proxyDeliveryNotes(request: Request, parts: string[]) {
  const requestId = randomUUID();
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
  const failure = (status: number, message: string) =>
    Response.json(
      {
        statusCode: status,
        code:
          status === 400
            ? 'VALIDATION_ERROR'
            : status === 403
              ? 'FORBIDDEN'
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
  const path = ['delivery-notes', ...parts].join('/');
  const contract = deliveryNoteRouteContract(path, request.method);
  if (!contract) return failure(404, 'No encontramos lo que buscás.');
  const write = request.method !== 'GET';
  const origin =
    process.env.WEB_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000');
  if (!origin) return failure(503, 'No pudimos conectar. Volvé a intentar.');
  if (
    write &&
    (request.headers.get('origin') !== origin ||
      request.headers.get('x-maxbio-csrf') !== '1' ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return failure(403, 'No pudimos validar la solicitud. Recargá la página.');
  const search = new URL(request.url).searchParams;
  if (
    new Set(search.keys()).size !== [...search.keys()].length ||
    (contract.query
      ? !contract.query.safeParse(Object.fromEntries(search)).success
      : search.size > 0)
  )
    return failure(400, 'Revisá los filtros y el tamaño de página (máximo 100).');
  try {
    let body: string | undefined;
    if (write) {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return failure(400, 'Enviá los datos del formulario.');
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 131072) {
            await reader.cancel();
            return failure(400, 'El formulario es demasiado largo. Revisá los datos.');
          }
          chunks.push(chunk.value);
        }
      body = Buffer.concat(chunks).toString('utf8') || '{}';
      let input: unknown;
      try {
        input = JSON.parse(body);
      } catch {
        return failure(400, 'Revisá los datos del formulario.');
      }
      if (!contract.body?.safeParse(input).success)
        return failure(400, 'Revisá los campos del formulario. No se aceptan campos adicionales.');
    }
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
      method: request.method,
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(write
          ? { Origin: origin, 'X-Maxbio-Csrf': '1', 'Content-Type': 'application/json' }
          : {}),
      },
      body,
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

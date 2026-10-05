import 'server-only';
import { randomUUID } from 'node:crypto';
import { apiErrorSchema, identityResponseSchema } from '@maxbio/contracts';

export const dynamic = 'force-dynamic';
const reads = new Set(['me', 'sessions', 'admin-check']);
const writes = new Set(['login', 'logout', 'organization', 'sessions/revoke-all']);

async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const requestId = randomUUID();
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
  const failure = (status: number, message: string) =>
    Response.json(
      {
        statusCode: status,
        code: status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE',
        message,
        requestId,
        timestamp: new Date().toISOString(),
        path: new URL(request.url).pathname,
      },
      { status, headers },
    );
  const path = (await context.params).path.join('/');
  const write = request.method === 'POST';
  if (
    !(write ? writes.has(path) || /^sessions\/[0-9a-f-]{36}\/revoke$/.test(path) : reads.has(path))
  )
    return failure(404, 'No encontramos lo que buscás.');
  const origin =
    process.env.WEB_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000');
  if (!origin) return failure(503, 'No pudimos conectar. Volvé a intentar en unos momentos.');
  if (
    write &&
    (request.headers.get('origin') !== origin ||
      request.headers.get('x-maxbio-csrf') !== '1' ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return failure(403, 'No pudimos validar la solicitud. Recargá la página.');
  try {
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error('Missing API URL');
    const url = new URL(`/api/v1/auth/${path}`, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    let body: string | undefined;
    if (write) {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return failure(403, 'No pudimos validar la solicitud.');
      // Leer con límite, incluso cuando Transfer-Encoding omite Content-Length.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 4096) {
            await reader.cancel();
            return failure(403, 'Revisá los datos ingresados.');
          }
          chunks.push(chunk.value);
        }
      body = Buffer.concat(chunks).toString('utf8') || '{}';
    }
    // Solo transportar la cookie propia; no reenviar headers de identidad ni IP declarada.
    // Nest elige el nombre según su política de cookies. Esto permite probar la web
    // compilada contra una API local HTTP sin debilitar el prefijo de producción.
    const cookie = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((item) => item.trim())
      .filter(
        (item) => item.startsWith('maxbio-session=') || item.startsWith('__Host-maxbio-session='),
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
    if (upstream.ok && path === 'me') identityResponseSchema.parse(data);
    if (!upstream.ok) apiErrorSchema.parse(data);
    for (const cookie of upstream.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
    headers.set('X-Request-Id', upstream.headers.get('x-request-id') ?? requestId);
    return Response.json(data, { status: upstream.status, headers });
  } catch {
    return failure(503, 'No pudimos conectar. Volvé a intentar en unos momentos.');
  }
}

export const GET = proxy;
export const POST = proxy;

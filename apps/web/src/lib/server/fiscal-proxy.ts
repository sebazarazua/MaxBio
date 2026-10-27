import 'server-only';
import { randomUUID } from 'node:crypto';
import { apiErrorSchema, fiscalRouteContract } from '@maxbio/contracts';

export const dynamic = 'force-dynamic';
type UpstreamFailureKind =
  | 'API_BASE_URL_MISSING'
  | 'API_BASE_URL_INVALID'
  | 'API_UNREACHABLE'
  | 'API_TIMEOUT'
  | 'INVALID_JSON'
  | 'CONTRACT_MISMATCH'
  | 'UNEXPECTED_RESPONSE';
class UpstreamFailure extends Error {
  constructor(
    readonly kind: UpstreamFailureKind,
    readonly detail = '',
  ) {
    super(kind);
  }
}
const production = () => process.env.NODE_ENV === 'production';
// Detail is limited to error codes, HTTP status and schema field paths: never bodies or headers.
function upstreamResponse(failure: UpstreamFailure) {
  switch (failure.kind) {
    case 'API_TIMEOUT':
      return [
        504,
        'La API tardó demasiado en responder. Volvé a intentar en unos momentos.',
      ] as const;
    case 'CONTRACT_MISMATCH':
      return [
        502,
        production()
          ? 'La API devolvió una respuesta inesperada. Volvé a intentar en unos momentos.'
          : 'La API respondió con una versión incompatible. Reiniciá MaxBio (web y API) y volvé a intentar.',
      ] as const;
    case 'INVALID_JSON':
    case 'UNEXPECTED_RESPONSE':
      return [
        502,
        'La API devolvió una respuesta inesperada. Volvé a intentar en unos momentos.',
      ] as const;
    default:
      return [503, 'No pudimos conectar. Volvé a intentar en unos momentos.'] as const;
  }
}
function networkFailure(error: unknown) {
  if (error instanceof Error && error.name === 'TimeoutError')
    return new UpstreamFailure('API_TIMEOUT');
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return new UpstreamFailure('API_UNREACHABLE', typeof cause?.code === 'string' ? cause.code : '');
}
// Explicit allowlist (fiscalRouteContract): auth cookie only, CSRF on writes, strict bodies.
export async function proxyFiscal(request: Request, parts: string[]) {
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
                : status === 502
                  ? 'UPSTREAM_INVALID_RESPONSE'
                  : status === 504
                    ? 'UPSTREAM_TIMEOUT'
                    : 'SERVICE_UNAVAILABLE',
        message,
        requestId,
        timestamp: new Date().toISOString(),
        path: new URL(request.url).pathname,
      },
      { status, headers },
    );
  const path = ['fiscal', ...parts].join('/');
  const contract = fiscalRouteContract(path, request.method);
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
  if (search.size > 0) return failure(400, 'Esta configuración no admite parámetros adicionales.');
  try {
    let body: string | undefined;
    if (write) {
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return failure(400, 'Enviá los datos del formulario.');
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 140000) {
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
    if (!base) throw new UpstreamFailure('API_BASE_URL_MISSING');
    if (!URL.canParse(base)) throw new UpstreamFailure('API_BASE_URL_INVALID');
    const url = new URL(`/api/v1/${path}`, base);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new UpstreamFailure('API_BASE_URL_INVALID');
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
      signal: AbortSignal.timeout(45000),
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(write
          ? { Origin: origin, 'X-Maxbio-Csrf': '1', 'Content-Type': 'application/json' }
          : {}),
      },
      body,
    }).catch((e: unknown) => {
      throw networkFailure(e);
    });
    const data: unknown = await upstream.json().catch((e: unknown) => {
      throw e instanceof Error && e.name === 'TimeoutError'
        ? new UpstreamFailure('API_TIMEOUT')
        : new UpstreamFailure('INVALID_JSON', `HTTP ${upstream.status}`);
    });
    if (upstream.ok) {
      const checked = contract.response.safeParse(data);
      if (!checked.success)
        throw new UpstreamFailure(
          'CONTRACT_MISMATCH',
          checked.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
            .join(', '),
        );
    } else if (!apiErrorSchema.safeParse(data).success)
      throw new UpstreamFailure('UNEXPECTED_RESPONSE', `HTTP ${upstream.status}`);
    for (const cookie of upstream.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
    headers.set('X-Request-Id', upstream.headers.get('x-request-id') ?? requestId);
    return Response.json(data, { status: upstream.status, headers });
  } catch (e) {
    const upstreamFailure =
      e instanceof UpstreamFailure ? e : new UpstreamFailure('UNEXPECTED_RESPONSE');
    console.error(
      `[fiscal-proxy] ${requestId} ${request.method} /api/${path}: ${upstreamFailure.kind}` +
        (upstreamFailure.detail && !production() ? ` (${upstreamFailure.detail})` : ''),
    );
    const [status, message] = upstreamResponse(upstreamFailure);
    return failure(status, message);
  }
}

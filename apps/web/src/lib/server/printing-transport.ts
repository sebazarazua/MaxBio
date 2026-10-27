import { randomUUID } from 'node:crypto';
import { apiErrorSchema, printingRouteContract } from '@maxbio/contracts';

export async function proxyPrinting(
  request: Request,
  parts: string[],
  upstreamFetch: typeof fetch = fetch,
) {
  const requestId = randomUUID();
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'X-Request-Id': requestId,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  });
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
  const path = parts.join('/'),
    contract = printingRouteContract(path, request.method);
  if (!contract) return failure(404, 'No encontramos esa operación de impresión.');
  if (new URL(request.url).search)
    return failure(400, 'Esta operación no acepta filtros en la URL.');
  const write = request.method !== 'GET';
  const origin =
    process.env.WEB_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000');
  if (!origin) return failure(503, 'No pudimos conectar.');
  if (
    write &&
    (request.headers.get('origin') !== origin ||
      request.headers.get('x-maxbio-csrf') !== '1' ||
      request.headers.get('sec-fetch-site') === 'cross-site')
  )
    return failure(403, 'No pudimos validar la solicitud. Recargá la página.');
  try {
    let body: string | undefined;
    if (write) {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        return failure(400, 'Enviá los datos del formulario.');
      const reader = request.body?.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > (path === 'assets' ? 5700000 : path === 'draft-preview' ? 1048576 : 131072)) {
            await reader.cancel();
            return failure(400, 'El contenido supera el límite permitido.');
          }
          chunks.push(chunk.value);
        }
      body = Buffer.concat(chunks).toString('utf8') || '{}';
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        return failure(400, 'El formulario no es válido.');
      }
      if (!contract.body?.safeParse(data).success)
        return failure(400, 'Revisá los campos y la geometría del formulario.');
    }
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error('Missing API URL');
    const url = new URL('/api/v1/printing/' + path, base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid API URL');
    const cookie = (request.headers.get('cookie') ?? '')
      .split(';')
      .map((c) => c.trim())
      .filter((c) => c.startsWith('maxbio-session=') || c.startsWith('__Host-maxbio-session='))
      .join('; ');
    const upstream = await upstreamFetch(url, {
      method: request.method,
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      body,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(write
          ? { Origin: origin, 'X-Maxbio-Csrf': '1', 'Content-Type': 'application/json' }
          : {}),
      },
    });
    for (const cookie of upstream.headers.getSetCookie()) headers.append('Set-Cookie', cookie);
    headers.set('X-Request-Id', upstream.headers.get('x-request-id') ?? requestId);
    if (!upstream.ok) {
      const data = apiErrorSchema.parse(await upstream.json());
      return Response.json(data, { status: upstream.status, headers });
    }
    if (contract.binary) {
      if (upstream.headers.get('content-type')?.split(';')[0] !== contract.binary)
        throw new Error('Invalid binary type');
      const reader = upstream.body?.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 33554432) {
            await reader.cancel();
            throw new Error('Binary too large');
          }
          chunks.push(chunk.value);
        }
      const bytes = Buffer.concat(chunks);
      if (
        contract.binary === 'application/pdf' &&
        !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
      )
        throw new Error('Invalid PDF');
      if (
        contract.binary === 'image/png' &&
        !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new Error('Invalid PNG');
      headers.set('Content-Type', contract.binary);
      headers.set(
        'Content-Disposition',
        'inline; filename="maxbio.' + (contract.binary === 'application/pdf' ? 'pdf' : 'png') + '"',
      );
      headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
      return new Response(Uint8Array.from(bytes), { status: 200, headers });
    }
    const data: unknown = await upstream.json();
    contract.response!.parse(data);
    return Response.json(data, { status: upstream.status, headers });
  } catch {
    return failure(503, 'No pudimos obtener el documento. Reintentá la misma operación.');
  }
}

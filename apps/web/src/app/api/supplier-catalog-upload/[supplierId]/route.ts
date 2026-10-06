import 'server-only';
import { randomUUID } from 'node:crypto';
import { apiErrorSchema, catalogInspectionSchema, supplierCatalogLimits } from '@maxbio/contracts';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request, context: { params: Promise<{ supplierId: string }> }) {
  const requestId = randomUUID();
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Request-Id': requestId });
  const failure = (status: number, message: string) =>
    Response.json(
      {
        statusCode: status,
        code:
          status === 403
            ? 'FORBIDDEN'
            : status === 503
              ? 'SERVICE_UNAVAILABLE'
              : 'VALIDATION_ERROR',
        message,
        requestId,
        timestamp: new Date().toISOString(),
        path: new URL(request.url).pathname,
      },
      { status, headers },
    );
  const { supplierId } = await context.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(supplierId))
    return failure(400, 'Revisá el proveedor.');
  const origin =
    process.env.WEB_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? undefined : 'http://localhost:3000');
  if (!origin) return failure(503, 'No pudimos conectar. Volvé a intentar.');
  if (
    request.headers.get('origin') !== origin ||
    request.headers.get('x-maxbio-csrf') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return failure(403, 'No pudimos validar la solicitud. Recargá la página.');
  if (
    new URL(request.url).search ||
    !request.headers.get('content-type')?.startsWith('multipart/form-data;')
  )
    return failure(400, 'Elegí un archivo .csv o .xlsx.');
  const cookie = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter(
      (part) => part.startsWith('maxbio-session=') || part.startsWith('__Host-maxbio-session='),
    )
    .join('; ');
  try {
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error();
    const auth = await fetch(new URL('/api/v1/auth/me', base), {
      cache: 'no-store',
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(5000),
    });
    if (!auth.ok) {
      const error = apiErrorSchema.parse(await auth.json());
      for (const value of auth.headers.getSetCookie()) headers.append('Set-Cookie', value);
      return Response.json(error, { status: auth.status, headers });
    }
    // La API vuelve a validar; este chequeo evita recibir 10 MiB de usuarios sin permiso.
    const { identityResponseSchema } = await import('@maxbio/contracts');
    const identity = identityResponseSchema.parse(await auth.json());
    if (identity.activeOrganization?.role !== 'ADMIN')
      return failure(403, 'Solo un administrador puede importar listas.');
    const maximum = supplierCatalogLimits.fileBytes + 65536;
    const length = request.headers.get('content-length');
    if (length && Number(length) > maximum)
      return failure(413, 'Elegí un archivo de hasta 10 MiB.');
    const reader = request.body?.getReader();
    if (!reader) return failure(400, 'Elegí un archivo.');
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) {
        await reader.cancel();
        return failure(413, 'Elegí un archivo de hasta 10 MiB.');
      }
      chunks.push(chunk.value);
    }
    const form = await new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': request.headers.get('content-type')! },
      body: Buffer.concat(chunks),
    }).formData();
    const entries = [...form.entries()];
    const file = form.get('file');
    if (
      entries.length !== 1 ||
      entries[0]?.[0] !== 'file' ||
      !(file instanceof File) ||
      !file.size ||
      file.size > supplierCatalogLimits.fileBytes
    )
      return failure(400, 'Elegí un único archivo de hasta 10 MiB.');
    const upstream = await fetch(
      new URL(`/api/v1/suppliers/${supplierId}/catalog-imports/inspect`, base),
      {
        method: 'POST',
        cache: 'no-store',
        signal: AbortSignal.timeout(30000),
        headers: { Cookie: cookie, Origin: origin, 'X-Maxbio-Csrf': '1' },
        body: form,
      },
    );
    const data: unknown = await upstream.json();
    if (upstream.ok) catalogInspectionSchema.parse(data);
    else apiErrorSchema.parse(data);
    for (const value of upstream.headers.getSetCookie()) headers.append('Set-Cookie', value);
    headers.set('X-Request-Id', upstream.headers.get('x-request-id') ?? requestId);
    return Response.json(data, { status: upstream.status, headers });
  } catch {
    return failure(503, 'No pudimos leer o enviar el archivo. Volvé a intentar.');
  }
}

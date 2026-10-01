import 'server-only';
import { randomUUID } from 'node:crypto';
import { healthResponseSchema } from '@maxbio/contracts';
import type { ApiError } from '@maxbio/contracts';

export const dynamic = 'force-dynamic';

// Proxy limitado al health check público; no acepta URL ni tenant del navegador.
export async function GET() {
  const requestId = randomUUID();
  try {
    const base = process.env.API_BASE_URL;
    if (!base) throw new Error('Falta API_BASE_URL');
    const url = new URL('/api/v1/health', base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API_BASE_URL inválida');
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error('Servicio no disponible');
    const data: unknown = await response.json();
    return Response.json(healthResponseSchema.parse(data), {
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
    });
  } catch {
    const error: ApiError = {
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'No pudimos comprobar la conexión. Volvé a intentar en unos momentos.',
      requestId,
      timestamp: new Date().toISOString(),
      path: '/api/system-status',
    };
    return Response.json(error, {
      status: 503,
      headers: { 'Cache-Control': 'no-store', 'X-Request-Id': requestId },
    });
  }
}

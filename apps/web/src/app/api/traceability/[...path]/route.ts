import { proxyTraceability } from '../../../../lib/server/traceability-proxy.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, context: Context) {
  return proxyTraceability(request, (await context.params).path);
}

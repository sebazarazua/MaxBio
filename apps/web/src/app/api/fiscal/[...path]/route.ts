import { proxyFiscal } from '../../../../lib/server/fiscal-proxy.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  return proxyFiscal(request, (await context.params).path);
}
export { handler as GET, handler as PUT, handler as POST };

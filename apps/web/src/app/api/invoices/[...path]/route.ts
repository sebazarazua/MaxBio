import { proxyInvoices } from '../../../../lib/server/invoices-proxy.ts';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  return proxyInvoices(request, (await context.params).path);
}
export { handler as GET, handler as POST, handler as PATCH };

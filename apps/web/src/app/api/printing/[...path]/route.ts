import { proxyPrinting } from '@/lib/server/printing-proxy';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  return proxyPrinting(request, (await context.params).path);
}
export { handler as GET, handler as POST };

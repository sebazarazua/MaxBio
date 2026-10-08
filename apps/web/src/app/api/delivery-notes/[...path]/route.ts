import { proxyDeliveryNotes } from '@/lib/server/delivery-notes-proxy';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  return proxyDeliveryNotes(request, (await context.params).path);
}
export { handler as GET, handler as POST, handler as PATCH };

import { proxyDeliveryNotes } from '@/lib/server/delivery-notes-proxy';
export const dynamic = 'force-dynamic';
function handler(request: Request) {
  return proxyDeliveryNotes(request, []);
}
export { handler as GET, handler as POST, handler as PATCH };

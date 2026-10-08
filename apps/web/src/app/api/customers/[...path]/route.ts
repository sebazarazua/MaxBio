import { proxyCustomers } from '@/lib/server/customers-proxy';
export const dynamic = 'force-dynamic';
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  return proxyCustomers(request, (await context.params).path);
}
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;

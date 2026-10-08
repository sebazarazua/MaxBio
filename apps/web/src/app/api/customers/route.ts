import { proxyCustomers } from '@/lib/server/customers-proxy';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => proxyCustomers(request, []);
export const POST = (request: Request) => proxyCustomers(request, []);

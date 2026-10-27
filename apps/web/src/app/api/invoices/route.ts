import { proxyInvoices } from '../../../lib/server/invoices-proxy.ts';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => proxyInvoices(request, []);
export const POST = (request: Request) => proxyInvoices(request, []);

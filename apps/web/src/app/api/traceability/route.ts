import { proxyTraceability } from '../../../lib/server/traceability-proxy.ts';
export const dynamic = 'force-dynamic';
// Only GET is exported: Next answers 405 to any other method.
export const GET = (request: Request) => proxyTraceability(request, []);

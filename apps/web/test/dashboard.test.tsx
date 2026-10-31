import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
registerHooks({
  resolve: (s, c, next) => next(['next/link', 'next/navigation'].includes(s) ? s + '.js' : s, c),
});
mock.module('server-only', { namedExports: {} });
mock.module('next/link', {
  defaultExport: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...props }, children),
});
mock.module('next/image.js', {
  defaultExport: ({ unoptimized: _unoptimized, ...props }: { unoptimized?: boolean }) => {
    void _unoptimized;
    return createElement('img', props);
  },
});
mock.module('next/navigation', {
  namedExports: { useRouter: () => ({ push() {}, replace() {} }), usePathname: () => '/' },
});
const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost:3000' });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { HomeDashboard } = await import('../src/components/home/dashboard.js');
const { Navigation } = await import('../src/components/navigation.js');
const uid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const page = (items: unknown[] = [], total = 0, limit = 1) => ({ items, total, page: 1, limit });
const receipt = (n: number, status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED', canEdit = false) => ({
  id: uid(n),
  kind: 'RECEIPT',
  status,
  version: 1,
  supplier: { id: uid(2), name: 'Proveedor ' + n },
  location: { id: uid(3), name: 'Depósito' },
  notes: null,
  createdAt: `2026-10-${30 - n}T16:30:00Z`,
  confirmedAt: status === 'CONFIRMED' ? '2026-10-30T17:00:00Z' : null,
  movementId: null,
  replayed: false,
  canEdit,
  lines: [],
  scopes: [],
});
const fixtures: Record<string, unknown> = {
  '/api/catalog/products?limit=1': page([], 1280),
  '/api/catalog/supplier-catalog-items?association=UNASSOCIATED&limit=1': page([], 807),
  '/api/invoices/pending-delivery-notes?limit=3': {
    ...page(
      [
        {
          id: uid(10),
          number: '00001-00000034',
          documentDate: '2026-10-30',
          customer: { id: uid(11), name: 'Instituto Central' },
          lineCount: 2,
          patientLinked: false,
        },
      ],
      21,
      3,
    ),
    customer: null,
  },
  '/api/invoices?status=DRAFT&limit=3': {
    ...page(
      [
        {
          id: uid(12),
          status: 'DRAFT',
          fiscalStatus: 'NOT_SUBMITTED',
          invoiceType: null,
          issueDate: '2026-10-30',
          customer: { id: uid(11), name: 'Instituto Central' },
          deliveryNoteNumbers: ['00001-00000030'],
          totalAmount: '1210.00',
          complete: false,
        },
      ],
      7,
      3,
    ),
    customer: null,
  },
  '/api/invoices?status=READY&limit=5': {
    ...page(
      [
        {
          id: uid(13),
          status: 'READY',
          fiscalStatus: 'NOT_SUBMITTED',
          invoiceType: 'INVOICE_A',
          issueDate: '2026-10-30',
          customer: { id: uid(11), name: 'Cliente listo' },
          deliveryNoteNumbers: [],
          totalAmount: '121.00',
          complete: true,
        },
        {
          id: uid(14),
          status: 'READY',
          fiscalStatus: 'AUTHORIZED',
          invoiceType: 'INVOICE_A',
          issueDate: '2026-10-30',
          customer: { id: uid(11), name: 'Cliente autorizado' },
          deliveryNoteNumbers: [],
          totalAmount: '121.00',
          complete: true,
        },
      ],
      2,
      5,
    ),
    customer: null,
  },
  '/api/inventory/receipts?limit=5': page(
    [receipt(1, 'DRAFT', true), receipt(2, 'CONFIRMED'), receipt(3, 'CANCELLED')],
    80,
    5,
  ),
  '/api/system-status': {
    status: 'ok',
    service: 'maxbio-api',
    database: 'ok',
    checkedAt: '2026-10-31T16:00:00Z',
  },
};
const originalFetch = globalThis.fetch;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let requests: { url: string; method: string }[] = [];
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
function serve(handler = (url: string) => Response.json(fixtures[url])) {
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' });
    return handler(String(input));
  }) as typeof fetch;
}
async function mount(node: ReactNode = <HomeDashboard isAdmin />) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(node));
  await settle();
}
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  globalThis.fetch = originalFetch;
  root = undefined;
});
const text = () => host.textContent ?? '';
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;

test('dashboard uses global totals, exact existing routes, and keeps supplier references distinct from registered products', async () => {
  serve();
  await mount();
  const shortcuts = [...host.querySelectorAll('[aria-label="Operaciones principales"] a')];
  assert.deepEqual(
    shortcuts.map((a) => a.getAttribute('href')),
    ['/inventario/ingresos', '/identificar', '/remitos', '/facturacion'],
  );
  assert.deepEqual(
    [...host.querySelectorAll('.dashboard-metric dd')].map((n) => n.textContent),
    ['1.280', '807', '21', '7'],
  );
  assert.match(text(), /no equivalen a productos registrados/);
  assert.ok(host.querySelector(`a[href="/facturacion/${uid(12)}"]`));
  assert.ok(host.querySelector(`a[href="/remitos/${uid(10)}"]`));
  assert.ok(host.querySelector(`a[href="/facturacion/${uid(13)}"]`));
  assert.equal(host.querySelector(`a[href="/facturacion/${uid(14)}"]`), null);
  const resume = host.querySelector('.dashboard-task-group:last-child')!;
  assert.match(resume.textContent!, /Borradores entre los últimos 3 ingresos visibles/);
  assert.equal(resume.querySelectorAll('a').length, 1);
  assert.equal(resume.querySelector('a')!.getAttribute('href'), '/inventario/ingresos/' + uid(1));
  assert.match(host.querySelector('.dashboard-activity')!.textContent!, /Creado/);
  assert.equal(requests.length, 7);
  assert.ok(requests.every((r) => r.method === 'GET'));
});

test('loading does not block shortcuts; render does not refetch and explicit refresh reuses six bounded queries', async () => {
  const releases: (() => void)[] = [];
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET' });
    return new Promise<Response>((resolve) =>
      releases.push(() => resolve(Response.json(fixtures[url]))),
    );
  }) as typeof fetch;
  await mount();
  assert.equal(host.querySelectorAll('[aria-label="Operaciones principales"] a').length, 4);
  assert.equal(host.querySelectorAll('.dashboard-skeleton').length, 4);
  await act(async () => releases.forEach((r) => r()));
  await settle();
  await act(async () => root!.render(<HomeDashboard isAdmin />));
  await settle();
  assert.equal(requests.length, 7);
  serve();
  await act(async () => button('Actualizar resumen').click());
  await settle();
  assert.equal(requests.length, 6);
  assert.equal(requests.filter((r) => r.url.includes('system-status')).length, 0);
});

test('a failed counter is not a zero, does not hide useful data, and retries only that resource', async () => {
  let fail = true;
  serve((url) =>
    url.includes('/products?') && fail
      ? Response.json(
          {
            statusCode: 503,
            code: 'UNAVAILABLE',
            message: 'Volvé a intentar.',
            requestId: uid(99),
            timestamp: '2026-10-31T16:00:00Z',
            path: url,
          },
          { status: 503 },
        )
      : Response.json(fixtures[url]),
  );
  await mount();
  assert.equal(host.querySelector('.dashboard-metric dd')!.textContent, '—');
  assert.ok(host.querySelector(`a[href="/remitos/${uid(10)}"]`));
  assert.match(
    host.querySelector('[role=alert]')!.textContent!,
    /No pudimos actualizar productos activos/,
  );
  const count = requests.length;
  fail = false;
  await act(async () => button('Reintentar').click());
  await settle();
  assert.equal(requests.length, count + 1);
  assert.equal(host.querySelector('.dashboard-metric dd')!.textContent, '1.280');
});

test('empty states report real zeroes and do not fabricate pending work; OPERATOR sees consultation actions', async () => {
  serve((url) =>
    Response.json(
      url.includes('system-status')
        ? fixtures[url]
        : url.includes('/invoices')
          ? { ...page([], 0, 3), customer: null }
          : page([], 0, url.includes('receipts') ? 5 : 1),
    ),
  );
  await mount(<HomeDashboard isAdmin={false} />);
  assert.deepEqual(
    [...host.querySelectorAll('.dashboard-metric dd')].map((n) => n.textContent),
    ['0', '0', '0', '0'],
  );
  assert.match(text(), /No hay remitos confirmados pendientes/);
  assert.match(text(), /Todavía no hay ingresos registrados/);
  assert.doesNotMatch(text(), /Ingresos para retomar/);
  await act(async () => root?.unmount());
  root = undefined;
  host.remove();
  serve();
  await mount(<HomeDashboard isAdmin={false} />);
  assert.match(text(), /Consultar/);
  assert.doesNotMatch(text(), /Completar →/);
  assert.ok(requests.every((r) => r.method === 'GET'));
});

test('institutional logo occupies the existing navigation mark without a text M', async () => {
  serve();
  await mount(<Navigation />);
  const mark = host.querySelector('.brand-mark')!;
  assert.equal(mark.textContent?.trim(), '');
  assert.equal(mark.querySelector('img')!.getAttribute('src'), '/brand/maxbio-logo.png');
  assert.equal(mark.querySelector('img')!.getAttribute('alt'), '');
  assert.equal(host.querySelector('nav [aria-current=page]')!.getAttribute('href'), '/');
});

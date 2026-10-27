import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, afterEach, mock, test } from 'node:test';
import { createElement, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import {
  traceabilityDetailSchema,
  traceabilityListSchema,
  type TraceabilityDetail,
  type TraceabilityItem,
  type TraceabilityList,
} from '@maxbio/contracts';
import {
  displayDate,
  emptyTraceabilityParams,
  traceabilityParams,
  traceabilityQuery,
} from '../src/lib/traceability.js';

// Next ships extensionless CJS entry points; Node ESM needs the file name before mocking them.
registerHooks({
  resolve: (specifier, context, next) =>
    next(
      ['next/link', 'next/navigation'].includes(specifier) ? specifier + '.js' : specifier,
      context,
    ),
});
mock.module('server-only', { namedExports: {} });
mock.module('next/link', {
  defaultExport: ({ href, children, ...props }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...props }, children),
});
mock.module('next/navigation', {
  namedExports: { useRouter: () => ({ replace() {}, push() {} }), usePathname: () => '/' },
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000/trazabilidad',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { TraceabilityView } = await import('../src/components/traceability/traceability.js');
const { proxyTraceability } = await import('../src/lib/server/traceability-proxy.js');

const ids = {
  note: '00000000-0000-4000-8000-000000000001',
  note2: '00000000-0000-4000-8000-000000000002',
  product: '00000000-0000-4000-8000-000000000003',
  customer: '00000000-0000-4000-8000-000000000004',
  stock: '00000000-0000-4000-8000-000000000005',
  declared: '00000000-0000-4000-8000-000000000006',
  movement: '00000000-0000-4000-8000-000000000007',
  location: '00000000-0000-4000-8000-000000000008',
};
const item = (traceId: string, extra: Partial<TraceabilityItem> = {}): TraceabilityItem => ({
  traceId,
  deliveryNote: { id: ids.note, number: '00001-00004122', documentDate: '2026-10-01' },
  product: {
    id: ids.product,
    name: 'Prótesis de rodilla',
    presentation: 'Talle M',
    unitOfMeasure: 'UNIT',
  },
  customer: { id: ids.customer, name: 'Hospital X' },
  quantity: '1',
  lotNumber: 'ABC123',
  expirationDate: '2028-01-31',
  serialNumber: 'S9982',
  source: 'STOCK',
  patientLinked: false,
  ...extra,
});
const list = (items: TraceabilityItem[], extra: Partial<TraceabilityList> = {}) =>
  traceabilityListSchema.parse({
    items,
    total: items.length,
    page: 1,
    limit: 25,
    match: null,
    filters: { product: null, customer: null },
    ...extra,
  });
const twoResults = list(
  [
    item(ids.stock),
    item(ids.declared, {
      deliveryNote: { id: ids.note2, number: '00001-00004100', documentDate: '2026-09-10' },
      customer: { id: ids.customer, name: 'OSDE' },
      source: 'DOCUMENTARY',
      lotNumber: null,
      expirationDate: null,
      patientLinked: true,
    }),
  ],
  { match: 'EXACT' },
);
const detail = (extra: Partial<TraceabilityDetail>): TraceabilityDetail =>
  traceabilityDetailSchema.parse({
    ...item(ids.declared),
    deliveryNote: {
      id: ids.note2,
      number: '00001-00004100',
      documentDate: '2026-09-10',
      confirmedAt: '2026-09-10T15:00:00.000Z',
    },
    documentQuantity: '3',
    patientName: 'Paciente de prueba',
    affiliateNumber: null,
    stock: null,
    scannedGtin: '07791234567898',
    captureMethod: 'GS1',
    source: 'DOCUMENTARY',
    ...extra,
  });

const originalFetch = globalThis.fetch;
let calls: string[] = [];
function serve(handler: (url: string) => unknown, status = 200) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return Response.json(handler(url), { status });
  }) as typeof fetch;
}
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function mount(initial = emptyTraceabilityParams, isAdmin = false) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<TraceabilityView initial={initial} isAdmin={isAdmin} />));
  await settle();
}
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label)!;
async function click(label: string) {
  await act(async () => button(label).click());
  await settle();
}
async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof dom.window.HTMLSelectElement
        ? dom.window.HTMLSelectElement.prototype
        : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await settle();
}
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  globalThis.fetch = originalFetch;
  dom.window.history.replaceState(null, '', '/trazabilidad');
});

test('pantalla inicial: título, búsqueda prominente y registros recientes', async () => {
  serve(() => twoResults);
  await mount();
  assert.match(text(), /Trazabilidad/);
  assert.match(text(), /Buscá por producto, lote, serie, cliente o remito\./);
  assert.ok(container.querySelector('input[type=search]#traceability-search'));
  assert.deepEqual(calls, ['/api/traceability']);
  assert.match(text(), /Registros más recientes/);
  assert.equal(container.querySelectorAll('tbody tr').length, 2);
  assert.equal(button('Limpiar filtros'), undefined);
});

test('búsqueda por serie: submit explícito, URL, etiquetas de origen y datos físicos', async () => {
  serve(() => twoResults);
  await mount();
  const input = container.querySelector<HTMLInputElement>('#traceability-search')!;
  await type(input, ' S9982 ');
  // Typing alone never queries.
  assert.equal(calls.length, 1);
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  await settle();
  assert.equal(calls.at(-1), '/api/traceability?search=S9982');
  assert.equal(dom.window.location.search, '?search=S9982');
  assert.match(text(), /2 registros encontrados · Coincidencia exacta/);
  const [stock, documentary] = [...container.querySelectorAll('tbody tr')].map(
    (r) => r.textContent!,
  );
  assert.match(stock!, /Vinculado a Stock/);
  assert.doesNotMatch(stock!, /Solo documental/);
  assert.match(documentary!, /Solo documental/);
  assert.doesNotMatch(documentary!, /Vinculado a Stock/);
  assert.match(stock!, /01\/10\/2026/);
  assert.match(stock!, /Lote ABC123/);
  assert.match(stock!, /Vence 31\/01\/2028/);
  assert.match(stock!, /S9982/);
  assert.match(stock!, /1 unidades/);
  assert.match(stock!, /Hospital X/);
  assert.doesNotMatch(stock!, /2028-01-31/);
  assert.match(documentary!, /Sin lote/);
  assert.match(documentary!, /Paciente\/Afiliado asociado/);
  const links = [...container.querySelectorAll('tbody a')].map((a) => [
    a.getAttribute('href'),
    a.textContent,
  ]);
  assert.deepEqual(links, [
    ['/remitos/' + ids.note, '00001-00004122'],
    ['/remitos/' + ids.note2, '00001-00004100'],
  ]);
});

test('filtros: producto desde la URL, origen, fecha y quitar filtro', async () => {
  serve(() =>
    list([item(ids.stock)], {
      filters: { product: { id: ids.product, name: 'Prótesis de rodilla' }, customer: null },
    }),
  );
  await mount({ ...emptyTraceabilityParams, productId: ids.product });
  assert.equal(calls[0], '/api/traceability?productId=' + ids.product);
  assert.equal(container.querySelector('details')!.open, true);
  assert.match(text(), /Producto: Prótesis de rodilla/);
  await type(container.querySelector('select')!, 'DOCUMENTARY');
  assert.equal(calls.at(-1), `/api/traceability?productId=${ids.product}&source=DOCUMENTARY`);
  const [from] = container.querySelectorAll<HTMLInputElement>('input[type=date]');
  await type(from!, '2026-09-01');
  assert.equal(
    calls.at(-1),
    `/api/traceability?productId=${ids.product}&source=DOCUMENTARY&dateFrom=2026-09-01`,
  );
  assert.equal(dom.window.location.search, '?' + calls.at(-1)!.split('?')[1]);
  await click('Quitar producto');
  assert.equal(calls.at(-1), '/api/traceability?source=DOCUMENTARY&dateFrom=2026-09-01');
});

test('filtro de cliente con la búsqueda existente de clientes', async () => {
  serve((url) =>
    url.startsWith('/api/customers')
      ? {
          items: [
            {
              id: ids.customer,
              name: 'OSDE',
              kind: 'HEALTH_INSURER',
              legalName: null,
              cuit: null,
              taxConditionText: null,
              addressLine: null,
              locality: null,
              province: null,
              postalCode: null,
              contactName: null,
              phone: null,
              email: null,
              notes: null,
              version: 1,
              createdAt: '2026-10-01T00:00:00.000Z',
              updatedAt: '2026-10-01T00:00:00.000Z',
              archivedAt: null,
            },
          ],
          total: 1,
          page: 1,
          limit: 8,
        }
      : list([]),
  );
  await mount();
  const [, customerSearch] = container.querySelectorAll<HTMLInputElement>(
    'details input[type=search]',
  );
  await type(customerSearch!, 'OSDE');
  await act(async () => new Promise((r) => setTimeout(r, 350)));
  await settle();
  assert.ok(calls.some((c) => c.startsWith('/api/customers?q=OSDE')));
  if (!button('OSDE')) return assert.fail(text());
  await click('OSDE');
  assert.equal(calls.at(-1), '/api/traceability?customerId=' + ids.customer);
  assert.match(text(), /Cliente: OSDE/);
});

test('estado vacío humano y limpiar filtros', async () => {
  serve(() => list([]));
  await mount({ ...emptyTraceabilityParams, search: 'NO-EXISTE', source: 'STOCK' });
  assert.match(text(), /No encontramos trazabilidad con estos filtros\./);
  assert.match(text(), /Revisá que la serie o el lote estén escritos exactamente/);
  assert.equal(container.querySelector('table'), null);
  await click('Limpiar filtros');
  assert.equal(calls.at(-1), '/api/traceability');
  assert.equal(dom.window.location.search, '');
  assert.equal(container.querySelector<HTMLInputElement>('#traceability-search')!.value, '');
});

test('paginación: página siguiente en la consulta y en la URL', async () => {
  serve((url) =>
    list(url.includes('page=2') ? [item(ids.declared)] : [item(ids.stock)], {
      total: 30,
      page: url.includes('page=2') ? 2 : 1,
    }),
  );
  await mount({ ...emptyTraceabilityParams, search: 'ABC123' });
  assert.match(text(), /30 resultados · Página 1 de 2/);
  await click('Siguiente');
  assert.equal(calls.at(-1), '/api/traceability?search=ABC123&page=2');
  assert.equal(dom.window.location.search, '?search=ABC123&page=2');
  assert.match(text(), /Página 2 de 2/);
});

test('error: mensaje humano sin detalles técnicos y reintento', async () => {
  serve(
    () => ({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'No pudimos conectar. Volvé a intentar en unos momentos.',
      requestId: '00000000-0000-4000-8000-0000000000ff',
      timestamp: '2026-10-26T00:00:00.000Z',
      path: '/api/traceability',
    }),
    503,
  );
  await mount();
  assert.match(container.querySelector('[role=alert]')!.textContent!, /No pudimos conectar/);
  assert.equal(container.querySelector('table'), null);
  serve(() => twoResults);
  await click('Volver a cargar');
  assert.equal(calls.length, 1);
  assert.equal(container.querySelectorAll('tbody tr').length, 2);
});

test('detalle documental: aviso explícito, paciente solo en detalle, Ver Remito y producto', async () => {
  serve((url) => (url.endsWith(ids.declared) ? detail({}) : twoResults));
  await mount();
  assert.doesNotMatch(text(), /Paciente de prueba/);
  const [, second] = [...container.querySelectorAll('tbody button')];
  await act(async () => (second as HTMLButtonElement).click());
  await settle();
  assert.equal(calls.at(-1), '/api/traceability/' + ids.declared);
  const panel = container.querySelector('[aria-label="Detalle de trazabilidad"]')!;
  assert.match(panel.textContent!, /Registrado solo en el Remito/);
  assert.match(
    panel.textContent!,
    /Estos datos fueron documentados en el Remito y no representan una salida registrada en Stock\./,
  );
  assert.doesNotMatch(panel.textContent!, /Vinculado a Stock/);
  assert.match(panel.textContent!, /Paciente de prueba/);
  assert.match(panel.textContent!, /de 3 en el Remito/);
  assert.match(panel.textContent!, /GTIN escaneado07791234567898/);
  // Capture method is an ADMIN-only detail.
  assert.doesNotMatch(panel.textContent!, /Origen de captura/);
  const links = [...panel.querySelectorAll('a')].map((a) => [
    a.textContent,
    a.getAttribute('href'),
  ]);
  assert.deepEqual(links, [
    ['Ver Remito', '/remitos/' + ids.note2],
    ['Ver producto', '/productos/' + ids.product],
  ]);
  await click('Cerrar detalle');
  assert.equal(container.querySelector('[aria-label="Detalle de trazabilidad"]'), null);
});

test('detalle vinculado a Stock: ubicación y movimiento; ADMIN ve el origen de captura', async () => {
  serve((url) =>
    url.endsWith(ids.stock)
      ? detail({
          ...item(ids.stock),
          deliveryNote: {
            ...item(ids.stock).deliveryNote,
            confirmedAt: '2026-10-01T12:00:00.000Z',
          },
          stock: {
            movementId: ids.movement,
            location: { id: ids.location, name: 'Depósito principal' },
          },
          patientName: null,
          scannedGtin: null,
          captureMethod: 'GS1',
        })
      : twoResults,
  );
  await mount(emptyTraceabilityParams, true);
  await act(async () => (container.querySelector('tbody button') as HTMLButtonElement).click());
  await settle();
  const panel = container.querySelector('[aria-label="Detalle de trazabilidad"]')!;
  assert.match(panel.textContent!, /Vinculado a Stock/);
  assert.doesNotMatch(panel.textContent!, /Registrado solo en el Remito/);
  assert.match(panel.textContent!, /Ubicación de salida: Depósito principal/);
  assert.match(panel.textContent!, /Origen de captura/);
  assert.match(panel.textContent!, /Escaneado/);
  assert.doesNotMatch(panel.textContent!, /Paciente/);
  assert.ok(
    [...panel.querySelectorAll('a')].some(
      (a) => a.getAttribute('href') === `/stock/${ids.product}#movimiento-${ids.movement}`,
    ),
  );
});

test('query params: valores inválidos descartados y orden estable', () => {
  assert.deepEqual(
    traceabilityParams({
      search: ' S9982 ',
      productId: 'x',
      customerId: ids.customer,
      source: 'INVENTORY',
      dateFrom: '2026-10-02',
      dateTo: '2026-10-01',
      page: '-1',
      organizationId: ids.note,
    }),
    {
      ...emptyTraceabilityParams,
      search: 'S9982',
      customerId: ids.customer,
      dateFrom: '2026-10-02',
    },
  );
  assert.equal(traceabilityParams({ search: ['a', 'b'], page: '3' }).page, 3);
  assert.equal(
    traceabilityQuery({
      ...emptyTraceabilityParams,
      search: '00001-00004122',
      source: 'STOCK',
      page: 2,
    }),
    'search=00001-00004122&source=STOCK&page=2',
  );
  assert.equal(traceabilityQuery(emptyTraceabilityParams), '');
  assert.equal(displayDate('2028-01-31'), '31/01/2028');
});

const previousBase = process.env.API_BASE_URL;
after(() => {
  if (previousBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = previousBase;
});
test('BFF trazabilidad: solo GET explícito, query estricta, cookie acotada y respuesta validada', async () => {
  process.env.API_BASE_URL = 'http://internal.invalid:3001';
  let upstream: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    upstream = { url: String(url), init };
    return Response.json(twoResults);
  }) as typeof fetch;
  const call = (path: string, method = 'GET', parts: string[] = []) =>
    proxyTraceability(
      new Request('http://localhost:3000/api/traceability' + path, {
        method,
        headers: { Cookie: 'maxbio-session=abc; other=secret' },
      }),
      parts,
    );
  const ok = await call('?search=S9982&page=2');
  assert.equal(ok.status, 200);
  assert.equal(
    upstream!.url,
    'http://internal.invalid:3001/api/v1/traceability?search=S9982&page=2',
  );
  assert.equal(upstream!.init?.method, 'GET');
  assert.equal(new Headers(upstream!.init?.headers).get('cookie'), 'maxbio-session=abc');
  assert.equal(upstream!.init?.body, undefined);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  upstream = undefined;
  for (const path of ['?organizationId=' + ids.note, '?search=a&search=b', '?limit=101', '?raw=x'])
    assert.equal((await call(path)).status, 400, path);
  assert.equal((await call('', 'POST')).status, 404);
  assert.equal((await call('', 'GET', ['x', 'y'])).status, 404);
  assert.equal((await call('?q=1', 'GET', [ids.stock])).status, 400);
  assert.equal(upstream, undefined);
  globalThis.fetch = (async () => Response.json(detail({}))) as unknown as typeof fetch;
  assert.equal((await call('', 'GET', [ids.declared])).status, 200);
  globalThis.fetch = (async () =>
    Response.json({ ...twoResults, organizationId: ids.note })) as unknown as typeof fetch;
  assert.equal((await call('')).status, 503);
});

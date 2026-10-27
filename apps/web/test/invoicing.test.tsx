import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { after, afterEach, mock, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import {
  invoiceListSchema,
  invoicePendingListSchema,
  invoiceSchema,
  type InvoiceView,
} from '@maxbio/contracts';
import {
  formatMoney,
  internalReference,
  moneyInputText,
  parseMoneyInput,
  toggleSelection,
} from '../src/lib/invoicing.js';

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
  url: 'http://localhost:3000/facturacion',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { BillingView } = await import('../src/components/invoicing/billing.js');
const { InvoiceDetailView, readyProblem } =
  await import('../src/components/invoicing/invoice-detail.js');
const { proxyInvoices } = await import('../src/lib/server/invoices-proxy.js');

const u = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const OSDE = { id: u(1), name: 'OSDE' };
const SWISS = { id: u(2), name: 'Swiss Medical' };
const pendingList = (items: { id: string; customer: typeof OSDE; number: string }[]) =>
  invoicePendingListSchema.parse({
    items: items.map((i) => ({
      ...i,
      documentDate: '2026-10-01',
      lineCount: 2,
      patientLinked: i.id === u(10),
    })),
    total: items.length,
    page: 1,
    limit: 25,
    customer: null,
  });
const notes = pendingList([
  { id: u(10), customer: OSDE, number: '00001-00004101' },
  { id: u(11), customer: OSDE, number: '00001-00004105' },
  { id: u(12), customer: SWISS, number: '00001-00004108' },
]);
const customer = {
  id: OSDE.id,
  name: 'OSDE',
  kind: 'HEALTH_INSURER',
  legalName: null,
  cuit: '20123456786',
  taxConditionText: 'IVA Responsable Inscripto',
  addressLine: null,
  locality: null,
  province: null,
  postalCode: null,
};
function invoice(extra: Partial<InvoiceView> = {}): InvoiceView {
  return invoiceSchema.parse({
    id: u(50),
    status: 'DRAFT',
    version: 2,
    invoiceType: null,
    issueDate: '2026-10-27',
    currency: 'ARS',
    notes: null,
    customer,
    customerArchived: false,
    netAmount: '0.00',
    vatAmount: '0.00',
    totalAmount: '0.00',
    complete: false,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    readyAt: null,
    readyBy: null,
    replayed: false,
    deliveryNotes: [
      { id: u(10), number: '00001-00004101', documentDate: '2026-10-01', lineCount: 1 },
      { id: u(11), number: '00001-00004105', documentDate: '2026-10-05', lineCount: 1 },
    ],
    lines: [
      {
        id: u(60),
        deliveryNoteId: u(10),
        productId: u(70),
        description: 'Rodillera · Talle M',
        productName: 'Rodillera',
        presentation: 'Talle M',
        unitOfMeasure: 'UNIT',
        quantity: '2',
        unitPrice: null,
        vatRate: null,
        netAmount: null,
        vatAmount: null,
        totalAmount: null,
      },
      {
        id: u(61),
        deliveryNoteId: u(11),
        productId: u(71),
        description: 'Venda',
        productName: 'Venda',
        presentation: null,
        unitOfMeasure: 'METER',
        quantity: '1.5',
        unitPrice: null,
        vatRate: null,
        netAmount: null,
        vatAmount: null,
        totalAmount: null,
      },
    ],
    history: [{ action: 'INVOICE_CREATED', at: '2026-10-27T10:00:00.000Z', actor: 'Ana' }],
    ...extra,
  });
}
const priced = (status: 'DRAFT' | 'READY', version = 3) =>
  invoice({
    status,
    version,
    invoiceType: 'INVOICE_A',
    netAmount: '2500.00',
    vatAmount: '472.50',
    totalAmount: '2972.50',
    complete: true,
    readyAt: status === 'READY' ? '2026-10-27T11:00:00.000Z' : null,
    readyBy: status === 'READY' ? 'Ana' : null,
    lines: invoice().lines.map((l, i) => ({
      ...l,
      unitPrice: i === 0 ? '1000.00' : '333.33',
      vatRate: i === 0 ? 'VAT_21' : 'VAT_10_5',
      netAmount: i === 0 ? '2000.00' : '500.00',
      vatAmount: i === 0 ? '420.00' : '52.50',
      totalAmount: i === 0 ? '2420.00' : '552.50',
    })),
  });

type Call = { url: string; method: string; body?: unknown };
let calls: Call[] = [];
const originalFetch = globalThis.fetch;
function serve(handler: (call: Call) => { status?: number; body: unknown }) {
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = handler(call);
    return Response.json(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
}
const apiError = (status: number, message: string) => ({
  status,
  body: {
    statusCode: status,
    code: 'CONFLICT',
    message,
    requestId: u(99),
    timestamp: '2026-10-27T00:00:00.000Z',
    path: '/api/invoices',
  },
});
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
async function mount(node: ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  await settle();
}
const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label);
async function click(element: Element | undefined) {
  assert.ok(element, 'missing element; screen: ' + text());
  await act(async () => (element as HTMLElement).click());
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
});

test('helpers: dinero exacto en formato argentino y selección de un solo cliente', () => {
  assert.equal(formatMoney('2972.5'), '$ 2.972,50');
  assert.equal(formatMoney('1234567.89'), '$ 1.234.567,89');
  assert.equal(formatMoney('0.00'), '$ 0,00');
  for (const [input, expected] of [
    ['1234,56', '1234.56'],
    ['1.234,56', '1234.56'],
    ['1234.56', '1234.56'],
    ['$ 1.000', '1000'],
    ['0,5', '0.5'],
    ['', null],
    ['-1', null],
    ['1,234', null],
    ['abc', null],
    ['1.2.3', null],
  ] as const)
    assert.equal(parseMoneyInput(input), expected, input);
  assert.equal(moneyInputText('1000.00'), '1000,00');
  const first = toggleSelection(null, notes.items[0]!);
  assert.ok(first && first !== 'OTHER_CUSTOMER');
  const two = toggleSelection(first, notes.items[1]!);
  assert.ok(two && two !== 'OTHER_CUSTOMER' && two.ids.length === 2);
  assert.equal(toggleSelection(two, notes.items[2]!), 'OTHER_CUSTOMER');
  assert.equal(toggleSelection(first, notes.items[0]!), null);
  assert.equal(internalReference(u(50)), 'Ref. interna 00000000');
});

test('pendientes: lista, búsqueda, selección múltiple del mismo cliente y crear factura', async () => {
  serve((c) => (c.method === 'POST' ? { body: invoice() } : { body: notes }));
  const opened: string[] = [];
  await mount(<BillingView isAdmin open={(id) => opened.push(id)} />);
  assert.equal(calls[0]!.url, '/api/invoices/pending-delivery-notes');
  assert.match(text(), /Pendientes de facturar/);
  assert.match(text(), /no tienen CAE ni validez fiscal/);
  assert.equal(container.querySelectorAll('tbody tr').length, 3);
  assert.match(text(), /Paciente\/Afiliado asociado/);
  assert.equal(container.querySelector('tbody a')!.getAttribute('href'), '/remitos/' + u(10));
  await type(container.querySelector<HTMLInputElement>('#billing-search')!, '4105');
  await act(async () =>
    container
      .querySelector('form')!
      .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
  );
  await settle();
  assert.equal(calls.at(-1)!.url, '/api/invoices/pending-delivery-notes?search=4105');
  const boxes = () => [
    ...container.querySelectorAll<HTMLInputElement>('tbody input[type=checkbox]'),
  ];
  await click(boxes()[0]);
  await click(boxes()[1]);
  assert.match(text(), /2 Remitos seleccionados · Cliente OSDE/);
  // Another customer's Remito cannot join the selection.
  assert.equal(boxes()[2]!.disabled, true);
  await click(button('Crear factura'));
  const post = calls.find((c) => c.method === 'POST')!;
  assert.equal(post.url, '/api/invoices');
  assert.deepEqual((post.body as { deliveryNoteIds: string[] }).deliveryNoteIds, [u(10), u(11)]);
  assert.match((post.body as { id: string }).id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(opened, [u(50)]);
});

test('pendientes: conflicto humano, reintento con la misma clave y operador sin crear', async () => {
  serve((c) =>
    c.method === 'POST'
      ? apiError(409, 'Este Remito ya fue incluido en otra factura.')
      : { body: notes },
  );
  await mount(<BillingView isAdmin open={() => {}} />);
  await click(container.querySelector('tbody input[type=checkbox]')!);
  await click(button('Crear factura'));
  assert.match(
    container.querySelector('[role=alert]')!.textContent!,
    /ya fue incluido en otra factura/,
  );
  await click(button('Crear factura'));
  const posts = calls.filter((c) => c.method === 'POST').map((c) => (c.body as { id: string }).id);
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
  await act(async () => root?.unmount());
  serve(() => ({ body: notes }));
  await mount(<BillingView isAdmin={false} open={() => {}} />);
  await click(container.querySelector('tbody input[type=checkbox]')!);
  assert.equal(button('Crear factura'), undefined);
  assert.match(text(), /Solo un administrador puede crear facturas/);
});

test('estados vacíos y lista de facturas con filtro de estado', async () => {
  serve((c) =>
    c.url.includes('pending')
      ? { body: pendingList([]) }
      : {
          body: invoiceListSchema.parse({
            items: c.url.includes('status=READY')
              ? []
              : [
                  {
                    id: u(50),
                    status: 'DRAFT',
                    invoiceType: null,
                    issueDate: '2026-10-27',
                    customer: OSDE,
                    deliveryNoteNumbers: ['00001-00004101', '00001-00004105'],
                    totalAmount: '2972.50',
                    complete: false,
                  },
                ],
            total: c.url.includes('status=READY') ? 0 : 1,
            page: 1,
            limit: 25,
            customer: null,
          }),
        },
  );
  await mount(<BillingView isAdmin open={() => {}} />);
  assert.match(text(), /No hay Remitos pendientes de facturar\./);
  await click(button('Facturas'));
  assert.equal(calls.at(-1)!.url, '/api/invoices');
  const row = container.querySelector('tbody tr')!.textContent!;
  assert.match(row, /OSDE/);
  assert.match(row, /00001-00004101, 00001-00004105/);
  assert.match(row, /Borrador/);
  assert.match(row, /\$ 2\.972,50/);
  assert.match(row, /Faltan precios o IVA/);
  assert.equal(container.querySelector('tbody a')!.getAttribute('href'), '/facturacion/' + u(50));
  const status = [...container.querySelectorAll('select')].at(-1)!;
  await type(status, 'READY');
  assert.equal(calls.at(-1)!.url, '/api/invoices?status=READY');
  assert.match(text(), /Todavía no hay facturas\./);
});

test('editor: precio con coma, IVA por línea y para todas, totales y validación antes de lista', async () => {
  serve((c) => (c.method === 'PATCH' ? { body: priced('DRAFT') } : { body: invoice() }));
  await mount(<InvoiceDetailView id={u(50)} isAdmin discarded={() => {}} />);
  assert.equal(calls[0]!.url, '/api/invoices/' + u(50));
  assert.match(text(), /Borrador de factura/);
  assert.match(text(), /Ref\. interna/);
  assert.doesNotMatch(text(), /Factura A 0000/);
  const links = [...container.querySelectorAll('a')].filter((a) => a.textContent === 'Ver Remito');
  assert.deepEqual(
    links.map((a) => a.getAttribute('href')),
    ['/remitos/' + u(10), '/remitos/' + u(11)],
  );
  // Missing price/VAT/type: a human message and no request.
  await click(button('Marcar lista para autorizar'));
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Elegí el tipo de factura/);
  assert.equal(calls.length, 1);
  const [typeSelect, allVat] = [...container.querySelectorAll('select')];
  await type(typeSelect!, 'INVOICE_A');
  await click(button('Guardar y marcar lista para autorizar'));
  assert.match(
    container.querySelector('[role=alert]')!.textContent!,
    /Completá el precio unitario de “Rodillera · Talle M”/,
  );
  const prices = () => [
    ...container.querySelectorAll<HTMLInputElement>('input[inputmode=decimal]'),
  ];
  await type(prices()[0]!, '1.000,00');
  await type(prices()[1]!, '333,33');
  await click(button('Guardar y marcar lista para autorizar'));
  assert.match(
    container.querySelector('[role=alert]')!.textContent!,
    /Revisá el IVA de “Rodillera · Talle M”/,
  );
  await type(allVat!, 'VAT_21');
  const lineVat = container.querySelector<HTMLSelectElement>('select[aria-label="IVA de Venda"]')!;
  await type(lineVat, 'VAT_10_5');
  const rows = [...container.querySelectorAll('tbody tr')].map((r) => r.textContent!);
  assert.match(rows[0]!, /\$ 2\.000,00.*\$ 420,00.*\$ 2\.420,00/);
  assert.match(rows[1]!, /\$ 500,00.*\$ 52,50.*\$ 552,50/);
  const summary = container.querySelector('[aria-label=Resumen]')!.textContent!;
  assert.match(summary, /Neto\$ 2\.500,00IVA\$ 472,50Total\$ 2\.972,50/);
  await click(button('Guardar borrador'));
  const patch = calls.find((c) => c.method === 'PATCH')!;
  assert.deepEqual(patch.body, {
    expectedVersion: 2,
    invoiceType: 'INVOICE_A',
    issueDate: '2026-10-27',
    notes: null,
    lines: [
      { id: u(60), description: 'Rodillera · Talle M', unitPrice: '1000.00', vatRate: 'VAT_21' },
      { id: u(61), description: 'Venda', unitPrice: '333.33', vatRate: 'VAT_10_5' },
    ],
  });
  // No browser totals travel to the API.
  assert.equal('totalAmount' in (patch.body as object), false);
});

test('marcar lista: guarda, envía operationId, muestra "Lista para autorizar" sin rótulos fiscales', async () => {
  serve((c) => {
    if (c.method === 'PATCH') return { body: priced('DRAFT', 3) };
    if (c.url.endsWith('/ready')) return { body: priced('READY', 4) };
    if (c.url.endsWith('/reopen')) return { body: priced('DRAFT', 5) };
    return { body: invoice() };
  });
  await mount(<InvoiceDetailView id={u(50)} isAdmin discarded={() => {}} />);
  const [typeSelect, allVat] = [...container.querySelectorAll('select')];
  await type(typeSelect!, 'INVOICE_A');
  await type(allVat!, 'VAT_21');
  for (const input of container.querySelectorAll<HTMLInputElement>('input[inputmode=decimal]'))
    await type(input, '10');
  await click(button('Guardar y marcar lista para autorizar'));
  const ready = calls.find((c) => c.url.endsWith('/ready'))!;
  assert.equal((ready.body as { expectedVersion: number }).expectedVersion, 3);
  assert.match((ready.body as { operationId: string }).operationId, /^[0-9a-f-]{36}$/);
  assert.ok(calls.findIndex((c) => c.method === 'PATCH') < calls.indexOf(ready));
  assert.match(text(), /Factura lista para autorizar/);
  assert.match(text(), /no tiene CAE ni validez fiscal/);
  assert.match(text(), /Integración ARCA pendiente/);
  for (const forbidden of [
    /Facturada/,
    /Autorizada por ARCA/,
    /CAE obtenido/,
    /Comprobante válido/,
  ])
    assert.doesNotMatch(text(), forbidden);
  assert.equal(container.querySelectorAll('input[inputmode=decimal]').length, 0);
  assert.match(text(), /\$ 2\.972,50/);
  await click(button('Volver a borrador'));
  assert.ok(calls.some((c) => c.url.endsWith('/reopen')));
  assert.match(text(), /Borrador de factura/);
});

test('detalle: error humano, operador sin edición e historial', async () => {
  serve(() => apiError(404, 'No encontramos lo que buscás.'));
  await mount(<InvoiceDetailView id={u(50)} isAdmin discarded={() => {}} />);
  assert.match(
    container.querySelector('[role=alert]')!.textContent!,
    /No encontramos lo que buscás/,
  );
  await act(async () => root?.unmount());
  serve(() => ({ body: invoice() }));
  await mount(<InvoiceDetailView id={u(50)} isAdmin={false} discarded={() => {}} />);
  assert.equal(container.querySelectorAll('input, select, textarea').length, 0);
  assert.match(text(), /Solo un administrador puede modificar facturas/);
  assert.match(text(), /Creada desde Remitos · .* · Ana/);
  assert.equal(
    readyProblem(invoice(), {
      invoiceType: 'INVOICE_B',
      issueDate: '2026-10-27',
      notes: '',
      lines: invoice().lines.map((l) => ({
        id: l.id,
        description: l.description,
        price: '1',
        vatRate: 'VAT_21',
      })),
    }),
    null,
  );
});

const previousBase = process.env.API_BASE_URL,
  previousOrigin = process.env.WEB_ORIGIN;
after(() => {
  if (previousBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = previousBase;
  if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = previousOrigin;
});
test('BFF facturación: allowlist, CSRF, cuerpo estricto y respuesta validada', async () => {
  process.env.API_BASE_URL = 'http://internal.invalid:3001';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  let upstream: string | undefined;
  globalThis.fetch = (async (url: string | URL | Request) => {
    upstream = String(url);
    return Response.json(url.toString().includes('pending') ? notes : invoice());
  }) as typeof fetch;
  const call = (parts: string[], method = 'GET', body?: unknown, csrf = '1', search = '') =>
    proxyInvoices(
      new Request('http://localhost:3000/api/invoices/' + parts.join('/') + search, {
        method,
        headers: {
          Origin: 'http://localhost:3000',
          'X-Maxbio-Csrf': csrf,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      parts,
    );
  assert.equal(
    (await call(['pending-delivery-notes'], 'GET', undefined, '1', '?customerId=' + OSDE.id))
      .status,
    200,
  );
  assert.equal(
    upstream,
    `http://internal.invalid:3001/api/v1/invoices/pending-delivery-notes?customerId=${OSDE.id}`,
  );
  const create = { id: u(50), deliveryNoteIds: [u(10)] };
  assert.equal((await call([], 'POST', create)).status, 200);
  assert.equal((await call([], 'POST', create, '0')).status, 403);
  for (const body of [
    { ...create, organizationId: u(1) },
    { ...create, totalAmount: '1.00' },
    { id: u(50), deliveryNoteIds: [] },
  ])
    assert.equal((await call([], 'POST', body)).status, 400);
  assert.equal((await call([u(50)], 'DELETE')).status, 404);
  assert.equal((await call([u(50), 'authorize'], 'POST', {})).status, 404);
  assert.equal(
    (await call(['pending-delivery-notes'], 'GET', undefined, '1', '?raw=x')).status,
    400,
  );
  globalThis.fetch = (async () =>
    Response.json({ ...invoice(), cae: '123' })) as unknown as typeof fetch;
  assert.equal((await call([u(50)])).status, 503);
});

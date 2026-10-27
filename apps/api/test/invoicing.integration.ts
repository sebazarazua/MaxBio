import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { before, after, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  deliveryNoteSchema,
  invoiceListSchema,
  invoicePendingListSchema,
  invoiceSchema,
  type DeliveryNoteView,
  type InvoiceView,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// Facturación V1 against a disposable database: never the operational one.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_invoice_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication, base: string, org: string, foreignOrg: string;
const cookies: string[] = [];
const ADMIN = 0,
  OPERATOR = 1,
  FOREIGN = 2;
async function request(path: string, method = 'GET', body?: unknown, actor = ADMIN) {
  return fetch(base + '/api/v1/' + path, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      Cookie: cookies[actor]!,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function checked(r: Response, status = 200) {
  const b: unknown = await r.json();
  assert.equal(r.status, status, JSON.stringify(b));
  return b;
}
async function failure(r: Response, status: number, message?: RegExp) {
  const b = (await checked(r, status)) as { message: string };
  if (message) assert.match(b.message, message);
  return b;
}
async function product(
  name: string,
  unitOfMeasure: 'UNIT' | 'METER' = 'UNIT',
  organizationId = org,
) {
  return client.product.create({
    data: {
      organizationId,
      name,
      unitOfMeasure,
      presentation: 'Talle M',
      searchText: name.toLowerCase(),
    },
  });
}
async function customer(name: string, organizationId = org, cuit: string | null = null) {
  return client.customer.create({
    data: { organizationId, name, kind: 'COMPANY', cuit, searchText: name.toLowerCase() },
  });
}
const line = (productId: string, quantity: string) => ({
  id: randomUUID(),
  productId,
  quantity,
  allocations: [],
});
async function draftNote(
  customerId: string,
  documentDate: string,
  lines: object[],
  actor = ADMIN,
  patientName?: string,
) {
  return deliveryNoteSchema.parse(
    await checked(
      await request(
        'delivery-notes',
        'POST',
        {
          id: randomUUID(),
          customerId,
          documentDate,
          lines,
          ...(patientName ? { patientName } : {}),
        },
        actor,
      ),
    ),
  );
}
async function confirmed(
  customerId: string,
  documentDate: string,
  lines: object[],
  actor = ADMIN,
  patientName?: string,
) {
  const d = await draftNote(customerId, documentDate, lines, actor, patientName);
  return deliveryNoteSchema.parse(
    await checked(
      await request(
        `delivery-notes/${d.id}/confirm`,
        'POST',
        { expectedVersion: d.version, operationId: randomUUID() },
        actor,
      ),
    ),
  );
}
const numberOf = (d: DeliveryNoteView) => d.documentPrefix + '-' + d.documentNumber;
async function create(deliveryNoteIds: string[], actor = ADMIN, status = 200, id = randomUUID()) {
  const r = await request('invoices', 'POST', { id, deliveryNoteIds }, actor);
  return status === 200 ? invoiceSchema.parse(await checked(r)) : failure(r, status);
}
async function pending(query: Record<string, string> = {}, actor = ADMIN) {
  return invoicePendingListSchema.parse(
    await checked(
      await request(
        'invoices/pending-delivery-notes?' + new URLSearchParams(query),
        'GET',
        undefined,
        actor,
      ),
    ),
  );
}
function edit(
  i: InvoiceView,
  changes: Partial<{ invoiceType: string | null; issueDate: string; notes: string | null }> = {},
  price: (
    l: InvoiceView['lines'][number],
    index: number,
  ) => { unitPrice: string | null; vatRate: string | null; description?: string },
) {
  return {
    expectedVersion: i.version,
    invoiceType: i.invoiceType,
    issueDate: i.issueDate,
    notes: i.notes,
    ...changes,
    lines: i.lines.map((l, index) => ({
      id: l.id,
      description: l.description,
      ...price(l, index),
    })),
  };
}
async function patch(i: InvoiceView, body: object, status = 200, actor = ADMIN) {
  const r = await request('invoices/' + i.id, 'PATCH', body, actor);
  return status === 200 ? invoiceSchema.parse(await checked(r)) : failure(r, status);
}
async function transition(
  i: InvoiceView,
  action: 'ready' | 'reopen',
  status = 200,
  operationId = randomUUID(),
  expectedVersion = i.version,
) {
  const r = await request(`invoices/${i.id}/${action}`, 'POST', { expectedVersion, operationId });
  return status === 200 ? invoiceSchema.parse(await checked(r)) : failure(r, status);
}
async function physical() {
  const where = { organizationId: { in: [org, foreignOrg] } };
  return Promise.all([
    client.inventoryBalance.count({ where }),
    client.inventoryMovement.count({ where }),
    client.inventoryMovementLine.count({ where }),
    client.deliveryNoteAllocation.count({ where }),
    client.deliveryNoteLineTrace.count({ where }),
    client.deliveryNote.aggregate({ where, _max: { updatedAt: true }, _sum: { version: true } }),
    client.deliveryNoteLine.count({ where }),
  ]);
}

let osde: { id: string; cuit: string | null },
  swiss: { id: string },
  foreignCustomer: { id: string },
  pA: { id: string },
  pB: { id: string },
  pForeign: { id: string };
let r1: DeliveryNoteView, r2: DeliveryNoteView, r3: DeliveryNoteView, rDraft: DeliveryNoteView;
let rCancelled: DeliveryNoteView, rForeign: DeliveryNoteView;

before(
  async () => {
    assert.match(databaseName, /^maxbio_invoice_test_[a-f0-9]{32}$/);
    await parent.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
    execFileSync(
      process.execPath,
      [
        resolvePath('../../packages/database/node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
      ],
      {
        cwd: resolvePath('../../packages/database'),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 60000,
      },
    );
    org = (
      await client.organization.create({
        data: { name: 'Invoice fixtures', slug: 'inv-' + randomUUID() },
      })
    ).id;
    foreignOrg = (
      await client.organization.create({
        data: { name: 'Invoice private', slug: 'inv-' + randomUUID() },
      })
    ).id;
    for (const organizationId of [org, foreignOrg])
      await client.deliveryNoteNumbering.create({
        data: { organizationId, prefix: '00001', nextNumber: 1n, numberWidth: 8 },
      });
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreignOrg, 'ADMIN'],
    ] as const) {
      const u = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'Invoice ' + role },
      });
      const m = await client.membership.create({ data: { organizationId, userId: u.id, role } });
      const token = randomBytes(32).toString('base64url');
      await client.session.create({
        data: {
          userId: u.id,
          activeMembershipId: m.id,
          tokenHash: tokenVerifier(token),
          expiresAt: new Date(Date.now() + 86400000),
          absoluteExpiresAt: new Date(Date.now() + 86400000),
        },
      });
      cookies.push('maxbio-session=' + token);
    }
    process.env.DATABASE_URL = url.toString();
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({
        client,
        ping: async () => {
          await client.$queryRaw`SELECT 1`;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();

    osde = await customer('OSDE Facturación', org, '20123456786');
    swiss = await customer('Swiss Facturación');
    pA = await product('Rodillera facturable');
    pB = await product('Venda elástica facturable', 'METER');
    r1 = await confirmed(
      osde.id,
      '2026-10-01',
      [line(pA.id, '2'), line(pB.id, '1.5')],
      OPERATOR,
      'Paciente Privado',
    );
    r2 = await confirmed(osde.id, '2026-10-05', [line(pA.id, '3')]);
    r3 = await confirmed(swiss.id, '2026-10-03', [line(pA.id, '1')]);
    rDraft = await draftNote(osde.id, '2026-10-06', [line(pA.id, '1')]);
    rCancelled = await draftNote(osde.id, '2026-10-07', [line(pA.id, '1')]);
    await checked(
      await request(`delivery-notes/${rCancelled.id}/cancel`, 'POST', {
        expectedVersion: rCancelled.version,
      }),
    );
    foreignCustomer = await customer('OSDE ajena', foreignOrg);
    pForeign = await product('Producto ajeno', 'UNIT', foreignOrg);
    rForeign = await confirmed(foreignCustomer.id, '2026-10-02', [line(pForeign.id, '1')], FOREIGN);
  },
  { timeout: 180000 },
);
after(async () => {
  await app?.close();
  await client.$disconnect();
  assert.match(databaseName, /^maxbio_invoice_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

test('pendientes: solo Remitos confirmados sin factura, filtros y sin datos de paciente', async () => {
  const all = await pending({}, OPERATOR);
  const ids = all.items.map((d) => d.id);
  for (const d of [r1, r2, r3]) assert.ok(ids.includes(d.id));
  for (const d of [rDraft, rCancelled, rForeign]) assert.equal(ids.includes(d.id), false);
  const first = all.items.find((d) => d.id === r1.id)!;
  assert.deepEqual(first, {
    id: r1.id,
    number: numberOf(r1),
    documentDate: '2026-10-01',
    customer: { id: osde.id, name: 'OSDE Facturación' },
    lineCount: 2,
    patientLinked: true,
  });
  assert.equal(JSON.stringify(all).includes('Paciente Privado'), false);
  assert.deepEqual(
    (await pending({ customerId: swiss.id })).items.map((d) => d.id),
    [r3.id],
  );
  assert.deepEqual(
    (await pending({ dateFrom: '2026-10-02', dateTo: '2026-10-04' })).items.map((d) => d.id),
    [r3.id],
  );
  assert.deepEqual(
    (await pending({ search: numberOf(r2) })).items.map((d) => d.id),
    [r2.id],
  );
  assert.deepEqual(
    (await pending({ search: r2.documentNumber!.replace(/^0+/, '') })).items.map((d) => d.id),
    [r2.id],
  );
  assert.deepEqual(
    (await pending({ search: 'swiss' })).items.map((d) => d.id),
    [r3.id],
  );
  await failure(
    await request('invoices/pending-delivery-notes?customerId=' + foreignCustomer.id),
    404,
  );
  await failure(await request('invoices/pending-delivery-notes?organizationId=' + foreignOrg), 400);
  assert.deepEqual(
    (await pending({}, FOREIGN)).items.map((d) => d.id),
    [rForeign.id],
  );
});

test('crear desde un Remito: borrador con líneas copiadas, sin precios inventados, idempotente', async () => {
  const before = await physical();
  const id = randomUUID();
  const i = (await create([r3.id], ADMIN, 200, id)) as InvoiceView;
  assert.equal(i.status, 'DRAFT');
  assert.equal(i.customer.id, swiss.id);
  assert.equal(i.invoiceType, null);
  assert.deepEqual(i.deliveryNotes, [
    { id: r3.id, number: numberOf(r3), documentDate: '2026-10-03', lineCount: 1 },
  ]);
  assert.deepEqual(
    i.lines.map((l) => [
      l.productId,
      l.description,
      l.quantity,
      l.unitOfMeasure,
      l.unitPrice,
      l.vatRate,
      l.netAmount,
    ]),
    [[pA.id, 'Rodillera facturable · Talle M', '1', 'UNIT', null, null, null]],
  );
  assert.deepEqual(
    [i.netAmount, i.vatAmount, i.totalAmount, i.complete],
    ['0.00', '0.00', '0.00', false],
  );
  assert.deepEqual(
    i.history.map((h) => h.action),
    ['INVOICE_CREATED'],
  );
  assert.equal(
    (await pending()).items.some((d) => d.id === r3.id),
    false,
  );
  // Retry / double click: same id and payload returns the same draft, never a second invoice.
  const again = (await create([r3.id], ADMIN, 200, id)) as InvoiceView;
  assert.equal(again.id, id);
  assert.equal(again.replayed, true);
  await failure(
    await request('invoices', 'POST', { id, deliveryNoteIds: [r1.id] }),
    409,
    /otros datos/,
  );
  assert.equal(await client.invoice.count({ where: { organizationId: org, id } }), 1);
  // OPERATOR reads but cannot write.
  invoiceSchema.parse(await checked(await request('invoices/' + id, 'GET', undefined, OPERATOR)));
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r1.id] }, OPERATOR),
    403,
  );
  assert.deepEqual(await physical(), before);
});

test('rechazos: clientes distintos, borrador, cancelado, ya facturado y Remito ajeno', async () => {
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r1.id, r3.id] }),
    400,
    /clientes distintos/,
  );
  const lone = await confirmed(swiss.id, '2026-10-08', [line(pA.id, '1')]);
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r1.id, lone.id] }),
    400,
    /clientes distintos/,
  );
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [rDraft.id] }),
    409,
    /confirmados/,
  );
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [rCancelled.id] }),
    409,
    /confirmados/,
  );
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r3.id] }),
    409,
    /ya fue incluido/,
  );
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [rForeign.id] }),
    404,
  );
  await failure(
    await request('invoices', 'POST', {
      id: randomUUID(),
      deliveryNoteIds: [r1.id],
      organizationId: foreignOrg,
    }),
    400,
  );
  // Nothing partial remained from the rejected attempts.
  const ids = (await pending()).items.map((d) => d.id);
  assert.ok(ids.includes(r1.id) && ids.includes(lone.id));
});

test('concurrencia: dos facturas para el mismo Remito, gana una sola', async () => {
  const r = await confirmed(osde.id, '2026-10-09', [line(pA.id, '1')]);
  const results = await Promise.all(
    [0, 1, 2].map(() => request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r.id] })),
  );
  const statuses = results.map((x) => x.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  for (const x of results.filter((x) => x.status === 409))
    assert.match(
      ((await x.json()) as { message: string }).message,
      /ya fue incluido en otra factura/,
    );
  assert.equal(
    await client.invoiceDeliveryNote.count({
      where: { organizationId: org, deliveryNoteId: r.id },
    }),
    1,
  );
});

let multi: InvoiceView;
test('varios Remitos del mismo cliente: una factura, líneas en orden y cálculo en backend', async () => {
  multi = (await create([r2.id, r1.id])) as InvoiceView;
  assert.deepEqual(
    multi.deliveryNotes.map((d) => d.id),
    [r1.id, r2.id],
  );
  assert.deepEqual(
    multi.lines.map((l) => [l.deliveryNoteId, l.productId, l.quantity, l.unitOfMeasure]),
    [
      [r1.id, pA.id, '2', 'UNIT'],
      [r1.id, pB.id, '1.5', 'METER'],
      [r2.id, pA.id, '3', 'UNIT'],
    ],
  );
  const prices = [
    { unitPrice: '1000.00', vatRate: 'VAT_21' },
    { unitPrice: '333.33', vatRate: 'VAT_10_5' },
    { unitPrice: '0.1', vatRate: 'VAT_27' },
  ];
  // Browser totals are never accepted.
  await patch(multi, { ...edit(multi, {}, (_l, i) => prices[i]!), netAmount: '1.00' }, 400);
  await patch(
    multi,
    edit(multi, {}, () => ({ unitPrice: '-1', vatRate: 'VAT_21' })),
    400,
  );
  await patch(
    multi,
    edit(multi, {}, () => ({ unitPrice: '1,5', vatRate: 'VAT_21' })),
    400,
  );
  const missing = edit(multi, {}, (_l, i) => prices[i]!);
  await patch(multi, { ...missing, lines: missing.lines.slice(1) }, 400);
  await patch(
    multi,
    { ...missing, lines: [...missing.lines.slice(1), { ...missing.lines[0]!, id: randomUUID() }] },
    400,
  );
  const priced = (await patch(
    multi,
    edit(multi, { invoiceType: 'INVOICE_A', notes: 'Entrega octubre' }, (l, i) => ({
      ...prices[i]!,
      description: i === 0 ? 'Rodillera articulada (comercial)' : l.description,
    })),
  )) as InvoiceView;
  assert.deepEqual(
    priced.lines.map((l) => [l.unitPrice, l.netAmount, l.vatAmount, l.totalAmount]),
    [
      ['1000.00', '2000.00', '420.00', '2420.00'],
      ['333.33', '500.00', '52.50', '552.50'],
      ['0.10', '0.30', '0.08', '0.38'],
    ],
  );
  assert.deepEqual(
    [priced.netAmount, priced.vatAmount, priced.totalAmount, priced.complete],
    ['2500.30', '472.58', '2972.88', true],
  );
  assert.equal(priced.lines[0]!.description, 'Rodillera articulada (comercial)');
  assert.equal(priced.version, multi.version + 1);
  // Stale version.
  await patch(
    multi,
    edit(multi, {}, (_l, i) => prices[i]!),
    409,
  );
  multi = priced;
});

test('lista para autorizar: validaciones, recálculo, snapshot congelado y reintento seguro', async () => {
  const incomplete = (await create([
    (await confirmed(osde.id, '2026-10-10', [line(pA.id, '2')])).id,
  ])) as InvoiceView;
  await transition(incomplete, 'ready', 400);
  const typed = (await patch(
    incomplete,
    edit(incomplete, { invoiceType: 'INVOICE_B' }, () => ({ unitPrice: null, vatRate: 'VAT_21' })),
  )) as InvoiceView;
  assert.match(
    ((await transition(typed, 'ready', 400)) as { message: string }).message,
    /Completá el precio unitario/,
  );
  const noVat = (await patch(
    typed,
    edit(typed, {}, () => ({ unitPrice: '10', vatRate: null })),
  )) as InvoiceView;
  assert.match(
    ((await transition(noVat, 'ready', 400)) as { message: string }).message,
    /Revisá el IVA/,
  );
  const typeC = (await patch(
    noVat,
    edit(noVat, { invoiceType: 'INVOICE_C' }, () => ({ unitPrice: '10', vatRate: 'VAT_21' })),
  )) as InvoiceView;
  assert.match(
    ((await transition(typeC, 'ready', 400)) as { message: string }).message,
    /facturas C no discriminan IVA/,
  );
  const swissA = (await create([
    (await confirmed(swiss.id, '2026-10-11', [line(pA.id, '1')])).id,
  ])) as InvoiceView;
  const swissPriced = (await patch(
    swissA,
    edit(swissA, { invoiceType: 'INVOICE_A' }, () => ({ unitPrice: '5', vatRate: 'VAT_21' })),
  )) as InvoiceView;
  assert.match(
    ((await transition(swissPriced, 'ready', 400)) as { message: string }).message,
    /requiere el CUIT/,
  );

  const operationId = randomUUID();
  const ready = (await transition(multi, 'ready', 200, operationId)) as InvoiceView;
  assert.equal(ready.status, 'READY');
  assert.equal(ready.readyBy, 'Invoice ADMIN');
  assert.equal(ready.totalAmount, '2972.88');
  assert.equal(ready.customer.cuit, '20123456786');
  const snapshot = await client.invoice.findUniqueOrThrow({ where: { id: multi.id } });
  assert.equal((snapshot.customerSnapshot as { name: string }).name, 'OSDE Facturación');
  // Retry with the same operation: replay, no second transition.
  const replay = (await transition(multi, 'ready', 200, operationId)) as InvoiceView;
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, ready.version);
  await transition(ready, 'ready', 409);
  await failure(
    await request(`invoices/${multi.id}/ready`, 'POST', {
      expectedVersion: ready.version,
      operationId,
    }),
    409,
    /otros datos/,
  );
  // READY is frozen.
  await patch(
    ready,
    edit(ready, {}, (l) => ({ unitPrice: '1', vatRate: l.vatRate })),
    409,
  );
  await failure(
    await request(`invoices/${ready.id}/discard`, 'POST', { expectedVersion: ready.version }),
    409,
  );
  multi = ready;
});

test('historia: cambios posteriores de Cliente y Producto no reescriben la factura lista', async () => {
  await client.customer.update({
    where: { id: osde.id },
    data: { name: 'OSDE renombrada', searchText: 'osde renombrada' },
  });
  await client.product.update({
    where: { id: pA.id },
    data: { name: 'Nombre nuevo', presentation: 'Otra' },
  });
  const view = invoiceSchema.parse(await checked(await request('invoices/' + multi.id)));
  assert.equal(view.customer.name, 'OSDE Facturación');
  assert.deepEqual(
    view.lines.map((l) => [l.productName, l.presentation]),
    [
      ['Rodillera facturable', 'Talle M'],
      ['Venda elástica facturable', 'Talle M'],
      ['Rodillera facturable', 'Talle M'],
    ],
  );
  assert.equal(view.lines[0]!.description, 'Rodillera articulada (comercial)');
  const list = invoiceListSchema.parse(await checked(await request('invoices?status=READY')));
  assert.equal(list.items.find((i) => i.id === multi.id)?.customer.name, 'OSDE Facturación');
  assert.deepEqual(
    view.history.map((h) => h.action),
    ['INVOICE_CREATED', 'INVOICE_UPDATED', 'INVOICE_MARKED_READY'],
  );
});

test('volver a borrador y descartar: libera Remitos solo desde borrador', async () => {
  const draft = (await transition(multi, 'reopen')) as InvoiceView;
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.customer.name, 'OSDE renombrada');
  assert.equal(draft.readyAt, null);
  assert.equal(draft.totalAmount, '2972.88');
  const again = (await transition(draft, 'ready')) as InvoiceView;
  assert.equal(again.customer.name, 'OSDE renombrada');
  const reopened = (await transition(again, 'reopen')) as InvoiceView;
  await failure(
    await request(`invoices/${reopened.id}/discard`, 'POST', {
      expectedVersion: reopened.version - 1,
    }),
    409,
  );
  await checked(
    await request(`invoices/${reopened.id}/discard`, 'POST', { expectedVersion: reopened.version }),
  );
  await failure(await request('invoices/' + reopened.id), 404);
  const ids = (await pending()).items.map((d) => d.id);
  assert.ok(ids.includes(r1.id) && ids.includes(r2.id));
  multi = (await create([r1.id, r2.id])) as InvoiceView;
});

test('facturas: lista con filtros de estado, cliente, fecha y número de Remito', async () => {
  const drafts = invoiceListSchema.parse(await checked(await request('invoices?status=DRAFT')));
  assert.ok(drafts.items.every((i) => i.status === 'DRAFT'));
  const byNumber = invoiceListSchema.parse(
    await checked(await request('invoices?search=' + numberOf(r1))),
  );
  assert.deepEqual(
    byNumber.items.map((i) => i.id),
    [multi.id],
  );
  assert.deepEqual(byNumber.items[0]!.deliveryNoteNumbers, [numberOf(r1), numberOf(r2)]);
  assert.equal(byNumber.items[0]!.complete, false);
  const bySwiss = invoiceListSchema.parse(
    await checked(await request('invoices?customerId=' + swiss.id, 'GET', undefined, OPERATOR)),
  );
  assert.ok(bySwiss.items.length >= 2 && bySwiss.items.every((i) => i.customer.id === swiss.id));
  assert.equal(
    invoiceListSchema.parse(await checked(await request('invoices?dateFrom=2099-01-01'))).total,
    0,
  );
});

test('multi-tenant: facturas, Remitos y clientes ajenos no se ven ni se modifican', async () => {
  await failure(await request('invoices/' + multi.id, 'GET', undefined, FOREIGN), 404);
  await failure(
    await request(
      'invoices/' + multi.id,
      'PATCH',
      edit(multi, {}, () => ({ unitPrice: null, vatRate: null })),
      FOREIGN,
    ),
    404,
  );
  await failure(
    await request(
      `invoices/${multi.id}/ready`,
      'POST',
      { expectedVersion: multi.version, operationId: randomUUID() },
      FOREIGN,
    ),
    404,
  );
  assert.equal(
    invoiceListSchema.parse(await checked(await request('invoices', 'GET', undefined, FOREIGN)))
      .total,
    0,
  );
  await failure(await request('invoices?customerId=' + osde.id, 'GET', undefined, FOREIGN), 404);
  await failure(
    await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [r1.id] }, FOREIGN),
    404,
  );
  const theirs = (await create([rForeign.id], FOREIGN)) as InvoiceView;
  await failure(await request('invoices/' + theirs.id), 404);
});

test('defensa en base de datos: estado, unicidad, cliente, cobertura, montos e inmutabilidad', async () => {
  const fresh = await confirmed(osde.id, '2026-10-12', [line(pA.id, '1')]);
  const other = await confirmed(swiss.id, '2026-10-12', [line(pA.id, '1')]);
  const inv = (await create([fresh.id])) as InvoiceView;
  const rejects = (fn: () => Promise<unknown>) => assert.rejects(fn);
  const link = (deliveryNoteId: string, customerId = osde.id) =>
    client.invoiceDeliveryNote.create({
      data: { organizationId: org, invoiceId: inv.id, customerId, deliveryNoteId, ordinal: 9 },
    });
  await rejects(() => link(rDraft.id));
  await rejects(() => link(fresh.id));
  await rejects(() => link(other.id, osde.id));
  await rejects(() => link(other.id, swiss.id));
  // A linked Remito must be invoiced completely and amounts must follow the rounding rule.
  await rejects(() => client.invoiceLine.deleteMany({ where: { invoiceId: inv.id } }));
  const l = inv.lines[0]!;
  await rejects(() =>
    client.invoiceLine.update({
      where: { id: l.id },
      data: {
        unitPrice: '10',
        vatRate: 'VAT_21',
        netAmount: '11',
        vatAmount: '2.1',
        totalAmount: '13.1',
      },
    }),
  );
  await rejects(() => client.invoiceLine.update({ where: { id: l.id }, data: { quantity: '2' } }));
  await rejects(() =>
    client.invoiceLine.update({
      where: { id: l.id },
      data: {
        unitPrice: '10',
        vatRate: 'VAT_21',
        netAmount: '10',
        vatAmount: '2.1',
        totalAmount: '12.1',
      },
    }),
  );
  await rejects(() =>
    client.invoice.update({ where: { id: inv.id }, data: { netAmount: '5', totalAmount: '5' } }),
  );
  await rejects(() =>
    client.invoice.update({ where: { id: inv.id }, data: { customerId: swiss.id } }),
  );
  await rejects(() => client.invoice.update({ where: { id: inv.id }, data: { currency: 'USD' } }));
  const readyRow = await client.invoice.findUniqueOrThrow({ where: { id: multi.id } });
  assert.equal(readyRow.status, 'DRAFT');
  const priced = (await patch(
    multi,
    edit(multi, { invoiceType: 'INVOICE_B' }, () => ({ unitPrice: '1', vatRate: 'VAT_0' })),
  )) as InvoiceView;
  const ready = (await transition(priced, 'ready')) as InvoiceView;
  await rejects(() =>
    client.invoiceLine.update({
      where: { id: ready.lines[0]!.id },
      data: { description: 'Cambio' },
    }),
  );
  await rejects(() =>
    client.invoice.update({ where: { id: ready.id }, data: { notes: 'Cambio' } }),
  );
  await rejects(() => client.invoice.delete({ where: { id: ready.id } }));
  await rejects(() => client.invoiceDeliveryNote.deleteMany({ where: { invoiceId: ready.id } }));
  assert.equal(await client.invoiceDeliveryNote.count({ where: { invoiceId: ready.id } }), 2);
});

test('facturación no modifica Inventory, allocations, traces ni Remitos', async () => {
  const before = await physical();
  const r = await confirmed(swiss.id, '2026-10-13', [line(pB.id, '2.25')]);
  const afterRemito = await physical();
  assert.notDeepEqual(afterRemito, before);
  const i = (await create([r.id])) as InvoiceView;
  const p = (await patch(
    i,
    edit(i, { invoiceType: 'INVOICE_B' }, () => ({ unitPrice: '10.10', vatRate: 'EXEMPT' })),
  )) as InvoiceView;
  assert.deepEqual([p.netAmount, p.vatAmount, p.totalAmount], ['22.73', '0.00', '22.73']);
  const ready = (await transition(p, 'ready')) as InvoiceView;
  await transition(ready, 'reopen');
  assert.deepEqual(await physical(), afterRemito);
  const note = deliveryNoteSchema.parse(await checked(await request('delivery-notes/' + r.id)));
  assert.equal(note.status, 'CONFIRMED');
  assert.equal(note.version, r.version);
});

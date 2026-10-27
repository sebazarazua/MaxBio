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
  inventoryDocumentSchema,
  inventoryPhysicalMatchSchema,
  traceabilityDetailSchema,
  traceabilityListSchema,
  type DeliveryNoteView,
  type InventoryDocument,
  type TraceabilityList,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import { hasValidGtinCheckDigit } from '../src/common/domain/scanning/gtin.js';
import { TraceabilityService } from '../src/modules/traceability/application/traceability.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// Trazabilidad against a disposable database: never the operational one.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_trace_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication, base: string, org: string, foreignOrg: string, supplier: string;
const cookies: string[] = [];
const memberships: { userId: string; membershipId: string }[] = [];
let sequence = 0;
// Synthetic GTIN-14 with a recomputed check digit; never a real product.
function gtin() {
  const body = '0779' + String(++sequence + 700).padStart(9, '0');
  for (let digit = 0; digit < 10; digit++)
    if (hasValidGtinCheckDigit(body + digit)) return body + digit;
  throw new Error('unreachable');
}
async function request(path: string, method = 'GET', body?: unknown, actor = 1) {
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
async function product(
  name: string,
  options: { gtin?: string; policy?: object; organizationId?: string } = {},
) {
  const organizationId = options.organizationId ?? org;
  const p = await client.product.create({
    data: { organizationId, name, unitOfMeasure: 'UNIT', searchText: name.toLowerCase() },
  });
  if (options.gtin)
    await client.productIdentifier.create({
      data: {
        organizationId,
        productId: p.id,
        kind: 'GTIN',
        value: options.gtin,
        normalizedValue: options.gtin,
      },
    });
  if (options.policy)
    await checked(
      await request(
        'inventory/products/' + p.id + '/policy',
        'PUT',
        { expectedVersion: 0, ...options.policy },
        0,
      ),
    );
  return p;
}
async function customer(name: string, organizationId = org) {
  return client.customer.create({
    data: { organizationId, name, kind: 'COMPANY', searchText: name.toLowerCase() },
  });
}
async function document(r: Promise<Response>) {
  return inventoryDocumentSchema.parse(await checked(await r));
}
// Stock only through the real receipt/posting flow.
async function receive(p: { id: string; unitOfMeasure: string }, line: object) {
  let d: InventoryDocument = await document(
    request('inventory/receipts', 'POST', { id: randomUUID(), supplierId: supplier }),
  );
  d = await document(
    request(`inventory/receipts/${d.id}/lines/${randomUUID()}`, 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      unitOfMeasure: p.unitOfMeasure,
      ...line,
    }),
  );
  await checked(
    await request(`inventory/receipts/${d.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: d.version,
    }),
  );
}
async function position(productId: string, criteria: object) {
  const m = inventoryPhysicalMatchSchema.parse(
    await checked(
      await request(`inventory/products/${productId}/physical-match`, 'POST', criteria),
    ),
  );
  return m.positions[0]!.positionId;
}
const declared = (
  quantity: string,
  physical: { lotNumber?: string; expirationDate?: string; serialNumber?: string },
  extra: object = {},
) => ({ id: randomUUID(), quantity, ...physical, ...extra });
const line = (
  productId: string,
  quantity: string,
  physicalTraces: object[] = [],
  allocations: object[] = [],
) => ({ id: randomUUID(), productId, quantity, allocations, physicalTraces });
async function draftNote(
  customerId: string,
  documentDate: string,
  lines: object[],
  options: { patientName?: string; actor?: number } = {},
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
          ...(options.patientName ? { patientName: options.patientName } : {}),
          lines,
        },
        options.actor ?? 1,
      ),
    ),
  );
}
async function confirmed(
  customerId: string,
  documentDate: string,
  lines: object[],
  options: { patientName?: string; actor?: number; reviewed?: string[] } = {},
) {
  const d = await draftNote(customerId, documentDate, lines, options);
  return deliveryNoteSchema.parse(
    await checked(
      await request(
        `delivery-notes/${d.id}/confirm`,
        'POST',
        {
          expectedVersion: d.version,
          operationId: randomUUID(),
          ...(options.reviewed ? { reviewedPriorTraceIds: options.reviewed } : {}),
        },
        options.actor ?? 1,
      ),
    ),
  );
}
async function trace(query: Record<string, string>, actor = 1, status = 200) {
  const r = await request(
    'traceability?' + new URLSearchParams(query).toString(),
    'GET',
    undefined,
    actor,
  );
  const body = await checked(r, status);
  return status === 200 ? traceabilityListSchema.parse(body) : (body as TraceabilityList);
}
const numberOf = (d: DeliveryNoteView) => d.documentPrefix + '-' + d.documentNumber;
const notes = (r: TraceabilityList) => r.items.map((i) => i.deliveryNote.id);
async function sideEffects() {
  const where = { organizationId: { in: [org, foreignOrg] } };
  return Promise.all([
    client.deliveryNote.count({ where }),
    client.deliveryNoteLine.count({ where }),
    client.deliveryNoteLineTrace.count({ where }),
    client.deliveryNoteAllocation.count({ where }),
    client.inventoryBalance.count({ where }),
    client.inventoryMovement.count({ where }),
    client.inventoryLot.count({ where }),
    client.inventorySerial.count({ where }),
    client.auditEvent.count({ where }),
    client.deliveryNote.aggregate({ where, _max: { updatedAt: true, version: true } }),
  ]);
}

const SERIAL = { lotRequired: true, expirationRequired: true, serialRequired: true };
const LOT = { lotRequired: true, expirationRequired: false, serialRequired: false };
let g: string,
  pSerial: { id: string; unitOfMeasure: string },
  pLot: { id: string; unitOfMeasure: string },
  pDoc: { id: string },
  pBulk: { id: string },
  pForeign: { id: string },
  osde: { id: string },
  swiss: { id: string },
  hospital: { id: string },
  foreignCustomer: { id: string };
let n1: DeliveryNoteView,
  n2: DeliveryNoteView,
  n3: DeliveryNoteView,
  n4: DeliveryNoteView,
  n5: DeliveryNoteView,
  foreignNote: DeliveryNoteView,
  draft: DeliveryNoteView,
  cancelled: DeliveryNoteView;

before(
  async () => {
    assert.match(databaseName, /^maxbio_trace_test_[a-f0-9]{32}$/);
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
        data: { name: 'Trace fixtures', slug: 'trace-' + randomUUID() },
      })
    ).id;
    foreignOrg = (
      await client.organization.create({
        data: { name: 'Trace private', slug: 'trace-' + randomUUID() },
      })
    ).id;
    for (const organizationId of [org, foreignOrg])
      await client.deliveryNoteNumbering.create({
        data: { organizationId, prefix: '00001', nextNumber: 1n, numberWidth: 8 },
      });
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreignOrg, 'OPERATOR'],
    ] as const) {
      const u = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'Trace ' + role },
      });
      const m = await client.membership.create({ data: { organizationId, userId: u.id, role } });
      memberships.push({ userId: u.id, membershipId: m.id });
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
    supplier = (
      await client.supplier.create({ data: { organizationId: org, name: 'Proveedor trace' } })
    ).id;
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

    // Fixtures through the real Remito/Inventory flows.
    g = gtin();
    pSerial = await product('Prótesis serie trazable', { gtin: g, policy: SERIAL });
    pLot = await product('Venda lote trazable', { policy: LOT });
    pDoc = await product('Rodillera articulada trazable');
    pBulk = await product('Gasa paginada trazable');
    osde = await customer('OSDE Trazabilidad');
    swiss = await customer('Swiss Medical Trazabilidad');
    hospital = await customer('Hospital X Trazabilidad');
    await receive(pSerial, {
      quantity: '1',
      lotNumber: 'LOT-S',
      expirationDate: '2029-06-30',
      serialNumbers: ['S9982'],
    });
    await receive(pLot, { quantity: '5', lotNumber: 'ABC123', expirationDate: '2028-03-31' });
    n1 = await confirmed(
      osde.id,
      '2026-09-01',
      [line(pDoc.id, '3', [declared('2', { lotNumber: 'ABC123', expirationDate: '2028-01-31' })])],
      { patientName: 'Paciente Privado Uno' },
    );
    n2 = await confirmed(swiss.id, '2026-09-10', [
      line(pDoc.id, '1', [declared('1', { lotNumber: 'ABC123' })]),
      line(pSerial.id, '1', [
        declared('1', { serialNumber: 'S9982' }, { scanValue: ']d201' + g + '21S9982' }),
      ]),
    ]);
    const prior = n2.lines[1]!.physicalTraces[0]!.id;
    n3 = await confirmed(
      hospital.id,
      '2026-10-01',
      [
        line(
          pSerial.id,
          '1',
          [],
          [{ positionId: await position(pSerial.id, { serialNumber: 'S9982' }), quantity: '1' }],
        ),
        line(
          pLot.id,
          '5',
          [],
          [{ positionId: await position(pLot.id, { lotNumber: 'ABC123' }), quantity: '5' }],
        ),
      ],
      { reviewed: [prior] },
    );
    // Commercial line without physical data: never a traceability result.
    n4 = await confirmed(osde.id, '2026-10-05', [line(pDoc.id, '4')]);
    n5 = await confirmed(swiss.id, '2026-08-01', [
      line(
        pBulk.id,
        '30',
        Array.from({ length: 30 }, (_, i) =>
          declared('1', { lotNumber: 'PAG-' + String(i + 1).padStart(2, '0') }),
        ),
      ),
    ]);
    draft = await draftNote(osde.id, '2026-10-10', [
      line(pDoc.id, '1', [declared('1', { lotNumber: 'ABC123', serialNumber: 'S9982' })]),
    ]);
    cancelled = await draftNote(osde.id, '2026-10-11', [
      line(pDoc.id, '1', [declared('1', { lotNumber: 'ABC123' })]),
    ]);
    await checked(
      await request(
        `delivery-notes/${cancelled.id}/cancel`,
        'POST',
        { expectedVersion: cancelled.version },
        0,
      ),
    );
    pForeign = await product('Prótesis ajena', { organizationId: foreignOrg });
    foreignCustomer = await customer('OSDE ajena', foreignOrg);
    foreignNote = await confirmed(
      foreignCustomer.id,
      '2026-10-02',
      [line(pForeign.id, '1', [declared('1', { lotNumber: 'ABC123', serialNumber: 'S9982' })])],
      { actor: 2 },
    );
  },
  { timeout: 180000 },
);
after(async () => {
  await app?.close();
  await client.$disconnect();
  assert.match(databaseName, /^maxbio_trace_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

test('serie exacta: todos los antecedentes, más reciente primero, Stock y documental diferenciados', async () => {
  const r = await trace({ search: 'S9982' });
  assert.equal(r.match, 'EXACT');
  assert.deepEqual(notes(r), [n3.id, n2.id]);
  assert.deepEqual(
    r.items.map((i) => [i.source, i.customer.name, i.serialNumber, i.quantity]),
    [
      ['STOCK', 'Hospital X Trazabilidad', 'S9982', '1'],
      ['DOCUMENTARY', 'Swiss Medical Trazabilidad', 'S9982', '1'],
    ],
  );
  // Stock snapshot of the linked unit; the documentary one keeps only what the Remito stated.
  assert.equal(r.items[0]!.lotNumber, 'LOT-S');
  assert.equal(r.items[0]!.expirationDate, '2029-06-30');
  assert.equal(r.items[1]!.lotNumber, null);
  assert.equal(r.items[0]!.deliveryNote.number, numberOf(n3));
  // Serial is exact and case-sensitive: no contains, no fuzzy.
  for (const search of ['s9982', 'S998', '9982'])
    assert.equal((await trace({ search })).total, 0, search);
});

test('lote: exacto en varios Remitos, clientes y orígenes; texto parcial como respaldo', async () => {
  const r = await trace({ search: 'ABC123' });
  assert.equal(r.match, 'EXACT');
  assert.deepEqual(notes(r), [n3.id, n2.id, n1.id]);
  assert.deepEqual(
    new Set(r.items.map((i) => i.customer.id)),
    new Set([hospital.id, swiss.id, osde.id]),
  );
  assert.deepEqual(
    r.items.map((i) => [i.product.id, i.quantity, i.source]),
    [
      [pLot.id, '5', 'STOCK'],
      [pDoc.id, '1', 'DOCUMENTARY'],
      [pDoc.id, '2', 'DOCUMENTARY'],
    ],
  );
  assert.equal(r.items[2]!.expirationDate, '2028-01-31');
  const partial = await trace({ search: 'abc12' });
  assert.equal(partial.match, 'TEXT');
  assert.deepEqual(notes(partial), notes(r));
  assert.equal((await trace({ search: 'ABC1234' })).total, 0);
});

test('DRAFT y CANCELLED excluidos; línea sin datos físicos no es trazabilidad', async () => {
  const all = await trace({});
  assert.equal(all.match, null);
  const ids = new Set(notes(all));
  for (const excluded of [draft.id, cancelled.id, n4.id, foreignNote.id])
    assert.equal(ids.has(excluded), false);
  const total = await client.deliveryNoteLineTrace.count({
    where: { organizationId: org, line: { deliveryNote: { status: 'CONFIRMED' } } },
  });
  assert.equal(all.total, total);
  assert.equal(all.total, 1 + 2 + 2 + 30);
});

test('filtros por Producto, Cliente, fecha, origen y combinados', async () => {
  const byProduct = await trace({ productId: pDoc.id });
  assert.deepEqual(notes(byProduct), [n2.id, n1.id]);
  assert.deepEqual(byProduct.filters.product, {
    id: pDoc.id,
    name: 'Rodillera articulada trazable',
  });
  const byCustomer = await trace({ customerId: osde.id });
  assert.deepEqual(notes(byCustomer), [n1.id]);
  assert.deepEqual(byCustomer.filters.customer, { id: osde.id, name: 'OSDE Trazabilidad' });
  const range = await trace({ dateFrom: '2026-09-05', dateTo: '2026-09-30' });
  assert.deepEqual(notes(range), [n2.id, n2.id]);
  const inclusive = await trace({ dateFrom: '2026-09-01', dateTo: '2026-09-01' });
  assert.deepEqual(notes(inclusive), [n1.id]);
  const stock = await trace({ source: 'STOCK' });
  assert.deepEqual(notes(stock), [n3.id, n3.id]);
  assert.ok(stock.items.every((i) => i.source === 'STOCK'));
  const documentary = await trace({ source: 'DOCUMENTARY', limit: '100' });
  assert.equal(documentary.total, 33);
  assert.ok(
    documentary.items.every((i) => i.source === 'DOCUMENTARY' && i.deliveryNote.id !== n3.id),
  );
  const combined = await trace({ search: 'ABC123', source: 'DOCUMENTARY', customerId: swiss.id });
  assert.deepEqual(notes(combined), [n2.id]);
  const none = await trace({ search: 'S9982', source: 'STOCK', dateTo: '2026-09-30' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.items, []);
});

test('número de Remito: exacto, sin ceros a la izquierda y solo número', async () => {
  const number = numberOf(n2);
  for (const search of [
    number,
    n2.documentPrefix!.replace(/^0+/, '') + '-' + n2.documentNumber!.replace(/^0+/, ''),
    n2.documentNumber!,
  ]) {
    const r = await trace({ search });
    assert.equal(r.match, 'EXACT', search);
    assert.deepEqual(notes(r), [n2.id, n2.id], search);
  }
  assert.equal((await trace({ search: '00001-99999999' })).total, 0);
});

test('GTIN exacto: observado en la lectura y GTIN del Producto, en 13 o 14 dígitos', async () => {
  for (const search of [g, g.slice(1)]) {
    const r = await trace({ search });
    assert.equal(r.match, 'EXACT');
    assert.deepEqual(notes(r), [n3.id, n2.id]);
  }
  const detail = traceabilityDetailSchema.parse(
    await checked(
      await request('traceability/' + n2.lines[1]!.physicalTraces[0]!.id, 'GET', undefined, 0),
    ),
  );
  assert.equal(detail.scannedGtin, g);
  assert.equal(detail.captureMethod, 'GS1');
  const operator = traceabilityDetailSchema.parse(
    await checked(await request('traceability/' + n2.lines[1]!.physicalTraces[0]!.id)),
  );
  assert.equal(operator.captureMethod, null);
});

test('texto controlado por producto y cliente, con snapshots históricos', async () => {
  const product = await trace({ search: 'rodillera' });
  assert.equal(product.match, 'TEXT');
  assert.deepEqual(notes(product), [n2.id, n1.id]);
  const customerText = await trace({ search: 'OSDE' });
  assert.deepEqual(notes(customerText), [n1.id]);
  // Masters change after confirmation; the result keeps what the Remito documented.
  await client.product.update({
    where: { id: pDoc.id },
    data: { name: 'Nombre nuevo', searchText: 'nombre nuevo' },
  });
  await client.customer.update({
    where: { id: osde.id },
    data: { name: 'Cliente renombrado', searchText: 'cliente renombrado' },
  });
  await receive(pLot, { quantity: '7', lotNumber: 'ABC123', expirationDate: '2028-03-31' });
  const after = await trace({ search: 'OSDE' });
  assert.deepEqual(notes(after), [n1.id]);
  assert.equal(after.items[0]!.customer.name, 'OSDE Trazabilidad');
  assert.equal(after.items[0]!.product.name, 'Rodillera articulada trazable');
  const lot = await trace({ search: 'ABC123' });
  assert.equal(lot.total, 3);
  assert.equal(lot.items[0]!.quantity, '5');
  // Text never searches patient/affiliate values.
  assert.equal((await trace({ search: 'Paciente Privado' })).total, 0);
});

test('detalle: paciente solo en detalle, Stock con movimiento/ubicación, documental explícito', async () => {
  const list = await trace({ customerId: osde.id });
  assert.equal(list.items[0]!.patientLinked, true);
  assert.equal(JSON.stringify(list).includes('Paciente Privado'), false);
  const documentary = traceabilityDetailSchema.parse(
    await checked(await request('traceability/' + list.items[0]!.traceId)),
  );
  assert.equal(documentary.patientName, 'Paciente Privado Uno');
  assert.equal(documentary.source, 'DOCUMENTARY');
  assert.equal(documentary.stock, null);
  assert.equal(documentary.documentQuantity, '3');
  assert.equal(documentary.quantity, '2');
  assert.equal(documentary.deliveryNote.number, numberOf(n1));
  const linked = (await trace({ search: 'S9982', source: 'STOCK' })).items[0]!;
  const stock = traceabilityDetailSchema.parse(
    await checked(await request('traceability/' + linked.traceId)),
  );
  assert.equal(stock.source, 'STOCK');
  assert.equal(stock.stock?.movementId, n3.movementId);
  assert.equal(stock.stock?.location.id, n3.lines[0]!.allocations[0]!.location.id);
  assert.equal(stock.patientName, null);
  for (const id of [draft.lines[0]!.physicalTraces[0]!.id, randomUUID()])
    await checked(await request('traceability/' + id), 404);
  await checked(await request('traceability/not-a-uuid'), 400);
});

test('paginación con total real y orden estable entre páginas', async () => {
  const query = { productId: pBulk.id };
  const first = await trace(query);
  assert.equal(first.total, 30);
  assert.equal(first.limit, 25);
  assert.equal(first.items.length, 25);
  const second = await trace({ ...query, page: '2' });
  assert.equal(second.items.length, 5);
  const ids = [...first.items, ...second.items].map((i) => i.traceId);
  assert.equal(new Set(ids).size, 30);
  assert.ok([...first.items, ...second.items].every((i) => i.deliveryNote.id === n5.id));
  // Same document: line and trace order, so lots appear in capture order.
  assert.deepEqual(
    [...first.items, ...second.items].map((i) => i.lotNumber),
    Array.from({ length: 30 }, (_, i) => 'PAG-' + String(i + 1).padStart(2, '0')),
  );
  for (let repeat = 0; repeat < 2; repeat++) {
    const again = await trace({ ...query, limit: '7', page: '3' });
    assert.deepEqual(
      again.items.map((i) => i.traceId),
      ids.slice(14, 21),
    );
  }
  assert.equal((await trace({ ...query, page: '5' })).items.length, 0);
});

test('aislamiento multi-tenant: sin resultados, Product ni Customer ajenos', async () => {
  const mine = await trace({ search: 'S9982' });
  assert.equal(notes(mine).includes(foreignNote.id), false);
  const theirs = await trace({ search: 'S9982' }, 2);
  assert.deepEqual(notes(theirs), [foreignNote.id]);
  assert.equal((await trace({ search: 'ABC123' }, 2)).total, 1);
  assert.equal((await trace({}, 2)).total, 1);
  await trace({ productId: pForeign.id }, 1, 404);
  await trace({ customerId: foreignCustomer.id }, 1, 404);
  await trace({ productId: pDoc.id }, 2, 404);
  await checked(await request('traceability/' + foreignNote.lines[0]!.physicalTraces[0]!.id), 404);
  await checked(
    await request('traceability/' + n1.lines[0]!.physicalTraces[0]!.id, 'GET', undefined, 2),
    404,
  );
});

test('contrato estricto, solo lectura y permisos ADMIN/OPERATOR', async () => {
  for (const query of [
    { organizationId: foreignOrg } as Record<string, string>,
    { limit: '101' },
    { page: '0' },
    { dateFrom: '2026-10-02', dateTo: '2026-10-01' },
    { dateFrom: '01/10/2026' },
    { productId: 'x' },
    { source: 'INVENTORY' },
    { raw: ']d201' + g },
  ])
    await trace(query, 1, 400);
  await checked(await request('traceability', 'POST', {}), 404);
  assert.equal((await trace({}, 0)).total, (await trace({}, 1)).total);
  const before = await sideEffects();
  await trace({ search: 'S9982' });
  await trace({ search: 'rodillera' });
  await trace({ productId: pBulk.id, page: '2' });
  await checked(await request('traceability/' + n1.lines[0]!.physicalTraces[0]!.id));
  assert.deepEqual(await sideEffects(), before);
});

test('sin N+1: la cantidad de consultas no crece con el tamaño de la página', async () => {
  let operations = 0;
  const counted = client.$extends({
    query: {
      async $allOperations({ args, query }) {
        operations++;
        return query(args);
      },
    },
  });
  const service = new TraceabilityService({ client: counted } as unknown as DatabaseService);
  const context: RequestActorContext = {
    ...memberships[1]!,
    organizationId: org,
    role: 'OPERATOR',
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const run = async (limit: number) => {
    operations = 0;
    const r = await service.search(context, { search: '', productId: pBulk.id, page: 1, limit });
    assert.equal(r.items.length, limit);
    return operations;
  };
  const one = await run(1);
  assert.equal(await run(25), one);
  assert.ok(one <= 5, String(one));
});

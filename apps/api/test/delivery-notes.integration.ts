import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { before, after, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  inventoryDocumentSchema,
  inventoryStockDetailSchema,
  inventoryHistorySchema,
  deliveryNoteSchema,
  deliveryNoteListSchema,
  type DeliveryNoteView,
  deliveryNoteCreateSchema,
  deliveryNoteUpdateSchema,
  type InventoryDocument,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { InventoryService } from '../src/modules/inventory/application/inventory.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';
import { businessDate } from '../src/modules/inventory/domain/quantity.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// The immutable ledger is not weakened for fixture teardown: this suite owns a disposable DB.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_delivery_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let customer: string;
let app: INestApplication,
  base: string,
  org: string,
  foreignOrg: string,
  supplier: string,
  foreignSupplier: string;
const actors: RequestActorContext[] = [],
  cookies: string[] = [];
async function request(path: string, method = 'GET', body?: unknown, actor = 1) {
  return fetch(base + '/api/v1/' + path, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      Cookie: cookies[actor]!,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
}
async function checked(r: Response, status = 200) {
  const b: unknown = await r.json();
  assert.equal(r.status, status, JSON.stringify(b));
  return b;
}
async function document(r: Promise<Response>) {
  return inventoryDocumentSchema.parse(await checked(await r));
}
async function product(
  unit: 'UNIT' | 'PAIR' | 'METER' = 'UNIT',
  policy = { lotRequired: false, expirationRequired: false, serialRequired: false },
) {
  const p = await client.product.create({
    data: { organizationId: org, name: 'Inventario ' + randomUUID(), unitOfMeasure: unit },
  });
  await checked(
    await request(
      'inventory/products/' + p.id + '/policy',
      'PUT',
      { expectedVersion: 0, ...policy },
      0,
    ),
  );
  return p;
}
async function opened(kind: 'receipts' | 'counts' = 'receipts') {
  return document(
    request('inventory/' + kind, 'POST', {
      id: randomUUID(),
      ...(kind === 'receipts' ? { supplierId: supplier } : {}),
    }),
  );
}
async function line(
  d: InventoryDocument,
  p: { id: string; unitOfMeasure: string },
  quantity = '1',
  extra: object = {},
  lineId = randomUUID(),
) {
  return document(
    request(
      `inventory/${d.kind === 'RECEIPT' ? 'receipts' : 'counts'}/${d.id}/lines/${lineId}`,
      'PUT',
      {
        expectedVersion: d.version,
        productId: p.id,
        unitOfMeasure: p.unitOfMeasure,
        quantity,
        ...extra,
      },
    ),
  );
}
async function confirm(d: InventoryDocument, operationId = randomUUID()) {
  return document(
    request(`inventory/${d.kind === 'RECEIPT' ? 'receipts' : 'counts'}/${d.id}/confirm`, 'POST', {
      operationId,
      expectedVersion: d.version,
      ...(d.kind === 'INITIAL_COUNT' ? { completeCoverage: true } : {}),
    }),
  );
}
async function stock(p: { id: string }) {
  return inventoryStockDetailSchema.parse(
    await checked(await request('inventory/products/' + p.id)),
  );
}
async function projection() {
  const rows = await client.$queryRaw<
    Array<{ mismatch: bigint }>
  >`WITH l AS (SELECT "organizationId","productId","locationId","lotId","serialId",condition,SUM("quantityDelta") quantity FROM "InventoryMovementLine" GROUP BY 1,2,3,4,5,6) SELECT COUNT(*) mismatch FROM l FULL JOIN "InventoryBalance" b ON l."organizationId"=b."organizationId" AND l."productId"=b."productId" AND l."locationId"=b."locationId" AND l."lotId" IS NOT DISTINCT FROM b."lotId" AND l."serialId" IS NOT DISTINCT FROM b."serialId" AND l.condition=b.condition WHERE COALESCE(l.quantity,0)<>COALESCE(b.quantity,0)`;
  assert.equal(rows[0]!.mismatch, 0n);
}
before(
  async () => {
    assert.match(databaseName, /^maxbio_delivery_test_[a-f0-9]{32}$/);
    await parent.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
    execFileSync(
      process.execPath,
      [resolve('../../packages/database/node_modules/prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: resolve('../../packages/database'),
        env: { ...process.env, DATABASE_URL: url.toString() },
        stdio: 'pipe',
        timeout: 60000,
      },
    );
    org = (
      await client.organization.create({
        data: { name: 'Inventory fixtures', slug: 'inventory-' + randomUUID() },
      })
    ).id;
    foreignOrg = (
      await client.organization.create({
        data: { name: 'Private inventory', slug: 'inventory-' + randomUUID() },
      })
    ).id;
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreignOrg, 'OPERATOR'],
    ] as const) {
      const u = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'Inventory ' + role },
      });
      const m = await client.membership.create({ data: { organizationId, userId: u.id, role } });
      const token = randomBytes(32).toString('base64url');
      const s = await client.session.create({
        data: {
          userId: u.id,
          activeMembershipId: m.id,
          tokenHash: tokenVerifier(token),
          expiresAt: new Date(Date.now() + 86400000),
          absoluteExpiresAt: new Date(Date.now() + 86400000),
        },
      });
      actors.push({
        organizationId,
        userId: u.id,
        membershipId: m.id,
        sessionId: s.id,
        role,
        requestId: randomUUID(),
      });
      cookies.push('maxbio-session=' + token);
    }
    supplier = (
      await client.supplier.create({ data: { organizationId: org, name: 'Inventory supplier' } })
    ).id;
    foreignSupplier = (
      await client.supplier.create({
        data: { organizationId: foreignOrg, name: 'Private supplier' },
      })
    ).id;
    customer = (
      await client.customer.create({
        data: {
          organizationId: org,
          name: 'Obra social principal',
          kind: 'HEALTH_INSURER',
          cuit: '20123456786',
          addressLine: 'Domicilio original',
        },
      })
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
  },
  { timeout: 120000 },
);
after(async () => {
  await app?.close();
  await client.$disconnect();
  assert.match(databaseName, /^maxbio_delivery_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

async function note(r: Promise<Response>) {
  return deliveryNoteSchema.parse(await checked(await r));
}
let sequence = 0;
async function draft(lines: object[] = [], extra: object = {}) {
  return note(
    request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-08',
      documentPrefix: '00001',
      documentNumber: String(++sequence).padStart(8, '0'),
      lines,
      ...extra,
    }),
  );
}
function outbound(d: DeliveryNoteView, operationId = randomUUID(), actor = 1) {
  return request(
    `delivery-notes/${d.id}/confirm`,
    'POST',
    { expectedVersion: d.version, operationId },
    actor,
  );
}
function editPayload(d: DeliveryNoteView, extra: object = {}) {
  return deliveryNoteUpdateSchema.parse({
    expectedVersion: d.version,
    customerId: d.customer.id,
    documentDate: d.documentDate,
    documentPrefix: d.documentPrefix,
    documentNumber: d.documentNumber,
    patientName: d.patientName,
    affiliateNumber: d.affiliateNumber,
    notes: d.notes,
    lines: d.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: l.quantity,
      allocations: l.allocations.map((a) => ({ positionId: a.positionId, quantity: a.quantity })),
    })),
    ...extra,
  });
}
async function supply(
  unit: 'UNIT' | 'PAIR' | 'METER' = 'UNIT',
  qty = '5',
  extra: object = {},
  policy = { lotRequired: false, expirationRequired: false, serialRequired: false },
) {
  const p = await product(unit, policy);
  await confirm(await line(await opened(), p, qty, extra));
  const positions = (await stock(p)).positions;
  return {
    p,
    positions,
    row: (q = '1', positionId = positions[0]!.id) => ({
      id: randomUUID(),
      productId: p.id,
      quantity: q,
      allocations: [{ positionId, quantity: q }],
    }),
  };
}

test('Vencimiento entre borrador y confirmación; dimensiones físicas no se cambian silenciosamente', async (t) => {
  const today = businessDate();
  const a = await supply('UNIT', '2', { lotNumber: 'VENCE-HOY', expirationDate: today });
  const d = await draft([a.row()]);
  await assert.rejects(
    client.inventoryBalance.update({
      where: { id: a.positions[0]!.id },
      data: { condition: 'QUARANTINE' },
    }),
  );
  const tomorrow = new Date(today + 'T03:00:00Z');
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  t.mock.timers.enable({ apis: ['Date'], now: tomorrow });
  try {
    await checked(await outbound(d), 409);
  } finally {
    t.mock.timers.reset();
  }
  assert.equal((await stock(a.p)).summary.physical, '2');
  assert.equal((await note(request('delivery-notes/' + d.id))).status, 'DRAFT');
});

test('Una línea distribuida entre lotes, líneas repetidas y suma agregada por posición', async () => {
  const a = await supply('UNIT', '3', { lotNumber: 'SPLIT-A' });
  await confirm(await line(await opened(), a.p, '2', { lotNumber: 'SPLIT-B' }));
  const positions = (await stock(a.p)).positions;
  const d = await draft([
    {
      id: randomUUID(),
      productId: a.p.id,
      quantity: '3',
      allocations: positions.map((p) => ({
        positionId: p.id,
        quantity: p.lotNumber === 'SPLIT-A' ? '1' : '2',
      })),
    },
    a.row('2'),
  ]);
  const confirmed = await note(outbound(d));
  assert.equal(confirmed.lines.length, 2);
  assert.equal(
    await client.inventoryMovementLine.count({ where: { movementId: confirmed.movementId! } }),
    3,
  );
  assert.equal((await stock(a.p)).summary.physical, '0');
  const b = await supply('UNIT', '3');
  await checked(await outbound(await draft([b.row('2'), b.row('2')])), 409);
  assert.equal((await stock(b.p)).summary.physical, '3');
  await projection();
});

test('Búsqueda POST privada, archivados históricos y scopes en conteo', async () => {
  const a = await supply('UNIT', '1'),
    d = await note(outbound(await draft([a.row()], { affiliateNumber: 'PRIVATE-SEARCH' })));
  const search = deliveryNoteListSchema.parse(
    await checked(await request('delivery-notes/search', 'POST', { q: 'PRIVATE-SEARCH' })),
  );
  assert.equal(search.items[0]?.id, d.id);
  assert.equal(JSON.stringify(search).includes('PRIVATE-SEARCH'), false);
  await client.product.update({ where: { id: a.p.id }, data: { archivedAt: new Date() } });
  assert.equal(
    (await note(request('delivery-notes/' + d.id))).lines[0]!.productName,
    d.lines[0]!.productName,
  );
  const b = await supply(),
    pending = await draft([b.row()]),
    count = await opened('counts');
  await client.inventoryStockScope.updateMany({
    where: { organizationId: org, productId: b.p.id },
    data: { activeCountSessionId: count.id },
  });
  await checked(await outbound(pending), 409);
  await checked(
    await request(
      `inventory/counts/${count.id}/cancel`,
      'POST',
      { expectedVersion: count.version },
      1,
    ),
  );
  await projection();
});

test('DRAFT: OPERATOR mínimo, creación idempotente, CRUD líneas, múltiples productos y cero efectos físicos', async () => {
  const a = await supply(),
    b = await supply('METER', '3.5');
  const input = { id: randomUUID(), customerId: customer, documentDate: '2026-10-08' };
  const baseline = await client.inventoryMovement.count();
  let d = await note(request('delivery-notes', 'POST', input));
  const replay = await note(request('delivery-notes', 'POST', input));
  assert.equal(replay.id, d.id);
  await checked(await request('delivery-notes', 'POST', { ...input, notes: 'distinto' }), 409);
  d = await note(
    request(
      `delivery-notes/${d.id}`,
      'PATCH',
      editPayload(d, { lines: [a.row('2'), a.row(), b.row('1.25')] }),
    ),
  );
  assert.equal(d.lines.length, 3);
  await checked(
    await request(`delivery-notes/${d.id}`, 'PATCH', { ...editPayload(d), expectedVersion: 1 }),
    409,
  );
  d = await note(
    request(`delivery-notes/${d.id}`, 'PATCH', editPayload(d, { lines: [a.row('3')] })),
  );
  assert.equal(d.lines.length, 1);
  assert.equal(d.lines[0]!.quantity, '3');
  await note(request('delivery-notes/' + d.id)); // preview/reopen
  assert.equal(await client.inventoryMovement.count(), baseline);
  assert.equal((await stock(a.p)).summary.physical, '5');
  assert.equal((await stock(b.p)).summary.physical, '3.5');
  assert.equal(
    await client.auditEvent.count({ where: { resourceId: d.id, action: 'DELIVERY_NOTE_CREATED' } }),
    1,
  );
  await projection();
});
test('CONFIRM: un OUTBOUND exacto, snapshot congelado, trazabilidad bidireccional e historia', async () => {
  const a = await supply('METER', '3.5', { lotNumber: 'TRACE-LOT', expirationDate: '2099-12-31' });
  let d = await draft([a.row('1.25')], {
    patientName: 'Paciente reservado',
    affiliateNumber: 'AF-PRIVADO',
  });
  d = await note(outbound(d));
  assert.equal(d.status, 'CONFIRMED');
  assert.ok(d.movementId);
  const m = await client.inventoryMovement.findUniqueOrThrow({
    where: { id: d.movementId },
    include: { lines: true },
  });
  assert.equal(m.type, 'OUTBOUND');
  assert.equal(m.deliveryNoteId, d.id);
  assert.equal(m.lines.length, 1);
  assert.equal(m.lines[0]!.quantityDelta.toString(), '-1.25');
  assert.ok(m.lines[0]!.deliveryAllocationId);
  assert.equal((await stock(a.p)).summary.physical, '2.25');
  const originalName = d.lines[0]!.productName;
  await client.product.update({
    where: { id: a.p.id },
    data: { name: 'Nombre modificado', presentation: 'Otra presentación' },
  });
  await client.customer.update({ where: { id: customer }, data: { name: 'Cliente modificado' } });
  const frozen = await note(request('delivery-notes/' + d.id));
  assert.equal(frozen.customer.name, d.customer.name);
  assert.equal(frozen.lines[0]!.productName, originalName);
  await checked(await request('delivery-notes/' + d.id, 'PATCH', editPayload(d)), 409);
  await checked(
    await request(`delivery-notes/${d.id}/cancel`, 'POST', { expectedVersion: d.version }, 0),
    409,
  );
  await checked(await request('delivery-notes/' + d.id, 'DELETE'), 404);
  const h = inventoryHistorySchema.parse(
    await checked(await request('inventory/products/' + a.p.id + '/history')),
  );
  assert.equal(h.items[0]!.sourceId, d.id);
  assert.equal(h.items[0]!.type, 'OUTBOUND');
  for (const q of [
    d.documentPrefix + '-' + d.documentNumber,
    'TRACE-LOT',
    'AF-PRIVADO',
    'Paciente',
    '20123456786',
    originalName,
  ]) {
    const result = deliveryNoteListSchema.parse(
      await checked(await request('delivery-notes?q=' + encodeURIComponent(q))),
    );
    assert.ok(
      result.items.some((r) => r.id === d.id),
      q,
    );
    assert.equal(JSON.stringify(result).includes('AF-PRIVADO'), false);
  }
  const audit = await client.auditEvent.findMany({ where: { resourceId: d.id } });
  assert.ok(audit.some((a) => a.action === 'DELIVERY_NOTE_CONFIRMED'));
  assert.ok(audit.every((a) => JSON.stringify(a.metadata) === '{}'));
  await assert.rejects(
    client.deliveryNote.update({ where: { id: d.id }, data: { notes: 'mutar' } }),
  );
  await assert.rejects(
    client.deliveryNoteLine.update({ where: { id: d.lines[0]!.id }, data: { quantity: '2' } }),
  );
  await assert.rejects(
    client.deliveryNoteAllocation.update({
      where: { id: d.lines[0]!.allocations[0]!.id },
      data: { quantity: '2' },
    }),
  );
  await projection();
});
test('CONFIRM: vacío, sin número, sin stock, allocation incompleta, entero y decimal', async () => {
  await checked(await outbound(await draft()), 400);
  const a = await supply();
  await checked(
    await outbound(await draft([a.row()], { documentPrefix: null, documentNumber: null })),
    400,
  );
  await checked(await outbound(await draft([a.row('6')])), 409);
  const incomplete = await draft([
    { ...a.row('2'), allocations: [{ positionId: a.positions[0]!.id, quantity: '1' }] },
  ]);
  await checked(await outbound(incomplete), 400);
  await checked(
    await request(
      'delivery-notes',
      'POST',
      deliveryNoteCreateSchema.parse({
        id: randomUUID(),
        customerId: customer,
        documentDate: '2026-10-08',
        lines: [a.row('1.2')],
      }),
    ),
    400,
  );
  const p = await product();
  await checked(
    await outbound(
      await draft([{ id: randomUUID(), productId: p.id, quantity: '1', allocations: [] }]),
    ),
    400,
  );
  const b = await supply('METER', '0.123456');
  await note(outbound(await draft([b.row('0.000001')])));
  assert.equal((await stock(b.p)).summary.physical, '0.123455');
  assert.equal((await stock(a.p)).summary.physical, '5');
  await projection();
});
test('Lotes: FEFO explícito, elección alternativa válida, vencidos y condiciones bloqueados', async () => {
  const p = await product();
  let r = await opened();
  for (const [lotNumber, expirationDate, condition] of [
    ['late', '2099-12-31', 'USABLE'],
    ['early', '2099-01-01', 'USABLE'],
    ['expired', '2000-01-01', 'USABLE'],
    ['damaged', null, 'DAMAGED'],
    ['quarantine', null, 'QUARANTINE'],
    ['no-date', null, 'USABLE'],
  ] as const)
    r = await line(r, p, '2', { lotNumber, expirationDate, condition });
  await confirm(r);
  const s = await stock(p);
  assert.deepEqual(
    s.positions.filter((p) => !p.expired && p.condition === 'USABLE').map((p) => p.lotNumber),
    ['early', 'late', 'no-date'],
  );
  const row = (lot: string) => ({
    id: randomUUID(),
    productId: p.id,
    quantity: '1',
    allocations: [{ positionId: s.positions.find((p) => p.lotNumber === lot)!.id, quantity: '1' }],
  });
  await note(outbound(await draft([row('late')])));
  for (const lot of ['expired', 'damaged', 'quarantine'])
    await checked(await outbound(await draft([row(lot)])), 409);
  await projection();
});
test('Series: identidad real, repetición en documento, ajena/inexistente y consumida', async () => {
  const a = await supply(
    'UNIT',
    '2',
    { lotNumber: 'SER-LOT', expirationDate: '2099-01-01', serialNumbers: ['SER-001', 'SER-002'] },
    { lotRequired: true, expirationRequired: true, serialRequired: true },
  );
  await checked(await outbound(await draft([a.row(), a.row()])), 400);
  const b = await supply();
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-08',
      lines: [{ ...a.row(), allocations: [{ positionId: b.positions[0]!.id, quantity: '1' }] }],
    }),
    404,
  );
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-08',
      lines: [a.row('1', randomUUID())],
    }),
    404,
  );
  await note(outbound(await draft([a.row()])));
  await checked(await outbound(await draft([a.row()])), 409);
  assert.equal((await stock(a.p)).summary.available, '1');
  await projection();
});
test('Concurrencia real: dos requests mismo remito, retry incierto e incompatible, un audit', async () => {
  const a = await supply('UNIT', '1'),
    d = await draft([a.row()]),
    operationId = randomUUID();
  const results = await Promise.all([outbound(d, operationId), outbound(d, operationId)]);
  const views = await Promise.all(
    results.map(async (r) => deliveryNoteSchema.parse(await checked(r))),
  );
  assert.equal(views[0]!.movementId, views[1]!.movementId);
  assert.ok(views.some((v) => v.replayed));
  const retry = await note(outbound(d, operationId));
  assert.equal(retry.movementId, views[0]!.movementId);
  await checked(
    await request(`delivery-notes/${d.id}/confirm`, 'POST', { operationId, expectedVersion: 99 }),
    409,
  );
  await checked(await outbound(d, operationId, 0), 409);
  assert.equal(await client.inventoryMovement.count({ where: { deliveryNoteId: d.id } }), 1);
  assert.equal(
    await client.auditEvent.count({
      where: { resourceId: d.id, action: 'DELIVERY_NOTE_CONFIRMED' },
    }),
    1,
  );
  await projection();
});
test('Concurrencia real: dos remitos última unidad y misma serie; no overselling', async () => {
  for (const serial of [false, true]) {
    const a = await supply('UNIT', '1', serial ? { serialNumbers: ['LAST-' + randomUUID()] } : {}, {
      lotRequired: false,
      expirationRequired: false,
      serialRequired: serial,
    });
    const d1 = await draft([a.row()]),
      d2 = await draft([a.row()]);
    const responses = await Promise.all([outbound(d1), outbound(d2)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await stock(a.p)).summary.physical, '0');
    assert.equal(
      await client.inventoryMovement.count({ where: { deliveryNoteId: { in: [d1.id, d2.id] } } }),
      1,
    );
  }
  await projection();
});
test('Concurrencia real: número documental, creación estable y edición vs confirmación', async () => {
  const input = {
    id: randomUUID(),
    customerId: customer,
    documentDate: '2026-10-08',
    documentPrefix: '00009',
    documentNumber: '00000001',
  };
  const numberRace = await Promise.all([
    request('delivery-notes', 'POST', input),
    request('delivery-notes', 'POST', { ...input, id: randomUUID() }),
  ]);
  assert.deepEqual(numberRace.map((r) => r.status).sort(), [200, 409]);
  const stable = { ...input, id: randomUUID(), documentNumber: '00000002' };
  const createRace = await Promise.all([
    request('delivery-notes', 'POST', stable),
    request('delivery-notes', 'POST', stable),
  ]);
  assert.deepEqual(
    createRace.map((r) => r.status),
    [200, 200],
  );
  const a = await supply(),
    d = await draft([a.row()]);
  const race = await Promise.all([
    outbound(d),
    request('delivery-notes/' + d.id, 'PATCH', editPayload(d, { notes: 'edit concurrent' })),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  const current = await note(request('delivery-notes/' + d.id));
  assert.equal(current.version, d.version + 1);
  await projection();
});
test('Revalidación: stock cambió, cliente archivado, producto archivado y falta de política', async () => {
  const a = await supply('UNIT', '1'),
    d = await draft([a.row()]);
  await note(outbound(await draft([a.row()])));
  await checked(await outbound(d), 409);
  const c = await client.customer.create({
    data: { organizationId: org, name: 'Cliente a archivar', kind: 'OTHER' },
  });
  const b = await supply(),
    archived = await draft([b.row()], { customerId: c.id });
  await client.customer.update({ where: { id: c.id }, data: { archivedAt: new Date() } });
  await checked(await outbound(archived), 409);
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: c.id,
      documentDate: '2026-10-08',
    }),
    409,
  );
  const p = await product(),
    dp = await draft([{ id: randomUUID(), productId: p.id, quantity: '1', allocations: [] }]);
  await client.product.update({ where: { id: p.id }, data: { archivedAt: new Date() } });
  await checked(await outbound(dp), 409);
  const unreviewed = await client.product.create({
    data: { organizationId: org, name: 'Sin revisión', unitOfMeasure: 'UNIT' },
  });
  await checked(
    await outbound(
      await draft([{ id: randomUUID(), productId: unreviewed.id, quantity: '1', allocations: [] }]),
    ),
    409,
  );
  await projection();
});
test('Tenant isolation: documento, cliente, producto y posiciones; permisos cancelación', async () => {
  const a = await supply(),
    d = await draft([a.row()]);
  for (const [path, method, body] of [
    [`delivery-notes/${d.id}`, 'GET', undefined],
    [`delivery-notes/${d.id}`, 'PATCH', editPayload(d)],
    [
      `delivery-notes/${d.id}/confirm`,
      'POST',
      { operationId: randomUUID(), expectedVersion: d.version },
    ],
  ] as const)
    await checked(await request(path, method, body, 2), 404);
  const foreign = await client.customer.create({
    data: { organizationId: foreignOrg, name: 'Privado', kind: 'OTHER' },
  });
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: foreign.id,
      documentDate: '2026-10-08',
    }),
    404,
  );
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: foreignSupplier,
      documentDate: '2026-10-08',
    }),
    404,
  );
  const p = await client.product.create({
    data: { organizationId: foreignOrg, name: 'Producto privado', unitOfMeasure: 'UNIT' },
  });
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-08',
      lines: [{ id: randomUUID(), productId: p.id, quantity: '1' }],
    }),
    404,
  );
  const foreignLocation = await client.inventoryLocation.create({
    data: { organizationId: foreignOrg, name: 'Privado', code: 'MAIN' },
  });
  const foreignPosition = await client.inventoryBalance.create({
    data: {
      organizationId: foreignOrg,
      productId: p.id,
      locationId: foreignLocation.id,
      quantity: '0',
      condition: 'USABLE',
    },
  });
  await checked(
    await request(
      'delivery-notes/' + d.id,
      'PATCH',
      editPayload(d, { lines: [a.row('1', foreignPosition.id)] }),
    ),
    404,
  );
  await checked(
    await request(`delivery-notes/${d.id}/cancel`, 'POST', { expectedVersion: d.version }),
    403,
  );
  const cancelled = await note(
    request(`delivery-notes/${d.id}/cancel`, 'POST', { expectedVersion: d.version }, 0),
  );
  assert.equal(cancelled.status, 'CANCELLED');
  await checked(await outbound(cancelled), 409);
  assert.equal((await stock(a.p)).summary.physical, '5');
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-08',
      documentPrefix: d.documentPrefix,
      documentNumber: d.documentNumber,
    }),
    409,
  );
});
test('Auditoría fallida revierte salida y snapshot; Inventory fallido revierte confirmación', async () => {
  const a = await supply(),
    d = await draft([a.row()]);
  const audit = app.get(AuditService),
    original = audit.success.bind(audit);
  audit.success = (...args: Parameters<AuditService['success']>) => {
    if (args[1] === 'DELIVERY_NOTE_CONFIRMED') throw new Error('Injected audit failure');
    return original(...args);
  };
  try {
    await checked(await outbound(d), 500);
  } finally {
    audit.success = original;
  }
  assert.equal((await note(request('delivery-notes/' + d.id))).status, 'DRAFT');
  assert.equal((await stock(a.p)).summary.physical, '5');
  assert.equal(await client.inventoryMovement.count({ where: { deliveryNoteId: d.id } }), 0);
  const inventory = app.get(InventoryService),
    posting = inventory.postDeliveryNote.bind(inventory);
  inventory.postDeliveryNote = async (
    ...args: Parameters<InventoryService['postDeliveryNote']>
  ) => {
    await posting(...args);
    throw new Error('Injected posting failure');
  };
  try {
    await checked(await outbound(d), 500);
  } finally {
    inventory.postDeliveryNote = posting;
  }
  assert.equal((await note(request('delivery-notes/' + d.id))).status, 'DRAFT');
  assert.equal((await stock(a.p)).summary.physical, '5');
  await projection();
});
test('DB: confirmed sin movimiento y movimiento sin confirmed imposibles; FK tenant real', async () => {
  const a = await supply(),
    d = await draft([a.row()]);
  await assert.rejects(
    client.deliveryNote.update({
      where: { id: d.id },
      data: {
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        confirmedByUserId: actors[1]!.userId,
        confirmedByMembershipId: actors[1]!.membershipId,
        confirmationOperationId: randomUUID(),
        requestHash: 'a'.repeat(64),
        customerSnapshot: d.customer,
      },
    }),
  );
  await assert.rejects(
    client.$transaction(async (tx) => {
      await tx.product.findFirstOrThrow({ where: { id: a.p.id } });
      await app.get(InventoryService).lockDeliveryProducts(tx, actors[1]!, [a.p.id]);
      await app.get(InventoryService).postDeliveryNote(tx, actors[1]!, d.id);
    }),
  );
  assert.equal((await stock(a.p)).summary.physical, '5');
  await assert.rejects(
    client.deliveryNote.create({
      data: {
        organizationId: foreignOrg,
        customerId: customer,
        documentDate: new Date(),
        creationHash: 'a'.repeat(64),
      },
    }),
  );
  await projection();
});

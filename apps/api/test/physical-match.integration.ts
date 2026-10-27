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
  inventoryStockDetailSchema,
  scanResultSchema,
  type DeliveryNoteView,
  type InventoryDocument,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import { hasValidGtinCheckDigit } from '../src/common/domain/scanning/gtin.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// GS1 Stage 4 against a disposable database: never the operational one.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_match_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication,
  base: string,
  org: string,
  foreignOrg: string,
  supplier: string,
  customer: string;
const cookies: string[] = [];
const GS = '\x1d';
let sequence = 0;
// Synthetic GTIN-14 with a recomputed check digit; never a real product.
function gtin() {
  const body = '0779' + String(++sequence + 500).padStart(9, '0');
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
type Policy = { lotRequired: boolean; expirationRequired: boolean; serialRequired: boolean };
const LOT: Policy = { lotRequired: true, expirationRequired: false, serialRequired: false };
const SERIAL: Policy = { lotRequired: true, expirationRequired: true, serialRequired: true };
async function product(
  policy: Policy | null,
  options: { gtin?: string; unit?: 'UNIT' | 'METER'; organizationId?: string } = {},
) {
  const organizationId = options.organizationId ?? org;
  const p = await client.product.create({
    data: {
      organizationId,
      name: 'Match ' + randomUUID(),
      unitOfMeasure: options.unit ?? 'UNIT',
    },
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
  if (policy)
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
async function document(r: Promise<Response>) {
  return inventoryDocumentSchema.parse(await checked(await r));
}
// Stock only through the real receipt/posting flow.
async function receive(p: { id: string; unitOfMeasure: string }, lines: object[]) {
  let d: InventoryDocument = await document(
    request('inventory/receipts', 'POST', { id: randomUUID(), supplierId: supplier }),
  );
  for (const line of lines)
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
async function match(productId: string, body: object, actor = 1) {
  return inventoryPhysicalMatchSchema.parse(
    await checked(
      await request(`inventory/products/${productId}/physical-match`, 'POST', body, actor),
    ),
  );
}
async function note(r: Promise<Response>, status = 200) {
  return checked(await r, status);
}
async function draft(lines: object[]) {
  return deliveryNoteSchema.parse(
    await note(
      request('delivery-notes', 'POST', {
        id: randomUUID(),
        customerId: customer,
        documentDate: '2026-10-26',
        lines,
      }),
    ),
  );
}
function outbound(d: DeliveryNoteView, status = 200) {
  return note(
    request(`delivery-notes/${d.id}/confirm`, 'POST', {
      expectedVersion: d.version,
      operationId: randomUUID(),
    }),
    status,
  );
}
const lineOf = (productId: string, quantity: string, allocations: object[] = []) => ({
  id: randomUUID(),
  productId,
  quantity,
  allocations,
});
async function stock(productId: string) {
  return inventoryStockDetailSchema.parse(
    await checked(await request('inventory/products/' + productId)),
  );
}
async function main() {
  return client.inventoryLocation.findFirstOrThrow({
    where: { organizationId: org, code: 'MAIN' },
  });
}
// V1 has a single depot workflow; extra locations are explicit fixtures in this disposable DB.
async function fixturePosition(
  productId: string,
  options: {
    lotId?: string | null;
    quantity: string;
    archivedLocation?: boolean;
    condition?: 'USABLE' | 'DAMAGED' | 'QUARANTINE';
  },
) {
  const location = await client.inventoryLocation.create({
    data: {
      organizationId: org,
      code: 'L' + randomUUID().slice(0, 8),
      name: 'Depósito ' + (++sequence).toString(),
      ...(options.archivedLocation ? { archivedAt: new Date() } : {}),
    },
  });
  await client.inventoryStockScope.create({
    data: { organizationId: org, productId, locationId: location.id },
  });
  await client.inventoryBalance.create({
    data: {
      organizationId: org,
      productId,
      locationId: location.id,
      lotId: options.lotId ?? null,
      condition: options.condition ?? 'USABLE',
      quantity: options.quantity,
    },
  });
  return location;
}
async function sideEffects() {
  const where = { organizationId: { in: [org, foreignOrg] } };
  return Promise.all([
    client.inventoryLot.count({ where }),
    client.inventorySerial.count({ where }),
    client.inventoryBalance.count({ where }),
    client.inventoryMovement.count({ where }),
    client.inventoryStockScope.count({ where }),
    client.inventoryCountScope.count({ where }),
    client.auditEvent.count({ where }),
    client.deliveryNote.count({ where }),
    client.deliveryNoteAllocation.count({ where }),
    client.inventoryStockScope.count({ where: { ...where, activeCountSessionId: { not: null } } }),
  ]);
}

before(
  async () => {
    assert.match(databaseName, /^maxbio_match_test_[a-f0-9]{32}$/);
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
        data: { name: 'Match fixtures', slug: 'match-' + randomUUID() },
      })
    ).id;
    foreignOrg = (
      await client.organization.create({
        data: { name: 'Match private', slug: 'match-' + randomUUID() },
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
        data: { email: randomUUID() + '@example.invalid', displayName: 'Match ' + role },
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
    supplier = (
      await client.supplier.create({ data: { organizationId: org, name: 'Proveedor match' } })
    ).id;
    customer = (
      await client.customer.create({
        data: { organizationId: org, name: 'Cliente match', kind: 'COMPANY' },
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
  assert.match(databaseName, /^maxbio_match_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

test('GS1 → resolve → serie exacta EXACT; vinculada sale; luego MISSING; conflictos de lote/fecha', async () => {
  const g = gtin();
  const p = await product(SERIAL, { gtin: g });
  await receive(p, [
    {
      quantity: '2',
      lotNumber: 'LOT-A',
      expirationDate: '2028-12-31',
      serialNumbers: ['SER-1', 'SER-2'],
    },
  ]);
  const scan = scanResultSchema.parse(
    await checked(
      await request('catalog-scans/resolve', 'POST', {
        value: ']d201' + g + '17281231' + '10LOT-A' + GS + '21SER-1',
      }),
    ),
  );
  assert.equal(scan.status, 'KNOWN');
  if (scan.status !== 'KNOWN') return;
  const { lotNumber, expirationDate, serialNumber } = scan.scan!.fields;
  const exact = await match(p.id, { lotNumber, expirationDate, serialNumber });
  assert.equal(exact.status, 'EXACT');
  assert.deepEqual(exact.reasonCodes, []);
  assert.equal(exact.total, 1);
  assert.equal(exact.availableQuantity, '1');
  assert.equal(exact.policy?.serialRequired, true);
  const position = exact.positions[0]!;
  assert.equal(position.serialNumber, 'SER-1');
  assert.equal(position.lotNumber, 'LOT-A');
  assert.equal(position.expirationDate, '2028-12-31');
  assert.equal(position.quantity, '1');
  assert.equal(position.eligible, true);
  // Without scanned lot/date the registered serial is still exact.
  assert.equal((await match(p.id, { serialNumber: 'SER-1' })).status, 'EXACT');
  const d = await draft([lineOf(p.id, '1', [{ positionId: position.positionId, quantity: '1' }])]);
  const confirmed = deliveryNoteSchema.parse(await outbound(d));
  assert.ok(confirmed.movementId);
  const gone = await match(p.id, { serialNumber: 'SER-1' });
  assert.equal(gone.status, 'MISSING');
  assert.deepEqual(gone.reasonCodes, ['SERIAL_NOT_IN_STOCK']);
  assert.deepEqual(gone.positions, []);
  assert.deepEqual((await match(p.id, { serialNumber: 'SER-9' })).reasonCodes, [
    'SERIAL_NOT_FOUND',
  ]);
  // Serial identity is exact and case-sensitive, like Inventory.
  assert.equal((await match(p.id, { serialNumber: 'ser-2' })).status, 'MISSING');
  const wrongLot = await match(p.id, { serialNumber: 'SER-2', lotNumber: 'LOT-B' });
  assert.equal(wrongLot.status, 'CONFLICT');
  assert.deepEqual(wrongLot.reasonCodes, ['SERIAL_LOT_CONFLICT']);
  assert.equal(wrongLot.positions[0]?.lotNumber, 'LOT-A');
  assert.equal(wrongLot.positions[0]?.eligible, false);
  assert.equal(wrongLot.availableQuantity, '0');
  const wrongDate = await match(p.id, { serialNumber: 'SER-2', expirationDate: '2029-01-01' });
  assert.equal(wrongDate.status, 'CONFLICT');
  assert.deepEqual(wrongDate.reasonCodes, ['SERIAL_EXPIRATION_CONFLICT']);
});

test('lote: CHOICES paginado, elegibles primero, ubicación opcional; inexistente, fecha distinta y fecha sola', async () => {
  const p = await product(LOT);
  await receive(p, [
    { quantity: '5', lotNumber: 'LOT-L', expirationDate: '2028-06-30' },
    { quantity: '2', lotNumber: 'LOT-L', expirationDate: '2028-06-30', condition: 'DAMAGED' },
    { quantity: '3', lotNumber: 'LOT-L', expirationDate: '2028-06-30', condition: 'QUARANTINE' },
  ]);
  const lot = await client.inventoryLot.findFirstOrThrow({
    where: { productId: p.id, normalizedLotNumber: 'LOT-L' },
  });
  const second = await fixturePosition(p.id, { lotId: lot.id, quantity: '4' });
  const first = await match(p.id, { lotNumber: 'LOT-L', limit: 2 });
  assert.equal(first.status, 'CHOICES');
  assert.equal(first.total, 4);
  assert.equal(first.availableQuantity, '9');
  assert.deepEqual(
    first.positions.map((x) => x.eligible),
    [true, true],
  );
  const page2 = await match(p.id, { lotNumber: 'LOT-L', limit: 2, page: 2 });
  assert.equal(page2.status, 'CHOICES');
  assert.deepEqual(page2.positions.map((x) => x.unavailableReason).sort(), [
    'DAMAGED',
    'QUARANTINED',
  ]);
  const located = await match(p.id, { lotNumber: 'LOT-L', locationId: second.id });
  assert.equal(located.total, 1);
  assert.equal(located.positions[0]?.quantity, '4');
  assert.equal(located.positions[0]?.location.name, second.name);
  assert.deepEqual((await match(p.id, { lotNumber: 'LOT-NONE' })).reasonCodes, ['LOT_NOT_FOUND']);
  assert.equal((await match(p.id, { lotNumber: 'lot-l' })).status, 'MISSING');
  const conflict = await match(p.id, { lotNumber: 'LOT-L', expirationDate: '2029-01-01' });
  assert.equal(conflict.status, 'CONFLICT');
  assert.deepEqual(conflict.reasonCodes, ['LOT_EXPIRATION_CONFLICT']);
  const byDate = await match(p.id, { expirationDate: '2028-06-30' });
  assert.equal(byDate.status, 'CHOICES');
  assert.equal(byDate.total, 4);
  assert.deepEqual((await match(p.id, { expirationDate: '2030-01-01' })).reasonCodes, [
    'NO_MATCHING_STOCK',
  ]);
  const meter = await product(LOT, { unit: 'METER' });
  await receive(meter, [{ quantity: '3.25', lotNumber: 'ROLL-1' }]);
  const exactQuantity = await match(meter.id, { lotNumber: 'ROLL-1' });
  assert.equal(exactQuantity.status, 'CHOICES');
  assert.equal(exactQuantity.availableQuantity, '3.25');
  assert.equal(exactQuantity.positions[0]?.quantity, '3.25');
});

test('no elegibles → UNAVAILABLE con motivo: dañado, cuarentena, vencido, conteo activo, ubicación archivada, sin policy', async () => {
  const p = await product(LOT);
  await receive(p, [
    { quantity: '1', lotNumber: 'L-DMG', condition: 'DAMAGED' },
    { quantity: '1', lotNumber: 'L-QUA', condition: 'QUARANTINE' },
    { quantity: '1', lotNumber: 'L-EXP', expirationDate: '2020-01-01' },
  ]);
  for (const [lotNumber, reason] of [
    ['L-DMG', 'DAMAGED'],
    ['L-QUA', 'QUARANTINED'],
    ['L-EXP', 'EXPIRED'],
  ] as const) {
    const result = await match(p.id, { lotNumber });
    assert.equal(result.status, 'UNAVAILABLE', lotNumber);
    assert.deepEqual(result.reasonCodes, [reason]);
    assert.equal(result.availableQuantity, '0');
  }
  const counted = await product(LOT);
  await receive(counted, [{ quantity: '2', lotNumber: 'L-CNT' }]);
  const session = inventoryDocumentSchema.parse(
    await checked(await request('inventory/counts', 'POST', { id: randomUUID() })),
  );
  // Active count hold on the existing stock scope, as postDeliveryNote reads it.
  await client.inventoryStockScope.update({
    where: {
      organizationId_productId_locationId: {
        organizationId: org,
        productId: counted.id,
        locationId: (await main()).id,
      },
    },
    data: { activeCountSessionId: session.id },
  });
  assert.deepEqual((await match(counted.id, { lotNumber: 'L-CNT' })).reasonCodes, ['COUNT_ACTIVE']);
  const archivedLocation = await product(LOT);
  await receive(archivedLocation, [{ quantity: '1', lotNumber: 'L-ARC' }]);
  const arcLot = await client.inventoryLot.findFirstOrThrow({
    where: { productId: archivedLocation.id },
  });
  await fixturePosition(archivedLocation.id, {
    lotId: arcLot.id,
    quantity: '1',
    archivedLocation: true,
  });
  const partlyArchived = await match(archivedLocation.id, { lotNumber: 'L-ARC' });
  assert.equal(partlyArchived.status, 'CHOICES');
  assert.equal(partlyArchived.availableQuantity, '1');
  assert.equal(partlyArchived.positions.at(-1)?.unavailableReason, 'LOCATION_ARCHIVED');
  const noPolicy = await product(null);
  const loose = await client.inventoryLot.create({
    data: {
      organizationId: org,
      productId: noPolicy.id,
      lotNumber: 'L-NOPOL',
      normalizedLotNumber: 'L-NOPOL',
    },
  });
  await fixturePosition(noPolicy.id, { lotId: loose.id, quantity: '1' });
  const missingPolicy = await match(noPolicy.id, { lotNumber: 'L-NOPOL' });
  assert.equal(missingPolicy.status, 'UNAVAILABLE');
  assert.deepEqual(missingPolicy.reasonCodes, ['NO_POLICY']);
  assert.equal(missingPolicy.policy, null);
  // Unavailable stock never blocks the document itself.
  const documentary = await draft([lineOf(noPolicy.id, '1')]);
  const confirmed = deliveryNoteSchema.parse(await outbound(documentary));
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.movementId, null);
});

test('scope tenant + Product: sin filtraciones; producto/ubicación ajenos 404; contrato estricto', async () => {
  const p = await product(SERIAL);
  const other = await product(SERIAL);
  await receive(other, [
    {
      quantity: '1',
      lotNumber: 'SHARED-LOT',
      expirationDate: '2028-01-01',
      serialNumbers: ['SHARED'],
    },
  ]);
  const scoped = await match(p.id, { serialNumber: 'SHARED' });
  assert.equal(scoped.status, 'MISSING');
  assert.deepEqual(scoped.reasonCodes, ['SERIAL_NOT_FOUND']);
  assert.deepEqual(scoped.positions, []);
  assert.deepEqual((await match(p.id, { lotNumber: 'SHARED-LOT' })).reasonCodes, ['LOT_NOT_FOUND']);
  const foreign = await product(null, { organizationId: foreignOrg });
  for (const [path, body, actor] of [
    [`inventory/products/${other.id}/physical-match`, { serialNumber: 'SHARED' }, 2],
    [`inventory/products/${foreign.id}/physical-match`, { serialNumber: 'SHARED' }, 1],
    [`inventory/products/${randomUUID()}/physical-match`, { lotNumber: 'X' }, 1],
    [
      `inventory/products/${other.id}/physical-match`,
      { lotNumber: 'X', locationId: randomUUID() },
      1,
    ],
  ] as const)
    await checked(await request(path, 'POST', body, actor), 404);
  for (const body of [
    {},
    { page: 1 },
    { lotNumber: 'A', organizationId: org },
    { lotNumber: 'A', productId: other.id },
    { lotNumber: 'A', gtin: '04006381333931' },
    { lotNumber: 'A', raw: 'x' },
    { lotNumber: 'A', limit: 101 },
    { lotNumber: 'A\u0001' },
    { lotNumber: 'A'.repeat(129) },
    { expirationDate: '2028-02-30' },
  ])
    await checked(
      await request(`inventory/products/${other.id}/physical-match`, 'POST', body),
      400,
    );
  // OPERATOR (actor 1) and ADMIN (actor 0) can both query; the match is a read.
  assert.equal((await match(other.id, { serialNumber: 'SHARED' }, 0)).status, 'EXACT');
});

test('el match no escribe: cero lotes, series, balances, movimientos, scopes, holds ni audit', async () => {
  const p = await product(LOT);
  await receive(p, [{ quantity: '3', lotNumber: 'NO-WRITE' }]);
  const initial = await sideEffects();
  for (const body of [
    { lotNumber: 'NO-WRITE' },
    { lotNumber: 'NEW-LOT' },
    { serialNumber: 'NEW-SERIAL' },
    { expirationDate: '2031-01-01' },
    { lotNumber: 'NO-WRITE', expirationDate: '2031-01-01' },
  ])
    await match(p.id, body);
  assert.deepEqual(await sideEffects(), initial);
});

test('Remito: parcial, completo y sin stock siguen válidos; OUTBOUND solo por lo vinculado', async () => {
  const p = await product(LOT);
  await receive(p, [{ quantity: '5', lotNumber: 'PART' }]);
  const found = await match(p.id, { lotNumber: 'PART' });
  const positionId = found.positions[0]!.positionId;
  const partial = await draft([lineOf(p.id, '5', [{ positionId, quantity: '2' }])]);
  const partialDone = deliveryNoteSchema.parse(await outbound(partial));
  assert.ok(partialDone.movementId);
  assert.equal(partialDone.lines[0]?.quantity, '5');
  assert.equal((await stock(p.id)).summary.physical, '3');
  const after = await match(p.id, { lotNumber: 'PART' });
  assert.equal(after.availableQuantity, '3');
  const full = await draft([lineOf(p.id, '3', [{ positionId, quantity: '3' }])]);
  assert.ok(deliveryNoteSchema.parse(await outbound(full)).movementId);
  assert.equal((await stock(p.id)).summary.physical, '0');
  assert.deepEqual((await match(p.id, { lotNumber: 'PART' })).reasonCodes, ['LOT_NOT_IN_STOCK']);
  const without = await draft([lineOf(p.id, '7')]);
  const documentary = deliveryNoteSchema.parse(await outbound(without));
  assert.equal(documentary.movementId, null);
  assert.equal((await stock(p.id)).summary.physical, '0');
});

test('Remito: serie duplicada en el borrador y match obsoleto se rechazan al confirmar sin degradar a documental', async () => {
  const p = await product(SERIAL);
  await receive(p, [
    {
      quantity: '1',
      lotNumber: 'STALE',
      expirationDate: '2028-01-01',
      serialNumbers: ['S-STALE'],
    },
  ]);
  const { positionId } = (await match(p.id, { serialNumber: 'S-STALE' })).positions[0]!;
  const allocation = [{ positionId, quantity: '1' }];
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-26',
      lines: [lineOf(p.id, '1', allocation), lineOf(p.id, '1', allocation)],
    }),
    400,
  );
  const first = await draft([lineOf(p.id, '1', allocation)]);
  const second = await draft([lineOf(p.id, '1', allocation)]);
  assert.ok(deliveryNoteSchema.parse(await outbound(first)).movementId);
  await outbound(second, 409);
  const kept = deliveryNoteSchema.parse(
    await checked(await request('delivery-notes/' + second.id)),
  );
  assert.equal(kept.status, 'DRAFT');
  assert.equal(kept.lines[0]?.allocations[0]?.positionId, positionId);
  assert.equal((await match(p.id, { serialNumber: 'S-STALE' })).status, 'MISSING');
});

// Stage 5 uses the same HTTP/DB harness; documentary facts do not require policy or existence.
const declared = (patch: object = {}) => ({
  id: randomUUID(),
  quantity: '1',
  lotNumber: 'DOC-LOT',
  expirationDate: '2028-12-31',
  serialNumber: null,
  ...patch,
});
const tracesOf = (d: DeliveryNoteView) => d.lines.flatMap((l) => l.physicalTraces);
async function updateNote(d: DeliveryNoteView, lines: object[], status = 200) {
  const r = await request('delivery-notes/' + d.id, 'PATCH', {
    expectedVersion: d.version,
    customerId: d.customer.id,
    documentDate: d.documentDate,
    lines,
  });
  const body = await checked(r, status);
  return status === 200 ? deliveryNoteSchema.parse(body) : d;
}
async function noInventory() {
  return Promise.all([
    client.inventoryLot.count(),
    client.inventorySerial.count(),
    client.inventoryBalance.count(),
    client.inventoryMovement.count(),
    client.inventoryLocation.count(),
    client.inventoryReceipt.count(),
  ]);
}

test('Stage 5: GS1 sin stock/policy conserva datos y GTIN observado sin crear Inventory; identidad manual no falsifica GS1', async () => {
  const g = gtin(),
    p = await product(null, { gtin: gtin() });
  await client.productIdentifier.create({
    data: { organizationId: org, productId: p.id, kind: 'GTIN', value: g, normalizedValue: g },
  });
  const scanValue = `(01)${g}(17)281231(10)DOC-LOT(21)DOC-SERIAL`;
  const initial = await noInventory();
  let d = await draft([
    { ...lineOf(p.id, '1'), physicalTraces: [declared({ serialNumber: 'DOC-SERIAL', scanValue })] },
  ]);
  const trace = tracesOf(d)[0]!;
  assert.equal(trace.origin, 'DECLARED');
  assert.equal(trace.captureMethod, 'GS1');
  assert.equal(trace.scannedGtinSnapshot, g);
  assert.equal(trace.inventoryAllocationId, null);
  d = deliveryNoteSchema.parse(await outbound(d));
  assert.equal(d.movementId, null);
  assert.equal(tracesOf(d)[0]!.serialNumber, 'DOC-SERIAL');
  assert.deepEqual(await noInventory(), initial);
  const stored = await client.deliveryNoteLineTrace.findUniqueOrThrow({ where: { id: trace.id } });
  assert.ok(!JSON.stringify(stored).includes(scanValue));
  assert.equal(stored.expirationDate!.toISOString().slice(0, 10), '2028-12-31');
  const events = await client.auditEvent.findMany({ where: { resourceId: d.id } });
  assert.ok(events.every((e) => !JSON.stringify(e.metadata).includes('DOC-SERIAL')));
  for (const [physical, key] of [
    [trace.lotNumber, 'lot'],
    [trace.serialNumber, 'serial'],
  ] as const)
    assert.ok(physical, key);
  const r = await request('delivery-notes/trace-history', 'POST', {
    productId: p.id,
    serialNumber: 'DOC-SERIAL',
  });
  const history = (await checked(r)) as { items: { traceId: string }[] };
  assert.equal(history.items[0]!.traceId, trace.id);
  const list = (await checked(
    await request('delivery-notes/search', 'POST', { q: 'DOC-SERIAL' }),
  )) as { items: { id: string }[] };
  assert.ok(list.items.some((i) => i.id === d.id));
  const edit = await draft([
    {
      ...lineOf(p.id, '1'),
      physicalTraces: [
        declared({ serialNumber: 'EDIT-S', scanValue: `(01)${g}(17)281231(10)DOC-LOT(21)EDIT-S` }),
      ],
    },
  ]);
  const t = tracesOf(edit)[0]!;
  const edited = await updateNote(edit, [
    {
      ...lineOf(p.id, '1'),
      id: edit.lines[0]!.id,
      physicalTraces: [
        { ...declared({ id: t.id, serialNumber: 'EDIT-S2' }), scannedGtinSnapshot: g },
      ],
    },
  ]);
  assert.equal(tracesOf(edited)[0]!.captureMethod, 'MANUAL');
  await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-26',
      lines: [{ ...lineOf(p.id, '1'), physicalTraces: [declared({ scannedGtinSnapshot: g })] }],
    }),
    400,
  );
});

test('Stage 5: allocation parcial + declarado, split/vínculo y desvínculo son atómicos y exactos', async () => {
  const p = await product(LOT);
  await receive(p, [{ quantity: '10', lotNumber: 'SPLIT' }]);
  const positionId = (await match(p.id, { lotNumber: 'SPLIT' })).positions[0]!.positionId;
  let d = await draft([
    {
      ...lineOf(p.id, '5'),
      physicalTraces: [declared({ quantity: '5', lotNumber: 'SPLIT', expirationDate: null })],
    },
  ]);
  const source = tracesOf(d)[0]!,
    lineId = d.lines[0]!.id,
    inventoryId = randomUUID();
  const splitLine = {
    id: lineId,
    productId: p.id,
    quantity: '5',
    allocations: [
      {
        positionId,
        quantity: '2',
        traceId: inventoryId,
        sourceTraceId: source.id,
        preserveOnUnlink: true,
      },
    ],
    physicalTraces: [
      declared({ id: source.id, quantity: '3', lotNumber: 'SPLIT', expirationDate: null }),
    ],
  };
  d = await updateNote(d, [splitLine]);
  assert.deepEqual(
    tracesOf(d).map((t) => [t.origin, t.quantity]),
    [
      ['INVENTORY', '2'],
      ['DECLARED', '3'],
    ],
  );
  assert.equal((await stock(p.id)).summary.physical, '10');
  await updateNote(d, [splitLine], 200); // Full replacement keeps the same trace IDs/provenance.
  const current = deliveryNoteSchema.parse(await checked(await request('delivery-notes/' + d.id)));
  await updateNote(d, [splitLine], 409); // stale version
  const unlinked = await updateNote(current, [
    {
      id: lineId,
      productId: p.id,
      quantity: '5',
      allocations: [],
      physicalTraces: [
        declared({ id: inventoryId, quantity: '2', lotNumber: 'SPLIT', expirationDate: null }),
        declared({ id: source.id, quantity: '3', lotNumber: 'SPLIT', expirationDate: null }),
      ],
    },
  ]);
  assert.ok(tracesOf(unlinked).every((t) => t.origin === 'DECLARED'));
  const done = deliveryNoteSchema.parse(await outbound(await updateNote(unlinked, [splitLine])));
  assert.ok(done.movementId);
  assert.equal((await stock(p.id)).summary.physical, '8');
  const ml = await client.inventoryMovementLine.findMany({
    where: { movementId: done.movementId! },
  });
  assert.equal(ml.length, 1);
  assert.equal(ml[0]!.quantityDelta.toString(), '-2');
  assert.deepEqual(
    tracesOf(done).map((t) => t.quantity),
    ['2', '3'],
  );
  const full = await draft([{ ...lineOf(p.id, '1', [{ positionId, quantity: '1' }]) }]);
  assert.equal(tracesOf(full).length, 1);
  assert.equal(tracesOf(full)[0]!.preserveOnUnlink, false);
});

test('Stage 5: cantidad/serie/cobertura, duplicados entre líneas y origen no controlado por browser', async () => {
  const p = await product(null);
  const create = (lines: object[]) =>
    request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: customer,
      documentDate: '2026-10-26',
      lines,
    });
  for (const patch of [
    { quantity: '2', serialNumber: 'S-ONE' },
    { quantity: '1.5' },
    { quantity: '0' },
    { lotNumber: null, expirationDate: null, serialNumber: null },
  ])
    await checked(await create([{ ...lineOf(p.id, '1'), physicalTraces: [declared(patch)] }]), 400);
  await checked(
    await create(
      [1, 2].map(() => ({
        ...lineOf(p.id, '1'),
        physicalTraces: [declared({ serialNumber: 'DUP' })],
      })),
    ),
    400,
  );
  await checked(
    await create([
      { ...lineOf(p.id, '1'), physicalTraces: [{ ...declared(), origin: 'INVENTORY' }] },
    ]),
    400,
  );
  const meter = await product(null, { unit: 'METER' });
  await checked(
    await create([
      { ...lineOf(meter.id, '1'), physicalTraces: [declared({ serialNumber: 'METER-S' })] },
    ]),
    400,
  );
  const plain = await draft([lineOf(p.id, '5')]);
  assert.deepEqual(tracesOf(plain), []);
  assert.equal(deliveryNoteSchema.parse(await outbound(plain)).movementId, null);
});

test('Stage 5: antecedentes históricos y carrera de confirmaciones requieren revisión sin unique global', async () => {
  const p = await product(null);
  const newDoc = () =>
    draft([{ ...lineOf(p.id, '1'), physicalTraces: [declared({ serialNumber: 'HISTORY' })] }]);
  const a = await newDoc(),
    b = await newDoc();
  const responses = await Promise.all(
    [a, b].map((d) =>
      request('delivery-notes/' + d.id + '/confirm', 'POST', {
        expectedVersion: d.version,
        operationId: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const first = deliveryNoteSchema.parse(await checked(responses.find((r) => r.status === 200)!));
  const pending = first.id === a.id ? b : a;
  const ids = tracesOf(first).map((t) => t.id),
    op = randomUUID();
  const command = { expectedVersion: pending.version, operationId: op, reviewedPriorTraceIds: ids };
  const next = deliveryNoteSchema.parse(
    await checked(await request('delivery-notes/' + pending.id + '/confirm', 'POST', command)),
  );
  assert.deepEqual(tracesOf(next)[0]!.reviewedPriorTraceIds, ids);
  assert.equal(next.movementId, null);
  const retry = deliveryNoteSchema.parse(
    await checked(await request('delivery-notes/' + pending.id + '/confirm', 'POST', command)),
  );
  assert.equal(retry.replayed, true);
  await checked(
    await request('delivery-notes/' + pending.id + '/confirm', 'POST', {
      ...command,
      reviewedPriorTraceIds: [],
    }),
    409,
  );
  const foreign = await product(null, { organizationId: foreignOrg });
  const history = (await checked(
    await request(
      'delivery-notes/trace-history',
      'POST',
      { productId: foreign.id, serialNumber: 'HISTORY' },
      2,
    ),
  )) as { items: object[] };
  assert.deepEqual(history.items, []);
  await checked(
    await request(
      'delivery-notes/trace-history',
      'POST',
      { productId: p.id, serialNumber: 'HISTORY' },
      2,
    ),
    404,
  );
});

test('Stage 5: SQL protege snapshots cerrados, tenant/Product/allocation y cobertura diferida', async () => {
  const p = await product(null),
    other = await product(null);
  const d = deliveryNoteSchema.parse(
    await outbound(await draft([{ ...lineOf(p.id, '1'), physicalTraces: [declared()] }])),
  );
  const t = tracesOf(d)[0]!;
  await assert.rejects(
    client.deliveryNoteLineTrace.update({ where: { id: t.id }, data: { lotNumber: 'CHANGED' } }),
  );
  await assert.rejects(client.deliveryNoteLineTrace.delete({ where: { id: t.id } }));
  const data = {
    organizationId: org,
    deliveryNoteId: d.id,
    productId: p.id,
    lineId: d.lines[0]!.id,
    ordinal: 1,
    quantity: '1',
    lotNumber: 'X',
    origin: 'DECLARED' as const,
    captureMethod: 'MANUAL' as const,
  };
  await assert.rejects(client.deliveryNoteLineTrace.create({ data }));
  const open = await draft([lineOf(p.id, '1')]);
  await assert.rejects(
    client.deliveryNoteLineTrace.create({
      data: { ...data, deliveryNoteId: open.id, lineId: open.lines[0]!.id, productId: other.id },
    }),
  );
  await assert.rejects(
    client.deliveryNoteLineTrace.create({
      data: {
        ...data,
        organizationId: foreignOrg,
        deliveryNoteId: open.id,
        lineId: open.lines[0]!.id,
      },
    }),
  );
  await assert.rejects(
    client.deliveryNoteLineTrace.create({
      data: { ...data, deliveryNoteId: open.id, lineId: open.lines[0]!.id, quantity: '2' },
    }),
  );
});

test(
  'Stage 5: 500 detalles manuales caben en transporte acotado y no crean stock',
  { timeout: 30000 },
  async () => {
    const p = await product(null);
    const lines = Array.from({ length: 50 }, () => ({
      ...lineOf(p.id, '10'),
      physicalTraces: Array.from({ length: 10 }, () =>
        declared({ lotNumber: 'L'.repeat(128), serialNumber: null }),
      ),
    }));
    const initial = await noInventory();
    assert.ok(Buffer.byteLength(JSON.stringify(lines)) > 102400);
    const d = await draft(lines);
    assert.equal(tracesOf(d).length, 500);
    assert.deepEqual(await noInventory(), initial);
  },
);

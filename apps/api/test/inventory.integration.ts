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
  inventoryStockListSchema,
  inventoryHistorySchema,
  catalogInspectionSchema,
  catalogImportSchema,
  type InventoryDocument,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { InventoryService } from '../src/modules/inventory/application/inventory.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// The immutable ledger is not weakened for fixture teardown: this suite owns a disposable DB.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_inventory_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
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
async function scope(d: InventoryDocument, productId: string) {
  return document(
    request(`inventory/counts/${d.id}/scopes`, 'POST', { productId, expectedVersion: d.version }),
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
    assert.match(databaseName, /^maxbio_inventory_test_[a-f0-9]{32}$/);
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
  assert.match(databaseName, /^maxbio_inventory_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

test('la política aún no configurada responde JSON null, compatible con el proxy web', async () => {
  const p = await client.product.create({
    data: { organizationId: org, name: 'Sin política ' + randomUUID(), unitOfMeasure: 'UNIT' },
  });
  const response = await request('inventory/products/' + p.id + '/policy');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /application\/json/);
  assert.equal(await response.json(), null);
});

test('OPERATOR receipt persistente: draft y líneas cero stock; múltiples Products; ledger=balance', async () => {
  const a = await product(),
    b = await product('METER');
  let d = await opened();
  assert.equal((await stock(a)).summary.physical, '0');
  for (const quantity of ['NaN', '1e3', 'junk']) {
    await checked(
      await request(`inventory/receipts/${d.id}/lines/${randomUUID()}`, 'PUT', {
        expectedVersion: d.version,
        productId: a.id,
        unitOfMeasure: 'UNIT',
        quantity,
      }),
      400,
    );
  }
  d = await line(d, a, '100');
  d = await line(d, b, '3.000001');
  assert.equal((await stock(a)).summary.physical, '0');
  const retrieved = inventoryDocumentSchema.parse(
    await checked(await request('inventory/receipts/' + d.id)),
  );
  assert.equal(retrieved.lines.length, 2);
  const confirmed = await confirm(d);
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal((await stock(a)).summary.available, '100');
  assert.equal((await stock(b)).summary.physical, '3.000001');
  assert.equal(
    await client.auditEvent.count({
      where: { organizationId: org, action: 'INVENTORY_RECEIPT_CONFIRMED', resourceId: d.id },
    }),
    1,
  );
  await projection();
  await checked(
    await request('inventory/receipts/' + d.id + '/cancel', 'POST', {
      expectedVersion: confirmed.version,
    }),
    409,
  );
});
test('mismo lote de distintas recepciones/proveedores se reutiliza; vencimiento contradictorio rollback', async () => {
  const p = await product('UNIT', {
    lotRequired: true,
    expirationRequired: true,
    serialRequired: false,
  });
  let d = await line(await opened(), p, '5', {
    lotNumber: '000Ab-C',
    expirationDate: '2099-01-01',
  });
  await confirm(d);
  const secondSupplier = await client.supplier.create({
    data: { organizationId: org, name: 'Second supplier' },
  });
  d = await document(
    request('inventory/receipts', 'POST', { id: randomUUID(), supplierId: secondSupplier.id }),
  );
  d = await line(d, p, '2', { lotNumber: '000Ab-C', expirationDate: '2099-01-01' });
  await confirm(d);
  assert.equal(
    await client.inventoryLot.count({ where: { organizationId: org, productId: p.id } }),
    1,
  );
  assert.equal((await stock(p)).summary.physical, '7');
  d = await line(await opened(), p, '1', { lotNumber: '000Ab-C', expirationDate: '2099-02-01' });
  await checked(
    await request('inventory/receipts/' + d.id + '/confirm', 'POST', {
      operationId: randomUUID(),
      expectedVersion: d.version,
    }),
    409,
  );
  assert.equal((await stock(p)).summary.physical, '7');
  assert.equal(await client.inventoryMovement.count({ where: { receiptId: d.id } }), 0);
  await projection();
});
test('series derivan cantidad, son indivisibles y no pueden tener dos posiciones positivas', async () => {
  const p = await product('PAIR', {
    lotRequired: false,
    expirationRequired: false,
    serialRequired: true,
  });
  let d = await opened();
  await checked(
    await request(`inventory/receipts/${d.id}/lines/${randomUUID()}`, 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      unitOfMeasure: 'PAIR',
      quantity: '5',
      serialNumbers: ['001', '002', '003', '004'],
    }),
    400,
  );
  d = await line(d, p, '2', { serialNumbers: ['0001', '0002'] });
  await confirm(d);
  assert.equal((await stock(p)).summary.physical, '2');
  const duplicate = await line(await opened(), p, '1', {
    serialNumbers: ['0001'],
    condition: 'DAMAGED',
  });
  await checked(
    await request(`inventory/receipts/${duplicate.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: duplicate.version,
    }),
    409,
  );
  assert.equal(
    await client.inventorySerial.count({ where: { organizationId: org, productId: p.id } }),
    2,
  );
  await projection();
});
test('vencido, dañado y cuarentena mantienen físico sin disponible; fecha nunca produce movimiento', async () => {
  const p = await product();
  let d = await line(await opened(), p, '4', {
    lotNumber: 'expired',
    expirationDate: '2000-01-01',
  });
  d = await line(d, p, '3', {
    condition: 'DAMAGED',
    lotNumber: 'also-expired',
    expirationDate: '2000-01-01',
  });
  d = await line(d, p, '2', { condition: 'QUARANTINE' });
  d = await line(d, p, '5');
  await confirm(d);
  const detail = await stock(p);
  assert.equal(detail.summary.physical, '14');
  assert.equal(detail.summary.available, '5');
  assert.equal(detail.summary.unavailable, '9');
  assert.ok(detail.positions.some((i) => i.expired));
  const count = await client.inventoryMovement.count({ where: { organizationId: org } });
  await stock(p);
  assert.equal(await client.inventoryMovement.count({ where: { organizationId: org } }), count);
  await projection();
});
test('doble confirmación simultánea/retry: mismo resultado, un movimiento y un audit; otra carga 409', async () => {
  const p = await product();
  const d = await line(await opened(), p, '7');
  const input = { operationId: randomUUID(), expectedVersion: d.version };
  const results = await Promise.all([
    document(request(`inventory/receipts/${d.id}/confirm`, 'POST', input)),
    document(request(`inventory/receipts/${d.id}/confirm`, 'POST', input)),
  ]);
  assert.equal(results[0]!.movementId, results[1]!.movementId);
  assert.equal((await stock(p)).summary.physical, '7');
  const replay = await document(request(`inventory/receipts/${d.id}/confirm`, 'POST', input));
  assert.equal(replay.replayed, true);
  await checked(
    await request(`inventory/receipts/${d.id}/confirm`, 'POST', {
      ...input,
      expectedVersion: input.expectedVersion + 1,
    }),
    409,
  );
  await checked(
    await request(`inventory/receipts/${d.id}/confirm`, 'POST', {
      ...input,
      operationId: randomUUID(),
    }),
    409,
  );
  await projection();
});
test('dos ingresos misma posición ausente y retry de Agregar no duplican filas ni saldo', async () => {
  const p = await product();
  let a = await opened(),
    b = await opened();
  const lineId = randomUUID();
  const input = {
    expectedVersion: a.version,
    productId: p.id,
    unitOfMeasure: 'UNIT',
    quantity: '2',
  };
  a = await document(request(`inventory/receipts/${a.id}/lines/${lineId}`, 'PUT', input));
  const repeat = await document(
    request(`inventory/receipts/${a.id}/lines/${lineId}`, 'PUT', input),
  );
  assert.equal(repeat.lines.length, 1);
  assert.equal(repeat.version, a.version);
  b = await line(b, p, '3');
  await Promise.all([confirm(a), confirm(b)]);
  assert.equal((await stock(p)).summary.physical, '5');
  assert.equal(
    await client.inventoryBalance.count({ where: { organizationId: org, productId: p.id } }),
    1,
  );
  await projection();
});
test('fallo de auditoría revierte ledger, lotes, balances y confirmación', async () => {
  const p = await product();
  const d = await line(await opened(), p, '6', { lotNumber: 'rollback' });
  const audit = app.get(AuditService);
  const original = audit.success.bind(audit);
  audit.success = () => {
    throw new Error('Inventory rollback fixture');
  };
  try {
    await checked(
      await request(`inventory/receipts/${d.id}/confirm`, 'POST', {
        operationId: randomUUID(),
        expectedVersion: d.version,
      }),
      500,
    );
  } finally {
    audit.success = original;
  }
  assert.equal((await stock(p)).summary.physical, '0');
  assert.equal(await client.inventoryLot.count({ where: { productId: p.id } }), 0);
  assert.equal((await document(request('inventory/receipts/' + d.id))).status, 'DRAFT');
  await confirm(d);
  await projection();
});
test('inventario inicial persistente, varios Products/lotes/series y cero inequívoco', async () => {
  const a = await product('UNIT', {
      lotRequired: true,
      expirationRequired: true,
      serialRequired: false,
    }),
    b = await product(),
    s = await product('UNIT', {
      lotRequired: false,
      expirationRequired: false,
      serialRequired: true,
    });
  let d = await opened('counts');
  d = await scope(d, a.id);
  d = await scope(d, b.id);
  d = await scope(d, s.id);
  d = await line(d, a, '3', { lotNumber: 'A', expirationDate: '2099-01-01' });
  d = await line(d, a, '4', { lotNumber: 'B', expirationDate: '2099-02-01' });
  d = await line(d, b, '0');
  d = await line(d, s, '1', { serialNumbers: ['initial-001'] });
  assert.equal((await stock(a)).summary.physical, '0');
  assert.equal((await document(request('inventory/counts/' + d.id))).lines.length, 4);
  const op = randomUUID();
  const closed = await confirm(d, op);
  assert.equal((await stock(a)).summary.physical, '7');
  assert.equal((await stock(b)).summary.physical, '0');
  assert.ok((await stock(b)).summary.initializedAt);
  assert.equal(await client.inventoryMovementLine.count({ where: { productId: b.id } }), 0);
  assert.equal(
    closed.scopes.every((i) => i.coverageConfirmed),
    true,
  );
  assert.equal((await confirm(d, op)).replayed, true);
  await projection();
  const again = await opened('counts');
  await checked(
    await request(`inventory/counts/${again.id}/scopes`, 'POST', {
      productId: b.id,
      expectedVersion: again.version,
    }),
    409,
  );
});
test('inventario inicial cero sin movimiento artificial; historial conserva cobertura', async () => {
  const p = await product();
  let d = await scope(await opened('counts'), p.id);
  d = await line(d, p, '0');
  const done = await confirm(d);
  assert.equal(done.movementId, null);
  assert.ok((await stock(p)).summary.initializedAt);
  const h = inventoryHistorySchema.parse(
    await checked(await request('inventory/products/' + p.id + '/history')),
  );
  assert.equal(h.items[0]!.change, '0');
  assert.equal(h.items[0]!.type, 'INITIAL_COUNT');
});
test('toma exclusiva, ingreso bloqueado durante conteo, inicial prohibido después de historia', async () => {
  const p = await product();
  let d = await scope(await opened('counts'), p.id);
  const other = await opened('counts');
  await checked(
    await request(`inventory/counts/${other.id}/scopes`, 'POST', {
      productId: p.id,
      expectedVersion: other.version,
    }),
    409,
  );
  const receipt = await line(await opened(), p, '2');
  await checked(
    await request(`inventory/receipts/${receipt.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: receipt.version,
    }),
    409,
  );
  d = await line(d, p, '0');
  await checked(
    await request(`inventory/counts/${d.id}/cancel`, 'POST', { expectedVersion: d.version }),
  );
  await confirm(receipt);
  const retry = await opened('counts');
  await checked(
    await request(`inventory/counts/${retry.id}/scopes`, 'POST', {
      productId: p.id,
      expectedVersion: retry.version,
    }),
    409,
  );
});
test('rollback de inventario inicial no inicializa ningún scope parcialmente', async () => {
  const p = await product();
  let d = await scope(await opened('counts'), p.id);
  d = await line(d, p, '2');
  const audit = app.get(AuditService);
  const original = audit.success.bind(audit);
  audit.success = () => {
    throw new Error('Count rollback');
  };
  try {
    await checked(
      await request(`inventory/counts/${d.id}/confirm`, 'POST', {
        operationId: randomUUID(),
        expectedVersion: d.version,
        completeCoverage: true,
      }),
      500,
    );
  } finally {
    audit.success = original;
  }
  const detail = await stock(p);
  assert.equal(detail.summary.physical, '0');
  assert.equal(detail.summary.initializedAt, null);
  assert.equal(detail.summary.countInProgress, true);
  await confirm(d);
  await projection();
});
test('policy requerida, UNIT/PAIR enteros, decimales y Catalog unidad/archivo protegidos', async () => {
  const raw = await client.product.create({
    data: { organizationId: org, name: 'No policy', unitOfMeasure: 'UNIT' },
  });
  const d = await opened();
  await checked(
    await request(`inventory/receipts/${d.id}/lines/${randomUUID()}`, 'PUT', {
      expectedVersion: d.version,
      productId: raw.id,
      quantity: '1',
      unitOfMeasure: 'UNIT',
    }),
    409,
  );
  const p = await product();
  await checked(
    await request(`inventory/receipts/${d.id}/lines/${randomUUID()}`, 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      quantity: '1.5',
      unitOfMeasure: 'UNIT',
    }),
    400,
  );
  const filled = await line(d, p, '1');
  await confirm(filled);
  await checked(
    await request(
      'products/' + p.id,
      'PATCH',
      { expectedVersion: p.version, unitOfMeasure: 'METER' },
      0,
    ),
    409,
  );
  await checked(
    await request(`products/${p.id}/archive`, 'POST', { expectedVersion: p.version }, 0),
    409,
  );
  await checked(
    await request(
      `inventory/products/${p.id}/policy`,
      'PUT',
      { expectedVersion: 1, lotRequired: true, expirationRequired: false, serialRequired: false },
      0,
    ),
    409,
  );
  await assert.rejects(
    client.product.update({ where: { id: p.id }, data: { unitOfMeasure: 'METER' } }),
  );
  await assert.rejects(
    client.product.update({ where: { id: p.id }, data: { archivedAt: new Date() } }),
  );
});
test('ajuste ADMIN esperado/observado, idempotencia, versión obsoleta y nunca negativo', async () => {
  const p = await product('METER');
  await confirm(await line(await opened(), p, '7'));
  let detail = await stock(p);
  const pos = detail.positions[0]!;
  const input = {
    operationId: randomUUID(),
    positionId: pos.id,
    expectedScopeVersion: detail.scopeVersion,
    observedQuantity: '10.5',
    reason: 'COUNT',
    notes: 'Conteo físico completo de la posición',
  };
  await checked(await request('inventory/adjustments', 'POST', input), 403);
  const result = await checked(await request('inventory/adjustments', 'POST', input, 0));
  assert.ok(result);
  assert.equal((await stock(p)).summary.physical, '10.5');
  await checked(await request('inventory/adjustments', 'POST', input, 0));
  assert.equal((await stock(p)).summary.physical, '10.5');
  await checked(
    await request(
      'inventory/adjustments',
      'POST',
      { ...input, operationId: randomUUID(), observedQuantity: '2' },
      0,
    ),
    409,
  );
  detail = await stock(p);
  await checked(
    await request(
      'inventory/adjustments',
      'POST',
      {
        ...input,
        operationId: randomUUID(),
        expectedScopeVersion: detail.scopeVersion,
        observedQuantity: '0',
      },
      0,
    ),
  );
  assert.equal((await stock(p)).summary.physical, '0');
  await assert.rejects(
    client.inventoryBalance.update({ where: { id: pos.id }, data: { quantity: '-1' } }),
  );
  await projection();
});
test('seguridad tenant/OPERATOR, CSRF, FKs reales y ledger inmutable incluso append tardío', async () => {
  const p = await product();
  const d = await confirm(await line(await opened(), p, '2'));
  await checked(await request('inventory/products/' + p.id, 'GET', undefined, 2), 404);
  await checked(await request('inventory/receipts/' + d.id, 'GET', undefined, 2), 404);
  await checked(
    await request('inventory/receipts', 'POST', { id: randomUUID(), supplierId: foreignSupplier }),
    404,
  );
  await checked(
    await request('inventory/products/' + p.id + '/policy', 'PUT', {
      expectedVersion: 1,
      lotRequired: false,
      expirationRequired: false,
      serialRequired: false,
    }),
    403,
  );
  await checked(
    await request('inventory/counts', 'POST', { id: randomUUID(), organizationId: foreignOrg }),
    400,
  );
  const noCsrf = await fetch(base + '/api/v1/inventory/counts', {
    method: 'POST',
    headers: { Cookie: cookies[1]!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: randomUUID() }),
  });
  assert.equal(noCsrf.status, 403);
  const l = await client.inventoryMovementLine.findFirstOrThrow({
    where: { movementId: d.movementId! },
  });
  await assert.rejects(
    client.inventoryMovementLine.update({ where: { id: l.id }, data: { quantityDelta: '3' } }),
  );
  await assert.rejects(client.inventoryMovementLine.delete({ where: { id: l.id } }));
  await assert.rejects(
    client.inventoryMovement.update({ where: { id: d.movementId! }, data: { notes: 'tamper' } }),
  );
  const { id: _, ...copy } = l;
  void _;
  await assert.rejects(client.inventoryMovementLine.create({ data: copy }));
  const foreignLocation = await client.inventoryLocation.create({
    data: { organizationId: foreignOrg, code: 'PRIVATE', name: 'Private' },
  });
  await assert.rejects(
    client.inventoryBalance.create({
      data: {
        organizationId: org,
        productId: p.id,
        locationId: foreignLocation.id,
        condition: 'USABLE',
        quantity: '1',
      },
    }),
  );
  const q = await product();
  const wrongLot = await client.inventoryLot.create({
    data: {
      organizationId: org,
      productId: q.id,
      lotNumber: 'wrong',
      normalizedLotNumber: 'wrong',
    },
  });
  await assert.rejects(
    client.inventoryBalance.create({
      data: {
        organizationId: org,
        productId: p.id,
        locationId: d.location.id,
        lotId: wrongLot.id,
        condition: 'DAMAGED',
        quantity: '1',
      },
    }),
  );
  await projection();
});
test('Stock busca código/GTIN/lote/serie; historia paginada conserva origen y unidad', async () => {
  const p = await product('UNIT', {
    lotRequired: false,
    expirationRequired: false,
    serialRequired: true,
  });
  const code = 'MB-' + randomUUID().slice(0, 8).toUpperCase();
  await client.productIdentifier.create({
    data: {
      organizationId: org,
      productId: p.id,
      kind: 'INTERNAL_BARCODE',
      value: code,
      normalizedValue: code,
    },
  });
  await confirm(
    await line(await opened(), p, '1', {
      lotNumber: 'search-lot',
      serialNumbers: ['search-serial'],
    }),
  );
  for (const query of [code, 'search-lot', 'search-serial']) {
    const list = inventoryStockListSchema.parse(
      await checked(await request('inventory/stock?q=' + encodeURIComponent(query))),
    );
    assert.ok(list.items.some((i) => i.product.id === p.id));
  }
  const history = inventoryHistorySchema.parse(
    await checked(await request('inventory/products/' + p.id + '/history?limit=1')),
  );
  assert.equal(history.items[0]!.type, 'RECEIPT');
  assert.equal(history.items[0]!.lines[0]!.serialNumber, 'search-serial');
  assert.equal(history.items[0]!.lines[0]!.unitOfMeasure, 'UNIT');
  assert.equal(history.items[0]!.supplierName, 'Inventory supplier');
});
test('importar CSV e identificar siguen creando cero stock y cero movimiento', async () => {
  const before = await client.inventoryMovement.count();
  const form = new FormData();
  form.set(
    'file',
    new File(['CODIGO,DESCRIPCION\nNO-STOCK,Referencia\n'], 'inventory-regression.csv'),
  );
  const inspection = catalogInspectionSchema.parse(
    await checked(await request(`suppliers/${supplier}/catalog-imports/inspect`, 'POST', form, 0)),
  );
  const preview = catalogImportSchema.parse(
    await checked(
      await request(
        `suppliers/${supplier}/catalog-imports/preview`,
        'POST',
        {
          uploadId: inspection.uploadId,
          sheet: 'CSV',
          headerRow: 1,
          mapping: {
            supplierCode: 0,
            description: 1,
            brandText: null,
            presentationText: null,
            reportedGtin: null,
          },
          mode: 'PARTIAL',
        },
        0,
      ),
      201,
    ),
  );
  await checked(
    await request(
      `supplier-catalog-imports/${preview.id}/commit`,
      'POST',
      { previewHash: preview.previewHash },
      0,
    ),
  );
  const ref = await client.supplierCatalogItem.findFirstOrThrow({
    where: { organizationId: org, supplierId: supplier, supplierCode: 'NO-STOCK' },
  });
  const confirmed = await checked(
    await request('catalog-identifications/confirm', 'POST', {
      operationId: randomUUID(),
      scan: { value: 'MB-INVENTORY-NO-STOCK', namespace: 'AUTO' },
      referenceId: ref.id,
      expectedReferenceVersion: ref.version,
      target: {
        mode: 'NEW',
        product: { name: 'Identificado sin existencia', unitOfMeasure: 'UNIT' },
      },
    }),
  );
  assert.ok(confirmed);
  const p = await client.product.findFirstOrThrow({
    where: { organizationId: org, name: 'Identificado sin existencia' },
  });
  await checked(
    await request('catalog-scans/resolve', 'POST', {
      value: 'MB-INVENTORY-NO-STOCK',
      namespace: 'AUTO',
    }),
  );
  assert.equal((await stock(p)).summary.physical, '0');
  assert.equal(await client.inventoryMovement.count(), before);
  await projection();
});

test('conteo cero con policy física completa y paginación del historial después de recibir', async () => {
  const p = await product('UNIT', {
    lotRequired: true,
    expirationRequired: true,
    serialRequired: true,
  });
  let d = await scope(await opened('counts'), p.id);
  d = await line(d, p, '0');
  await confirm(d);
  await confirm(
    await line(await opened(), p, '1', {
      lotNumber: 'after-zero',
      expirationDate: '2099-01-01',
      serialNumbers: ['zero-return'],
    }),
  );
  const first = inventoryHistorySchema.parse(
    await checked(await request(`inventory/products/${p.id}/history?limit=1`)),
  );
  const second = inventoryHistorySchema.parse(
    await checked(await request(`inventory/products/${p.id}/history?limit=1&page=2`)),
  );
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.type, 'RECEIPT');
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]!.change, '0');
  assert.equal(second.total, 2);
});
test('dos sesiones iniciales concurrentes y dos ajustes simultáneos tienen un solo ganador', async () => {
  const p = await product();
  const a = await opened('counts'),
    b = await opened('counts');
  const responses = await Promise.all([
    request(`inventory/counts/${a.id}/scopes`, 'POST', {
      productId: p.id,
      expectedVersion: a.version,
    }),
    request(`inventory/counts/${b.id}/scopes`, 'POST', {
      productId: p.id,
      expectedVersion: b.version,
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const winner = inventoryDocumentSchema.parse(
    await responses.find((r) => r.status === 200)!.json(),
  );
  await confirm(await line(winner, p, '1'));
  const d = await stock(p);
  const input = {
    positionId: d.positions[0]!.id,
    expectedScopeVersion: d.scopeVersion,
    observedQuantity: '0',
    reason: 'COUNT',
    notes: 'Conteo simultáneo de verificación',
  };
  const results = await Promise.all([
    request('inventory/adjustments', 'POST', { ...input, operationId: randomUUID() }, 0),
    request('inventory/adjustments', 'POST', { ...input, operationId: randomUUID() }, 0),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await stock(p)).summary.physical, '0');
  await projection();
});
test('dos recepciones simultáneas de la misma serie no duplican existencia', async () => {
  const p = await product('UNIT', {
    lotRequired: false,
    expirationRequired: false,
    serialRequired: true,
  });
  const a = await line(await opened(), p, '1', { serialNumbers: ['concurrent-serial'] }),
    b = await line(await opened(), p, '1', { serialNumbers: ['concurrent-serial'] });
  const responses = await Promise.all([
    request(`inventory/receipts/${a.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: a.version,
    }),
    request(`inventory/receipts/${b.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: b.version,
    }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await stock(p)).summary.physical, '1');
  await projection();
});
test('CLI detecta divergencia y rebuild acotado restaura proyección sin alterar el ledger', async () => {
  const p = await product();
  await confirm(await line(await opened(), p, '3'));
  const d = await stock(p);
  await client.inventoryBalance.update({
    where: { id: d.positions[0]!.id },
    data: { quantity: '99' },
  });
  const script = resolve('dist-test/src/modules/inventory/verify-inventory.js');
  const options = {
    env: { ...process.env, DATABASE_URL: url.toString() },
    encoding: 'utf8' as const,
    timeout: 15000,
  };
  assert.throws(() =>
    execFileSync(process.execPath, [script, '--organization', org, '--product', p.id], options),
  );
  const before = await client.inventoryMovementLine.count();
  const output = execFileSync(
    process.execPath,
    [script, '--organization', org, '--product', p.id, '--rebuild'],
    options,
  );
  assert.match(output, /"mismatches":"0"/);
  assert.equal(await client.inventoryMovementLine.count(), before);
  assert.equal((await stock(p)).summary.physical, '3');
  await projection();
});
test('acceso revalidado dentro de transacción: una sesión revocada no confirma', async () => {
  const p = await product();
  const d = await line(await opened(), p, '2');
  const owner = actors[1]!;
  const token = randomBytes(32).toString('base64url');
  const s = await client.session.create({
    data: {
      userId: owner.userId,
      activeMembershipId: owner.membershipId,
      tokenHash: tokenVerifier(token),
      expiresAt: new Date(Date.now() + 86400000),
      absoluteExpiresAt: new Date(Date.now() + 86400000),
    },
  });
  await client.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  await assert.rejects(
    app.get(InventoryService).confirm({ ...owner, sessionId: s.id }, 'receipts', d.id, {
      operationId: randomUUID(),
      expectedVersion: d.version,
    }),
  );
  assert.equal((await stock(p)).summary.physical, '0');
});
test('límite de captura: quinientas series se confirma y el ledger sigue igual al balance', async () => {
  const p = await product('UNIT', {
    lotRequired: false,
    expirationRequired: false,
    serialRequired: true,
  });
  let d = await opened();
  for (let block = 0; block < 5; block++)
    d = await line(d, p, '100', {
      serialNumbers: Array.from({ length: 100 }, (_, i) => `load-${block}-${i}`),
    });
  await confirm(d);
  assert.equal((await stock(p)).summary.physical, '500');
  await projection();
});

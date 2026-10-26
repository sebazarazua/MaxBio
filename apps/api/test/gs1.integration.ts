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
  identificationConfirmationSchema,
  inventoryDocumentSchema,
  inventoryPolicySchema,
  inventoryStockDetailSchema,
  scanResultSchema,
  type IdentificationConfirm,
  type InventoryDocument,
  type ScanResult,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import {
  catalogPrefix,
  referenceCode,
} from '../src/modules/catalog/domain/catalog-reference-code.js';
import { hasValidGtinCheckDigit } from '../src/common/domain/scanning/gtin.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
// GS1 Stages 2-3 against a disposable database: never the operational one.
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_gs1_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication, base: string, org: string, foreignOrg: string, supplier: string;
const cookies: string[] = [];
const GS = '\x1d';
let sequence = 0;
// Synthetic GTIN-14 with a recomputed check digit; never a real product.
function gtin() {
  const body = '0779' + String(++sequence).padStart(9, '0');
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
async function resolve(value: string, extra: object = {}, actor = 1): Promise<ScanResult> {
  return scanResultSchema.parse(
    await checked(await request('catalog-scans/resolve', 'POST', { value, ...extra }, actor)),
  );
}
function known(result: ScanResult) {
  assert.equal(result.status, 'KNOWN', JSON.stringify(result));
  return result as Extract<ScanResult, { status: 'KNOWN' }>;
}
async function product(
  options: {
    gtin?: string;
    legacyValue?: string;
    policy?: { lotRequired: boolean; expirationRequired: boolean; serialRequired: boolean };
    organizationId?: string;
  } = {},
) {
  const organizationId = options.organizationId ?? org;
  const p = await client.product.create({
    data: { organizationId, name: 'GS1 ' + randomUUID(), unitOfMeasure: 'UNIT' },
  });
  if (options.gtin)
    await client.productIdentifier.create({
      data: {
        organizationId,
        productId: p.id,
        kind: 'GTIN',
        value: options.legacyValue ?? options.gtin,
        normalizedValue: options.gtin,
      },
    });
  if (options.policy)
    inventoryPolicySchema.parse(
      await checked(
        await request(
          'inventory/products/' + p.id + '/policy',
          'PUT',
          { expectedVersion: 0, ...options.policy },
          0,
        ),
      ),
    );
  return p;
}
async function reference(normalizedReportedGtin?: string) {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${org}::uuid FOR UPDATE`;
    const s = await tx.supplier.findUniqueOrThrow({ where: { id: supplier } });
    const prefix = s.catalogPrefix ?? catalogPrefix(1);
    await tx.supplier.update({
      where: { id: supplier },
      data: { catalogPrefix: prefix, catalogNextSequence: { increment: 1 } },
    });
    return tx.supplierCatalogItem.create({
      data: {
        organizationId: org,
        supplierId: supplier,
        supplierCode: 'GS1-' + randomUUID(),
        description: 'Referencia GS1',
        referenceSequence: s.catalogNextSequence,
        internalReferenceCode: referenceCode(prefix, s.catalogNextSequence),
        ...(normalizedReportedGtin
          ? { reportedGtin: normalizedReportedGtin, normalizedReportedGtin }
          : {}),
      },
    });
  });
}
async function document(r: Promise<Response>, status = 200) {
  return inventoryDocumentSchema.parse(await checked(await r, status));
}
async function opened(kind: 'receipts' | 'counts' = 'receipts') {
  return document(
    request('inventory/' + kind, 'POST', {
      id: randomUUID(),
      ...(kind === 'receipts' ? { supplierId: supplier } : {}),
    }),
  );
}
function linePath(d: InventoryDocument, lineId = randomUUID()) {
  return `inventory/${d.kind === 'RECEIPT' ? 'receipts' : 'counts'}/${d.id}/lines/${lineId}`;
}
async function line(d: InventoryDocument, productId: string, quantity: string, extra: object) {
  return document(
    request(linePath(d), 'PUT', {
      expectedVersion: d.version,
      productId,
      unitOfMeasure: 'UNIT',
      quantity,
      ...extra,
    }),
  );
}
async function confirm(d: InventoryDocument, status = 200) {
  const r = await request(
    `inventory/${d.kind === 'RECEIPT' ? 'receipts' : 'counts'}/${d.id}/confirm`,
    'POST',
    {
      operationId: randomUUID(),
      expectedVersion: d.version,
      ...(d.kind === 'INITIAL_COUNT' ? { completeCoverage: true } : {}),
    },
  );
  return checked(r, status);
}
async function stock(productId: string) {
  return inventoryStockDetailSchema.parse(
    await checked(await request('inventory/products/' + productId)),
  );
}
// Everything a scan must never touch by itself, including Audit and scopes.
async function sideEffects() {
  const where = { organizationId: { in: [org, foreignOrg] } };
  return Promise.all([
    client.inventoryLot.count({ where }),
    client.inventorySerial.count({ where }),
    client.inventoryBalance.count({ where }),
    client.inventoryMovement.count({ where }),
    client.inventoryReceipt.count({ where }),
    client.inventoryReceiptLine.count({ where }),
    client.inventoryCountSession.count({ where }),
    client.inventoryCountScope.count({ where }),
    client.inventoryCountLine.count({ where }),
    client.auditEvent.count({ where }),
    client.product.count({ where }),
    client.productIdentifier.count({ where }),
    client.supplierScanIdentifier.count({ where }),
    client.catalogIdentification.count({ where }),
  ]);
}
async function rawTextCount(needle: string) {
  const pattern = '%' + needle + '%';
  const rows = await client.$queryRaw<Array<{ n: bigint }>>`SELECT
    (SELECT COUNT(*) FROM "AuditEvent" a WHERE a::text LIKE ${pattern}) +
    (SELECT COUNT(*) FROM "CatalogIdentification" c WHERE c::text LIKE ${pattern}) +
    (SELECT COUNT(*) FROM "ProductIdentifier" i WHERE i::text LIKE ${pattern}) +
    (SELECT COUNT(*) FROM "SupplierScanIdentifier" s WHERE s::text LIKE ${pattern}) AS n`;
  return rows[0]!.n;
}

before(
  async () => {
    assert.match(databaseName, /^maxbio_gs1_test_[a-f0-9]{32}$/);
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
        data: { name: 'GS1 fixtures', slug: 'gs1-' + randomUUID() },
      })
    ).id;
    foreignOrg = (
      await client.organization.create({
        data: { name: 'GS1 private', slug: 'gs1-' + randomUUID() },
      })
    ).id;
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreignOrg, 'OPERATOR'],
    ] as const) {
      const u = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'GS1 ' + role },
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
      await client.supplier.create({ data: { organizationId: org, name: 'Proveedor GS1' } })
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
  assert.match(databaseName, /^maxbio_gs1_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});

test('GS1 conocido = mismo Product que EAN-13 legacy; datos físicos y cero efectos', async () => {
  const p = await product({ gtin: '04006381333931', legacyValue: '4006381333931' });
  const initial = await sideEffects();
  const legacy = known(await resolve('4006381333931'));
  assert.equal(legacy.product.id, p.id);
  assert.equal('scan' in legacy, false);
  for (const value of [
    ']d2010400638133393117281231' + '10ABC123' + GS + '21S9982',
    '(01)04006381333931(17)281231(10)ABC123(21)S9982',
    ' ]C1010400638133393117281231' + '10ABC123' + GS + '21S9982\r\n',
  ]) {
    const result = known(await resolve(value, { supplierId: supplier }));
    assert.equal(result.product.id, p.id);
    assert.deepEqual(result.identity, {
      kind: 'GTIN',
      value: '04006381333931',
      normalizedValue: '04006381333931',
      supplierId: null,
    });
    assert.equal(result.scan?.status, 'VALID');
    assert.deepEqual(result.scan?.fields, {
      gtin14: '04006381333931',
      lotNumber: 'ABC123',
      expirationDate: '2028-12-31',
      expiration: { encoded: '281231', precision: 'DAY' },
      serialNumber: 'S9982',
    });
  }
  const only = known(await resolve('0104006381333931'));
  assert.deepEqual(only.scan?.fields, { gtin14: '04006381333931' });
  const partial = known(await resolve('(01)04006381333931(10)ABC(17)280231'));
  assert.equal(partial.product.id, p.id);
  assert.equal(partial.scan?.status, 'PARTIAL');
  assert.equal(partial.scan?.canApplyPhysicalData, false);
  assert.deepEqual(partial.scan?.issues, [
    { code: 'INVALID_EXPIRATION', severity: 'ERROR', ai: '17' },
  ]);
  const month = known(await resolve('(01)04006381333931(17)280200'));
  assert.equal(month.scan?.fields.expiration?.precision, 'MONTH');
  assert.equal(month.scan?.issues[0]?.code, 'EXPIRATION_DAY_UNSPECIFIED');
  const text = await (
    await request('catalog-scans/resolve', 'POST', {
      value: ']d20104006381333931' + '10ABC' + GS + '21S1',
    })
  ).text();
  assert.doesNotMatch(text, /\\u001d|\]d2|elements|offset|"raw"/);
  assert.deepEqual(await sideEffects(), initial);
});

test('GTIN inválido, formatos no soportados y GS1 en INTERNAL_CODE nunca se rescatan', async () => {
  const initial = await sideEffects();
  for (const [value, status, reasonCode, extra] of [
    ['(01)04006381333932(10)LOT', 'INVALID', 'INVALID_GTIN', { supplierId: supplier }],
    ['(01)07791234567890', 'INVALID', 'INVALID_GTIN', {}],
    ['0104006381333931' + '91OTRO' + GS + '17281231', 'UNSUPPORTED', 'UNSUPPORTED_AI', {}],
    ['https://id.gs1.org/01/04006381333931/10/ABC', 'UNSUPPORTED', 'UNSUPPORTED_FORMAT', {}],
    [']d2]C10104006381333931', 'INVALID', 'MIXED_FORMAT', {}],
    ['(10)ABC(17)281231', 'INVALID', 'MISSING_GTIN', {}],
    ['(01)04006381333931', 'UNSUPPORTED', 'FORMAT_CONFLICT', { namespace: 'INTERNAL_CODE' }],
  ] as const) {
    const result = await resolve(value, extra);
    assert.equal(result.status, status, value);
    assert.ok(result.status === 'INVALID' || result.status === 'UNSUPPORTED');
    assert.equal(result.reasonCode, reasonCode, value);
    assert.equal('identity' in result, false);
  }
  // Invalid GS1 intent is never confirmed as a supplier barcode or internal code.
  await checked(
    await request('catalog-identifications/confirm', 'POST', {
      operationId: randomUUID(),
      scan: { value: '(01)04006381333932(10)LOT', supplierId: supplier },
      referenceId: (await reference()).id,
      expectedReferenceVersion: 1,
      target: { mode: 'NEW', product: { name: 'No', unitOfMeasure: 'UNIT' } },
    }),
    400,
  );
  assert.deepEqual(await sideEffects(), initial);
});

test('UNKNOWN, CANDIDATES y ARCHIVED conservan Product Identification y adjuntan el scan', async () => {
  const unknownGtin = gtin(),
    candidateGtin = gtin(),
    archivedGtin = gtin();
  const ref = await reference(candidateGtin);
  const archived = await product({ gtin: archivedGtin });
  await client.productIdentifier.updateMany({
    where: { productId: archived.id },
    data: { archivedAt: new Date() },
  });
  const initial = await sideEffects();
  const unknown = await resolve('01' + unknownGtin + '10L1');
  assert.equal(unknown.status, 'UNKNOWN');
  if (unknown.status === 'UNKNOWN') {
    assert.equal(unknown.identity.normalizedValue, unknownGtin);
    assert.equal(unknown.scan?.fields.lotNumber, 'L1');
  }
  const candidates = await resolve(']d201' + candidateGtin + '21SER');
  assert.equal(candidates.status, 'CANDIDATES');
  if (candidates.status === 'CANDIDATES') {
    assert.equal(candidates.candidates[0]?.id, ref.id);
    assert.equal(candidates.scan?.fields.serialNumber, 'SER');
  }
  const reserved = await resolve('(01)' + archivedGtin + '(10)X');
  assert.equal(reserved.status, 'ARCHIVED');
  if (reserved.status === 'ARCHIVED') assert.equal(reserved.scan?.fields.lotNumber, 'X');
  assert.deepEqual(await sideEffects(), initial);
});

test('confirmar identificación GS1 persiste solo el GTIN; lote/serie/raw no se guardan; retry idempotente', async () => {
  const target = await product();
  const ref = await reference();
  const g = gtin();
  const value = ']d201' + g + '17281231' + '10LOTEGS1X' + GS + '21SERIEGS1X';
  const input: IdentificationConfirm = {
    operationId: randomUUID(),
    scan: { value, namespace: 'AUTO' },
    referenceId: ref.id,
    expectedReferenceVersion: ref.version,
    target: { mode: 'EXISTING', productId: target.id, expectedProductVersion: target.version },
  };
  const physical = (await sideEffects()).slice(0, 9);
  const result = identificationConfirmationSchema.parse(
    await checked(await request('catalog-identifications/confirm', 'POST', input)),
  );
  assert.equal(result.product.id, target.id);
  const identifiers = await client.productIdentifier.findMany({ where: { productId: target.id } });
  assert.deepEqual(
    identifiers.map(({ kind, value, normalizedValue }) => ({ kind, value, normalizedValue })),
    [{ kind: 'GTIN', value: g, normalizedValue: g }],
  );
  assert.equal(await client.supplierScanIdentifier.count({ where: { organizationId: org } }), 0);
  assert.deepEqual((await sideEffects()).slice(0, 9), physical);
  for (const needle of ['LOTEGS1X', 'SERIEGS1X', ']d2'])
    assert.equal(await rawTextCount(needle), 0n, needle);
  const replay = identificationConfirmationSchema.parse(
    await checked(await request('catalog-identifications/confirm', 'POST', input)),
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.confirmationId, result.confirmationId);
  assert.equal(known(await resolve(g)).product.id, target.id);
  assert.equal(known(await resolve(g.replace(/^0/, ''))).product.id, target.id);
  assert.equal(known(await resolve('(01)' + g + '(21)OTRA')).product.id, target.id);
});

test('tenant isolation: un GTIN de otra organización no resuelve; supplier ajeno 404', async () => {
  const g = gtin();
  const foreign = await product({ gtin: g, organizationId: foreignOrg });
  assert.equal((await resolve('(01)' + g + '(10)L')).status, 'UNKNOWN');
  assert.equal(known(await resolve('(01)' + g + '(10)L', {}, 2)).product.id, foreign.id);
  await checked(
    await request('catalog-scans/resolve', 'POST', { value: '(01)' + g, supplierId: supplier }, 2),
    404,
  );
  await checked(
    await request('catalog-scans/resolve', 'POST', { value: '(01)' + g, organizationId: org }),
    400,
  );
  await checked(
    await request('catalog-scans/resolve', 'POST', { value: '(01)' + g, lotNumber: 'L' }),
    400,
  );
});

test('regresiones legacy: externo por proveedor, MB- e INTERNAL_CODE siguen iguales', async () => {
  const external = 'EXT-' + randomUUID().slice(0, 8);
  const ref = await reference();
  const confirmed = identificationConfirmationSchema.parse(
    await checked(
      await request('catalog-identifications/confirm', 'POST', {
        operationId: randomUUID(),
        scan: { value: external, supplierId: supplier },
        referenceId: ref.id,
        expectedReferenceVersion: ref.version,
        target: { mode: 'NEW', product: { name: 'Externo', unitOfMeasure: 'UNIT' } },
      }),
    ),
  );
  const supplierKnown = known(await resolve(external, { supplierId: supplier }));
  assert.equal(supplierKnown.product.id, confirmed.product.id);
  assert.equal(supplierKnown.identity.kind, 'SUPPLIER_BARCODE');
  assert.equal((await resolve(external)).status, 'AMBIGUOUS');
  assert.equal((await resolve('MB-GS1-REG')).status, 'UNKNOWN');
  const internal = await resolve('OWN-GS1', { namespace: 'INTERNAL_CODE' });
  assert.equal(internal.status, 'UNKNOWN');
  if (internal.status === 'UNKNOWN') assert.equal(internal.identity.kind, 'INTERNAL_CODE');
  const generic = await resolve(']d1HELLO', { supplierId: supplier });
  assert.equal(generic.status, 'UNKNOWN');
  if (generic.status === 'UNKNOWN') assert.equal(generic.identity.value, ']d1HELLO');
});

test('Receipt: los datos GS1 precargan la línea; Agregar guarda borrador sin stock; confirmar publica', async () => {
  const g = gtin();
  const p = await product({
    gtin: g,
    policy: { lotRequired: true, expirationRequired: true, serialRequired: true },
  });
  const read = async (serial: string, date = '281231') =>
    known(await resolve(']d201' + g + '17' + date + '10LOT-A' + GS + '21' + serial)).scan!.fields;
  const first = await read('SER-1'),
    second = await read('SER-2');
  let d = await opened();
  // Policy: one serial cannot represent five units.
  await checked(
    await request(linePath(d), 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      unitOfMeasure: 'UNIT',
      quantity: '5',
      lotNumber: first.lotNumber,
      expirationDate: first.expirationDate,
      serialNumbers: [first.serialNumber],
    }),
    400,
  );
  const beforeAdd = await sideEffects();
  d = await line(d, p.id, '2', {
    lotNumber: first.lotNumber,
    expirationDate: first.expirationDate,
    serialNumbers: [first.serialNumber, second.serialNumber],
  });
  assert.deepEqual(d.lines[0]?.serialNumbers, ['SER-1', 'SER-2']);
  assert.equal(d.lines[0]?.lotNumber, 'LOT-A');
  assert.equal(d.lines[0]?.expirationDate, '2028-12-31');
  const draft = await sideEffects();
  assert.deepEqual([draft[0], draft[1], draft[2], draft[3]], beforeAdd.slice(0, 4));
  assert.equal((await stock(p.id)).summary.physical, '0');
  await confirm(d);
  const detail = await stock(p.id);
  assert.equal(detail.summary.physical, '2');
  assert.deepEqual(detail.positions.map((x) => x.serialNumber).sort(), ['SER-1', 'SER-2']);
  assert.ok(detail.positions.every((x) => x.lotNumber === 'LOT-A'));
  // The same serial scanned again cannot become a second existence.
  const again = await line(await opened(), p.id, '1', {
    lotNumber: first.lotNumber,
    expirationDate: first.expirationDate,
    serialNumbers: [first.serialNumber],
  });
  await confirm(again, 409);
  // Same lot with another expiration conflicts and never overwrites the lot master.
  const other = await read('SER-3', '290101');
  const conflict = await line(await opened(), p.id, '1', {
    lotNumber: other.lotNumber,
    expirationDate: other.expirationDate,
    serialNumbers: [other.serialNumber],
  });
  await confirm(conflict, 409);
  const lot = await client.inventoryLot.findFirstOrThrow({
    where: { productId: p.id, normalizedLotNumber: 'LOT-A' },
  });
  assert.equal(lot.expirationDate?.toISOString().slice(0, 10), '2028-12-31');
  assert.equal((await stock(p.id)).summary.physical, '2');
});

test('Receipt: serie con policy false se rechaza salvo descarte; extras opcionales y vencidos se conservan', async () => {
  const g = gtin();
  const p = await product({
    gtin: g,
    policy: { lotRequired: false, expirationRequired: false, serialRequired: false },
  });
  const fields = known(await resolve('(01)' + g + '(17)200101(10)OLD-1(21)S-NO')).scan!.fields;
  assert.equal(fields.expirationDate, '2020-01-01');
  let d = await opened();
  await checked(
    await request(linePath(d), 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      unitOfMeasure: 'UNIT',
      quantity: '1',
      serialNumbers: [fields.serialNumber],
    }),
    400,
  );
  d = await line(d, p.id, '1', {
    lotNumber: fields.lotNumber,
    expirationDate: fields.expirationDate,
  });
  await confirm(d);
  const detail = await stock(p.id);
  assert.equal(detail.summary.physical, '1');
  assert.equal(detail.summary.available, '0');
  assert.equal(detail.positions[0]?.expired, true);
  assert.equal(detail.positions[0]?.serialNumber, null);
  assert.equal(await client.inventorySerial.count({ where: { productId: p.id } }), 0);
  assert.equal(
    inventoryPolicySchema.parse(await checked(await request(`inventory/products/${p.id}/policy`)))
      .serialRequired,
    false,
  );
});

test('sin policy: identidad válida, pero ingreso exige configuración administrativa', async () => {
  const g = gtin();
  const p = await product({ gtin: g });
  const result = known(await resolve('(01)' + g + '(10)L'));
  assert.equal(result.product.id, p.id);
  assert.equal(await checked(await request(`inventory/products/${p.id}/policy`)), null);
  const d = await opened();
  await checked(
    await request(linePath(d), 'PUT', {
      expectedVersion: d.version,
      productId: p.id,
      unitOfMeasure: 'UNIT',
      quantity: '1',
      lotNumber: 'L',
    }),
    409,
  );
});

test('Initial Count: mismo prefill; scan no reclama scope; cobertura y cero explícitos intactos', async () => {
  const g = gtin(),
    zero = gtin();
  const counted = await product({
    gtin: g,
    policy: { lotRequired: true, expirationRequired: true, serialRequired: false },
  });
  const empty = await product({
    gtin: zero,
    policy: { lotRequired: true, expirationRequired: true, serialRequired: false },
  });
  let d = await opened('counts');
  const scopes = await client.inventoryCountScope.count({ where: { sessionId: d.id } });
  const fields = known(await resolve(']C101' + g + '17281231' + '10CNT-1')).scan!.fields;
  known(await resolve('01' + zero));
  assert.equal(await client.inventoryCountScope.count({ where: { sessionId: d.id } }), scopes);
  await checked(
    await request(linePath(d), 'PUT', {
      expectedVersion: d.version,
      productId: counted.id,
      unitOfMeasure: 'UNIT',
      quantity: '4',
      lotNumber: fields.lotNumber,
      expirationDate: fields.expirationDate,
    }),
    409,
  );
  for (const p of [counted, empty])
    d = await document(
      request(`inventory/counts/${d.id}/scopes`, 'POST', {
        productId: p.id,
        expectedVersion: d.version,
      }),
    );
  d = await line(d, counted.id, '4', {
    lotNumber: fields.lotNumber,
    expirationDate: fields.expirationDate,
  });
  d = await line(d, empty.id, '0', {});
  // Coverage must be declared explicitly; a scan never means "counted".
  await checked(
    await request(`inventory/counts/${d.id}/confirm`, 'POST', {
      operationId: randomUUID(),
      expectedVersion: d.version,
    }),
    400,
  );
  await confirm(d);
  assert.equal((await stock(counted.id)).summary.physical, '4');
  assert.equal((await stock(counted.id)).positions[0]?.lotNumber, 'CNT-1');
  assert.equal((await stock(empty.id)).summary.physical, '0');
});

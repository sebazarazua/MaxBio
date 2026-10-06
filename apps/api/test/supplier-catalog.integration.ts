import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { z } from 'zod';
import { createDatabaseClient } from '@maxbio/database';
import type { Prisma } from '@maxbio/database';
import {
  apiErrorSchema,
  catalogInspectionSchema,
  catalogImportSchema,
  catalogImportRowsSchema,
  supplierCatalogListSchema,
  supplierCatalogItemSchema,
  catalogImportListSchema,
  type CatalogPreviewInput,
  type CatalogImportView,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { SupplierCatalogService } from '../src/modules/catalog/application/supplier-catalog.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';
import { xlsxFixture } from './supplier-catalog-fixtures.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const { AppModule } = await import('../src/app.module.js');
const client = createDatabaseClient(process.env.DATABASE_URL!);
const suffix = randomUUID();
const orgs: string[] = [];
const users: string[] = [];
const requestIds: string[] = [];
let app: INestApplication;
let base: string;
let supplierA: string;
let supplierB: string;
let otherSupplierA: string;
let productId: string;
let adminA: RequestActorContext;
let adminB: RequestActorContext;
let operatorA: RequestActorContext;
const cookies = new Map<string, string>();
const mapping = {
  supplierCode: 0,
  description: 1,
  brandText: 2,
  presentationText: 3,
  reportedGtin: 4,
};
const csv = (rows: string[][]) =>
  'CODIGO,DESCRIPCION,MARCA,PRESENTACION,GTIN\n' +
  rows.map((row) => row.map((value) => '"' + value.replace(/"/g, '""') + '"').join(',')).join('\n');
async function request(path: string, method = 'GET', body?: unknown, context = adminA) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      Cookie: cookies.get(context.sessionId)!,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
  requestIds.push(response.headers.get('x-request-id')!);
  return response;
}
async function checked<T>(response: Response, schema: z.ZodType<T>, status = 200): Promise<T> {
  const data: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return schema.parse(data);
}
async function inspect(
  content: string | Buffer,
  supplierId = supplierA,
  name = 'lista.csv',
  context = adminA,
) {
  const form = new FormData();
  form.set(
    'file',
    new File([typeof content === 'string' ? content : new Uint8Array(content)], name, {
      type: name.endsWith('.xlsx')
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv',
    }),
  );
  return checked(
    await request(`suppliers/${supplierId}/catalog-imports/inspect`, 'POST', form, context),
    catalogInspectionSchema,
  );
}
async function preview(
  content: string,
  mode: 'PARTIAL' | 'COMPLETE' = 'PARTIAL',
  supplierId = supplierA,
) {
  const file = await inspect(content, supplierId);
  return checked(
    await request(`suppliers/${supplierId}/catalog-imports/preview`, 'POST', {
      uploadId: file.uploadId,
      sheet: 'CSV',
      headerRow: 1,
      mapping,
      mode,
    }),
    catalogImportSchema,
    201,
  );
}
async function commit(value: CatalogImportView, excludeInvalidRows = false) {
  return checked(
    await request(`supplier-catalog-imports/${value.id}/commit`, 'POST', {
      previewHash: value.previewHash,
      excludeInvalidRows,
    }),
    catalogImportSchema,
  );
}
async function imported(
  rows: string[][],
  mode: 'PARTIAL' | 'COMPLETE' = 'PARTIAL',
  supplierId = supplierA,
) {
  return commit(await preview(csv(rows), mode, supplierId));
}
async function counts() {
  const where = { organizationId: orgs[0]! };
  return Promise.all([
    client.product.count({ where }),
    client.productIdentifier.count({ where }),
    client.supplierProduct.count({ where }),
  ]);
}
async function error(response: Response, status: number, pattern?: RegExp) {
  const data = await checked(response, apiErrorSchema, status);
  if (pattern) assert.match(data.message, pattern);
  assert.doesNotMatch(data.message, /Prisma|constraint|stack|C:\\/i);
  return data;
}

before(async () => {
  for (const label of ['a', 'b'])
    orgs.push(
      (
        await client.organization.create({
          data: { name: `Supplier catalog ${label}`, slug: `supplier-catalog-${label}-${suffix}` },
        })
      ).id,
    );
  const contexts: RequestActorContext[] = [];
  for (const [index, role] of [
    [0, 'ADMIN'],
    [1, 'ADMIN'],
    [0, 'OPERATOR'],
  ] as const) {
    const user = await client.user.create({
      data: { displayName: `Fixture ${role}`, email: `${randomUUID()}@example.invalid` },
    });
    users.push(user.id);
    const membership = await client.membership.create({
      data: { organizationId: orgs[index]!, userId: user.id, role },
    });
    const token = randomBytes(32).toString('base64url');
    const session = await client.session.create({
      data: {
        userId: user.id,
        activeMembershipId: membership.id,
        tokenHash: tokenVerifier(token),
        expiresAt: new Date(Date.now() + 86400000),
        absoluteExpiresAt: new Date(Date.now() + 86400000),
      },
    });
    cookies.set(session.id, 'maxbio-session=' + token);
    contexts.push({
      userId: user.id,
      organizationId: orgs[index]!,
      membershipId: membership.id,
      role,
      sessionId: session.id,
      requestId: randomUUID(),
    });
  }
  [adminA, adminB, operatorA] = contexts as [
    RequestActorContext,
    RequestActorContext,
    RequestActorContext,
  ];
  supplierA = (
    await client.supplier.create({ data: { organizationId: orgs[0]!, name: 'Proveedor Walker A' } })
  ).id;
  otherSupplierA = (
    await client.supplier.create({ data: { organizationId: orgs[0]!, name: 'Otro proveedor A' } })
  ).id;
  supplierB = (
    await client.supplier.create({
      data: { organizationId: orgs[1]!, name: 'Proveedor privado B' },
    })
  ).id;
  productId = (
    await client.product.create({
      data: { organizationId: orgs[0]!, name: 'Bota Walker corta', unitOfMeasure: 'UNIT' },
    })
  ).id;
  await client.productIdentifier.create({
    data: {
      organizationId: orgs[0]!,
      productId,
      kind: 'GTIN',
      value: '4006381333931',
      normalizedValue: '04006381333931',
    },
  });
  await client.supplierProduct.create({
    data: {
      organizationId: orgs[0]!,
      supplierId: supplierA,
      productId,
      supplierCode: 'DL2115',
      supplierDescription: 'Descripción ya confirmada',
    },
  });
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
});
after(async () => {
  await app?.close();
  const scope = { organizationId: { in: orgs } };
  await client.supplierCatalogImportRow.deleteMany({ where: scope });
  await client.supplierCatalogImport.deleteMany({ where: scope });
  await client.supplierCatalogUpload.deleteMany({ where: scope });
  await client.supplierCatalogItem.deleteMany({ where: scope });
  await client.auditEvent.deleteMany({
    where: { OR: [scope, { actorUserId: { in: users } }, { requestId: { in: requestIds } }] },
  });
  await client.supplierProduct.deleteMany({ where: scope });
  await client.productIdentifier.deleteMany({ where: scope });
  await client.product.deleteMany({ where: scope });
  await client.supplier.deleteMany({ where: scope });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.membership.deleteMany({ where: scope });
  await client.user.deleteMany({ where: { id: { in: users } } });
  await client.organization.deleteMany({ where: { id: { in: orgs } } });
  await client.$disconnect();
});
beforeEach(async () => {
  await client.supplierCatalogUpload.deleteMany({ where: { organizationId: { in: orgs } } });
});

test('ADMIN inspecciona/revisa/confirma; preview no escribe comercio; una fila crea cero productos/vínculos/identificadores', async () => {
  const before = await counts();
  const pending = await preview(
    csv([['DL2115', 'Bota Walker corta', 'Marca', 'Unidad', '4006381333931']]),
  );
  assert.equal(await client.supplierCatalogItem.count({ where: { organizationId: orgs[0] } }), 0);
  assert.deepEqual(await counts(), before);
  const result = await commit(pending);
  assert.equal(result.status, 'COMMITTED');
  assert.equal(result.summary.created, 1);
  assert.deepEqual(await counts(), before);
  const list = await checked(
    await request(`suppliers/${supplierA}/catalog-items?q=DL2115`, 'GET', undefined, operatorA),
    supplierCatalogListSchema,
  );
  assert.equal(list.total, 1);
  assert.equal(list.items[0]!.associationStatus, 'UNASSOCIATED');
  assert.equal(list.items[0]!.normalizedReportedGtin, '04006381333931');
  await checked(
    await request(`supplier-catalog-items/${list.items[0]!.id}`, 'GET', undefined, operatorA),
    supplierCatalogItemSchema,
  );
  assert.equal(await client.supplierCatalogUpload.count({ where: { organizationId: orgs[0] } }), 0);
  const audit = await client.auditEvent.findFirstOrThrow({
    where: { resourceId: result.id, action: 'SUPPLIER_CATALOG_IMPORTED' },
  });
  assert.equal(audit.organizationId, orgs[0]);
  assert.equal(audit.actorUserId, adminA.userId);
  assert.equal(audit.sessionId, adminA.sessionId);
  assert.deepEqual(
    Object.keys(audit.metadata as object).sort(),
    [
      'supplierId',
      'importId',
      'created',
      'updated',
      'unchanged',
      'ignored',
      'errors',
      'conflicts',
      'missing',
      'mode',
    ].sort(),
  );
  assert.equal((audit.metadata as { supplierId: string }).supplierId, supplierA);
});
test('5.000 referencias reales, paginadas, sin Products nuevos ni cambios a Product/Identifier/SupplierProduct', async () => {
  const before = await counts();
  const original = await client.product.findUniqueOrThrow({ where: { id: productId } });
  const start = Date.now();
  const result = await imported(
    Array.from({ length: 5000 }, (_, index) => [`00${index}`, 'Walker referencia masiva']),
  );
  assert.equal(result.summary.created, 5000);
  assert.deepEqual(await counts(), before);
  assert.deepEqual(await client.product.findUnique({ where: { id: productId } }), original);
  assert.equal(
    await client.supplierCatalogImportRow.count({
      where: { importId: result.id, itemId: { not: null } },
    }),
    5000,
  );
  const list = await checked(
    await request('supplier-catalog-items?q=masiva&limit=100&page=2', 'GET', undefined, operatorA),
    supplierCatalogListSchema,
  );
  assert.equal(list.total, 5000);
  assert.equal(list.items.length, 100);
  assert.equal(list.page, 2);
  const tables = await client.$queryRaw<
    { table_name: string }[]
  >`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('Inventory','Stock','InventoryMovement','Lot','SerialNumber')`;
  assert.equal(tables.length, 0);
  console.log(
    `Supplier catalog 5000 rows: ${Date.now() - start} ms including inspect + preview + commit + assertions`,
  );
});
test('10.000 filas máximas se confirman y actualizan en lote sin duplicar ni crear Products', async () => {
  const before = await counts();
  const rows = Array.from({ length: 10000 }, (_, index) => [`MAX-${index}`, 'Referencia máxima']);
  const created = await imported(rows, 'PARTIAL', otherSupplierA);
  assert.equal(created.summary.created, 10000);
  const updated = await imported(
    rows.map(([code]) => [code!, 'Descripción actualizada']),
    'PARTIAL',
    otherSupplierA,
  );
  assert.equal(updated.summary.updated, 10000);
  assert.equal(
    await client.supplierCatalogItem.count({ where: { supplierId: otherSupplierA } }),
    10000,
  );
  assert.deepEqual(await counts(), before);
  // Solo las referencias de esta prueba para mantener independiente el escenario siguiente.
  await client.supplierCatalogImportRow.deleteMany({
    where: { importId: { in: [created.id, updated.id] } },
  });
  await client.supplierCatalogImport.deleteMany({
    where: { id: { in: [created.id, updated.id] } },
  });
  await client.supplierCatalogItem.deleteMany({
    where: { organizationId: orgs[0]!, supplierId: otherSupplierA },
  });
});
test('reimportar no duplica; actualizar solo referencia, conservar opcionales no mapeados y texto GTIN inválido', async () => {
  const product = await client.product.findUniqueOrThrow({ where: { id: productId } });
  const count = await client.supplierCatalogItem.count({ where: { organizationId: orgs[0] } });
  const unchanged = await imported([
    ['DL2115', 'Bota Walker corta', 'Marca', 'Unidad', '4006381333931'],
  ]);
  assert.equal(unchanged.summary.unchanged, 1);
  const updated = await imported([
    ['DL2115', 'Descripción cambiada', 'Otra marca', 'Caja', 'GTIN inválido'],
  ]);
  assert.equal(updated.summary.updated, 1);
  assert.equal(updated.summary.warnings, 1);
  const item = await client.supplierCatalogItem.findFirstOrThrow({
    where: { supplierId: supplierA, supplierCode: 'DL2115' },
  });
  assert.equal(item.version, 2);
  assert.equal(item.normalizedReportedGtin, null);
  assert.equal(item.reportedGtin, 'GTIN inválido');
  assert.equal(
    await client.supplierCatalogItem.count({ where: { organizationId: orgs[0] } }),
    count,
  );
  assert.deepEqual(await client.product.findUnique({ where: { id: productId } }), product);
  assert.equal(
    (await client.supplierProduct.findFirstOrThrow({ where: { productId } })).supplierDescription,
    'Descripción ya confirmada',
  );
  const file = await inspect('SKU,PRODUCTO\nDL2115,Otra descripción');
  const pending = await checked(
    await request(`suppliers/${supplierA}/catalog-imports/preview`, 'POST', {
      uploadId: file.uploadId,
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
    }),
    catalogImportSchema,
    201,
  );
  await commit(pending);
  assert.equal(
    (await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: item.id } })).brandText,
    'Otra marca',
  );
});
test('parcial conserva ausentes; completo marca ausencia separada de archivado; completo con errores no cambia indicadores', async () => {
  await imported(
    [
      ['A', 'Referencia A'],
      ['B', 'Referencia B'],
    ],
    'PARTIAL',
    otherSupplierA,
  );
  await imported([['A', 'Referencia A modificada']], 'PARTIAL', otherSupplierA);
  const b = await client.supplierCatalogItem.findFirstOrThrow({
    where: { supplierId: otherSupplierA, supplierCode: 'B' },
  });
  assert.equal(b.missingFromLatestCompleteListAt, null);
  const complete = await imported([['A', 'Referencia A modificada']], 'COMPLETE', otherSupplierA);
  assert.equal(complete.summary.missing, 1);
  const missing = await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: b.id } });
  assert.ok(missing.missingFromLatestCompleteListAt);
  assert.equal(missing.archivedAt, null);
  const invalid = await preview(
    csv([
      ['B', 'Referencia B'],
      ['', 'No tiene código'],
    ]),
    'COMPLETE',
    otherSupplierA,
  );
  assert.equal(invalid.summary.absencesSuppressed, true);
  await commit(invalid, true);
  assert.equal(
    (
      await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: b.id } })
    ).missingFromLatestCompleteListAt!.getTime(),
    missing.missingFromLatestCompleteListAt!.getTime(),
  );
  await imported(
    [
      ['A', 'Referencia A modificada'],
      ['B', 'Referencia B'],
    ],
    'COMPLETE',
    otherSupplierA,
  );
  assert.equal(
    (await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: b.id } }))
      .missingFromLatestCompleteListAt,
    null,
  );
});
test('conflictos y errores requieren exclusión expresa; historia distingue creadas/actualizadas/ignoradas/errores', async () => {
  const pending = await preview(
    csv([
      ['CONFLICT', 'Uno'],
      ['CONFLICT', 'Dos'],
      ['OK', 'Referencia'],
      ['OK', 'Referencia'],
      [],
      ['NO_DESC', ''],
    ]),
  );
  assert.equal(pending.summary.conflicts, 2);
  assert.equal(pending.summary.errors, 1);
  assert.equal(pending.summary.duplicates, 1);
  assert.equal(pending.summary.empty, 1);
  await error(
    await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
      previewHash: pending.previewHash,
    }),
    400,
    /excluir/,
  );
  await commit(pending, true);
  assert.equal(
    await client.supplierCatalogItem.count({
      where: { supplierId: supplierA, supplierCode: 'CONFLICT' },
    }),
    0,
  );
  const rows = await checked(
    await request(`supplier-catalog-imports/${pending.id}/rows?limit=2&page=2`),
    catalogImportRowsSchema,
  );
  assert.equal(rows.total, 6);
  assert.equal(rows.items.length, 2);
  assert.equal(rows.items[0]!.outcome, 'CREATED');
  assert.equal(rows.items[0]!.itemId, rows.items[1]!.itemId);
  const conflicts = await checked(
    await request(`supplier-catalog-imports/${pending.id}/rows?outcome=CONFLICT`),
    catalogImportRowsSchema,
  );
  assert.equal(conflicts.total, 2);
  const invalid = await preview(csv([['', 'Error']]), 'COMPLETE');
  await error(
    await request(`supplier-catalog-imports/${invalid.id}/commit`, 'POST', {
      previewHash: invalid.previewHash,
      excludeInvalidRows: true,
    }),
    400,
    /No hay referencias/,
  );
});
test('tenant: referencias/imports/filas/inspect/preview/commit ajenos dan 404; FKs impiden cruces', async () => {
  const item = await client.supplierCatalogItem.findFirstOrThrow({
    where: { supplierId: supplierA },
  });
  const confirmed = await client.supplierCatalogImport.findFirstOrThrow({
    where: { supplierId: supplierA, status: 'COMMITTED' },
  });
  for (const path of [
    `supplier-catalog-items/${item.id}`,
    `supplier-catalog-imports/${confirmed.id}`,
    `supplier-catalog-imports/${confirmed.id}/rows`,
    `suppliers/${supplierA}/catalog-items`,
  ])
    await error(await request(path, 'GET', undefined, adminB), 404);
  const list = await checked(
    await request('supplier-catalog-items', 'GET', undefined, adminB),
    supplierCatalogListSchema,
  );
  assert.equal(list.total, 0);
  const form = new FormData();
  form.set('file', new File(['A,B'], 'lista.csv', { type: 'text/csv' }));
  await error(await request(`suppliers/${supplierB}/catalog-imports/inspect`, 'POST', form), 404);
  await error(
    await request(
      `supplier-catalog-imports/${confirmed.id}/commit`,
      'POST',
      { previewHash: confirmed.previewHash },
      adminB,
    ),
    404,
  );
  await assert.rejects(
    client.supplierCatalogItem.create({
      data: {
        organizationId: orgs[1]!,
        supplierId: supplierA,
        supplierCode: 'Cross',
        description: 'Prohibido',
      },
    }),
    { code: 'P2003' },
  );
  const upload = await inspect(csv([['A', 'Desc']]));
  const original = await client.supplierCatalogUpload.findUniqueOrThrow({
    where: { id: upload.uploadId },
  });
  await assert.rejects(
    client.supplierCatalogUpload.create({
      data: {
        ...original,
        sheets: original.sheets as Prisma.InputJsonValue,
        id: randomUUID(),
        organizationId: orgs[1]!,
        supplierId: supplierB,
      },
    }),
    { code: 'P2003' },
  );
  await error(
    await request(
      `suppliers/${supplierB}/catalog-imports/preview`,
      'POST',
      { uploadId: upload.uploadId, sheet: 'CSV', headerRow: 1, mapping, mode: 'PARTIAL' },
      adminB,
    ),
    404,
  );
  const otherImport = await imported([['FOREIGN_ROW', 'Desc']], 'PARTIAL', otherSupplierA);
  await assert.rejects(
    client.supplierCatalogImportRow.create({
      data: {
        organizationId: orgs[0]!,
        supplierId: otherSupplierA,
        importId: otherImport.id,
        rowNumber: 999,
        outcome: 'UNCHANGED',
        itemId: item.id,
        messages: [],
      },
    }),
    { code: 'P2003' },
  );
  await client.supplierCatalogUpload.delete({ where: { id: upload.uploadId } });
});
test('OPERATOR consulta/busca pero no inspecciona, revisa ni confirma; application refuerza permisos', async () => {
  const form = new FormData();
  form.set('file', new File(['A,B'], 'lista.csv', { type: 'text/csv' }));
  await error(
    await request(`suppliers/${supplierA}/catalog-imports/inspect`, 'POST', form, operatorA),
    403,
  );
  await error(
    await request(`suppliers/${supplierA}/catalog-imports/preview`, 'POST', {}, operatorA),
    403,
  );
  await error(
    await request(`supplier-catalog-imports/${randomUUID()}/commit`, 'POST', {}, operatorA),
    403,
  );
  await assert.rejects(
    app.get(SupplierCatalogService).inspect(operatorA, supplierA, {
      buffer: Buffer.from('A,B'),
      originalname: 'lista.csv',
      mimetype: 'text/csv',
    }),
    /administrador/,
  );
  const list = await checked(
    await request('supplier-catalog-items?q=Proveedor%20Walker', 'GET', undefined, operatorA),
    supplierCatalogListSchema,
  );
  assert.ok(list.total > 0);
});
test('preview exacto: hash incorrecto, cuerpo alterado, datos obsoletos, expiración y sesión ajena rechazados', async () => {
  const pending = await preview(csv([['STALE', 'Referencia vieja']]));
  await error(
    await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
      previewHash: 'f'.repeat(64),
    }),
    409,
    /vista previa/,
  );
  await error(
    await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
      previewHash: pending.previewHash,
      organizationId: orgs[1],
    }),
    400,
  );
  await imported([['INTERVENING', 'Otra importación']]);
  await error(
    await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
      previewHash: pending.previewHash,
    }),
    409,
    /catálogo cambió/,
  );
  await client.supplierCatalogImport.update({
    where: { id: pending.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await error(
    await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
      previewHash: pending.previewHash,
    }),
    404,
  );
  await app.get(SupplierCatalogService).cleanup(adminA);
  assert.equal(await client.supplierCatalogImport.count({ where: { id: pending.id } }), 0);
});
test('concurrencia: dos imports mismo código tienen un ganador; doble confirmación idempotente y un evento', async () => {
  const file = await inspect(csv([['RACE', 'Primera referencia']]));
  const input: CatalogPreviewInput = {
    uploadId: file.uploadId,
    sheet: 'CSV',
    headerRow: 1,
    mapping,
    mode: 'PARTIAL',
  };
  const [first, second] = await Promise.all([
    checked(
      await request(`suppliers/${supplierA}/catalog-imports/preview`, 'POST', input),
      catalogImportSchema,
      201,
    ),
    checked(
      await request(`suppliers/${supplierA}/catalog-imports/preview`, 'POST', input),
      catalogImportSchema,
      201,
    ),
  ]);
  const responses = await Promise.all(
    [first, second].map((value) =>
      request(`supplier-catalog-imports/${value.id}/commit`, 'POST', {
        previewHash: value.previewHash,
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  for (const response of responses) {
    if (response.ok) catalogImportSchema.parse(await response.json());
    else apiErrorSchema.parse(await response.json());
  }
  assert.equal(
    await client.supplierCatalogItem.count({
      where: { supplierId: supplierA, supplierCode: 'RACE' },
    }),
    1,
  );
  const same = await preview(csv([['IDEMPOTENT', 'Referencia']]));
  const repeats = await Promise.all(
    [1, 2].map(() =>
      request(`supplier-catalog-imports/${same.id}/commit`, 'POST', {
        previewHash: same.previewHash,
      }),
    ),
  );
  for (const response of repeats) await checked(response, catalogImportSchema);
  assert.equal(
    await client.auditEvent.count({
      where: { resourceId: same.id, action: 'SUPPLIER_CATALOG_IMPORTED' },
    }),
    1,
  );
  const archived = await client.supplierCatalogItem.findFirstOrThrow({
    where: { supplierId: supplierA, supplierCode: 'RACE' },
  });
  await client.supplierCatalogItem.update({
    where: { id: archived.id },
    data: { archivedAt: new Date(), version: { increment: 1 } },
  });
  await assert.rejects(
    client.supplierCatalogItem.create({
      data: {
        organizationId: orgs[0]!,
        supplierId: supplierA,
        supplierCode: 'RACE',
        description: 'Reuso prohibido',
      },
    }),
    { code: 'P2002' },
  );
  assert.equal((await preview(csv([['RACE', 'Otro']]))).summary.conflicts, 1);
});
test('fallo de auditoría revierte todas las referencias, ausencia, filas y estado confirmado', async () => {
  const pending = await preview(
    csv([['ROLLBACK', 'Referencia que no debe persistir']]),
    'COMPLETE',
    otherSupplierA,
  );
  const before = await client.supplierCatalogItem.findMany({
    where: { supplierId: otherSupplierA },
    orderBy: { id: 'asc' },
  });
  const audit = app.get(AuditService);
  const original = audit.append;
  audit.append = () => {
    throw new Error('Injected audit failure');
  };
  try {
    await error(
      await request(`supplier-catalog-imports/${pending.id}/commit`, 'POST', {
        previewHash: pending.previewHash,
      }),
      500,
    );
  } finally {
    audit.append = original;
  }
  assert.deepEqual(
    await client.supplierCatalogItem.findMany({
      where: { supplierId: otherSupplierA },
      orderBy: { id: 'asc' },
    }),
    before,
  );
  assert.equal(
    (await client.supplierCatalogImport.findUniqueOrThrow({ where: { id: pending.id } })).status,
    'PREVIEW',
  );
  assert.equal(
    await client.supplierCatalogImportRow.count({
      where: { importId: pending.id, itemId: { not: null } },
    }),
    0,
  );
  assert.equal(await client.auditEvent.count({ where: { resourceId: pending.id } }), 0);
});
test('XLSX real varias hojas y hoja elegida; historial/búsqueda por marca/GTIN y límites HTTP', async () => {
  const file = await inspect(
    xlsxFixture([
      {
        name: 'No elegida',
        rows: [
          ['SKU', 'PRODUCTO'],
          ['NO_IMPORTAR', 'Otra'],
        ],
      },
      {
        name: 'Lista',
        rows: [
          ['SKU', 'PRODUCTO', 'MARCA', 'GTIN'],
          ['000X', 'Referencia Excel', 'MarcaExcel', '4006381333931'],
        ],
      },
    ]),
    otherSupplierA,
    'lista.xlsx',
  );
  assert.equal(file.sheets.length, 2);
  const pending = await checked(
    await request(`suppliers/${otherSupplierA}/catalog-imports/preview`, 'POST', {
      uploadId: file.uploadId,
      sheet: 'Lista',
      headerRow: 1,
      mapping: {
        supplierCode: 0,
        description: 1,
        brandText: 2,
        presentationText: null,
        reportedGtin: 3,
      },
      mode: 'PARTIAL',
    }),
    catalogImportSchema,
    201,
  );
  await commit(pending);
  assert.equal(
    await client.supplierCatalogItem.count({
      where: { supplierId: otherSupplierA, supplierCode: 'NO_IMPORTAR' },
    }),
    0,
  );
  for (const q of ['000X', 'Excel', 'MarcaExcel', '4006381333931'])
    assert.ok(
      (await checked(await request('supplier-catalog-items?q=' + q), supplierCatalogListSchema))
        .total > 0,
    );
  const history = await checked(
    await request(`suppliers/${otherSupplierA}/catalog-imports?limit=2&page=1`),
    catalogImportListSchema,
  );
  assert.equal(history.items.length, 2);
  assert.ok(history.items.every((item) => item.status === 'COMMITTED'));
  for (const path of [
    'supplier-catalog-items?limit=101',
    'supplier-catalog-items?organizationId=' + orgs[1],
    `supplier-catalog-imports/${pending.id}/rows?limit=101`,
  ])
    await error(await request(path), 400);
  const tooLarge = new FormData();
  tooLarge.set(
    'file',
    new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.csv', { type: 'text/csv' }),
  );
  await error(
    await request(`suppliers/${supplierA}/catalog-imports/inspect`, 'POST', tooLarge),
    413,
    /10 MiB/,
  );
  const extra = new FormData();
  extra.set('file', new File(['A,B'], 'lista.csv', { type: 'text/csv' }));
  extra.set('organizationId', orgs[1]!);
  await error(await request(`suppliers/${supplierA}/catalog-imports/inspect`, 'POST', extra), 400);
});

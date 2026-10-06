import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  scanResultSchema,
  identificationConfirmationSchema,
  supplierCatalogItemSchema,
  supplierCatalogListSchema,
  supplierScanIdentifierListSchema,
  catalogInspectionSchema,
  catalogImportSchema,
  type IdentificationConfirm,
  type ProductView,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdentificationService } from '../src/modules/catalog/application/identification.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const { AppModule } = await import('../src/app.module.js');
const client = createDatabaseClient(process.env.DATABASE_URL!);
const orgs: string[] = [],
  users: string[] = [];
const contexts: RequestActorContext[] = [];
const cookies = new Map<string, string>();
let app: INestApplication, base: string;
let supplierA: string, supplierB: string, foreignSupplier: string;
const gtin = '4006381333931';
const canonical = '04006381333931';
async function request(path: string, method = 'GET', body?: unknown, actor = contexts[0]!) {
  return fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      Cookie: cookies.get(actor.sessionId)!,
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: body instanceof FormData ? body : JSON.stringify(body) }),
  });
}
async function checked(response: Response, status = 200) {
  const data: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}
async function product(name = 'Producto manual', org = orgs[0]!) {
  return client.product.create({ data: { organizationId: org, name, unitOfMeasure: 'UNIT' } });
}
async function reference(
  code: string = randomUUID(),
  supplierId = supplierA,
  org = orgs[0]!,
  normalizedReportedGtin?: string,
) {
  return client.supplierCatalogItem.create({
    data: {
      organizationId: org,
      supplierId,
      supplierCode: code,
      description: 'Bota Walker corta',
      brandText: 'Marca externa',
      presentationText: 'Caja Walker',
      ...(normalizedReportedGtin ? { reportedGtin: gtin, normalizedReportedGtin } : {}),
    },
  });
}
function command(
  ref: { id: string; version: number },
  value: string,
  target?: { id: string; version: number },
): IdentificationConfirm {
  return {
    operationId: randomUUID(),
    scan: { value, namespace: 'AUTO' },
    referenceId: ref.id,
    expectedReferenceVersion: ref.version,
    target: target
      ? { mode: 'EXISTING', productId: target.id, expectedProductVersion: target.version }
      : {
          mode: 'NEW',
          product: { name: 'Walker identificada', unitOfMeasure: 'PAIR', presentation: 'Caja' },
        },
  };
}
async function confirm(input: IdentificationConfirm) {
  return identificationConfirmationSchema.parse(
    await checked(await request('catalog-identifications/confirm', 'POST', input)),
  );
}
async function resolve(value: string, extra: object = {}, actor = contexts[0]!) {
  return scanResultSchema.parse(
    await checked(await request('catalog-scans/resolve', 'POST', { value, ...extra }, actor)),
  );
}
async function counts() {
  const where = { organizationId: orgs[0]! };
  return Promise.all([
    client.product.count({ where }),
    client.productIdentifier.count({ where }),
    client.supplierProduct.count({ where }),
    client.supplierScanIdentifier.count({ where }),
    client.catalogIdentification.count({ where }),
    client.auditEvent.count({
      where: {
        ...where,
        action: {
          in: [
            'CATALOG_REFERENCE_ASSOCIATED',
            'PRODUCT_CREATED_FROM_IDENTIFICATION',
            'PRODUCT_IDENTIFIER_ADDED_FROM_IDENTIFICATION',
          ],
        },
      },
    }),
  ]);
}
before(async () => {
  for (const label of ['a', 'b'])
    orgs.push(
      (
        await client.organization.create({
          data: { name: `Identification ${label}`, slug: `identification-${randomUUID()}` },
        })
      ).id,
    );
  for (const [index, role] of [
    [0, 'OPERATOR'],
    [0, 'ADMIN'],
    [1, 'OPERATOR'],
  ] as const) {
    const user = await client.user.create({
      data: { email: `${randomUUID()}@example.invalid`, displayName: `Identification ${role}` },
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
      sessionId: session.id,
      role,
      requestId: randomUUID(),
    });
  }
  supplierA = (
    await client.supplier.create({ data: { organizationId: orgs[0]!, name: 'Proveedor Walker' } })
  ).id;
  supplierB = (
    await client.supplier.create({ data: { organizationId: orgs[0]!, name: 'Otro proveedor' } })
  ).id;
  foreignSupplier = (
    await client.supplier.create({ data: { organizationId: orgs[1]!, name: 'Privado' } })
  ).id;
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
  const where = { organizationId: { in: orgs } };
  await client.catalogIdentification.deleteMany({ where });
  await client.supplierScanIdentifier.deleteMany({ where });
  await client.supplierCatalogImportRow.deleteMany({ where });
  await client.supplierCatalogImport.deleteMany({ where });
  await client.supplierCatalogUpload.deleteMany({ where });
  await client.supplierCatalogItem.deleteMany({ where });
  await client.auditEvent.deleteMany({ where: { OR: [where, { actorUserId: { in: users } }] } });
  await client.supplierProduct.deleteMany({ where });
  await client.productIdentifier.deleteMany({ where });
  await client.product.deleteMany({ where });
  await client.brand.deleteMany({ where });
  await client.category.deleteMany({ where });
  await client.supplier.deleteMany({ where });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.membership.deleteMany({ where });
  await client.user.deleteMany({ where: { id: { in: users } } });
  await client.organization.deleteMany({ where: { id: { in: orgs } } });
  await client.$disconnect();
});

test('resolve UNKNOWN/INVALID/UNSUPPORTED no escribe negocio ni auditoría ni stock', async () => {
  const initial = await counts();
  assert.equal((await resolve(gtin)).status, 'UNKNOWN');
  assert.equal((await resolve('4006381333932')).status, 'INVALID');
  assert.equal((await resolve('(01)04006381333931(10)LOT')).status, 'UNSUPPORTED');
  assert.deepEqual(await counts(), initial);
  const tables = await client.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~* '^(Stock|Inventory|Lot|SerialNumber|Reservation)'`;
  assert.deepEqual(tables, []);
});
test('reportedGtin es candidato fuerte; búsqueda manual incluye presentación, marca, proveedor y código', async () => {
  const ref = await reference('DL2115', supplierA, orgs[0], canonical);
  const result = await resolve(gtin);
  assert.equal(result.status, 'CANDIDATES');
  if (result.status === 'CANDIDATES') assert.equal(result.candidates[0]?.id, ref.id);
  for (const q of [
    'DL2115',
    'Walker corta',
    'Marca externa',
    'Caja Walker',
    'Proveedor Walker',
    gtin,
  ]) {
    const list = supplierCatalogListSchema.parse(
      await checked(await request('supplier-catalog-items?q=' + encodeURIComponent(q))),
    );
    assert.ok(list.items.some((item) => item.id === ref.id));
  }
});
let knownProduct: ProductView;
test('OPERATOR asocia Product manual sin duplicarlo; FK/lista asociados; futuros scans KNOWN', async () => {
  const p = await product();
  const ref = await reference();
  const initial = await counts();
  const result = await confirm(command(ref, gtin, p));
  knownProduct = result.product;
  assert.equal(result.product.id, p.id);
  assert.equal((await counts())[0], initial[0]);
  const item = supplierCatalogItemSchema.parse(
    await checked(await request('supplier-catalog-items/' + ref.id)),
  );
  assert.equal(item.associationStatus, 'ASSOCIATED');
  assert.equal(item.supplierProduct?.product.id, p.id);
  const filtered = supplierCatalogListSchema.parse(
    await checked(await request(`suppliers/${supplierA}/catalog-items?association=ASSOCIATED`)),
  );
  assert.ok(filtered.items.some((row) => row.id === ref.id));
  const result2 = await resolve(canonical);
  assert.equal(result2.status, 'KNOWN');
  if (result2.status === 'KNOWN') assert.equal(result2.product.id, p.id);
  const audits = await client.auditEvent.findMany({
    where: { organizationId: orgs[0], action: { contains: 'IDENTIFICATION' } },
  });
  assert.ok(audits.some((row) => row.action === 'PRODUCT_IDENTIFIER_ADDED_FROM_IDENTIFICATION'));
  assert.ok(audits.every((row) => !JSON.stringify(row.metadata).includes(gtin)));
});
test('dos proveedores ofrecen mismo Product; reutiliza SupplierProduct sin cambiar código principal', async () => {
  const existing = await client.supplierProduct.findUniqueOrThrow({
    where: {
      organizationId_supplierId_productId: {
        organizationId: orgs[0]!,
        supplierId: supplierA,
        productId: knownProduct.id,
      },
    },
  });
  const ref = await reference('CODIGO-SECUNDARIO');
  const result = await confirm(command(ref, '96385074', knownProduct));
  assert.equal(result.supplierProductId, existing.id);
  const preserved = await client.supplierProduct.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(preserved.supplierCode, existing.supplierCode);
  const other = await reference(undefined, supplierB);
  const current = await client.product.findUniqueOrThrow({ where: { id: knownProduct.id } });
  const result2 = await confirm(command(other, '012345678905', current));
  assert.equal(result2.product.id, knownProduct.id);
  assert.notEqual(result2.supplierProductId, existing.id);
  assert.equal(
    await client.supplierProduct.count({
      where: { organizationId: orgs[0], productId: knownProduct.id },
    }),
    2,
  );
});
test('Product nuevo con unidad elegida; double submit simultáneo y retry no repiten cambios/auditoría', async () => {
  const ref = await reference();
  const input = command(ref, '5901234123457');
  const initial = await counts();
  const results = await Promise.all([confirm(input), confirm(input)]);
  assert.equal(results[0]!.product.id, results[1]!.product.id);
  assert.equal(results[0]!.confirmationId, results[1]!.confirmationId);
  assert.ok(results.some((row) => row.replayed));
  assert.equal(results[0]!.product.unitOfMeasure, 'PAIR');
  const afterCreate = await counts();
  assert.deepEqual(
    afterCreate.map((n, i) => n - initial[i]!),
    [1, 1, 1, 0, 1, 3],
  );
  assert.equal((await confirm(input)).replayed, true);
  assert.deepEqual(await counts(), afterCreate);
  await checked(
    await request('catalog-identifications/confirm', 'POST', {
      ...input,
      scan: { ...input.scan, value: '12345670' },
    }),
    409,
  );
  await checked(await request('catalog-identifications/confirm', 'POST', input, contexts[1]), 409);
});
test('referencia ya asociada agrega identificador a P y nunca se reasigna ni crea duplicado', async () => {
  const ref = await client.supplierCatalogItem.findFirstOrThrow({
    where: { organizationId: orgs[0], supplierProduct: { productId: knownProduct.id } },
  });
  const p = await client.product.findUniqueOrThrow({ where: { id: knownProduct.id } });
  const result = await confirm(command(ref, '12345670', p));
  assert.equal(result.product.id, knownProduct.id);
  const wrong = await product('Otro producto');
  await checked(
    await request('catalog-identifications/confirm', 'POST', command(ref, '12345670', wrong)),
    409,
  );
  const initial = await counts();
  await checked(
    await request('catalog-identifications/confirm', 'POST', command(ref, '12345670')),
    409,
  );
  assert.deepEqual(await counts(), initial);
});
test('archivados reservan identificador/producto y no permiten reutilización', async () => {
  const ref = await reference();
  const created = await confirm(command(ref, '5012345678900'));
  await client.productIdentifier.updateMany({
    where: { organizationId: orgs[0], productId: created.product.id },
    data: { archivedAt: new Date() },
  });
  assert.equal((await resolve('5012345678900')).status, 'ARCHIVED');
  const initial = await counts();
  await checked(
    await request(
      'catalog-identifications/confirm',
      'POST',
      command(await reference(), '5012345678900'),
    ),
    409,
  );
  assert.deepEqual(await counts(), initial);
  await client.product.update({ where: { id: knownProduct.id }, data: { archivedAt: new Date() } });
  assert.equal((await resolve(gtin)).status, 'ARCHIVED');
  await client.product.update({ where: { id: knownProduct.id }, data: { archivedAt: null } });
});
test('externos exigen proveedor, se reservan por namespace; internos conservan semántica', async () => {
  assert.equal((await resolve('EXT-WALKER')).status, 'UNKNOWN');
  const ref = await reference();
  const input = command(ref, 'EXT-WALKER');
  await checked(await request('catalog-identifications/confirm', 'POST', input), 400);
  input.scan.supplierId = supplierA;
  const result = await confirm(input);
  const visible = supplierScanIdentifierListSchema.parse(
    await checked(await request(`products/${result.product.id}/supplier-scan-identifiers`)),
  );
  assert.equal(visible.items[0]?.value, 'EXT-WALKER');
  assert.equal(visible.items[0]?.supplierId, supplierA);
  await checked(
    await request(
      `products/${result.product.id}/supplier-scan-identifiers`,
      'GET',
      undefined,
      contexts[2],
    ),
    404,
  );
  assert.equal((await resolve('EXT-WALKER', { supplierId: supplierA })).status, 'KNOWN');
  assert.equal((await resolve('EXT-WALKER')).status, 'AMBIGUOUS');
  assert.equal((await resolve('EXT-WALKER', { supplierId: supplierB })).status, 'UNKNOWN');
  const other = command(await reference(undefined, supplierB), 'EXT-WALKER');
  other.scan.supplierId = supplierB;
  const otherResult = await confirm(other);
  assert.notEqual(otherResult.product.id, result.product.id);
  const mb = await confirm(command(await reference(), 'MB-WALKER'));
  assert.equal((await resolve('MB-WALKER')).status, 'KNOWN');
  const internal = command(await reference(), 'OWN-CODE');
  internal.scan.namespace = 'INTERNAL_CODE';
  await confirm(internal);
  assert.equal((await resolve('OWN-CODE', { namespace: 'INTERNAL_CODE' })).status, 'KNOWN');
  assert.equal((await resolve('OWN-CODE')).status, 'UNKNOWN');
  assert.notEqual(mb.product.id, result.product.id);
});
test('OPERATOR mantiene prohibiciones generales ADMIN y contratos rechazan autoridad/stock', async () => {
  for (const [path, body] of [
    ['products', { name: 'X', unitOfMeasure: 'UNIT' }],
    ['suppliers', { name: 'X' }],
    ['brands', { name: 'X' }],
    ['categories', { name: 'X' }],
    [`products/${knownProduct.id}/archive`, { expectedVersion: 1 }],
    [
      `products/${knownProduct.id}/identifiers`,
      { kind: 'INTERNAL_CODE', value: 'X', expectedVersion: 1 },
    ],
    [`suppliers/${supplierA}/catalog-imports/preview`, {}],
  ] as const)
    await checked(await request(path, 'POST', body), 403);
  await checked(
    await request('catalog-scans/resolve', 'POST', { value: gtin, organizationId: orgs[1] }),
    400,
  );
  await checked(
    await request('catalog-identifications/confirm', 'POST', {
      ...command(await reference(), 'MB-STOCK'),
      quantity: 1,
    }),
    400,
  );
});
test('tenant isolation en resolve, confirm, clasificación y FKs PostgreSQL reales', async () => {
  assert.equal((await resolve(gtin, {}, contexts[2])).status, 'UNKNOWN');
  await checked(
    await request('catalog-scans/resolve', 'POST', { value: 'EXT', supplierId: foreignSupplier }),
    404,
  );
  const foreignRef = await reference(undefined, foreignSupplier, orgs[1]);
  const foreignProduct = await product('Privado', orgs[1]);
  await checked(
    await request('catalog-identifications/confirm', 'POST', command(foreignRef, 'MB-CROSS')),
    404,
  );
  await checked(
    await request(
      'catalog-identifications/confirm',
      'POST',
      command(await reference(), 'MB-CROSS', foreignProduct),
    ),
    404,
  );
  const foreignBrand = await client.brand.create({
    data: { organizationId: orgs[1]!, name: 'Privada', normalizedName: 'privada' },
  });
  const bad = command(await reference(), 'MB-CROSS-BRAND');
  if (bad.target.mode === 'NEW') bad.target.product.brandId = foreignBrand.id;
  const initial = await counts();
  await checked(await request('catalog-identifications/confirm', 'POST', bad), 404);
  assert.deepEqual(await counts(), initial);
  const foreignLink = await client.supplierProduct.create({
    data: { organizationId: orgs[1]!, supplierId: foreignSupplier, productId: foreignProduct.id },
  });
  const localRef = await reference();
  await assert.rejects(
    client.supplierCatalogItem.update({
      where: { id: localRef.id },
      data: { supplierProductId: foreignLink.id },
    }),
  );
  const sameOrgWrongSupplier = await client.supplierProduct.create({
    data: { organizationId: orgs[0]!, supplierId: supplierB, productId: (await product()).id },
  });
  await assert.rejects(
    client.supplierCatalogItem.update({
      where: { id: localRef.id },
      data: { supplierProductId: sameOrgWrongSupplier.id },
    }),
  );
  await assert.rejects(
    client.supplierScanIdentifier.create({
      data: {
        organizationId: orgs[0]!,
        supplierId: supplierB,
        supplierProductId: sameOrgWrongSupplier.id,
        value: '4006381333932',
        normalizedValue: '4006381333932',
      },
    }),
  );
});
test('carrera mismo identificador/dos Products: un ganador, 409 y rollback completo', async () => {
  const r1 = await reference(),
    r2 = await reference();
  const initial = await counts();
  const responses = await Promise.all([
    request('catalog-identifications/confirm', 'POST', command(r1, '7612345678900')),
    request('catalog-identifications/confirm', 'POST', command(r2, '7612345678900')),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(
    (await counts()).map((n, i) => n - initial[i]!),
    [1, 1, 1, 0, 1, 3],
  );
  assert.equal(
    await client.supplierCatalogItem.count({
      where: { id: { in: [r1.id, r2.id] }, supplierProductId: { not: null } },
    }),
    1,
  );
});
test('carrera misma referencia/dos empleados: una confirmación y otro 409', async () => {
  const ref = await reference();
  const initial = await counts();
  const responses = await Promise.all([
    request('catalog-identifications/confirm', 'POST', command(ref, 'MB-RACE-A')),
    request('catalog-identifications/confirm', 'POST', command(ref, 'MB-RACE-B'), contexts[1]),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.deepEqual(
    (await counts()).map((n, i) => n - initial[i]!),
    [1, 1, 1, 0, 1, 3],
  );
});
test('fallo de auditoría provoca rollback de Product, identifier, link, referencia y recibo', async () => {
  const audit = app.get(AuditService),
    original = audit.success;
  const ref = await reference();
  const initial = await counts();
  let calls = 0;
  audit.success = (...args) => {
    if (++calls === 3) throw new Error('Injected audit failure');
    return original.apply(audit, args);
  };
  try {
    await assert.rejects(
      app.get(IdentificationService).confirm(contexts[0]!, command(ref, 'MB-ROLLBACK')),
      /Injected audit/,
    );
  } finally {
    audit.success = original;
  }
  assert.deepEqual(await counts(), initial);
  assert.equal(
    (await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: ref.id } }))
      .supplierProductId,
    null,
  );
});
test('revalidación de membresía/sesión y optimistic concurrency del workflow', async () => {
  const ref = await reference();
  const p = await product();
  const input = command(ref, 'MB-VERSION', p);
  await client.product.update({ where: { id: p.id }, data: { version: { increment: 1 } } });
  await checked(await request('catalog-identifications/confirm', 'POST', input), 409);
  await assert.rejects(
    app
      .get(IdentificationService)
      .confirm({ ...contexts[0]!, sessionId: randomUUID() }, command(ref, 'MB-NO-SESSION')),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'status' in error && error.status === 403,
  );
  await client.supplierCatalogItem.update({
    where: { id: ref.id },
    data: { version: { increment: 1 } },
  });
  await checked(
    await request('catalog-identifications/confirm', 'POST', command(ref, 'MB-REF-VERSION')),
    409,
  );
});
test('importar y reimportar conserva vínculo explícito y nunca crea Product', async () => {
  const content = 'CODIGO,DESCRIPCION\nREIMPORT,Walker\n';
  async function imported(description: string) {
    const form = new FormData();
    form.set('file', new File([content.replace('Walker', description)], 'list.csv'));
    const inspection = catalogInspectionSchema.parse(
      await checked(
        await request(`suppliers/${supplierB}/catalog-imports/inspect`, 'POST', form, contexts[1]),
      ),
    );
    const preview = catalogImportSchema.parse(
      await checked(
        await request(
          `suppliers/${supplierB}/catalog-imports/preview`,
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
          contexts[1],
        ),
        201,
      ),
    );
    await checked(
      await request(
        `supplier-catalog-imports/${preview.id}/commit`,
        'POST',
        { previewHash: preview.previewHash },
        contexts[1],
      ),
    );
  }
  const initial = await client.product.count({ where: { organizationId: orgs[0] } });
  await imported('Walker');
  assert.equal(await client.product.count({ where: { organizationId: orgs[0] } }), initial);
  const ref = await client.supplierCatalogItem.findFirstOrThrow({
    where: { organizationId: orgs[0], supplierId: supplierB, supplierCode: 'REIMPORT' },
  });
  const linked = await confirm(command(ref, 'MB-REIMPORT'));
  await imported('Walker actualizada');
  const updated = await client.supplierCatalogItem.findUniqueOrThrow({ where: { id: ref.id } });
  assert.equal(updated.supplierProductId, linked.supplierProductId);
  assert.equal(updated.description, 'Walker actualizada');
  assert.equal(await client.product.count({ where: { organizationId: orgs[0] } }), initial + 1);
});

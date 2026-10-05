import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  productSchema,
  supplierSchema,
  namedEntitySchema,
  productListSchema,
  supplierListSchema,
  namedListSchema,
  identifierListSchema,
  supplierProductListSchema,
  identifierMutationResultSchema,
  supplierProductMutationResultSchema,
  apiErrorSchema,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { CatalogService } from '../src/modules/catalog/application/catalog.service.js';
import { hashPassword } from '../src/modules/identity/password.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const { AppModule } = await import('../src/app.module.js');
const client = createDatabaseClient(process.env.DATABASE_URL!);
const suffix = randomUUID();
const orgs: string[] = [];
const users: string[] = [];
const password = 'Frase segura solo para fixtures de catalogo';
let app: INestApplication;
let base: string;
let a: string;
let b: string;
let adminA: string;
let adminB: string;
let operatorA: string;
let userA: string;
let brandA: string;
let brandB: string;
let categoryA: string;
let categoryB: string;
let productA: string;
let productB: string;
let supplierA: string;
let supplierB: string;
const requestIds: string[] = [];
async function request(
  path: string,
  cookie = adminA,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  requestIds.push(response.headers.get('x-request-id')!);
  return response;
}
// El helper valida el contrato real antes de ofrecer la forma usada por los fixtures.
interface TestResponse {
  id: string;
  name: string;
  version: number;
  archivedAt: string | null;
  kind: string;
  normalizedValue: string;
  supplierCode: string | null;
  total: number;
  items: TestResponse[];
  product: TestResponse;
  supplier: TestResponse;
  link: TestResponse;
  identifier: TestResponse;
}
async function json(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = adminA,
  status = method === 'POST' ? 201 : 200,
): Promise<TestResponse> {
  const response = await request(path, cookie, method, body);
  const data: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  const route = path.split('?')[0]!;
  const schema =
    route.includes('/identifiers/') || (route.endsWith('/identifiers') && method === 'POST')
      ? identifierMutationResultSchema
      : route.startsWith('supplier-products/') ||
          (route.endsWith('/supplier-products') && method === 'POST')
        ? supplierProductMutationResultSchema
        : route.endsWith('/supplier-products')
          ? supplierProductListSchema
          : route.endsWith('/identifiers')
            ? identifierListSchema
            : route === 'products' && method === 'GET'
              ? productListSchema
              : route === 'suppliers' && method === 'GET'
                ? supplierListSchema
                : (route === 'brands' || route === 'categories') && method === 'GET'
                  ? namedListSchema
                  : route.startsWith('brands') || route.startsWith('categories')
                    ? namedEntitySchema
                    : route.startsWith('suppliers')
                      ? supplierSchema
                      : productSchema;
  return schema.parse(data) as unknown as TestResponse;
}
const productInput = (name: string) => ({ name, unitOfMeasure: 'UNIT' });
async function version(id = productA) {
  return (await json(`products/${id}`)).version as number;
}

before(async () => {
  const hash = await hashPassword(password);
  a = (
    await client.organization.create({
      data: { name: 'Catálogo fixture A', slug: `cat-a-${suffix}` },
    })
  ).id;
  b = (
    await client.organization.create({
      data: { name: 'Catálogo fixture B', slug: `cat-b-${suffix}` },
    })
  ).id;
  orgs.push(a, b);
  const actors: string[] = [];
  for (const [name, organizationId, role] of [
    ['admin-a', a, 'ADMIN'],
    ['admin-b', b, 'ADMIN'],
    ['operator-a', a, 'OPERATOR'],
  ] as const) {
    const user = await client.user.create({
      data: { email: `${name}-${suffix}@example.invalid`, displayName: name, passwordHash: hash },
    });
    users.push(user.id);
    if (name === 'admin-a') userA = user.id;
    await client.membership.create({ data: { organizationId, userId: user.id, role } });
    actors.push(user.email);
  }
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
  const cookies: string[] = [];
  for (const email of actors) {
    const response = await request('auth/login', '', 'POST', { email, password });
    assert.equal(response.status, 200);
    cookies.push(response.headers.getSetCookie().at(-1)!.split(';')[0]!);
  }
  [adminA, adminB, operatorA] = cookies as [string, string, string];
  brandA = (await json('brands', 'POST', { name: 'Marca Médica' })).id;
  brandB = (await json('brands', 'POST', { name: 'Marca Médica' }, adminB)).id;
  categoryA = (await json('categories', 'POST', { name: 'Ortopedia' })).id;
  categoryB = (await json('categories', 'POST', { name: 'Ortopedia' }, adminB)).id;
  productA = (
    await json('products', 'POST', {
      ...productInput('Cánula fixture'),
      presentation: 'Caja x 100 unidades',
      manufacturerName: 'Fábrica Fixture',
      brandId: brandA,
      categoryId: categoryA,
      identifiers: [
        { kind: 'INTERNAL_CODE', value: '00a/B' },
        { kind: 'GTIN', value: '4006381333931' },
      ],
    })
  ).id;
  productB = (
    await json(
      'products',
      'POST',
      {
        ...productInput('Producto privado B'),
        identifiers: [{ kind: 'GTIN', value: '4006381333931' }],
      },
      adminB,
    )
  ).id;
  supplierA = (
    await json('suppliers', 'POST', {
      name: 'Proveedor fixture A',
      email: 'proveedor@example.invalid',
    })
  ).id;
  supplierB = (await json('suppliers', 'POST', { name: 'Proveedor privado B' }, adminB)).id;
});
after(async () => {
  await app?.close();
  // Eliminación únicamente de fixtures identificados por UUID propios de esta ejecución.
  await client.auditEvent.deleteMany({
    where: {
      OR: [
        { organizationId: { in: orgs } },
        { actorUserId: { in: users } },
        { requestId: { in: requestIds } },
      ],
    },
  });
  await client.supplierProduct.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.productIdentifier.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.product.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.supplier.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.brand.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.category.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.membership.deleteMany({ where: { organizationId: { in: orgs } } });
  await client.user.deleteMany({ where: { id: { in: users } } });
  await client.organization.deleteMany({ where: { id: { in: orgs } } });
  await client.$disconnect();
});

test('producto real cumple contrato, códigos visibles y unidad/presentación independientes', async () => {
  const data = productSchema.parse(await json(`products/${productA}`));
  assert.equal(data.unitOfMeasure, 'UNIT');
  assert.equal(data.presentation, 'Caja x 100 unidades');
  assert.deepEqual(data.internalCodes, ['00a/B']);
  assert.equal(data.brand?.id, brandA);
  assert.equal(data.category?.id, categoryA);
  assert.equal(data.version, 1);
  assert.doesNotMatch(JSON.stringify(data), /organizationId|passwordHash|tokenHash/);
});
test('actualización con versión vieja devuelve 409 y conserva la edición de B', async () => {
  const initial = await version();
  const changed = await json(`products/${productA}`, 'PATCH', {
    name: 'Cánula editada por B',
    expectedVersion: initial,
  });
  assert.equal(changed.version, initial + 1);
  const stale = await request(`products/${productA}`, adminA, 'PATCH', {
    name: 'Edición vieja de A',
    expectedVersion: initial,
  });
  assert.equal(stale.status, 409);
  assert.match(apiErrorSchema.parse(await stale.json()).message, /modificado por otra persona/);
  assert.equal((await json(`products/${productA}`)).name, 'Cánula editada por B');
});
test('dos ediciones simultáneas con la misma versión tienen un único ganador', async () => {
  const expectedVersion = await version();
  const responses = await Promise.all(
    ['Primero', 'Segundo'].map((name) =>
      request(`products/${productA}`, adminA, 'PATCH', { name: `Cánula ${name}`, expectedVersion }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal(await version(), expectedVersion + 1);
});
test('aislamiento de producto, listados, búsqueda, relaciones y headers falsos', async () => {
  assert.equal((await request(`products/${productA}`, adminB)).status, 404);
  assert.equal((await request(`products/${productB}`, adminA)).status, 404);
  assert.equal((await json('products?q=Cánula', 'GET', undefined, adminB)).total, 0);
  const response = await request(`products/${productA}`, adminA, 'GET', undefined, {
    'x-organization-id': b,
    'x-user-id': users[1]!,
  });
  assert.equal(response.status, 200);
  assert.equal((await request(`products/${productA}/identifiers`, adminB)).status, 404);
  assert.equal((await request(`products/${productA}/supplier-products`, adminB)).status, 404);
});
test('Brand y Category ajenas se rechazan en API y por FK compuesta en PostgreSQL', async () => {
  for (const relation of [{ brandId: brandB }, { categoryId: categoryB }]) {
    assert.equal(
      (
        await request('products', adminA, 'POST', {
          ...productInput('No debe crearse'),
          ...relation,
        })
      ).status,
      404,
    );
    await assert.rejects(
      client.product.create({
        data: { name: 'FK rechazada', unitOfMeasure: 'UNIT', organizationId: a, ...relation },
      }),
    );
    assert.equal(
      (
        await request(`products/${productA}`, adminA, 'PATCH', {
          ...relation,
          expectedVersion: await version(),
        })
      ).status,
      404,
    );
  }
});
test('OPERATOR consulta pero no puede mutar ninguna entidad del catálogo', async () => {
  assert.equal((await request('products', operatorA)).status, 200);
  assert.equal((await request('suppliers', operatorA)).status, 200);
  for (const path of [
    'products',
    'suppliers',
    'brands',
    'categories',
    `products/${productA}/identifiers`,
    `products/${productA}/supplier-products`,
  ])
    assert.equal((await request(path, operatorA, 'POST', {})).status, 403);
  assert.equal(
    (
      await request(`products/${productA}`, operatorA, 'PATCH', {
        name: 'Prohibido',
        expectedVersion: await version(),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(`products/${productA}/archive`, operatorA, 'POST', {
        expectedVersion: await version(),
      })
    ).status,
    403,
  );
  const identity = await app
    .get(IdentityService)
    .authenticate(operatorA.split('=')[1], randomUUID());
  await assert.rejects(
    app
      .get(CatalogService)
      .createProduct(identity.context!, { name: 'Interno prohibido', unitOfMeasure: 'UNIT' }),
  );
});
test('sin login no hay catálogo; CSRF protege POST y PATCH', async () => {
  assert.equal((await request('products', '')).status, 401);
  assert.equal(
    (
      await request('products', adminA, 'POST', productInput('CSRF'), {
        Origin: 'https://evil.invalid',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request(
        `products/${productA}`,
        adminA,
        'PATCH',
        { name: 'CSRF', expectedVersion: await version() },
        { 'X-Maxbio-Csrf': '' },
      )
    ).status,
    403,
  );
});
test('paginación con orden estable y límites; tenant declarado y campos extra inválidos', async () => {
  const page = productListSchema.parse(await json('products?page=1&limit=1'));
  assert.equal(page.limit, 1);
  assert.equal(page.items.length, 1);
  for (const query of [
    'limit=1000000',
    'limit=0',
    'page=-1',
    'includeArchived=yes',
    `organizationId=${b}`,
  ])
    assert.equal((await request(`products?${query}`)).status, 400);
  for (const body of [
    { ...productInput('Invalid'), organizationId: b },
    { name: 'Invalid', unitOfMeasure: 'BOX' },
    { ...productInput('Invalid'), cost: 10 },
    { ...productInput('Invalid'), name: '  ' },
  ])
    assert.equal((await request('products', adminA, 'POST', body)).status, 400);
  const invalid = await request(`products/${productA}`, adminA, 'PATCH', { name: 'Sin versión' });
  assert.equal(invalid.status, 400);
});
test('búsqueda encuentra nombre, código interno, GTIN equivalente, marca y fabricante', async () => {
  for (const q of ['Cánula', '00a/B', '04006381333931', 'Marca Médica', 'Fábrica Fixture']) {
    const result = await json(`products?q=${encodeURIComponent(q)}`);
    assert.ok(
      result.items.some((item: { id: string }) => item.id === productA),
      q,
    );
  }
  assert.ok(
    (await json(`products?brandId=${brandA}&categoryId=${categoryA}`)).items.some(
      (item: { id: string }) => item.id === productA,
    ),
  );
});
test('GTIN válido equivalente se resuelve en cada tenant sin ambigüedad', async () => {
  const path = 'product-identifiers/resolve?kind=GTIN&value=04006381333931';
  assert.equal((await json(path)).id, productA);
  assert.equal((await json(path, 'GET', undefined, adminB)).id, productB);
  assert.equal(
    (await json('product-identifiers/resolve?kind=INTERNAL_CODE&value=00a%2FB')).id,
    productA,
  );
  assert.equal(
    (await request('product-identifiers/resolve?kind=INTERNAL_CODE&value=00A%2FB')).status,
    404,
  );
});
test('identificadores inválidos y duplicados no cambian producto ni auditoría', async () => {
  const expectedVersion = await version();
  const auditBefore = await client.auditEvent.count({ where: { organizationId: a } });
  for (const [value, status] of [
    ['4006381333932', 400],
    ['04006381333931', 409],
  ] as const) {
    const response = await request(`products/${productA}/identifiers`, adminA, 'POST', {
      kind: 'GTIN',
      value,
      expectedVersion,
    });
    assert.equal(response.status, status);
    assert.doesNotMatch(JSON.stringify(await response.json()), /P2002|constraint|Prisma|SQL/);
  }
  assert.equal(await version(), expectedVersion);
  assert.equal(await client.auditEvent.count({ where: { organizationId: a } }), auditBefore);
});
test('creación de Product + identificadores es atómica ante un duplicado o GTIN inválido', async () => {
  const productsBefore = await client.product.count({ where: { organizationId: a } });
  const auditsBefore = await client.auditEvent.count({ where: { organizationId: a } });
  for (const [value, status] of [
    ['4006381333931', 409],
    ['4006381333932', 400],
  ] as const)
    assert.equal(
      (
        await request('products', adminA, 'POST', {
          ...productInput('No parcial'),
          identifiers: [
            { kind: 'INTERNAL_CODE', value: 'UNIQUE-PARTIAL' },
            { kind: 'GTIN', value },
          ],
        })
      ).status,
      status,
    );
  assert.equal(await client.product.count({ where: { organizationId: a } }), productsBefore);
  assert.equal(await client.auditEvent.count({ where: { organizationId: a } }), auditsBefore);
});
test('barcode interno se agrega, se resuelve y tiene validación explícita', async () => {
  const added = await json(`products/${productA}/identifiers`, 'POST', {
    kind: 'INTERNAL_BARCODE',
    value: 'MB-FIXTURE',
    expectedVersion: await version(),
  });
  assert.equal(added.identifier.normalizedValue, 'MB-FIXTURE');
  assert.equal(
    (await json('product-identifiers/resolve?kind=INTERNAL_BARCODE&value=MB-FIXTURE')).id,
    productA,
  );
  assert.equal(
    (
      await request(`products/${productA}/identifiers`, adminA, 'POST', {
        kind: 'INTERNAL_BARCODE',
        value: 'mb-fixture',
        expectedVersion: await version(),
      })
    ).status,
    400,
  );
});
test('archivar identificador conserva reserva y restaurar recupera resolución', async () => {
  const list = await json(`products/${productA}/identifiers`);
  const identifier = list.items.find((row: { kind: string }) => row.kind === 'GTIN');
  assert.ok(identifier);
  await json(
    `products/${productA}/identifiers/${identifier.id}/archive`,
    'POST',
    { expectedVersion: await version() },
    adminA,
    200,
  );
  assert.equal(
    (await request('product-identifiers/resolve?kind=GTIN&value=4006381333931')).status,
    404,
  );
  assert.equal(
    (
      await request('products', adminA, 'POST', {
        ...productInput('Reserva prohibida'),
        identifiers: [{ kind: 'GTIN', value: '4006381333931' }],
      })
    ).status,
    409,
  );
  assert.equal(
    (await json(`products/${productA}/identifiers`)).items.some(
      (row: { id: string }) => row.id === identifier.id,
    ),
    false,
  );
  assert.ok(
    (await json(`products/${productA}/identifiers?includeArchived=true`)).items.some(
      (row: { id: string }) => row.id === identifier.id,
    ),
  );
  await json(
    `products/${productA}/identifiers/${identifier.id}/restore`,
    'POST',
    { expectedVersion: await version() },
    adminA,
    200,
  );
});
test('PostgreSQL rechaza identificador cross-tenant, normalización falsa y GTIN inválido', async () => {
  await assert.rejects(
    client.productIdentifier.create({
      data: {
        organizationId: b,
        productId: productA,
        kind: 'INTERNAL_CODE',
        value: 'CROSS',
        normalizedValue: 'CROSS',
      },
    }),
  );
  await assert.rejects(
    client.productIdentifier.create({
      data: {
        organizationId: a,
        productId: productA,
        kind: 'GTIN',
        value: '4006381333932',
        normalizedValue: '04006381333932',
      },
    }),
  );
  await assert.rejects(
    client.productIdentifier.create({
      data: {
        organizationId: a,
        productId: productA,
        kind: 'INTERNAL_CODE',
        value: 'ABC',
        normalizedValue: 'abc',
      },
    }),
  );
});
test('proveedor cumple contrato, edición concurrente y aislamiento', async () => {
  const initial = supplierSchema.parse(await json(`suppliers/${supplierA}`));
  const updated = await json(`suppliers/${supplierA}`, 'PATCH', {
    name: 'Proveedor A editado',
    phone: '011 1234-5678',
    expectedVersion: initial.version,
  });
  assert.equal(updated.version, initial.version + 1);
  assert.equal(
    (
      await request(`suppliers/${supplierA}`, adminA, 'PATCH', {
        name: 'Viejo',
        expectedVersion: initial.version,
      })
    ).status,
    409,
  );
  assert.equal((await request(`suppliers/${supplierA}`, adminB)).status, 404);
  assert.equal((await request(`suppliers/${supplierB}/supplier-products`, adminA)).status, 404);
  assert.equal((await json('suppliers?q=editado')).total, 1);
});
test('SupplierProduct se vincula y busca por proveedor/código; dup y cross-tenant se rechazan', async () => {
  const linked = await json(`products/${productA}/supplier-products`, 'POST', {
    supplierId: supplierA,
    supplierCode: '  000abc  ',
    supplierDescription: 'Nombre propio del proveedor',
    expectedVersion: await version(),
  });
  assert.equal(linked.link.supplierCode, '000abc');
  assert.equal(linked.link.supplier.id, supplierA);
  assert.equal((await json('products?q=000abc')).items[0]!.id, productA);
  assert.equal((await json(`products?supplierId=${supplierA}`)).items[0]!.id, productA);
  assert.equal(
    (await json(`suppliers/${supplierA}/supplier-products`)).items[0]!.product.id,
    productA,
  );
  assert.equal(
    (
      await request(`products/${productA}/supplier-products`, adminA, 'POST', {
        supplierId: supplierA,
        expectedVersion: await version(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`products/${productA}/supplier-products`, adminA, 'POST', {
        supplierId: supplierB,
        expectedVersion: await version(),
      })
    ).status,
    404,
  );
  await assert.rejects(
    client.supplierProduct.create({
      data: { organizationId: a, productId: productA, supplierId: supplierB },
    }),
  );
  assert.equal(
    (
      await request(`supplier-products/${linked.link.id}`, adminB, 'PATCH', {
        supplierCode: 'AJENO',
        expectedVersion: 1,
      })
    ).status,
    404,
  );
});
test('relación comercial tiene su propia versión, archivo y restauración', async () => {
  const link = (await json(`products/${productA}/supplier-products`)).items[0];
  assert.ok(link);
  const updated = await json(`supplier-products/${link.id}`, 'PATCH', {
    supplierCode: 'CODE-UPDATED',
    expectedVersion: link.version,
  });
  assert.equal(updated.link.version, link.version + 1);
  assert.equal(
    (
      await request(`supplier-products/${link.id}`, adminA, 'PATCH', {
        supplierCode: 'OLD',
        expectedVersion: link.version,
      })
    ).status,
    409,
  );
  const archived = await json(
    `supplier-products/${link.id}/archive`,
    'POST',
    { expectedVersion: updated.link.version },
    adminA,
    200,
  );
  assert.equal((await json(`products/${productA}/supplier-products`)).total, 0);
  assert.equal(
    (
      await request(`products/${productA}/supplier-products`, adminA, 'POST', {
        supplierId: supplierA,
        expectedVersion: await version(),
      })
    ).status,
    409,
  );
  await json(
    `supplier-products/${link.id}/restore`,
    'POST',
    { expectedVersion: archived.link.version },
    adminA,
    200,
  );
});
test('unicidad de código por proveedor permite NULL y mismo código en otros proveedores', async () => {
  const extraProduct = await json('products', 'POST', productInput('Otro artículo'));
  const extraSupplier = await json('suppliers', 'POST', { name: 'Otro proveedor' });
  await json(`products/${extraProduct.id}/supplier-products`, 'POST', {
    supplierId: extraSupplier.id,
    supplierCode: 'CODE-UPDATED',
    expectedVersion: extraProduct.version,
  });
  assert.equal(
    (
      await request(`products/${extraProduct.id}/supplier-products`, adminA, 'POST', {
        supplierId: supplierA,
        supplierCode: 'CODE-UPDATED',
        expectedVersion: await version(extraProduct.id),
      })
    ).status,
    409,
  );
  await json(`products/${extraProduct.id}/supplier-products`, 'POST', {
    supplierId: supplierA,
    supplierCode: null,
    expectedVersion: await version(extraProduct.id),
  });
  const third = await json('products', 'POST', productInput('Tercer artículo'));
  await json(`products/${third.id}/supplier-products`, 'POST', {
    supplierId: supplierA,
    supplierCode: null,
    expectedVersion: third.version,
  });
});
test('marcas/categorías evitan duplicados triviales y soportan edición, archivo y restauración', async () => {
  for (const [path, id, name] of [
    ['brands', brandA, 'Marca Médica'],
    ['categories', categoryA, 'Ortopedia'],
  ] as const) {
    assert.equal(
      (await request(path, adminA, 'POST', { name: `  ${name.toUpperCase()}  ` })).status,
      409,
    );
    const record = namedEntitySchema.parse(
      (await json(`${path}?includeArchived=true`)).items.find(
        (row: { id: string }) => row.id === id,
      ),
    );
    const updated = await json(`${path}/${id}`, 'PATCH', {
      name: `${name} Actualizada`,
      expectedVersion: record.version,
    });
    const archived = await json(
      `${path}/${id}/archive`,
      'POST',
      { expectedVersion: updated.version },
      adminA,
      200,
    );
    assert.equal(
      (await json(path)).items.some((row: { id: string }) => row.id === id),
      false,
    );
    assert.equal(
      (
        await request('products', adminA, 'POST', {
          ...productInput('Referencia archivada'),
          [path === 'brands' ? 'brandId' : 'categoryId']: id,
        })
      ).status,
      409,
    );
    const edit = await json(`products/${productA}`, 'PATCH', {
      description: 'Conserva clasificación archivada',
      expectedVersion: await version(),
    });
    assert.ok(edit.id);
    await json(`${path}/${id}/restore`, 'POST', { expectedVersion: archived.version }, adminA, 200);
    assert.equal(
      (await request(`${path}/${id}`, adminB, 'PATCH', { name: 'Ajena', expectedVersion: 3 }))
        .status,
      404,
    );
  }
});
test('fallo real de auditoría revierte creación y edición comercial', async () => {
  const audit = app.get(AuditService);
  const original = audit.success;
  const beforeCount = await client.product.count({ where: { organizationId: a } });
  const originalProduct = await json(`products/${productA}`);
  audit.success = () => {
    throw new Error('fixture private audit failure');
  };
  try {
    for (const response of [
      await request('products', adminA, 'POST', {
        ...productInput('Rollback'),
        identifiers: [{ kind: 'INTERNAL_CODE', value: 'ROLLBACK' }],
      }),
      await request(`products/${productA}`, adminA, 'PATCH', {
        name: 'No debe persistir',
        expectedVersion: originalProduct.version,
      }),
    ]) {
      assert.equal(response.status, 500);
      const error = apiErrorSchema.parse(await response.json());
      assert.doesNotMatch(JSON.stringify(error), /fixture|private|stack|Prisma/);
    }
  } finally {
    audit.success = original;
  }
  assert.equal(await client.product.count({ where: { organizationId: a } }), beforeCount);
  assert.equal((await json(`products/${productA}`)).name, originalProduct.name);
  assert.equal(await version(), originalProduct.version);
});
test('auditoría contiene tenant, actor y sesión reales, metadata vacía segura', async () => {
  const identity = await app.get(IdentityService).authenticate(adminA.split('=')[1], randomUUID());
  const rows = await client.auditEvent.findMany({
    where: { organizationId: a, actorUserId: userA, action: { startsWith: 'PRODUCT_' } },
  });
  assert.ok(rows.length > 5);
  for (const row of rows) {
    assert.equal(row.sessionId, identity.session.id);
    assert.deepEqual(row.metadata, {});
    assert.equal(row.result, 'SUCCESS');
  }
  for (const action of [
    'PRODUCT_CREATED',
    'PRODUCT_UPDATED',
    'PRODUCT_IDENTIFIER_ADDED',
    'SUPPLIER_CREATED',
    'SUPPLIER_UPDATED',
    'SUPPLIER_PRODUCT_LINKED',
    'BRAND_CREATED',
    'CATEGORY_CREATED',
  ])
    assert.ok(await client.auditEvent.count({ where: { organizationId: a, action } }), action);
});
test('archivar proveedor oculta vínculos efectivos; restaurar mantiene relaciones', async () => {
  const supplier = await json(`suppliers/${supplierA}`);
  const archived = await json(
    `suppliers/${supplierA}/archive`,
    'POST',
    { expectedVersion: supplier.version },
    adminA,
    200,
  );
  assert.equal(
    (await json('suppliers')).items.some((row: { id: string }) => row.id === supplierA),
    false,
  );
  assert.equal((await json(`products/${productA}/supplier-products`)).total, 0);
  assert.ok((await json(`products/${productA}/supplier-products?includeArchived=true`)).total > 0);
  assert.equal(
    (
      await request(`suppliers/${supplierA}`, adminA, 'PATCH', {
        name: 'No',
        expectedVersion: archived.version,
      })
    ).status,
    409,
  );
  await json(
    `suppliers/${supplierA}/restore`,
    'POST',
    { expectedVersion: archived.version },
    adminA,
    200,
  );
});
test('archivar producto conserva identidad, relaciones y códigos reservados', async () => {
  const archived = await json(
    `products/${productA}/archive`,
    'POST',
    { expectedVersion: await version() },
    adminA,
    200,
  );
  assert.ok(archived.archivedAt);
  assert.equal(
    (await json('products')).items.some((row: { id: string }) => row.id === productA),
    false,
  );
  assert.ok(
    (await json('products?includeArchived=true')).items.some(
      (row: { id: string }) => row.id === productA,
    ),
  );
  assert.equal(
    (await request('product-identifiers/resolve?kind=GTIN&value=4006381333931')).status,
    404,
  );
  assert.equal(
    (
      await request('products', adminA, 'POST', {
        ...productInput('No reasignar'),
        identifiers: [{ kind: 'GTIN', value: '4006381333931' }],
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`products/${productA}`, adminA, 'PATCH', {
        name: 'No editar',
        expectedVersion: archived.version,
      })
    ).status,
    409,
  );
  await assert.rejects(client.product.delete({ where: { id: productA } }));
  assert.equal((await request(`products/${productA}`, adminA, 'DELETE')).status, 404);
  const eventsBefore = await client.auditEvent.count({
    where: { organizationId: a, action: 'PRODUCT_ARCHIVED' },
  });
  await json(
    `products/${productA}/archive`,
    'POST',
    { expectedVersion: archived.version },
    adminA,
    200,
  );
  assert.equal(
    await client.auditEvent.count({ where: { organizationId: a, action: 'PRODUCT_ARCHIVED' } }),
    eventsBefore,
  );
  await json(
    `products/${productA}/restore`,
    'POST',
    { expectedVersion: archived.version },
    adminA,
    200,
  );
});

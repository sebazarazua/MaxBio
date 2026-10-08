import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import { apiErrorSchema, customerSchema, customerListSchema } from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { IdentityService } from '../src/modules/identity/identity.service.js';
import { CustomersService } from '../src/modules/customers/application/customers.service.js';
import { hashPassword } from '../src/modules/identity/password.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const { AppModule } = await import('../src/app.module.js');
const client = createDatabaseClient(process.env.DATABASE_URL!);
const suffix = randomUUID();
const organizations: string[] = [],
  users: string[] = [],
  requestIds: string[] = [];
const password = 'Frase de prueba exclusiva del maestro clientes';
let app: INestApplication,
  base: string,
  orgA: string,
  orgB: string,
  adminA: string,
  adminB: string,
  operatorA: string;
let cuitSequence = 10000000;
function nextCuit() {
  while (true) {
    const first = '30' + String(cuitSequence++);
    const sum = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((n, w, i) => n + w * Number(first[i]), 0);
    const digit = (11 - (sum % 11)) % 11;
    if (digit < 10) return first + digit;
  }
}
async function request(path: string, method = 'GET', body?: unknown, cookie = adminA, csrf = true) {
  const response = await fetch(`${base}/api/v1/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? { Origin: 'http://localhost:3000', 'X-Maxbio-Csrf': '1' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  requestIds.push(response.headers.get('x-request-id')!);
  return response;
}
async function entity(path: string, method = 'GET', body?: unknown, cookie = adminA) {
  const response = await request(path, method, body, cookie);
  const data: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  return customerSchema.parse(data);
}
async function create(fields: Record<string, unknown> = {}, cookie = adminA) {
  return entity(
    'customers',
    'POST',
    { id: randomUUID(), name: 'Cliente fixture', kind: 'OTHER', ...fields },
    cookie,
  );
}
async function list(q = '', cookie = adminA) {
  const response = await request('customers?' + q, 'GET', undefined, cookie);
  assert.equal(response.status, 200);
  return customerListSchema.parse(await response.json());
}
async function error(path: string, method: string, body: unknown, status: number, cookie = adminA) {
  const response = await request(path, method, body, cookie);
  assert.equal(response.status, status);
  return apiErrorSchema.parse(await response.json());
}
before(async () => {
  const hash = await hashPassword(password);
  for (const name of ['A', 'B'])
    organizations.push(
      (
        await client.organization.create({
          data: { name: 'Customers ' + name, slug: `customers-${name}-${suffix}` },
        })
      ).id,
    );
  [orgA, orgB] = organizations as [string, string];
  const emails: string[] = [];
  for (const [name, organizationId, role] of [
    ['admin-a', orgA, 'ADMIN'],
    ['admin-b', orgB, 'ADMIN'],
    ['operator-a', orgA, 'OPERATOR'],
  ] as const) {
    const user = await client.user.create({
      data: { email: `${name}-${suffix}@example.invalid`, displayName: name, passwordHash: hash },
    });
    users.push(user.id);
    emails.push(user.email);
    await client.membership.create({ data: { organizationId, userId: user.id, role } });
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
  for (const email of emails) {
    const response = await request('auth/login', 'POST', { email, password }, '');
    assert.equal(response.status, 200);
    cookies.push(response.headers.getSetCookie().at(-1)!.split(';')[0]!);
  }
  [adminA, adminB, operatorA] = cookies as [string, string, string];
});
after(async () => {
  await app?.close();
  // Only fixtures owned by this test run are removed; there is no DELETE API.
  await client.auditEvent.deleteMany({
    where: {
      OR: [
        { organizationId: { in: organizations } },
        { actorUserId: { in: users } },
        { requestId: { in: requestIds } },
      ],
    },
  });
  await client.customer.deleteMany({ where: { organizationId: { in: organizations } } });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.membership.deleteMany({ where: { organizationId: { in: organizations } } });
  await client.user.deleteMany({ where: { id: { in: users } } });
  await client.organization.deleteMany({ where: { id: { in: organizations } } });
  await client.$disconnect();
});

test('Customer mínimo y completo, opcionales null y respuesta sin tenant/searchText', async () => {
  const minimal = await create({ name: ' Clínica X ', kind: 'INSTITUTION' });
  assert.equal(minimal.name, 'Clínica X');
  assert.equal(minimal.cuit, null);
  assert.equal(minimal.email, null);
  assert.equal(minimal.version, 1);
  const full = await create({
    name: 'OSDE fixture',
    kind: 'HEALTH_INSURER',
    legalName: 'Razón social declarada',
    cuit: '20-12345678-6',
    taxConditionText: 'Declarada',
    addressLine: 'Calle 123',
    locality: 'Ciudad',
    province: 'Provincia',
    postalCode: '0010A',
    contactName: 'María fixture',
    phone: '011-4567-8900',
    email: ' contacto@example.invalid ',
    notes: 'Horario comercial\nSolo entregas acordadas',
  });
  assert.equal(full.cuit, '20123456786');
  assert.equal(full.postalCode, '0010A');
  assert.equal(full.email, 'contacto@example.invalid');
  assert.equal(full.notes, 'Horario comercial\nSolo entregas acordadas');
  assert.doesNotMatch(JSON.stringify(full), /organizationId|searchText/);
  const identicalName = await create({ name: minimal.name });
  assert.notEqual(identicalName.id, minimal.id);
});
test('CUIT único histórico por tenant, varios null y mismo CUIT en otra organización', async () => {
  const cuit = nextCuit();
  await create({ cuit });
  await error(
    'customers',
    'POST',
    { id: randomUUID(), name: 'Duplicado', kind: 'COMPANY', cuit },
    409,
  );
  assert.equal((await create({ cuit }, adminB)).cuit, cuit);
  await create({ cuit: null });
  await create({ cuit: null });
});
test('CUIT/estructura inválida y campos internos se rechazan sin escritura', async () => {
  const before = await client.customer.count({ where: { organizationId: orgA } });
  for (const fields of [
    { cuit: '20123456785' },
    { cuit: '00000000000' },
    { email: 'invalido' },
    { organizationId: orgB },
    { version: 77 },
    { searchText: 'forzado' },
    { kind: 'PATIENT' },
  ])
    await error(
      'customers',
      'POST',
      { id: randomUUID(), name: 'Rechazado', kind: 'OTHER', ...fields },
      400,
    );
  assert.equal(await client.customer.count({ where: { organizationId: orgA } }), before);
});
test('doble create simultáneo/retry usa el mismo UUID y un único audit, otra carga 409', async () => {
  const input = { id: randomUUID(), name: 'Alta idempotente', kind: 'COMPANY', cuit: nextCuit() };
  const responses = await Promise.all([
    request('customers', 'POST', input),
    request('customers', 'POST', input),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(customerSchema.parse(await response.json()).id, input.id);
  }
  assert.equal((await entity('customers', 'POST', { ...input, phone: '' })).id, input.id);
  assert.equal(
    await client.auditEvent.count({ where: { resourceId: input.id, action: 'CUSTOMER_CREATED' } }),
    1,
  );
  await error('customers', 'POST', { ...input, name: 'Otra intención' }, 409);
});
test('carrera por CUIT: la DB permite una sola alta, rollback sin auditoría duplicada', async () => {
  const cuit = nextCuit();
  const responses = await Promise.all(
    [1, 2].map((i) =>
      request('customers', 'POST', { id: randomUUID(), name: 'Carrera ' + i, kind: 'OTHER', cuit }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await client.customer.count({ where: { organizationId: orgA, cuit } }), 1);
});
test('búsqueda server-side por todos los campos, tokens invertidos, tildes y CUIT humano', async () => {
  const cuit = nextCuit();
  const formatted = cuit.slice(0, 2) + '-' + cuit.slice(2, 10) + '-' + cuit.slice(10);
  const row = await create({
    name: 'Hospital Italiano de Buenos Aires',
    legalName: 'Fundación Única de Salud',
    cuit,
    contactName: 'Ángela Torres',
    phone: '011-7788-9900',
    email: 'italiano-busqueda@example.invalid',
  });
  for (const query of [
    'hospital italiano',
    'italiano hospital',
    'fundacion unica',
    'angela torres',
    'Torres hospital',
    '011-7788-9900',
    'italiano-busqueda@example.invalid',
    cuit,
    formatted,
  ]) {
    const result = await list(new URLSearchParams({ q: query }).toString());
    assert.ok(
      result.items.some((item) => item.id === row.id),
      query,
    );
  }
  await entity('customers/' + row.id, 'PATCH', {
    expectedVersion: 1,
    legalName: 'Nueva razón singular',
  });
  assert.ok((await list('q=nueva+razon+singular')).items.some((item) => item.id === row.id));
  assert.equal(
    (await list('q=fundacion+unica')).items.some((item) => item.id === row.id),
    false,
  );
  assert.equal((await list('q=%25')).total, 0);
});
test('OPERATOR lee y busca, pero no crea/edita/archiva/restaura; tampoco llamadas internas', async () => {
  const row = await create();
  assert.equal((await entity('customers/' + row.id, 'GET', undefined, operatorA)).id, row.id);
  assert.ok((await list('', operatorA)).items.length > 0);
  await error(
    'customers',
    'POST',
    { id: randomUUID(), name: 'No autorizado', kind: 'OTHER' },
    403,
    operatorA,
  );
  await error(
    'customers/' + row.id,
    'PATCH',
    { expectedVersion: 1, name: 'No autorizado' },
    403,
    operatorA,
  );
  for (const action of ['archive', 'restore'])
    await error(`customers/${row.id}/${action}`, 'POST', { expectedVersion: 1 }, 403, operatorA);
  const identity = await app
    .get(IdentityService)
    .authenticate(operatorA.split('=')[1]!, randomUUID());
  await assert.rejects(
    app
      .get(CustomersService)
      .create(identity.context!, { id: randomUUID(), name: 'Interno', kind: 'OTHER' }),
    /permiso/,
  );
});
test('tenant isolation en listado, ficha, edición, estados y replay; 404 sin enumeración', async () => {
  const foreign = await create({ name: 'Cliente privado B', cuit: nextCuit() }, adminB);
  assert.equal(
    (await list('q=Cliente+privado+B')).items.some((item) => item.id === foreign.id),
    false,
  );
  for (const [path, method, body] of [
    [`customers/${foreign.id}`, 'GET', undefined],
    [`customers/${foreign.id}`, 'PATCH', { expectedVersion: 1, name: 'Intruso' }],
    [`customers/${foreign.id}/archive`, 'POST', { expectedVersion: 1 }],
    [`customers/${foreign.id}/restore`, 'POST', { expectedVersion: 1 }],
    [
      'customers',
      'POST',
      { id: foreign.id, name: foreign.name, kind: foreign.kind, cuit: foreign.cuit },
    ],
  ] as const) {
    const e = await error(path, method, body, 404);
    assert.equal(e.message, 'No encontramos lo que buscás.');
  }
  assert.equal((await entity('customers/' + foreign.id, 'GET', undefined, adminB)).version, 1);
});
test('edición concurrente no pierde cambios; no-op no emite audit ni incrementa versión', async () => {
  const row = await create();
  const responses = await Promise.all(
    ['Edición A', 'Edición B'].map((name) =>
      request('customers/' + row.id, 'PATCH', { expectedVersion: 1, name }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const latest = await entity('customers/' + row.id);
  assert.equal(latest.version, 2);
  assert.equal(
    (await entity('customers/' + row.id, 'PATCH', { expectedVersion: 2, name: latest.name }))
      .version,
    2,
  );
  assert.equal(
    await client.auditEvent.count({ where: { resourceId: row.id, action: 'CUSTOMER_UPDATED' } }),
    1,
  );
});
test('archive/restore conserva identidad y CUIT, filtra activos y bloquea edición archivada', async () => {
  const row = await create({ name: 'Lifecycle exclusivo', cuit: nextCuit() });
  const archived = await entity(`customers/${row.id}/archive`, 'POST', { expectedVersion: 1 });
  assert.ok(archived.archivedAt);
  assert.equal(archived.version, 2);
  assert.equal((await list('q=Lifecycle+exclusivo')).total, 0);
  assert.equal((await list('q=Lifecycle+exclusivo&includeArchived=true')).items[0]!.id, row.id);
  assert.equal(
    (await entity(`customers/${row.id}/archive`, 'POST', { expectedVersion: 2 })).version,
    2,
  );
  await error('customers/' + row.id, 'PATCH', { expectedVersion: 2, name: 'No' }, 409);
  await error(
    'customers',
    'POST',
    { id: randomUUID(), name: 'CUIT reservado', kind: 'OTHER', cuit: row.cuit },
    409,
  );
  const restored = await entity(`customers/${row.id}/restore`, 'POST', { expectedVersion: 2 });
  assert.equal(restored.id, row.id);
  assert.equal(restored.cuit, row.cuit);
  assert.equal(restored.archivedAt, null);
  assert.equal(restored.version, 3);
  assert.equal(
    (await entity(`customers/${row.id}/restore`, 'POST', { expectedVersion: 3 })).version,
    3,
  );
  await error(`customers/${row.id}/archive`, 'POST', { expectedVersion: 2 }, 409);
});
test('Audit create/update/archive/restore es semántico y metadata vacía sin datos privados', async () => {
  const row = await create({ notes: 'Nota privada', email: 'privado@example.invalid' });
  await entity('customers/' + row.id, 'PATCH', { expectedVersion: 1, phone: 'Contacto privado' });
  await entity(`customers/${row.id}/archive`, 'POST', { expectedVersion: 2 });
  await entity(`customers/${row.id}/restore`, 'POST', { expectedVersion: 3 });
  const events = await client.auditEvent.findMany({
    where: { organizationId: orgA, resourceId: row.id },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    events.map((e) => e.action),
    ['CUSTOMER_CREATED', 'CUSTOMER_UPDATED', 'CUSTOMER_ARCHIVED', 'CUSTOMER_RESTORED'],
  );
  for (const e of events) {
    assert.deepEqual(e.metadata, {});
    assert.equal(e.resourceType, 'Customer');
    assert.ok(e.actorUserId);
    assert.ok(e.sessionId);
  }
});
test('fallo de auditoría revierte alta, edición, archivo y restauración', async () => {
  const audit = app.get(AuditService),
    original = audit.success;
  const row = await create();
  const archived = await create();
  await entity(`customers/${archived.id}/archive`, 'POST', { expectedVersion: 1 });
  const id = randomUUID();
  try {
    audit.success = () => {
      throw new Error('Fallo controlado');
    };
    await error('customers', 'POST', { id, name: 'Rollback', kind: 'OTHER' }, 500);
    await error(
      'customers/' + row.id,
      'PATCH',
      { expectedVersion: 1, name: 'No debe guardar' },
      500,
    );
    await error(`customers/${row.id}/archive`, 'POST', { expectedVersion: 1 }, 500);
    await error(`customers/${archived.id}/restore`, 'POST', { expectedVersion: 2 }, 500);
  } finally {
    audit.success = original;
  }
  assert.equal(await client.customer.count({ where: { id } }), 0);
  assert.equal((await entity('customers/' + row.id)).version, 1);
  assert.ok((await entity('customers/' + archived.id)).archivedAt);
});
test('paginación estable por nombre/id sin descarga ilimitada ni filtros de tenant del cliente', async () => {
  for (let i = 0; i < 5; i++) await create({ name: 'Paginación exclusiva' });
  const first = await list('q=Paginacion+exclusiva&limit=2');
  const second = await list('q=Paginacion+exclusiva&limit=2&page=2');
  const third = await list('q=Paginacion+exclusiva&limit=2&page=3');
  assert.equal(first.total, 5);
  assert.equal(third.items.length, 1);
  const ids = [...first.items, ...second.items, ...third.items].map((row) => row.id);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(ids, [...ids].sort());
  assert.deepEqual((await list('q=Paginacion+exclusiva&limit=2')).items, first.items);
  await error('customers?limit=101', 'GET', undefined, 400);
  await error('customers?organizationId=' + orgB, 'GET', undefined, 400);
});
test('DB defiende CUIT, versión, nombre, lifecycle, FK y búsqueda incluso fuera de frontend', async () => {
  const row = await create({ name: 'Actualización SQL' });
  for (const data of [
    { cuit: '20123456785' },
    { version: 0 },
    { name: ' ' },
    { archivedAt: new Date('2000-01-01') },
  ])
    await assert.rejects(client.customer.update({ where: { id: row.id }, data }));
  await assert.rejects(
    client.customer.create({
      data: { organizationId: randomUUID(), name: 'FK inválida', kind: 'OTHER' },
    }),
  );
  await client.customer.update({
    where: { id: row.id },
    data: { legalName: 'Título Único SQL', searchText: 'ignorado' },
  });
  assert.equal((await list('q=titulo+unico+sql')).items[0]!.id, row.id);
  assert.equal(
    (await list('q=ignorado')).items.some((item) => item.id === row.id),
    false,
  );
});
test('CSRF/sesión y revalidación dentro de transacción; no existe hard-delete', async () => {
  assert.equal(
    (
      await request(
        'customers',
        'POST',
        { id: randomUUID(), name: 'Sin CSRF', kind: 'OTHER' },
        adminA,
        false,
      )
    ).status,
    403,
  );
  assert.equal((await request('customers', 'GET', undefined, '')).status, 401);
  const row = await create();
  assert.equal((await request('customers/' + row.id, 'DELETE')).status, 404);
  const identity = await app.get(IdentityService).authenticate(adminB.split('=')[1]!, randomUUID());
  await client.session.update({
    where: { id: identity.session.id },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(
    app
      .get(CustomersService)
      .create(identity.context!, { id: randomUUID(), name: 'Sesión revocada', kind: 'OTHER' }),
    /acceso cambió/,
  );
});
test('Customers produce cero Product/Supplier/Catalog/Inventory: aislamiento del incremento', async () => {
  const where = { organizationId: { in: organizations } };
  const counts = await Promise.all([
    client.product.count({ where }),
    client.productIdentifier.count({ where }),
    client.supplier.count({ where }),
    client.supplierProduct.count({ where }),
    client.supplierCatalogItem.count({ where }),
    client.inventoryMovement.count({ where }),
    client.inventoryMovementLine.count({ where }),
    client.inventoryBalance.count({ where }),
    client.inventoryReceipt.count({ where }),
    client.inventoryCountSession.count({ where }),
    client.inventoryLocation.count({ where }),
  ]);
  assert.deepEqual(counts, new Array(counts.length).fill(0));
});

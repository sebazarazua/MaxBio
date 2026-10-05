import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import { identityResponseSchema } from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { IdentityService, tokenVerifier } from '../src/modules/identity/identity.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { bootstrapAdmin } from '../src/modules/identity/bootstrap-admin.js';
import { hashPassword } from '../src/modules/identity/password.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { LoginLimiter } from '../src/modules/identity/login-limiter.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const { AppModule } = await import('../src/app.module.js');
const client = createDatabaseClient(process.env.DATABASE_URL!);
const suffix = randomUUID();
const password = 'Una frase de prueba suficientemente larga';
const users: string[] = [];
const orgs: string[] = [];
let admin: string;
let operator: string;
let multi: string;
let a: string;
let b: string;
let ma: string;
let mb: string;
let app: INestApplication;
let base: string;
let limitEnabled = false;
const limiter = new LoginLimiter();
const email = (name: string) => `${name}-${suffix}@example.invalid`;
const headers = {
  Origin: 'http://localhost:3000',
  'X-Maxbio-Csrf': '1',
  'Content-Type': 'application/json',
};
async function request(
  path: string,
  cookie?: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(`${base}/api/v1/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(name = 'admin') {
  const response = await request('login', undefined, { email: email(name), password });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const cookie = response.headers.getSetCookie().at(-1)!.split(';')[0]!;
  return cookie;
}
async function sessionFor(cookie: string) {
  return client.session.findUniqueOrThrow({
    where: { tokenHash: tokenVerifier(cookie.split('=')[1]!) },
  });
}

before(async () => {
  const hash = await hashPassword(password);
  a = (await client.organization.create({ data: { name: 'Fixture A', slug: `auth-a-${suffix}` } }))
    .id;
  b = (await client.organization.create({ data: { name: 'Fixture B', slug: `auth-b-${suffix}` } }))
    .id;
  orgs.push(a, b);
  for (const name of ['admin', 'operator', 'multi', 'outsider']) {
    const user = await client.user.create({
      data: { email: email(name), displayName: name, passwordHash: hash },
    });
    users.push(user.id);
  }
  [admin, operator, multi] = users as [string, string, string];
  await client.membership.create({ data: { organizationId: a, userId: admin, role: 'ADMIN' } });
  await client.membership.create({
    data: { organizationId: a, userId: operator, role: 'OPERATOR' },
  });
  ma = (
    await client.membership.create({ data: { organizationId: a, userId: multi, role: 'OPERATOR' } })
  ).id;
  mb = (
    await client.membership.create({ data: { organizationId: b, userId: multi, role: 'ADMIN' } })
  ).id;
  await client.membership.create({ data: { organizationId: b, userId: users[3]!, role: 'ADMIN' } });
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseService)
    .useValue({
      client,
      ping: async () => {
        await client.$queryRaw`SELECT 1`;
      },
    })
    .overrideProvider(LoginLimiter)
    .useValue({
      enter: (ip: string, email: string) => (limitEnabled ? limiter.enter(ip, email) : () => {}),
    })
    .compile();
  app = module.createNestApplication({ logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  await app?.close();
  // Solo fixtures UUID de esta ejecución; nunca auditoría real ni una base completa.
  const sessions = await client.session.findMany({
    where: { userId: { in: users } },
    select: { id: true },
  });
  await client.auditEvent.deleteMany({
    where: {
      OR: [
        { actorUserId: { in: users } },
        { requestId: { in: failureIds } },
        { sessionId: { in: sessions.map((item) => item.id) } },
      ],
    },
  });
  await client.session.deleteMany({ where: { userId: { in: users } } });
  await client.membership.deleteMany({ where: { userId: { in: users } } });
  await client.user.deleteMany({ where: { id: { in: users } } });
  await client.organization.deleteMany({ where: { id: { in: orgs } } });
  await client.$disconnect();
});
const failureIds: string[] = [];

test('login real normaliza email, cookie persistente, token hasheado, sin secretos en respuesta', async () => {
  const response = await request('login', undefined, {
    email: email('admin').toUpperCase(),
    password,
    deviceName: 'PC oficina',
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie().at(-1)!;
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=/);
  assert.match(setCookie, /Path=\//);
  assert.doesNotMatch(setCookie, /Domain=/);
  const cookie = setCookie.split(';')[0]!;
  const session = await sessionFor(cookie);
  assert.notEqual(session.tokenHash, cookie.split('=')[1]);
  assert.equal(session.deviceName, 'PC oficina');
  const me = await request('me', cookie);
  assert.equal(me.status, 200);
  const view = identityResponseSchema.parse(await me.json());
  assert.equal(view.activeOrganization?.id, a);
  assert.equal(view.activeOrganization?.role, 'ADMIN');
  assert.doesNotMatch(JSON.stringify(view), /password|tokenHash|argon2|revokedAt/);
  assert.equal(me.headers.get('cache-control'), 'no-store');
  assert.equal(
    await client.auditEvent.count({
      where: { sessionId: session.id, action: 'AUTH_LOGIN_SUCCEEDED' },
    }),
    1,
  );
});

test('contraseña incorrecta y usuario inexistente tienen igual respuesta y auditoría sin email', async () => {
  const bodies: unknown[] = [];
  for (const name of ['admin', 'missing']) {
    const response = await request('login', undefined, {
      email: email(name),
      password: 'incorrecta',
    });
    assert.equal(response.status, 401);
    const requestId = response.headers.get('x-request-id')!;
    failureIds.push(requestId);
    const body = (await response.json()) as { message: string; code: string };
    bodies.push({ message: body.message, code: body.code });
    const audit = await client.auditEvent.findFirstOrThrow({ where: { requestId } });
    assert.equal(audit.actorUserId, null);
    assert.equal(audit.organizationId, null);
    assert.deepEqual(audit.metadata, { reason: 'INVALID_CREDENTIALS' });
    assert.doesNotMatch(JSON.stringify(audit), /incorrecta|@example/);
  }
  assert.deepEqual(bodies[0], bodies[1]);
});

test('sin sesión ni headers falsos no hay acceso; cookies aleatorias tampoco', async () => {
  for (const cookie of [undefined, `maxbio-session=${'z'.repeat(43)}`]) {
    const response = await request('admin-check', cookie, undefined, {
      'x-user-id': admin,
      'x-organization-id': a,
    });
    assert.equal(response.status, 401);
  }
});

test('CSRF protege login y todas las escrituras; no habilita CORS', async () => {
  const invalidHeaders: Record<string, string>[] = [
    { Origin: 'https://evil.invalid' },
    { 'X-Maxbio-Csrf': '' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ];
  for (const extra of invalidHeaders) {
    const response = await request('login', undefined, { email: email('admin'), password }, extra);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  assert.equal(
    (await request('logout', await login(), {}, { Origin: 'https://evil.invalid' })).status,
    403,
  );
});

test('sesión expirada por inactividad o lifetime absoluto y revocada se rechaza', async () => {
  for (const data of [
    { expiresAt: new Date(0) },
    { absoluteExpiresAt: new Date(0) },
    { revokedAt: new Date() },
  ]) {
    const cookie = await login();
    const session = await sessionFor(cookie);
    await client.session.update({ where: { id: session.id }, data });
    const response = await request('me', cookie);
    assert.equal(response.status, 401);
    assert.match(response.headers.getSetCookie().at(-1)!, /Max-Age=0/);
  }
});

test('actividad rolling se throttlea y nunca supera el límite absoluto', async () => {
  const cookie = await login();
  const session = await sessionFor(cookie);
  await request('me', cookie);
  assert.equal((await sessionFor(cookie)).lastUsedAt.getTime(), session.lastUsedAt.getTime());
  const absolute = new Date(Date.now() + 86400000);
  await client.session.update({
    where: { id: session.id },
    data: {
      lastUsedAt: new Date(Date.now() - 3600000),
      expiresAt: new Date(Date.now() + 3600000),
      absoluteExpiresAt: absolute,
    },
  });
  assert.equal((await request('me', cookie)).status, 200);
  const renewed = await sessionFor(cookie);
  assert.equal(renewed.expiresAt.getTime(), absolute.getTime());
  assert.ok(renewed.lastUsedAt > session.lastUsedAt);
  assert.equal(renewed.tokenHash, session.tokenHash);
});

test('logout revoca solo dispositivo actual; login crea sesiones independientes', async () => {
  const first = await login();
  const second = await login();
  assert.notEqual(first, second);
  const firstSession = await sessionFor(first);
  assert.equal((await request('logout', first, {})).status, 200);
  assert.equal((await request('me', first)).status, 401);
  assert.equal((await request('me', second)).status, 200);
  assert.equal(
    await client.auditEvent.count({ where: { sessionId: firstSession.id, action: 'AUTH_LOGOUT' } }),
    1,
  );
});

test('revocación específica no permite sesiones ajenas y queda auditada', async () => {
  const actor = await login();
  const other = await login();
  const foreign = await login('outsider');
  const target = await sessionFor(other);
  const alien = await sessionFor(foreign);
  assert.equal((await request(`sessions/${alien.id}/revoke`, actor, {})).status, 404);
  assert.equal((await request(`sessions/${target.id}/revoke`, actor, {})).status, 200);
  assert.equal((await request('me', other)).status, 401);
  assert.equal((await request('me', foreign)).status, 200);
  assert.equal(
    await client.auditEvent.count({ where: { resourceId: target.id, action: 'SESSION_REVOKED' } }),
    1,
  );
  const list = await request('sessions', actor);
  assert.equal(list.status, 200);
  assert.doesNotMatch(JSON.stringify(await list.json()), /tokenHash|password/);
});

test('cerrar todas las sesiones invalida todos los dispositivos del usuario', async () => {
  const first = await login();
  const second = await login();
  assert.equal((await request('sessions/revoke-all', first, {})).status, 200);
  assert.equal((await request('me', first)).status, 401);
  assert.equal((await request('me', second)).status, 401);
});

test('renovación concurrente con logout nunca revive la sesión', async () => {
  const cookie = await login();
  const session = await sessionFor(cookie);
  await client.session.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date(Date.now() - 3600000) },
  });
  const results = await Promise.all([
    request('me', cookie),
    request('me', cookie),
    request('logout', cookie, {}),
  ]);
  assert.equal(results[2]!.status, 200);
  assert.ok((await sessionFor(cookie)).revokedAt);
  assert.equal((await request('me', cookie)).status, 401);
});

test('usuario deshabilitado invalida sesión y login', async () => {
  const cookie = await login();
  await client.user.update({ where: { id: admin }, data: { disabledAt: new Date() } });
  try {
    assert.equal((await request('me', cookie)).status, 401);
    const fail = await request('login', undefined, { email: email('admin'), password });
    assert.equal(fail.status, 401);
    failureIds.push(fail.headers.get('x-request-id')!);
  } finally {
    await client.user.update({ where: { id: admin }, data: { disabledAt: null } });
  }
});

test('membership revocada u organización archivada se rechazan sin cambiar tenant silenciosamente', async () => {
  const membership = await client.membership.findUniqueOrThrow({
    where: { organizationId_userId: { organizationId: a, userId: admin } },
  });
  for (const kind of ['membership', 'organization']) {
    const cookie = await login();
    if (kind === 'membership')
      await client.membership.update({
        where: { id: membership.id },
        data: { revokedAt: new Date() },
      });
    else await client.organization.update({ where: { id: a }, data: { archivedAt: new Date() } });
    try {
      assert.equal((await request('me', cookie)).status, 401);
    } finally {
      await client.membership.update({ where: { id: membership.id }, data: { revokedAt: null } });
      await client.organization.update({ where: { id: a }, data: { archivedAt: null } });
    }
  }
});

test('ADMIN permite endpoint; OPERATOR no; organizationId arbitrario no cambia contexto', async () => {
  const cookie = await login();
  const response = await request('admin-check', cookie, undefined, { 'x-organization-id': b });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, organizationId: a });
  assert.equal((await request('admin-check', await login('operator'))).status, 403);
  assert.equal((await request('organization', cookie, { organizationId: b })).status, 400);
  assert.equal((await request('organization', cookie, { membershipId: mb })).status, 403);
});

test('multi-tenant valida selección server-side y aplica rol específico de cada organización', async () => {
  const cookie = await login('multi');
  const initial = identityResponseSchema.parse(await (await request('me', cookie)).json());
  assert.equal(initial.activeOrganization, null);
  assert.equal(initial.organizations.length, 2);
  assert.equal((await request('admin-check', cookie)).status, 403);
  assert.equal((await request('organization', cookie, { membershipId: ma })).status, 200);
  assert.equal((await request('admin-check', cookie)).status, 403);
  assert.equal((await request('organization', cookie, { membershipId: mb })).status, 200);
  const adminResponse = await request('admin-check', cookie);
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(await adminResponse.json(), { ok: true, organizationId: b });
  assert.equal(
    await client.auditEvent.count({
      where: { sessionId: (await sessionFor(cookie)).id, action: 'ACTIVE_ORGANIZATION_SELECTED' },
    }),
    2,
  );
});

test('FK compuesta impide pertenencia de otro usuario; históricos usan Restrict', async () => {
  const session = await sessionFor(await login());
  await assert.rejects(
    client.session.update({ where: { id: session.id }, data: { activeMembershipId: mb } }),
  );
  await assert.rejects(client.user.delete({ where: { id: admin } }));
  await assert.rejects(client.session.delete({ where: { id: session.id } }));
});

test('auditoría y cambios comparten transacción y se revierten juntos ante error', async () => {
  const requestId = randomUUID();
  await assert.rejects(
    client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: operator }, data: { displayName: 'Should rollback' } });
      await app.get(AuditService).append(
        {
          organizationId: a,
          actorUserId: admin,
          action: 'TEST_CHANGE',
          resourceType: 'User',
          resourceId: operator,
          result: 'SUCCESS',
          requestId,
        },
        tx,
      );
      throw new Error('Rollback fixture');
    }),
  );
  assert.equal(
    (await client.user.findUniqueOrThrow({ where: { id: operator } })).displayName,
    'operator',
  );
  assert.equal(await client.auditEvent.count({ where: { requestId } }), 0);
});

test('administración application requiere ADMIN, rechaza ajenos, revoca dispositivos y deshabilita con auditoría', async () => {
  const service = app.get(IdentityService);
  const adminCookie = await login();
  const operatorCookie = await login('operator');
  const actor = await service.authenticate(adminCookie.split('=')[1], randomUUID());
  const operatorActor = await service.authenticate(operatorCookie.split('=')[1], randomUUID());
  await assert.rejects(service.disableUser(operatorActor.context!, admin));
  await assert.rejects(service.disableUser(actor.context!, users[3]!));
  await assert.rejects(service.disableUser(actor.context!, multi));
  const secondOperatorCookie = await login('operator');
  await assert.rejects(service.revokeUserSessions(operatorActor.context!, admin));
  await assert.rejects(
    service.revokeUserSession(
      actor.context!,
      users[3]!,
      (await sessionFor(secondOperatorCookie)).id,
    ),
  );
  await service.revokeUserSession(
    actor.context!,
    operator,
    (await sessionFor(secondOperatorCookie)).id,
  );
  assert.equal((await request('me', secondOperatorCookie)).status, 401);
  assert.equal((await request('me', operatorCookie)).status, 200);
  await service.revokeUserSessions(actor.context!, operator);
  assert.equal((await request('me', operatorCookie)).status, 401);
  const thirdOperatorCookie = await login('operator');
  await service.disableUser(actor.context!, operator);
  assert.equal((await request('me', thirdOperatorCookie)).status, 401);
  assert.ok((await client.user.findUniqueOrThrow({ where: { id: operator } })).disabledAt);
  assert.equal(
    await client.auditEvent.count({ where: { action: 'USER_DISABLED', resourceId: operator } }),
    1,
  );
});

test('bootstrap valida contraseña y no reemplaza credenciales existentes', async () => {
  await assert.rejects(
    bootstrapAdmin(client, { email: email('admin'), displayName: 'Admin', password: 'short' }),
  );
  const organization = await client.organization.findUnique({ where: { slug: 'maxbio' } });
  // En la base de trabajo no crear ni sustituir el primer admin desde tests.
  if (organization) {
    const prior = await client.user.findUniqueOrThrow({ where: { id: admin } });
    await assert.rejects(
      bootstrapAdmin(client, { email: prior.email, displayName: 'Changed', password }),
    );
    assert.equal(
      (await client.user.findUniqueOrThrow({ where: { id: admin } })).passwordHash,
      prior.passwordHash,
    );
  }
});

test('login HTTP devuelve 429 después del límite incluso para cuentas inexistentes', async () => {
  limitEnabled = true;
  for (let i = 0; i < 11; i++) {
    const response = await request('login', undefined, {
      email: email('rate-missing'),
      password: 'incorrecta',
    });
    assert.equal(response.status, i < 10 ? 401 : 429);
    if (i < 10) failureIds.push(response.headers.get('x-request-id')!);
  }
});

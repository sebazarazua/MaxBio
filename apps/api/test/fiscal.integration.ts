import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  arcaReadinessSchema,
  fiscalProfileResponseSchema,
  arcaCsrSchema,
  type ArcaReadiness,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import {
  CREDENTIAL_STORAGE,
  LocalPrivateCredentialStorage,
} from '../src/modules/fiscal/infrastructure/private-credential-storage.js';
import { ARCA_CLOCK, ArcaError } from '../src/modules/fiscal/arca/arca-errors.js';
import { ArcaWsaaClient } from '../src/modules/fiscal/arca/wsaa-client.js';
import { ArcaTicketProvider } from '../src/modules/fiscal/arca/ticket-provider.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { crypto, ephemeralFiles, testCertificate } from './arca-fixtures.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const parent = createDatabaseClient(process.env.DATABASE_URL!),
  databaseName = 'maxbio_fiscal_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication,
  base: string,
  org: string,
  foreign: string,
  root: string,
  storage: LocalPrivateCredentialStorage;
let at = new Date(Date.now() + 10000),
  calls = 0,
  failWsaa = false,
  failAudit = false;
const cookies: string[] = [];
const fields = {
  // Accented legal name: OpenSSL for Windows must receive UTF-8 argv (OPENSSL_WIN32_UTF8).
  legalName: 'Biotecnología Compañía Test S.A.',
  tradeName: 'Comercio',
  cuit: '27-11024724-4',
  vatCondition: 'RESPONSABLE_INSCRIPTO',
  grossIncomeRegime: 'MULTILATERAL_AGREEMENT',
  grossIncomeNumber: '901-034461-6',
  addressLine: 'Bogotá 2314, piso 1, oficina 5',
  locality: 'CABA',
  province: 'CABA',
  postalCode: '1406',
  country: 'AR',
  nationalActivityCode: '477330',
  multilateralActivityCode: '464330',
};
async function request(path: string, method = 'GET', body?: unknown, actor = 0, csrf = true) {
  return fetch(base + '/api/v1/fiscal/' + path, {
    method,
    headers: {
      Cookie: cookies[actor]!,
      Origin: 'http://localhost:3000',
      ...(csrf ? { 'X-Maxbio-Csrf': '1' } : {}),
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
async function readiness(actor = 0) {
  return arcaReadinessSchema.parse(
    await checked(await request('arca/readiness', 'GET', undefined, actor)),
  );
}
async function generate(a: ArcaReadiness, extra: object = {}, actor = 0) {
  return arcaReadinessSchema.parse(
    await checked(
      await request(
        'arca/credentials/generate',
        'POST',
        {
          operationId: randomUUID(),
          expectedVersion: a.version,
          commonName: 'MaxBio Homologacion',
          ...extra,
        },
        actor,
      ),
    ),
  );
}
before(
  async () => {
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
    root = await mkdtemp(join(tmpdir(), 'maxbio-fiscal-integration-'));
    storage = new LocalPrivateCredentialStorage(root);
    org = (await client.organization.create({ data: { name: 'Fiscal test', slug: randomUUID() } }))
      .id;
    foreign = (await client.organization.create({ data: { name: 'Foreign', slug: randomUUID() } }))
      .id;
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreign, 'ADMIN'],
    ] as const) {
      const u = await client.user.create({
          data: { email: randomUUID() + '@example.invalid', displayName: 'Fiscal Test' },
        }),
        m = await client.membership.create({ data: { organizationId, userId: u.id, role } }),
        token = randomBytes(32).toString('base64url');
      await client.session.create({
        data: {
          userId: u.id,
          activeMembershipId: m.id,
          tokenHash: tokenVerifier(token),
          expiresAt: new Date('2099-01-01'),
          absoluteExpiresAt: new Date('2099-01-01'),
        },
      });
      cookies.push('maxbio-session=' + token);
    }
    process.env.DATABASE_URL = url.toString();
    const { AppModule } = await import('../src/app.module.js');
    const realAudit = new AuditService({ client } as DatabaseService);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({
        client,
        ping: async () => {
          await client.$queryRaw`SELECT 1`;
        },
      })
      .overrideProvider(CREDENTIAL_STORAGE)
      .useValue(storage)
      .overrideProvider(ARCA_CLOCK)
      .useValue({ now: () => at })
      .overrideProvider(AuditService)
      .useValue({
        append: realAudit.append.bind(realAudit),
        success: (...args: Parameters<AuditService['success']>) => {
          if (failAudit) throw new Error('Injected audit failure');
          return realAudit.success(...args);
        },
      })
      .overrideProvider(ArcaWsaaClient)
      .useValue({
        login: async () => {
          calls++;
          if (failWsaa) throw new ArcaError('SERVICE_UNAUTHORIZED');
          return {
            token: 'SECRET_TEST_TOKEN',
            sign: 'SECRET_TEST_SIGN',
            obtainedAt: at,
            expiresAt: new Date(at.getTime() + 43200000),
          };
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    // Test certificates start "now": a slow migrate above must not leave them not-yet-valid.
    at = new Date(Date.now() + 10000);
  },
  { timeout: 90000 },
);
after(async () => {
  if (app) await app.close();
  if (root)
    for (const organizationId of [org, foreign]) {
      const dir = join(root, organizationId);
      for (const name of await readdir(dir).catch(() => []))
        await storage.remove(organizationId, organizationId + '/' + name);
      await rmdir(dir).catch(() => {});
    }
  if (root) await rmdir(root);
  await client.$disconnect();
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});
test('Fiscal HTTP: partial/complete, version race, strict inputs, roles and CSRF', async () => {
  const initial = await readiness();
  assert.equal(initial.fiscalProfile, 'INCOMPLETE');
  assert.equal(initial.openssl, 'AVAILABLE');
  await checked(
    await request('profile', 'PUT', { ...fields, cuit: '27110247245', expectedVersion: 0 }),
    400,
  );
  const p = fiscalProfileResponseSchema.parse(
    await checked(await request('profile', 'PUT', { ...fields, expectedVersion: 0 })),
  ).profile!;
  assert.equal(p.completeness, 'COMPLETE');
  assert.equal(p.cuit, '27110247244');
  const race = await Promise.all([
    request('profile', 'PUT', { ...fields, expectedVersion: p.version }),
    request('profile', 'PUT', { ...fields, tradeName: 'Other', expectedVersion: p.version }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  for (const path of ['profile', 'arca/readiness'])
    await checked(await request(path, 'GET', undefined, 1), 403);
  await checked(await request('profile', 'PUT', { ...fields, expectedVersion: 2 }, 1), 403);
  await checked(await request('profile', 'PUT', { ...fields, expectedVersion: 2 }, 0, false), 403);
  for (const key of [
    'organizationId',
    'privateKey',
    'token',
    'sign',
    'endpoint',
    'productionUrl',
    'rawSoap',
  ])
    await checked(
      await request('profile', 'PUT', { ...fields, expectedVersion: 2, [key]: 'secret' }),
      400,
    );
  assert.equal(
    fiscalProfileResponseSchema.parse(await checked(await request('profile', 'GET', undefined, 2)))
      .profile,
    null,
  );
});
test('Credential HTTP: idempotent generation, CSR only, cross-tenant and upload validation', async () => {
  let a = await readiness();
  const operationId = randomUUID(),
    body = { operationId, expectedVersion: a.version, commonName: 'MaxBio Homologacion' };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => request('arca/credentials/generate', 'POST', body)),
  );
  for (const r of results) a = arcaReadinessSchema.parse(await checked(r));
  assert.equal(a.credentials.length, 1);
  assert.ok(a.pendingCredentialId);
  assert.equal(await client.arcaCredential.count(), 1);
  a = await generate(a);
  assert.equal(a.credentials.length, 1);
  const id = a.pendingCredentialId!;
  const csr = arcaCsrSchema.parse(await checked(await request(`arca/credentials/${id}/csr`)));
  assert.match(csr.pem, /BEGIN CERTIFICATE REQUEST/);
  assert.doesNotMatch(JSON.stringify(csr), /PRIVATE KEY/);
  const subject = await ephemeralFiles({ 'request.csr': csr.pem }, async (dir) =>
    (
      await crypto.command([
        'req',
        '-in',
        join(dir, 'request.csr'),
        '-verify',
        '-noout',
        '-subject',
        '-nameopt',
        'utf8',
      ])
    ).toString('utf8'),
  );
  assert.match(subject, /O=Biotecnología Compañía Test S\.A\./);
  assert.match(subject, /serialNumber=CUIT 27110247244/);
  for (const [path, method, body] of [
    [`arca/credentials/${id}/csr`, 'GET', undefined],
    [
      `arca/credentials/${id}/certificate`,
      'POST',
      { expectedVersion: 1, certificateBase64: 'YWJj' },
    ],
    [
      `arca/credentials/${id}/activate`,
      'POST',
      { expectedVersion: 1, expectedConfigVersion: a.version },
    ],
  ] as const) {
    await checked(await request(path, method, body, 2), 404);
    await checked(await request(path, method, body, 1), 403);
  }
  await checked(await request(`arca/credentials/${id}/private-key`), 404);
  await checked(
    await request(`arca/credentials/${id}/certificate`, 'POST', {
      expectedVersion: 1,
      certificateBase64: 'YWJj',
    }),
    400,
  );
  const row = (await client.arcaCredential.findFirst({ where: { organizationId: org, id } }))!,
    key = await storage.read(org, row.privateKeyStorageKey);
  try {
    const different = await crypto.generate('Other', '27110247244', 'MaxBio Homologacion');
    try {
      const cert = await testCertificate(different.privateKey);
      const b = await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: 1,
          certificateBase64: cert.toString('base64'),
        }),
        400,
      );
      assert.match(JSON.stringify(b), /no corresponde/);
    } finally {
      different.privateKey.fill(0);
    }
    const wrongCuit = await testCertificate(key, '20123456786');
    await checked(
      await request(`arca/credentials/${id}/certificate`, 'POST', {
        expectedVersion: 1,
        certificateBase64: wrongCuit.toString('base64'),
      }),
      400,
    );
    const cert = await testCertificate(key);
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: 1,
          certificateBase64: cert.toString('base64'),
        }),
      ),
    );
    assert.equal(a.canTest, false);
    assert.equal(a.trust, 'PENDING_WSAA');
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/activate`, 'POST', {
          expectedVersion: 2,
          expectedConfigVersion: a.version,
        }),
      ),
    );
    assert.equal(a.canTest, true);
    assert.equal(a.certificateMatchesKey, true);
    assert.ok(!JSON.stringify(a).includes(key.toString()));
  } finally {
    key.fill(0);
  }
});
test('WSAA HTTP: 20 calls single flight, server-only tickets, restart reservation, expiry and audit allowlist', async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => request('arca/wsaa/test', 'POST', {})),
  );
  for (const result of results) {
    const b = await checked(result);
    assert.equal(arcaReadinessSchema.parse(b).access.status, 'AUTHENTICATED');
    assert.doesNotMatch(JSON.stringify(b), /SECRET_TEST|BEGIN PRIVATE|token|"sign"/);
  }
  assert.equal(calls, 1);
  await checked(await request('arca/wsaa/test', 'POST', {}));
  assert.equal(calls, 1);
  app.get(ArcaTicketProvider).invalidate(org);
  const blocked = await readiness();
  assert.equal(blocked.access.status, 'WAITING');
  assert.equal(blocked.canTest, false);
  await checked(await request('arca/wsaa/test', 'POST', {}), 400);
  assert.equal(calls, 1);
  at = new Date(at.getTime() + 43200001);
  failWsaa = true;
  await checked(await request('arca/wsaa/test', 'POST', {}), 400);
  assert.equal(calls, 2);
  await checked(await request('arca/wsaa/test', 'POST', {}), 400);
  assert.equal(calls, 2);
  at = new Date(at.getTime() + 60001);
  failWsaa = false;
  await checked(await request('arca/wsaa/test', 'POST', {}));
  assert.equal(calls, 3);
  const events = await client.auditEvent.findMany({ where: { organizationId: org } });
  for (const name of [
    'FISCAL_PROFILE_UPDATED',
    'ARCA_CREDENTIAL_GENERATED',
    'ARCA_CERTIFICATE_INSTALLED',
    'ARCA_CREDENTIAL_ACTIVATED',
    'ARCA_WSAA_TEST_SUCCEEDED',
    'ARCA_WSAA_TEST_FAILED',
  ])
    assert.ok(
      events.some((e) => e.action === name),
      name,
    );
  for (const e of events) assert.deepEqual(e.metadata, {});
  assert.doesNotMatch(
    JSON.stringify(events),
    /SECRET_TEST|BEGIN PRIVATE|certificateBase64|rawSoap/,
  );
  const a = await readiness(),
    active = a.credentials.find((c) => c.id === a.activeCredentialId)!;
  at = new Date(new Date(active.validTo!).getTime() + 1);
  await checked(await request('arca/wsaa/test', 'POST', {}), 400);
  assert.equal(calls, 3);
  at = new Date(Date.now() + 10000);
});
test('Rotation and rollback: no overwritten key, stale activation, failed transaction removes only new files', async () => {
  let a = await readiness();
  const old = a.activeCredentialId!;
  const before = await readdir(join(root, org));
  failAudit = true;
  await checked(
    await request('arca/credentials/generate', 'POST', {
      operationId: randomUUID(),
      expectedVersion: a.version,
      commonName: 'MaxBio Homologacion',
      replacePending: true,
    }),
    500,
  );
  failAudit = false;
  assert.deepEqual((await readdir(join(root, org))).sort(), before.sort());
  assert.equal((await readiness()).activeCredentialId, old);
  a = await generate(a, { replacePending: true });
  const next = a.pendingCredentialId!;
  assert.notEqual(next, old);
  const row = (await client.arcaCredential.findFirst({
      where: { id: next, organizationId: org },
    }))!,
    oldRow = (await client.arcaCredential.findFirst({ where: { id: old, organizationId: org } }))!;
  assert.notEqual(row.privateKeyStorageKey, oldRow.privateKeyStorageKey);
  assert.ok(await storage.read(org, oldRow.privateKeyStorageKey));
  const key = await storage.read(org, row.privateKeyStorageKey);
  try {
    const cert = await testCertificate(key);
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${next}/certificate`, 'POST', {
          expectedVersion: 1,
          certificateBase64: cert.toString('base64'),
        }),
      ),
    );
    await checked(
      await request(`arca/credentials/${next}/activate`, 'POST', {
        expectedVersion: 1,
        expectedConfigVersion: a.version,
      }),
      409,
    );
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${next}/activate`, 'POST', {
          expectedVersion: 2,
          expectedConfigVersion: a.version,
        }),
      ),
    );
    assert.equal(a.activeCredentialId, next);
    assert.equal(a.credentials.find((c) => c.id === old)?.status, 'REPLACED');
    assert.equal(
      await client.arcaCredential.count({ where: { organizationId: org, status: 'ACTIVE' } }),
      1,
    );
    await assert.rejects(
      client.arcaCredential.update({ where: { id: old }, data: { status: 'ACTIVE' } }),
    );
  } finally {
    key.fill(0);
  }
  assert.equal(await client.invoice.count(), 0);
  assert.equal(await client.inventoryMovement.count(), 0);
  assert.equal(await client.deliveryNote.count(), 0);
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rmdir, rm } from 'node:fs/promises';
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
import {
  ARCA_CLOCK,
  ArcaError,
  type ArcaErrorCode,
} from '../src/modules/fiscal/arca/arca-errors.js';
import { ArcaWsaaClient } from '../src/modules/fiscal/arca/wsaa-client.js';
import { ArcaTicketProvider } from '../src/modules/fiscal/arca/ticket-provider.js';
import {
  TICKET_STORAGE,
  EncryptedPrivateTicketStorage,
} from '../src/modules/fiscal/infrastructure/private-ticket-storage.js';
import { CMS_SIGNER } from '../src/modules/fiscal/arca/openssl-crypto.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { crypto, ephemeralFiles, testCertificate, wsassCertificate } from './arca-fixtures.js';

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
  failAudit = false,
  wsaaIdentity: { cuit: string; commonName: string } | undefined;
let failRemoveKey: string | undefined;
let wsaaError: ArcaErrorCode | undefined;
let wsaaGate: { entered: () => void; wait: Promise<void> } | undefined;
const signedFingerprints: string[] = [];
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
      .useValue({
        put: storage.put.bind(storage),
        read: storage.read.bind(storage),
        remove: async (org: string, key: string) => {
          if (key === failRemoveKey) throw new Error('Injected storage failure');
          await storage.remove(org, key);
        },
      })
      .overrideProvider(TICKET_STORAGE)
      .useValue(
        new EncryptedPrivateTicketStorage(
          storage,
          new LocalPrivateCredentialStorage(join(root, 'tickets')),
        ),
      )
      .overrideProvider(CMS_SIGNER)
      .useValue({
        sign: async (xml: string, key: Buffer, cert: Buffer) => {
          signedFingerprints.push(new X509Certificate(cert).fingerprint256);
          return crypto.sign(xml, key, cert);
        },
      })
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
        login: async (_cms: string, identity: { cuit: string; commonName: string }) => {
          calls++;
          wsaaIdentity = identity;
          const gate = wsaaGate;
          gate?.entered();
          await gate?.wait;
          if (failWsaa) throw new ArcaError('SERVICE_UNAUTHORIZED');
          if (wsaaError) throw new ArcaError(wsaaError);
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
  if (root) {
    assert.ok(
      resolve(root).startsWith(resolve(tmpdir())) && root.includes('maxbio-fiscal-integration-'),
    );
    await rm(join(root, 'tickets'), { recursive: true, force: true });
    await rmdir(root);
  }
  await client.$disconnect();
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
});
test('Fiscal HTTP: partial/complete, version race, strict inputs, roles and CSRF', async () => {
  const initial = await readiness();
  assert.equal(initial.fiscalProfile, 'INCOMPLETE');
  assert.equal(initial.openssl, 'AVAILABLE');
  const noActive = await checked(await request('arca/wsaa/test', 'POST', {}), 400);
  assert.match(JSON.stringify(noActive), /No hay una credencial ARCA activa/);
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
    // Real WSASS DN: "SERIALNUMBER=CUIT n, CN=<alias>", no C, CN differs from the CSR CN.
    const cert = await wsassCertificate(await storage.read(org, row.csrStorageKey));
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: 1,
          certificateBase64: cert.toString('base64'),
        }),
      ),
    );
    const installed = a.credentials.find((c) => c.id === id)!;
    assert.equal(installed.status, 'CERTIFICATE_INSTALLED');
    // Same condition the UI uses to enable "Activar credencial de homologación".
    assert.ok(['VALID', 'EXPIRING_SOON'].includes(installed.certificateState));
    assert.ok(installed.validFrom && installed.validTo);
    assert.match(installed.subject ?? '', /CN=maxbiohomologacion/);
    assert.equal(installed.commonName, 'MaxBio Homologacion');
    assert.equal(a.canTest, false);
    assert.equal(a.trust, 'PENDING_WSAA');
    assert.equal(calls, 0);
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
  assert.deepEqual(wsaaIdentity, { cuit: '27110247244', commonName: 'maxbiohomologacion' });
  await checked(await request('arca/wsaa/test', 'POST', {}));
  assert.equal(calls, 1);
  app.get(ArcaTicketProvider).invalidate(org);
  assert.equal((await readiness()).access.status, 'AUTHENTICATED');
  const beforeNearExpiry = at;
  at = new Date(at.getTime() + 43140000);
  const nearExpiry = await readiness();
  assert.equal(nearExpiry.access.state, 'EXPIRING');
  assert.match(nearExpiry.access.testBlockedReason!, /próximo a vencer/);
  assert.equal(nearExpiry.canTest, false);
  at = beforeNearExpiry;
  await app.get(ArcaTicketProvider).remove(org, (await readiness()).activeCredentialId!);
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
  for (const e of events) {
    if (!e.action.startsWith('ARCA_WSAA_')) assert.deepEqual(e.metadata, {});
    else
      assert.ok(
        Object.keys(e.metadata as object).every((key) => ['code', 'retryAfter'].includes(key)),
      );
  }
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
test('ACTIVE + pending: WSAA signs with ACTIVE; discard is authorized, audited, retryable and leaves ACTIVE untouched', async () => {
  const a = await generate(await readiness());
  const activeId = a.activeCredentialId!,
    id = a.pendingCredentialId!;
  const activeBefore = await client.arcaCredential.findUniqueOrThrow({ where: { id: activeId } });
  const row = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  assert.equal(row.status, 'CSR_READY');
  assert.equal(row.certificateStorageKey, null);
  assert.equal(a.certificateMatchesKey, true);
  // Fresh CMS, not only cache reuse. Isolated test DB and mock WSAA.
  await app.get(ArcaTicketProvider).remove(org, activeId);
  await client.arcaIntegrationConfig.update({
    where: { organizationId: org },
    data: { authBlockedUntil: null },
  });
  const previousCalls = calls;
  const verified = arcaReadinessSchema.parse(
    await checked(await request('arca/wsaa/test', 'POST', {})),
  );
  assert.equal(calls, previousCalls + 1);
  assert.equal(signedFingerprints.at(-1), activeBefore.certificateFingerprint);
  assert.ok(verified.lastVerifiedAt);
  assert.equal(verified.activeCredentialId, activeId);
  const body = { expectedVersion: row.version };
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body, 1), 403);
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body, 2), 404);
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body, 0, false), 403);
  await checked(
    await request(`arca/credentials/${activeId}/discard`, 'POST', {
      expectedVersion: activeBefore.version,
    }),
    409,
  );
  await checked(await request(`arca/credentials/${activeId}/cleanup`, 'POST', {}), 409);
  await checked(
    await request(`arca/credentials/${id}/discard`, 'POST', { expectedVersion: row.version + 1 }),
    409,
  );
  failAudit = true;
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body), 500);
  failAudit = false;
  assert.equal(
    (await client.arcaCredential.findUniqueOrThrow({ where: { id } })).status,
    'CSR_READY',
  );
  (await storage.read(org, row.privateKeyStorageKey)).fill(0);
  failRemoveKey = row.csrStorageKey;
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body), 503);
  const retired = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  assert.equal(retired.status, 'DISCARDED');
  assert.ok(retired.discardedAt);
  assert.equal(retired.secretsDeletedAt, null);
  await assert.rejects(storage.read(org, row.privateKeyStorageKey));
  assert.ok(await storage.read(org, row.csrStorageKey));
  await checked(await request(`arca/credentials/${id}/csr`), 409);
  failRemoveKey = undefined;
  const discarded = arcaReadinessSchema.parse(
    await checked(await request(`arca/credentials/${id}/discard`, 'POST', body)),
  );
  assert.equal(discarded.activeCredentialId, activeId);
  assert.equal(discarded.pendingCredentialId, null);
  assert.ok(discarded.credentials.find((c) => c.id === id)?.secretsDeletedAt);
  await assert.rejects(storage.read(org, row.privateKeyStorageKey));
  await assert.rejects(storage.read(org, row.csrStorageKey));
  await checked(await request(`arca/credentials/${id}/discard`, 'POST', body));
  assert.equal(
    await client.auditEvent.count({
      where: { resourceId: id, action: 'ARCA_CREDENTIAL_DISCARDED' },
    }),
    1,
  );
  assert.equal(
    await client.auditEvent.count({
      where: { resourceId: id, action: 'ARCA_CREDENTIAL_SECRETS_REMOVED' },
    }),
    1,
  );
  await checked(await request('arca/wsaa/test', 'POST', {}));
  assert.equal(calls, previousCalls + 1, 'existing ticket reused for ACTIVE');
  assert.deepEqual(
    await client.arcaCredential.findUniqueOrThrow({ where: { id: activeId } }),
    activeBefore,
  );
  await checked(
    await request('arca/credentials/generate', 'POST', {
      operationId: row.generationOperationId,
      expectedVersion: a.version - 1,
      commonName: row.commonName,
    }),
    409,
  );
});

test('Discard installed certificate removes all three files; shared references fail closed', async () => {
  let a = await generate(await readiness());
  const id = a.pendingCredentialId!,
    activeId = a.activeCredentialId!;
  let row = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  const key = await storage.read(org, row.privateKeyStorageKey);
  try {
    const cert = await testCertificate(key);
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: row.version,
          certificateBase64: cert.toString('base64'),
        }),
      ),
    );
  } finally {
    key.fill(0);
  }
  row = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  assert.equal(a.activeCredentialId, activeId);
  const active = await client.arcaCredential.findUniqueOrThrow({ where: { id: activeId } });
  // A legacy cross-column reference must not allow deletion of ACTIVE's key.
  await client.arcaCredential.update({
    where: { id },
    data: { csrStorageKey: active.privateKeyStorageKey },
  });
  await checked(
    await request(`arca/credentials/${id}/discard`, 'POST', { expectedVersion: row.version }),
    409,
  );
  (await storage.read(org, active.privateKeyStorageKey)).fill(0);
  await client.arcaCredential.update({ where: { id }, data: { csrStorageKey: row.csrStorageKey } });
  a = arcaReadinessSchema.parse(
    await checked(
      await request(`arca/credentials/${id}/discard`, 'POST', { expectedVersion: row.version }),
    ),
  );
  for (const reference of [row.privateKeyStorageKey, row.csrStorageKey, row.certificateStorageKey!])
    await assert.rejects(storage.read(org, reference));
  assert.equal(a.activeCredentialId, activeId);
  assert.equal(a.certificateMatchesKey, true);
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
    assert.equal(a.activeCredentialId, old, 'installing B must not change ACTIVE A');
    assert.equal(a.certificateMatchesKey, true);
    failAudit = true;
    await checked(
      await request(`arca/credentials/${next}/activate`, 'POST', {
        expectedVersion: 2,
        expectedConfigVersion: a.version,
      }),
      500,
    );
    failAudit = false;
    assert.equal((await readiness()).activeCredentialId, old, 'activation rolls back atomically');
    (await storage.read(org, oldRow.privateKeyStorageKey)).fill(0);
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
    assert.ok(a.credentials.find((c) => c.id === old)?.replacedAt);
    assert.ok(a.credentials.find((c) => c.id === old)?.secretsDeletedAt);
    for (const reference of [
      oldRow.privateKeyStorageKey,
      oldRow.csrStorageKey,
      oldRow.certificateStorageKey!,
    ])
      await assert.rejects(storage.read(org, reference));
    assert.equal(
      await client.arcaCredential.count({ where: { organizationId: org, status: 'ACTIVE' } }),
      1,
    );
    await assert.rejects(
      client.arcaCredential.update({
        where: { id: old },
        data: { status: 'ACTIVE', secretsDeletedAt: null },
      }),
    );
  } finally {
    key.fill(0);
  }
  assert.equal(await client.invoice.count(), 0);
  assert.equal(await client.inventoryMovement.count(), 0);
  assert.equal(await client.deliveryNote.count(), 0);
});

test('Concurrent discard / activation has one winner and never removes the winning ACTIVE files', async () => {
  let a = await generate(await readiness());
  const id = a.pendingCredentialId!;
  const row = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  const key = await storage.read(org, row.privateKeyStorageKey);
  try {
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: row.version,
          certificateBase64: (await testCertificate(key)).toString('base64'),
        }),
      ),
    );
  } finally {
    key.fill(0);
  }
  const results = await Promise.all([
    request(`arca/credentials/${id}/activate`, 'POST', {
      expectedVersion: 2,
      expectedConfigVersion: a.version,
    }),
    request(`arca/credentials/${id}/discard`, 'POST', { expectedVersion: 2 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const active = await client.arcaCredential.findMany({
    where: { organizationId: org, status: 'ACTIVE' },
  });
  assert.equal(active.length, 1);
  assert.equal(active[0]!.secretsDeletedAt, null);
  (await storage.read(org, active[0]!.privateKeyStorageKey)).fill(0);
  assert.ok(await storage.read(org, active[0]!.certificateStorageKey!));
  assert.equal((await readiness()).certificateMatchesKey, true);
});

test('Late WSAA response for replaced A cannot overwrite readiness for new ACTIVE B', async () => {
  let a = await generate(await readiness());
  const old = a.activeCredentialId!,
    id = a.pendingCredentialId!;
  const row = await client.arcaCredential.findUniqueOrThrow({ where: { id } });
  const key = await storage.read(org, row.privateKeyStorageKey);
  try {
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/certificate`, 'POST', {
          expectedVersion: row.version,
          certificateBase64: (await testCertificate(key)).toString('base64'),
        }),
      ),
    );
  } finally {
    key.fill(0);
  }
  await app.get(ArcaTicketProvider).remove(org, old);
  await client.arcaIntegrationConfig.update({
    where: { organizationId: org },
    data: { authBlockedUntil: null },
  });
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  wsaaGate = {
    entered,
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  const flight = request('arca/wsaa/test', 'POST', {});
  try {
    await waiting;
    a = arcaReadinessSchema.parse(
      await checked(
        await request(`arca/credentials/${id}/activate`, 'POST', {
          expectedVersion: 2,
          expectedConfigVersion: a.version,
        }),
      ),
    );
    assert.equal(a.activeCredentialId, id);
    const reservation = await client.arcaIntegrationConfig.findUniqueOrThrow({
      where: { organizationId: org },
    });
    release();
    await checked(await flight, 409);
    const config = await client.arcaIntegrationConfig.findUniqueOrThrow({
      where: { organizationId: org },
    });
    assert.equal(config.lastResultCode, null);
    assert.deepEqual(config.authBlockedUntil, reservation.authBlockedUntil);
    assert.equal((await readiness()).lastVerifiedAt, null);
    assert.equal(
      (await client.arcaCredential.findUniqueOrThrow({ where: { id: old } })).status,
      'REPLACED',
    );
  } finally {
    release();
    wsaaGate = undefined;
  }
});

test('Corrupt multiple ACTIVE rows fail closed in readiness and WSAA; no CMS or WSAA call', async () => {
  const old = await client.arcaCredential.findFirstOrThrow({
    where: { organizationId: org, status: 'REPLACED', certificateStorageKey: { not: null } },
  });
  const previousCalls = calls,
    previousSignatures = signedFingerprints.length;
  // Only this disposable test DB. Simulate a restore without its partial unique index.
  await client.$executeRawUnsafe('DROP INDEX arca_one_active');
  try {
    await client.arcaCredential.update({
      where: { id: old.id },
      data: { status: 'ACTIVE', secretsDeletedAt: null },
    });
    for (const [path, method, body] of [
      ['arca/readiness', 'GET', undefined],
      ['arca/wsaa/test', 'POST', {}],
    ] as const) {
      const response = await checked(await request(path, method, body), 409);
      assert.match(JSON.stringify(response), /inconsistente/);
    }
    assert.equal(calls, previousCalls);
    assert.equal(signedFingerprints.length, previousSignatures);
  } finally {
    await client.arcaCredential.update({
      where: { id: old.id },
      data: { status: old.status, secretsDeletedAt: old.secretsDeletedAt },
    });
    await client.$executeRawUnsafe(
      `CREATE UNIQUE INDEX arca_one_active ON "ArcaCredential" ("organizationId", "environment") WHERE status = 'ACTIVE'`,
    );
  }
});

test('WSAA retry persistence, original error visibility, restart reservation and safe audit', async () => {
  const activeId = (await readiness()).activeCredentialId!;
  await app.get(ArcaTicketProvider).remove(org, activeId);
  for (const [code, long] of [
    ['CLOCK_ERROR', false],
    ['SERVICE_UNAUTHORIZED', false],
    ['WSAA_UNAVAILABLE', false],
    ['NETWORK_ERROR', true],
    ['INVALID_RESPONSE', true],
    ['TICKET_TIME_INVALID', true],
    ['ALREADY_AUTHENTICATED', true],
  ] as const) {
    await client.arcaIntegrationConfig.update({
      where: { organizationId: org },
      data: { authBlockedUntil: null },
    });
    wsaaError = code;
    const beforeCalls = calls;
    await checked(await request('arca/wsaa/test', 'POST', {}), 400);
    assert.equal(calls, beforeCalls + 1);
    const config = await client.arcaIntegrationConfig.findUniqueOrThrow({
      where: { organizationId: org },
    });
    assert.equal(config.lastResultCode, code);
    assert.equal(config.authBlockedUntil!.getTime() - at.getTime(), long ? 43500000 : 60000);
    const view = await readiness();
    assert.equal(view.canTest, false);
    assert.equal(view.access.lastResultCode, code);
    assert.ok(view.access.lastError);
    assert.ok(view.access.testBlockedReason);
    assert.ok(view.access.lastAttemptAt);
    await checked(await request('arca/wsaa/test', 'POST', {}), 400);
    assert.equal(calls, beforeCalls + 1);
    assert.equal((await readiness()).access.lastResultCode, code);
    const audit = await client.auditEvent.findFirstOrThrow({
      where: { resourceId: activeId, action: 'ARCA_WSAA_LOGIN_FAILED' },
      orderBy: { createdAt: 'desc' },
    });
    assert.deepEqual(audit.metadata, { code });
  }
  wsaaError = undefined;
  await client.arcaIntegrationConfig.update({
    where: { organizationId: org },
    data: { authBlockedUntil: null },
  });
  await checked(await request('arca/wsaa/test', 'POST', {}));
  assert.equal((await readiness()).access.status, 'AUTHENTICATED');
  app.get(ArcaTicketProvider).invalidate(org);
  const afterRestart = await readiness();
  assert.equal(afterRestart.access.status, 'AUTHENTICATED');
  assert.ok(afterRestart.lastVerifiedAt);
  assert.equal(afterRestart.canTest, true);
  await app.get(ArcaTicketProvider).remove(org, activeId);
  const legacy = await readiness();
  assert.equal(legacy.access.state, 'LOST_TICKET');
  assert.equal(legacy.canTest, false);
  assert.match(legacy.access.testBlockedReason!, /no está disponible en este proceso/);
  assert.equal(await client.invoiceFiscalAttempt.count(), 0);
});

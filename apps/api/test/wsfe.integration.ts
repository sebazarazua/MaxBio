import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  invoiceSchema,
  invoiceFiscalReadinessSchema,
  wsfeConfigurationSchema,
  type InvoiceView,
  type WsfeReferences,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { testDatabaseManagement } from './test-database-management.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import { FiscalService } from '../src/modules/fiscal/application/fiscal.service.js';
import { ARCA_CLOCK } from '../src/modules/fiscal/arca/arca-errors.js';
import {
  FISCAL_PROVIDER,
  WsfeError,
  type WsfeInvoice,
  type WsfeResult,
  type WsfeRegistered,
  type WsfeIdentity,
} from '../src/modules/fiscal/arca/wsfe-types.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN =
  process.env.MAXBIO_WSFE_BROWSER === '1' ? 'http://localhost:18030' : 'http://localhost:3000';
const parent = testDatabaseManagement(process.env.DATABASE_URL!),
  name = 'maxbio_wsfe_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + name;
const db = createDatabaseClient(url.toString());
let app: INestApplication,
  base: string,
  org: string,
  foreign: string,
  customerA: string,
  customerB: string,
  product: string,
  active: string;
let at = new Date('2026-10-28T20:00:00Z'),
  mode = 'authorize',
  sends = 0,
  failAuditAction = '',
  failLast = false;
let gate: { entered: () => void; wait: Promise<void> } | undefined;
let wsaaAvailable = true;
const cookies: string[] = [],
  emitted = new Map<string, WsfeRegistered>(),
  lastNumbers = new Map<string, number>();
const key = (a: WsfeIdentity, n?: number) =>
  `${a.pointOfSale}:${a.documentType}${n === undefined ? '' : ':' + n}`;
const refs: WsfeReferences = {
  points: [23, 42],
  conditions: {
    A: [
      { id: 1, label: 'IVA Responsable Inscripto' },
      { id: 6, label: 'Responsable Monotributo' },
    ],
    B: [
      { id: 5, label: 'Consumidor Final' },
      { id: 4, label: 'Exento' },
    ],
    C: [
      { id: 1, label: 'Responsable Inscripto' },
      { id: 5, label: 'Consumidor Final' },
    ],
  },
  documentTypes: [
    { id: 1, label: 'Factura A' },
    { id: 6, label: 'Factura B' },
    { id: 11, label: 'Factura C' },
  ],
  ivaTypes: [
    { id: 3, label: '0%' },
    { id: 4, label: '10.5%' },
    { id: 5, label: '21%' },
    { id: 6, label: '27%' },
  ],
};
const result = (i: WsfeInvoice): WsfeResult => ({
  result: 'A',
  cae: '740000' + String(i.documentType).padStart(2, '0') + String(i.number).padStart(6, '0'),
  caeExpiration: '20261107',
  messages: [],
  observations: [],
  events: [],
});
async function request(path: string, method = 'GET', body?: unknown, actor = 0, csrf = true) {
  return fetch(base + '/api/v1/' + path, {
    method,
    headers: {
      Cookie: cookies[actor]!,
      Origin: process.env.WEB_ORIGIN!,
      'Content-Type': 'application/json',
      ...(csrf ? { 'X-Maxbio-Csrf': '1' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function checked(r: Response, status = 200) {
  const b: unknown = await r.json();
  assert.equal(r.status, status, JSON.stringify(b));
  return b;
}
async function get(id: string) {
  return invoiceSchema.parse(await checked(await request('invoices/' + id)));
}
async function authorize(i: InvoiceView, operationId = randomUUID(), status = 200, actor = 0) {
  const body = await checked(
    await request(
      `invoices/${i.id}/fiscal/authorize`,
      'POST',
      { expectedVersion: i.version, operationId },
      actor,
    ),
    status,
  );
  return status === 200 ? invoiceSchema.parse(body) : body;
}
async function ready(type: 'INVOICE_A' | 'INVOICE_B' | 'INVOICE_C' = 'INVOICE_A') {
  const c = type === 'INVOICE_B' ? customerB : customerA;
  const note = (await checked(
    await request('delivery-notes', 'POST', {
      id: randomUUID(),
      customerId: c,
      documentDate: '2026-10-28',
      lines: [{ id: randomUUID(), productId: product, quantity: '1', allocations: [] }],
    }),
  )) as { id: string; version: number };
  await checked(
    await request(`delivery-notes/${note.id}/confirm`, 'POST', {
      expectedVersion: note.version,
      operationId: randomUUID(),
    }),
  );
  let i = invoiceSchema.parse(
    await checked(
      await request('invoices', 'POST', { id: randomUUID(), deliveryNoteIds: [note.id] }),
    ),
  );
  i = invoiceSchema.parse(
    await checked(
      await request('invoices/' + i.id, 'PATCH', {
        expectedVersion: i.version,
        invoiceType: type,
        issueDate: '2026-10-28',
        notes: null,
        lines: i.lines.map((l) => ({
          id: l.id,
          description: l.description,
          unitPrice: '100.00',
          vatRate: type === 'INVOICE_C' ? 'VAT_0' : 'VAT_21',
        })),
      }),
    ),
  );
  return invoiceSchema.parse(
    await checked(
      await request(`invoices/${i.id}/ready`, 'POST', {
        expectedVersion: i.version,
        operationId: randomUUID(),
      }),
    ),
  );
}
before(
  async () => {
    await parent.connect();
    await parent.query('CREATE DATABASE "' + name + '"');
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
    org = (await db.organization.create({ data: { name: 'WSFE test', slug: randomUUID() } })).id;
    foreign = (await db.organization.create({ data: { name: 'Foreign', slug: randomUUID() } })).id;
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreign, 'ADMIN'],
    ] as const) {
      const user = await db.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'Fiscal Test' },
      });
      const member = await db.membership.create({
          data: { organizationId, userId: user.id, role },
        }),
        token = randomBytes(32).toString('base64url');
      await db.session.create({
        data: {
          userId: user.id,
          activeMembershipId: member.id,
          tokenHash: tokenVerifier(token),
          expiresAt: new Date('2099-01-01'),
          absoluteExpiresAt: new Date('2099-01-01'),
        },
      });
      cookies.push('maxbio-session=' + token);
    }
    await db.organizationFiscalProfile.create({
      data: {
        organizationId: org,
        legalName: 'Emisor de pruebas',
        tradeName: 'Test',
        cuit: '27110247244',
        vatCondition: 'RESPONSABLE_INSCRIPTO',
        grossIncomeRegime: 'EXEMPT',
        addressLine: 'Calle de prueba 1',
        locality: 'CABA',
        province: 'CABA',
        postalCode: '1000',
        country: 'AR',
      },
    });
    await db.arcaIntegrationConfig.create({ data: { organizationId: org } });
    active = (
      await db.arcaCredential.create({
        data: {
          organizationId: org,
          commonName: 'Fake fixture',
          legalName: 'Test',
          cuit: '27110247244',
          generationOperationId: randomUUID(),
          generationHash: 'a'.repeat(64),
          privateKeyStorageKey: org + '/' + randomUUID(),
          csrStorageKey: org + '/' + randomUUID(),
          certificateStorageKey: org + '/' + randomUUID(),
          certificateFingerprint: 'public test',
          certificateSerial: '1',
          certificateSubject: 'Test',
          certificateIssuer: 'Test',
          validFrom: new Date('2026-01-01'),
          validTo: new Date('2028-01-01'),
          status: 'ACTIVE',
        },
      })
    ).id;
    customerA = (
      await db.customer.create({
        data: {
          organizationId: org,
          name: 'Receptor A',
          kind: 'COMPANY',
          cuit: '20123456786',
          arcaVatConditionId: 1,
          arcaVatConditionLabel: 'IVA Responsable Inscripto',
          searchText: 'receptor a',
        },
      })
    ).id;
    customerB = (
      await db.customer.create({
        data: {
          organizationId: org,
          name: 'Receptor B',
          kind: 'OTHER',
          cuit: '20111111112',
          arcaVatConditionId: 5,
          arcaVatConditionLabel: 'Consumidor Final',
          searchText: 'receptor b',
        },
      })
    ).id;
    product = (
      await db.product.create({
        data: {
          organizationId: org,
          name: 'Producto test',
          unitOfMeasure: 'UNIT',
          searchText: 'producto test',
        },
      })
    ).id;
    await db.deliveryNoteNumbering.create({
      data: { organizationId: org, prefix: '00001', nextNumber: 1, numberWidth: 8 },
    });
    const realAudit = new AuditService({ client: db } as DatabaseService);
    process.env.DATABASE_URL = url.toString();
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({
        client: db,
        ping: async () => {
          await db.$queryRaw`SELECT 1`;
        },
      })
      .overrideProvider(ARCA_CLOCK)
      .useValue({ now: () => at })
      .overrideProvider(FiscalService)
      .useValue({
        readiness: async () => ({
          environment: 'HOMOLOGATION',
          service: 'wsfe',
          version: 1,
          cuitValid: true,
          lastVerifiedAt: at.toISOString(),
          openssl: 'AVAILABLE',
          privateKey: true,
          csr: true,
          certificateInstalled: true,
          canTest: wsaaAvailable,
          pendingCredentialId: null,
          credentials: [
            {
              id: active,
              commonName: 'Synthetic browser fixture',
              status: 'ACTIVE',
              version: 1,
              createdAt: at.toISOString(),
              replacedAt: null,
              discardedAt: null,
              secretsDeletedAt: null,
              fingerprint: 'TEST',
              serial: '1',
              subject: 'Test',
              issuer: 'Test',
              validFrom: '2026-01-01T00:00:00.000Z',
              validTo: '2028-01-01T00:00:00.000Z',
              certificateState: 'VALID',
            },
          ],
          trust: 'VERIFIED_BY_WSAA',
          wsfeImplemented: true,
          productionEnabled: false,
          fiscalProfile: 'COMPLETE',
          certificateMatchesKey: true,
          cuit: '27110247244',
          activeCredentialId: active,
          access: {
            status: wsaaAvailable ? 'AUTHENTICATED' : 'WAITING',
            state: wsaaAvailable ? 'ACTIVE' : 'UNCERTAIN',
            retryAfter: null,
            obtainedAt: at.toISOString(),
            expiresAt: new Date(at.getTime() + 43200000).toISOString(),
            message: null,
            lastResultCode: 'SUCCESS',
            lastAttemptAt: at.toISOString(),
            lastError: null,
            testBlockedReason: null,
          },
        }),
        testConnection: async () => {
          // The browser fixture authenticates only against this disposable test double.
          const r = await fetch(base + '/api/v1/fiscal/arca/readiness', {
            headers: { Cookie: cookies[0]! },
          });
          return r.json();
        },
      })
      .overrideProvider(AuditService)
      .useValue({
        append: realAudit.append.bind(realAudit),
        success: (...args: Parameters<AuditService['success']>) => {
          if (args[1] === failAuditAction) throw new Error('Injected audit failure');
          return realAudit.success(...args);
        },
      })
      .overrideProvider(FISCAL_PROVIDER)
      .useValue({
        references: async () => ({
          references: structuredClone(refs),
          cuit: '27110247244',
          credentialId: active,
        }),
        last: async (_c: unknown, i: WsfeIdentity) => {
          if (failLast) throw new WsfeError('NETWORK');
          return lastNumbers.get(key(i)) ?? 0;
        },
        authorize: async (_c: unknown, i: WsfeInvoice) => {
          sends++;
          if (mode === 'reject')
            return {
              result: 'R',
              cae: null,
              caeExpiration: null,
              messages: [],
              observations: [{ code: '10016', message: 'Rechazo fiscal controlado' }],
              events: [],
            };
          if (mode === 'timeout_absent') throw new WsfeError('NETWORK');
          const out = result(i);
          emitted.set(key(i, i.number!), { invoice: structuredClone(i), result: out });
          lastNumbers.set(key(i), i.number!);
          if (mode === 'timeout_authorized') throw new WsfeError('NETWORK');
          const pending = gate;
          pending?.entered();
          await pending?.wait;
          return out;
        },
        consult: async (_c: unknown, i: WsfeIdentity, n: number) => {
          if (mode === 'consult_divergent') throw new WsfeError('DIVERGENT_RECORD');
          return structuredClone(emitted.get(key(i, n)) ?? null);
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  },
  { timeout: 90000 },
);
after(async () => {
  if (app) await app.close();
  await db.$disconnect();
  await parent.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
  await parent.end();
});

test(
  'Browser fixture: full UI preflight, disposable data, no authorization',
  { timeout: 660000 },
  async (t) => {
    if (process.env.MAXBIO_WSFE_BROWSER !== '1') {
      t.skip('Opt-in Playwright fixture');
      return;
    }
    const before = sends;
    let cfg = wsfeConfigurationSchema.parse(
      await checked(await request('fiscal/arca/invoicing/refresh', 'POST', {})),
    );
    cfg = wsfeConfigurationSchema.parse(
      await checked(
        await request('fiscal/arca/invoicing/point-of-sale', 'POST', {
          expectedVersion: cfg.version,
          pointOfSale: 23,
        }),
      ),
    );
    assert.equal(cfg.pointOfSale, 23);
    const invoice = await ready();
    const state = resolve('../../artifacts/ta-browser-state-private.json');
    const done = resolve('../../artifacts/ta-browser-done.json');
    await unlink(done).catch(() => {});
    await writeFile(
      state,
      JSON.stringify({
        cookies: [
          {
            name: 'maxbio-session',
            value: cookies[0]!.split('=')[1],
            domain: 'localhost',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      resolve('../../artifacts/ta-browser-fixture.json'),
      JSON.stringify({
        apiBase: base,
        invoiceId: invoice.id,
        productId: product,
        customerId: customerA,
        deliveryNoteId: invoice.deliveryNotes[0]!.id,
      }),
    );
    console.log(
      'Disposable browser fixture ready; waiting for Playwright preflight without authorization.',
    );
    try {
      let complete = false;
      for (let n = 0; n < 600; n++) {
        const result = await readFile(done, 'utf8').catch(() => '');
        if (result) {
          assert.equal(JSON.parse(result).success, true);
          complete = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      assert.ok(complete, 'Browser did not complete the preflight');
      assert.equal(sends, before, 'Browser must stop before authorization');
      assert.equal(await db.invoiceFiscalAttempt.count({ where: { invoiceId: invoice.id } }), 0);
    } finally {
      await unlink(state).catch(() => {});
    }
  },
);

test('Reference discovery and POS: server-validated values, confirmation, stale version, ADMIN and CSRF', async () => {
  let cfg = wsfeConfigurationSchema.parse(await checked(await request('fiscal/arca/invoicing')));
  assert.equal(cfg.ready, false);
  cfg = wsfeConfigurationSchema.parse(
    await checked(await request('fiscal/arca/invoicing/refresh', 'POST', {})),
  );
  assert.deepEqual(cfg.references?.points, [23, 42]);
  await checked(
    await request('fiscal/arca/invoicing/point-of-sale', 'POST', {
      expectedVersion: cfg.version,
      pointOfSale: 999,
    }),
    400,
  );
  await checked(
    await request('fiscal/arca/invoicing/point-of-sale', 'POST', {
      expectedVersion: cfg.version + 1,
      pointOfSale: 23,
    }),
    409,
  );
  cfg = wsfeConfigurationSchema.parse(
    await checked(
      await request('fiscal/arca/invoicing/point-of-sale', 'POST', {
        expectedVersion: cfg.version,
        pointOfSale: 23,
      }),
    ),
  );
  assert.equal(cfg.pointOfSale, 23);
  assert.equal(cfg.ready, true);
  await checked(await request('fiscal/arca/invoicing/refresh', 'POST', {}, 1), 403);
  await checked(await request('fiscal/arca/invoicing/refresh', 'POST', {}, 0, false), 403);
});

test('Readiness lists local recipient blockers alongside WSAA, missing references and missing POS without sending', async () => {
  const config = await db.arcaIntegrationConfig.findUniqueOrThrow({
    where: { organizationId: org },
  });
  const customer = await db.customer.findUniqueOrThrow({ where: { id: customerB } });
  const before = sends;
  try {
    await db.customer.update({
      where: { id: customerB },
      data: { cuit: null, arcaVatConditionId: null, arcaVatConditionLabel: null },
    });
    const i = await ready('INVOICE_B');
    const { DbNull } = await import('@maxbio/database');
    await db.arcaIntegrationConfig.update({
      where: { organizationId: org },
      data: {
        pointOfSale: null,
        pointOfSaleCuit: null,
        pointOfSaleValidatedAt: null,
        wsfeCheckedAt: null,
        wsfeReferences: DbNull,
      },
    });
    wsaaAvailable = false;
    const r = invoiceFiscalReadinessSchema.parse(
      await checked(await request(`invoices/${i.id}/fiscal/readiness`)),
    );
    assert.equal(r.ready, false);
    assert.deepEqual(r.conditions, []);
    for (const text of [
      'CUIT del cliente',
      'condición IVA del receptor',
      'referencias de ARCA',
      'punto de venta',
      'WSAA',
    ])
      assert.ok(
        r.reasons.some((reason) => reason.includes(text)),
        text,
      );
    assert.equal(sends, before);
    assert.equal(await db.invoiceFiscalAttempt.count({ where: { invoiceId: i.id } }), 0);
  } finally {
    wsaaAvailable = true;
    await db.customer.update({
      where: { id: customerB },
      data: {
        cuit: customer.cuit,
        arcaVatConditionId: customer.arcaVatConditionId,
        arcaVatConditionLabel: customer.arcaVatConditionLabel,
      },
    });
    await db.arcaIntegrationConfig.update({
      where: { organizationId: org },
      data: {
        pointOfSale: config.pointOfSale,
        pointOfSaleCuit: config.pointOfSaleCuit,
        pointOfSaleValidatedAt: config.pointOfSaleValidatedAt,
        wsfeCheckedAt: config.wsfeCheckedAt,
        wsfeReferences: config.wsfeReferences as never,
      },
    });
  }
  const good = await ready();
  const r = invoiceFiscalReadinessSchema.parse(
    await checked(await request(`invoices/${good.id}/fiscal/readiness`)),
  );
  assert.equal(r.ready, false);
  assert.equal(r.canCheckSequence, true, JSON.stringify(r.reasons));
  const sequence = invoiceFiscalReadinessSchema.parse(
    await checked(await request(`invoices/${good.id}/fiscal/sequence`, 'POST', {})),
  );
  assert.equal(sequence.ready, true, JSON.stringify(sequence.reasons));
  assert.equal(sequence.sequence?.status, 'VERIFIED');
  assert.equal(sends, before);
});

test('Sequence diagnostic reports remote errors, expires, respects access control and never authorizes', async () => {
  const i = await ready(),
    before = sends;
  await checked(await request(`invoices/${i.id}/fiscal/sequence`, 'POST', {}, 1), 403);
  await checked(await request(`invoices/${i.id}/fiscal/sequence`, 'POST', {}, 0, false), 403);
  await checked(
    await request(`invoices/${i.id}/fiscal/sequence`, 'POST', { authorize: true }),
    400,
  );
  failLast = true;
  const failure = invoiceFiscalReadinessSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/sequence`, 'POST', {})),
  );
  failLast = false;
  assert.equal(failure.ready, false);
  assert.equal(failure.sequence?.status, 'ERROR');
  const ok = invoiceFiscalReadinessSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/sequence`, 'POST', {})),
  );
  assert.equal(ok.ready, true);
  const savedTime = at;
  at = new Date(at.getTime() + 300001);
  const expired = invoiceFiscalReadinessSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/readiness`)),
  );
  assert.equal(expired.ready, false);
  assert.equal(expired.sequence?.status, 'PENDING');
  at = savedTime;
  assert.equal(sends, before);
  assert.equal(await db.invoiceFiscalAttempt.count({ where: { invoiceId: i.id } }), 0);
});

test('READY → CAE, replay, verification and commercial/fiscal immutability', async () => {
  const i = await ready(),
    op = randomUUID(),
    before = sends;
  const a = (await authorize(i, op)) as InvoiceView;
  assert.equal(a.fiscal?.status, 'AUTHORIZED');
  assert.match(a.fiscal!.attempts[0]!.cae!, /^\d{14}$/);
  assert.equal(a.fiscal!.attempts[0]!.documentNumber, 1);
  assert.equal(sends, before + 1);
  const replay = (await authorize(i, op)) as InvoiceView;
  assert.equal(replay.replayed, true);
  assert.equal(sends, before + 1);
  await checked(
    await request(`invoices/${i.id}/reopen`, 'POST', {
      expectedVersion: a.version,
      operationId: randomUUID(),
    }),
    409,
  );
  await checked(
    await request(`invoices/${i.id}/discard`, 'POST', { expectedVersion: a.version }),
    409,
  );
  await assert.rejects(
    db.invoice.update({ where: { id: i.id }, data: { issueDate: new Date('2026-10-29') } }),
  );
  await assert.rejects(
    db.invoice.update({
      where: { id: i.id },
      data: {
        status: 'DRAFT',
        fiscalStatus: 'NOT_SUBMITTED',
        readyAt: null,
        readyByUserId: null,
        readyByMembershipId: null,
        customerSnapshot: null as never,
      },
    }),
  );
  const attempt = await db.invoiceFiscalAttempt.findFirstOrThrow({ where: { invoiceId: i.id } });
  await assert.rejects(
    db.invoiceFiscalAttempt.update({ where: { id: attempt.id }, data: { cae: '11111111111111' } }),
  );
  await assert.rejects(
    db.invoiceFiscalAttempt.update({ where: { id: attempt.id }, data: { documentNumber: 77 } }),
  );
  const verified = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(verified.fiscal?.status, 'AUTHORIZED');
  assert.ok(verified.fiscal?.attempts[0]?.verifiedAt);
  assert.equal(verified.fiscal?.attempts[0]?.cae, a.fiscal?.attempts[0]?.cae);
});

test('Definitive rejection is retained; correction is explicit and a new operation can authorize', async () => {
  mode = 'reject';
  const i = await ready(),
    op = randomUUID(),
    before = sends;
  const rejected = (await authorize(i, op)) as InvoiceView;
  assert.equal(rejected.fiscal?.status, 'REJECTED');
  assert.equal(rejected.fiscal?.attempts[0]?.cae, null);
  assert.equal(rejected.fiscal?.attempts[0]?.observations[0]?.code, '10016');
  await authorize(i, op);
  assert.equal(sends, before + 1);
  let correction = invoiceSchema.parse(
    await checked(
      await request(`invoices/${i.id}/reopen`, 'POST', {
        expectedVersion: rejected.version,
        operationId: randomUUID(),
      }),
    ),
  );
  assert.equal(correction.status, 'DRAFT');
  assert.equal(correction.fiscal?.attempts[0]?.status, 'REJECTED');
  correction = invoiceSchema.parse(
    await checked(
      await request(`invoices/${i.id}/ready`, 'POST', {
        expectedVersion: correction.version,
        operationId: randomUUID(),
      }),
    ),
  );
  mode = 'authorize';
  const a = (await authorize(correction)) as InvoiceView;
  assert.equal(a.fiscal?.status, 'AUTHORIZED');
  assert.equal(a.fiscal?.attempts.length, 2);
  assert.equal(a.fiscal?.attempts[1]?.status, 'REJECTED');
});

test('Timeout with registration: UNCERTAIN blocks only its sequence and consult recovers CAE without resend', async () => {
  mode = 'timeout_authorized';
  const i = await ready(),
    before = sends;
  const uncertain = (await authorize(i)) as InvoiceView;
  assert.equal(uncertain.fiscal?.status, 'UNCERTAIN');
  const second = await ready();
  await authorize(second, randomUUID(), 409);
  mode = 'authorize';
  const b = (await authorize(await ready('INVOICE_B'))) as InvoiceView;
  assert.equal(b.fiscal?.status, 'AUTHORIZED');
  assert.equal(b.fiscal?.attempts[0]?.documentNumber, 1);
  const reconciled = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(reconciled.fiscal?.status, 'AUTHORIZED');
  assert.equal(reconciled.fiscal?.attempts[0]?.reconciliation, 'MATCH');
  assert.equal(sends, before + 2);
});

test('Concurrent same operation sends once; another invoice obtains the next number from provider', async () => {
  const i = await ready(),
    op = randomUUID(),
    before = sends;
  const responses = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(`invoices/${i.id}/fiscal/authorize`, 'POST', {
        expectedVersion: i.version,
        operationId: op,
      }),
    ),
  );
  for (const r of responses) assert.equal(r.status, 200, await r.text());
  assert.equal(sends, before + 1);
  const first = await get(i.id),
    next = (await authorize(await ready())) as InvoiceView;
  assert.equal(
    next.fiscal!.attempts[0]!.documentNumber,
    first.fiscal!.attempts[0]!.documentNumber! + 1,
  );
});

test('A registered voucher in a different fiscal mode becomes a conflict without resending', async () => {
  const i = await ready('INVOICE_B');
  mode = 'timeout_authorized';
  const uncertain = (await authorize(i)) as InvoiceView;
  const count = sends;
  assert.equal(uncertain.fiscal?.status, 'UNCERTAIN');
  mode = 'consult_divergent';
  const conflict = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  mode = 'authorize';
  assert.equal(conflict.fiscal?.status, 'CONFLICT');
  assert.equal(conflict.fiscal?.attempts[0]?.reconciliation, 'FISCAL_SEQUENCE_CONFLICT');
  assert.equal(sends, count);
});

test('In-flight owner expiry reconciles without resend; concurrent invoice cannot skip the pending number', async () => {
  const first = await ready(),
    second = await ready(),
    before = sends;
  let release: () => void = () => {},
    entered: () => void = () => {};
  const arrival = new Promise<void>((r) => {
    entered = r;
  });
  gate = {
    entered,
    wait: new Promise<void>((r) => {
      release = r;
    }),
  };
  const flight = request(`invoices/${first.id}/fiscal/authorize`, 'POST', {
    expectedVersion: first.version,
    operationId: randomUUID(),
  });
  try {
    await arrival;
    await authorize(second, randomUUID(), 409);
    assert.equal(sends, before + 1);
    at = new Date(at.getTime() + 90001);
    const recovered = invoiceSchema.parse(
      await checked(await request(`invoices/${first.id}/fiscal/verify`, 'POST', {})),
    );
    assert.equal(recovered.fiscal?.status, 'AUTHORIZED');
    release();
    await checked(await flight);
    gate = undefined;
    const next = (await authorize(second)) as InvoiceView;
    assert.equal(
      next.fiscal?.attempts[0]?.documentNumber,
      recovered.fiscal!.attempts[0]!.documentNumber! + 1,
    );
    assert.equal(sends, before + 2);
  } finally {
    release();
    gate = undefined;
  }
});

test('C authorization uses the issuer profile and independent ARCA sequence without VAT detail', async () => {
  await db.organizationFiscalProfile.update({
    where: { organizationId: org },
    data: { vatCondition: 'MONOTRIBUTO', version: { increment: 1 } },
  });
  try {
    const i = await ready('INVOICE_C'),
      out = (await authorize(i)) as InvoiceView;
    assert.equal(out.fiscal?.status, 'AUTHORIZED');
    assert.equal(out.fiscal?.attempts[0]?.documentType, 11);
    assert.equal(out.fiscal?.attempts[0]?.documentNumber, 1);
    const payload = emitted.get('23:11:1')!.invoice;
    assert.equal(payload.vat, '0.00');
    assert.deepEqual(payload.iva, []);
  } finally {
    await db.organizationFiscalProfile.update({
      where: { organizationId: org },
      data: { vatCondition: 'RESPONSABLE_INSCRIPTO', version: { increment: 1 } },
    });
  }
});

test('Timeout absent requires spaced consultations; old operation never resends and explicit new operation can use ARCA+1', async () => {
  mode = 'timeout_absent';
  const i = await ready(),
    op = randomUUID(),
    before = sends;
  await authorize(i, op);
  let current = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(current.fiscal?.status, 'UNCERTAIN');
  at = new Date(at.getTime() + 120001);
  current = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(current.fiscal?.status, 'UNCERTAIN');
  await authorize(i, op);
  assert.equal(sends, before + 1);
  at = new Date(at.getTime() + 60001);
  current = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(current.fiscal?.status, 'NOT_SUBMITTED');
  assert.equal(current.fiscal?.attempts[0]?.status, 'NOT_FOUND');
  await authorize(i, op);
  assert.equal(sends, before + 1);
  mode = 'authorize';
  current = (await authorize(current)) as InvoiceView;
  assert.equal(current.fiscal?.status, 'AUTHORIZED');
  assert.equal(sends, before + 2);
});

test('Audit rollback before send and after CAE: no blind retry, consult repairs persisted result', async () => {
  const i = await ready(),
    before = sends;
  failAuditAction = 'INVOICE_ARCA_AUTHORIZATION_REQUESTED';
  await authorize(i, randomUUID(), 500);
  failAuditAction = '';
  assert.equal(sends, before);
  assert.equal((await get(i.id)).fiscal?.status, 'NOT_SUBMITTED');
  failAuditAction = 'INVOICE_ARCA_AUTHORIZED';
  const uncertain = (await authorize(i)) as InvoiceView;
  failAuditAction = '';
  assert.equal(uncertain.fiscal?.status, 'UNCERTAIN');
  assert.equal(sends, before + 1);
  const recovered = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(recovered.fiscal?.status, 'AUTHORIZED');
  assert.equal(sends, before + 1);
});

test('Pre-send failure releases preparation safely, and missing/invalid recipient blocks emission', async () => {
  const i = await ready(),
    before = sends;
  failLast = true;
  await authorize(i, randomUUID(), 503);
  failLast = false;
  assert.equal(sends, before);
  assert.equal((await get(i.id)).fiscal?.attempts[0]?.status, 'ABORTED');
  const next = await ready();
  // A structured condition is never inferred from legacy free text.
  await db.invoice.update({
    where: { id: next.id },
    data: { receiverVatConditionId: null, receiverVatConditionLabel: null },
  });
  await authorize(next, randomUUID(), 400);
  assert.equal(sends, before);
  await checked(
    await request(`invoices/${next.id}/fiscal/receiver`, 'POST', {
      expectedVersion: next.version,
      conditionId: 5,
    }),
    400,
  );
  const filled = invoiceSchema.parse(
    await checked(
      await request(`invoices/${next.id}/fiscal/receiver`, 'POST', {
        expectedVersion: next.version,
        conditionId: 1,
      }),
    ),
  );
  assert.equal(filled.fiscal?.receiverVatConditionId, 1);
  assert.equal(
    (await db.customer.findUniqueOrThrow({ where: { id: customerA } })).arcaVatConditionId,
    1,
  );
});

test('Tenant isolation, OPERATOR, strict inputs and audit without fiscal secrets', async () => {
  const i = await ready();
  await authorize(i, randomUUID(), 403, 1);
  await authorize(i, randomUUID(), 404, 2);
  await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {}, 1), 403);
  await checked(
    await request(
      `invoices/${i.id}/fiscal/receiver`,
      'POST',
      { expectedVersion: i.version, conditionId: 1 },
      2,
    ),
    404,
  );
  for (const extra of [
    { organizationId: org },
    { cae: '11111111111111' },
    { documentNumber: 1 },
    { pointOfSale: 23 },
    { totalAmount: '1.00' },
    { fiscalStatus: 'AUTHORIZED' },
  ])
    await checked(
      await request(`invoices/${i.id}/fiscal/authorize`, 'POST', {
        expectedVersion: i.version,
        operationId: randomUUID(),
        ...extra,
      }),
      400,
    );
  const events = await db.auditEvent.findMany({
    where: { organizationId: org, action: { startsWith: 'INVOICE_ARCA_' } },
  });
  for (const e of events) assert.deepEqual(e.metadata, {});
  for (const action of [
    'INVOICE_ARCA_AUTHORIZATION_REQUESTED',
    'INVOICE_ARCA_AUTHORIZED',
    'INVOICE_ARCA_REJECTED',
    'INVOICE_ARCA_RESULT_UNCERTAIN',
    'INVOICE_ARCA_RECONCILED',
    'INVOICE_ARCA_VERIFIED',
  ])
    assert.ok(
      events.some((e) => e.action === action),
      action,
    );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE KEY|Token|Sign|SOAP/);
});

test('Authorization has no Inventory/Remito/trace side effects; divergent consultation blocks sequence', async () => {
  const i = await ready();
  const physical = () =>
    Promise.all([
      db.inventoryMovement.count(),
      db.inventoryBalance.count(),
      db.deliveryNoteAllocation.count(),
      db.deliveryNoteLineTrace.count(),
      db.deliveryNote.aggregate({ _sum: { version: true }, _max: { updatedAt: true } }),
    ]);
  const before = await physical();
  mode = 'timeout_authorized';
  const uncertain = (await authorize(i)) as InvoiceView;
  mode = 'authorize';
  assert.deepEqual(await physical(), before);
  const a = uncertain.fiscal!.attempts[0]!,
    stored = emitted.get(`${a.pointOfSale}:${a.documentType}:${a.documentNumber}`)!;
  stored.invoice.docNumber = '27110247244';
  const conflict = invoiceSchema.parse(
    await checked(await request(`invoices/${i.id}/fiscal/verify`, 'POST', {})),
  );
  assert.equal(conflict.fiscal?.status, 'CONFLICT');
  assert.equal(conflict.fiscal?.attempts[0]?.reconciliation, 'FISCAL_SEQUENCE_CONFLICT');
  await authorize(await ready(), randomUUID(), 409);
  await assert.rejects(
    db.fiscalSequence.update({
      where: {
        organizationId_environment_pointOfSale_documentType: {
          organizationId: org,
          environment: 'HOMOLOGATION',
          pointOfSale: 23,
          documentType: 1,
        },
      },
      data: { blockedAttemptId: null },
    }),
  );
});

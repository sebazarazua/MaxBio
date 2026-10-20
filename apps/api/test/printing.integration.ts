import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createDatabaseClient } from '@maxbio/database';
import {
  printTemplateSchema,
  printArtifactSchema,
  printCalibrationSchema,
  printEvaluationSchema,
  deliveryNoteSchema,
  deliveryNoteListSchema,
  inventoryDocumentSchema,
  inventoryStockDetailSchema,
  type PrintTemplate,
  type DeliveryNoteView,
} from '@maxbio/contracts';
import { configureApp } from '../src/configure-app.js';
import { DatabaseService } from '../src/infrastructure/database/database.service.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import { PrintingService } from '../src/modules/printing/application/printing.service.js';
import {
  PRINT_STORAGE,
  type LocalPrivatePrintStorage,
} from '../src/modules/printing/infrastructure/private-print-storage.js';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';
import { printingTemplateInput, printingPng } from './printing-fixtures.js';

process.env.NODE_ENV = 'test';
process.env.WEB_ORIGIN = 'http://localhost:3000';
const parent = createDatabaseClient(process.env.DATABASE_URL!);
const databaseName = 'maxbio_print_test_' + randomUUID().replaceAll('-', '');
const url = new URL(process.env.DATABASE_URL!);
url.pathname = '/' + databaseName;
const client = createDatabaseClient(url.toString());
let app: INestApplication, base: string, org: string, foreign: string, folder: string;
let customer: string, product: string, position: string, background: string;
let template: PrintTemplate, confirmed: DeliveryNoteView;
const cookies: string[] = [],
  actors: RequestActorContext[] = [];
async function request(path: string, method = 'GET', body?: unknown, actor = 0) {
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
  const data: unknown = await r.json();
  assert.equal(r.status, status, JSON.stringify(data));
  return data;
}
let seq = 0;
async function draft(extra: object = {}) {
  return deliveryNoteSchema.parse(
    await checked(
      await request(
        'delivery-notes',
        'POST',
        {
          id: randomUUID(),
          customerId: customer,
          documentDate: '2026-10-19',
          documentPrefix: '00001',
          documentNumber: String(++seq).padStart(8, '0'),
          patientName: 'PACIENTE PRIVADO',
          affiliateNumber: 'AF-PRIVADO',
          lines: [
            {
              id: randomUUID(),
              productId: product,
              quantity: '1',
              allocations: [{ positionId: position, quantity: '1' }],
            },
          ],
          ...extra,
        },
        1,
      ),
    ),
  );
}
function renderInput(d: DeliveryNoteView, t = template, calibrationId: string | null = null) {
  return { templateRevisionId: t.id, expectedVersion: d.version, calibrationId, guides: false };
}
before(
  async () => {
    assert.match(databaseName, /^maxbio_print_test_[a-f0-9]{32}$/);
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
    folder = await mkdtemp(join(tmpdir(), 'maxbio-print-'));
    process.env.PRINT_STORAGE_DIR = folder;
    org = (
      await client.organization.create({ data: { name: 'Printing tests', slug: randomUUID() } })
    ).id;
    foreign = (
      await client.organization.create({ data: { name: 'Foreign printing', slug: randomUUID() } })
    ).id;
    for (const [organizationId, role] of [
      [org, 'ADMIN'],
      [org, 'OPERATOR'],
      [foreign, 'ADMIN'],
    ] as const) {
      const user = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: role },
      });
      const membership = await client.membership.create({
        data: { organizationId, userId: user.id, role },
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
      cookies.push('maxbio-session=' + token);
      actors.push({
        organizationId,
        userId: user.id,
        membershipId: membership.id,
        sessionId: session.id,
        role,
        requestId: randomUUID(),
      });
    }
    customer = (
      await client.customer.create({
        data: {
          organizationId: org,
          name: 'Cliente de prueba',
          kind: 'COMPANY',
          addressLine: 'Calle 123',
        },
      })
    ).id;
    product = (
      await client.product.create({
        data: { organizationId: org, name: 'Producto X', unitOfMeasure: 'UNIT' },
      })
    ).id;
    await client.productInventoryPolicy.create({
      data: {
        organizationId: org,
        productId: product,
        lotRequired: true,
        expirationRequired: true,
      },
    });
    const supplier = (
      await client.supplier.create({ data: { organizationId: org, name: 'Proveedor' } })
    ).id;
    process.env.DATABASE_URL = url.toString();
    const { AppModule } = await import('../src/app.module.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ client, ping: async () => {} })
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    let receipt = inventoryDocumentSchema.parse(
      await checked(
        await request('inventory/receipts', 'POST', { id: randomUUID(), supplierId: supplier }, 1),
      ),
    );
    receipt = inventoryDocumentSchema.parse(
      await checked(
        await request(
          `inventory/receipts/${receipt.id}/lines/${randomUUID()}`,
          'PUT',
          {
            expectedVersion: receipt.version,
            productId: product,
            quantity: '20',
            unitOfMeasure: 'UNIT',
            lotNumber: 'LOTE-A',
            expirationDate: '2099-01-01',
            serialNumbers: [],
            condition: 'USABLE',
          },
          1,
        ),
      ),
    );
    await checked(
      await request(
        `inventory/receipts/${receipt.id}/confirm`,
        'POST',
        { expectedVersion: receipt.version, operationId: randomUUID() },
        1,
      ),
    );
    position = inventoryStockDetailSchema.parse(
      await checked(await request(`inventory/products/${product}`)),
    ).positions[0]!.id;
    const asset = (await checked(
      await request('printing/assets', 'POST', { pngBase64: printingPng().toString('base64') }),
    )) as { id: string };
    background = asset.id;
    template = printTemplateSchema.parse(
      await checked(await request('printing/templates', 'POST', printingTemplateInput(background))),
    );
    const d = await draft();
    confirmed = deliveryNoteSchema.parse(
      await checked(
        await request(
          `delivery-notes/${d.id}/confirm`,
          'POST',
          { expectedVersion: d.version, operationId: randomUUID() },
          1,
        ),
      ),
    );
  },
  { timeout: 120000 },
);
after(async () => {
  await app?.close();
  await client.$disconnect();
  assert.match(databaseName, /^maxbio_print_test_[a-f0-9]{32}$/);
  await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
  await parent.$disconnect();
  if (folder) {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    await rm(folder, { recursive: true, force: true });
  }
});

test('Printing HTTP: PNG privado, roles, tenant, formatos y proporción', async () => {
  const r = await request(`printing/assets/${background}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.match(r.headers.get('cache-control')!, /no-store/);
  await checked(await request(`printing/assets/${background}`, 'GET', undefined, 2), 404);
  await checked(
    await request('printing/assets', 'POST', { pngBase64: printingPng().toString('base64') }, 1),
    403,
  );
  await checked(
    await request('printing/assets', 'POST', {
      pngBase64: Buffer.from('<svg>arbitrary</svg>').toString('base64'),
    }),
    400,
  );
  await checked(
    await request('printing/templates', 'POST', printingTemplateInput(background), 1),
    403,
  );
  await checked(
    await request('printing/templates', 'POST', printingTemplateInput(background), 2),
    404,
  );
  await checked(
    await request('printing/templates', 'POST', {
      ...printingTemplateInput(background),
      pageHeightMm: 500,
    }),
    400,
  );
});
test('Printing HTTP: preview DRAFT, guías, evaluación, overlay exige CONFIRMED y PUBLISHED', async () => {
  const d = await draft();
  const physicalBefore = await physicalState();
  const documentBefore = await client.deliveryNote.findUnique({
    where: { id: d.id },
    include: { lines: { include: { allocations: true } } },
  });
  const input = renderInput(d);
  const r = await request(`printing/delivery-notes/${d.id}/preview`, 'POST', {
    ...input,
    guides: true,
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type')!, /application\/pdf/);
  assert.match(Buffer.from(await r.arrayBuffer()).toString('ascii', 0, 5), /%PDF-/);
  const e = printEvaluationSchema.parse(
    await checked(await request(`printing/delivery-notes/${d.id}/evaluate`, 'POST', input)),
  );
  assert.equal(e.state, 'SAFE');
  await checked(await request(`printing/delivery-notes/${d.id}/preview`, 'POST', input, 1), 403);
  const generation = {
    id: randomUUID(),
    templateRevisionId: template.id,
    expectedVersion: d.version,
    calibrationId: null,
  };
  await checked(
    await request(`printing/delivery-notes/${d.id}/artifacts`, 'POST', generation),
    409,
  );
  await checked(await request(`printing/delivery-notes/${d.id}/preview`, 'POST', input, 2), 404);
  await checked(
    await request(`printing/delivery-notes/${d.id}/preview`, 'POST', {
      ...input,
      expectedVersion: 100,
    }),
    409,
  );
  await checked(
    await request(`printing/templates/${template.id}/publish`, 'POST', { activate: false }, 1),
    403,
  );
  template = printTemplateSchema.parse(
    await checked(
      await request(`printing/templates/${template.id}/publish`, 'POST', { activate: false }),
    ),
  );
  await checked(
    await request(`printing/delivery-notes/${d.id}/artifacts`, 'POST', generation, 1),
    409,
  );
  const publishedPreview = await request(
    `printing/delivery-notes/${d.id}/preview`,
    'POST',
    input,
    1,
  );
  assert.equal(publishedPreview.status, 200);
  assert.deepEqual(await physicalState(), physicalBefore);
  assert.deepEqual(
    await client.deliveryNote.findUnique({
      where: { id: d.id },
      include: { lines: { include: { allocations: true } } },
    }),
    documentBefore,
  );
});
test('Printing: published immutable en SQL, revisión nueva, calibración inmutable y compatibilidad', async () => {
  await assert.rejects(
    client.printTemplate.update({
      where: { id: template.id },
      data: { name: 'Mutación prohibida' },
    }),
  );
  const next = printTemplateSchema.parse(
    await checked(
      await request('printing/templates', 'POST', {
        ...printingTemplateInput(background),
        sourceTemplateId: template.id,
      }),
    ),
  );
  assert.equal(next.familyId, template.familyId);
  assert.equal(next.revision, 2);
  assert.equal(next.status, 'DRAFT');
  const cal = printCalibrationSchema.parse(
    await checked(
      await request('printing/calibrations', 'POST', {
        id: randomUUID(),
        templateRevisionId: template.id,
        name: 'Equipo y bandeja',
        offsetXmm: 0.1,
        offsetYmm: 0.1,
      }),
    ),
  );
  await assert.rejects(
    client.printerCalibration.update({ where: { id: cal.id }, data: { offsetXmm: 1 } }),
  );
  const revision = printCalibrationSchema.parse(
    await checked(
      await request('printing/calibrations', 'POST', {
        id: randomUUID(),
        sourceCalibrationId: cal.id,
        templateRevisionId: template.id,
        name: 'Equipo y bandeja',
        offsetXmm: 0.2,
        offsetYmm: 0.1,
      }),
    ),
  );
  assert.equal(revision.revision, 2);
  assert.equal(revision.familyId, cal.familyId);
  await checked(
    await request(
      'printing/calibrations',
      'POST',
      {
        id: randomUUID(),
        templateRevisionId: template.id,
        name: 'Sin permiso',
        offsetXmm: 0,
        offsetYmm: 0,
      },
      1,
    ),
    403,
  );
  await checked(
    await request(
      'printing/calibrations',
      'POST',
      {
        id: randomUUID(),
        templateRevisionId: template.id,
        name: 'Ajena',
        offsetXmm: 0,
        offsetYmm: 0,
      },
      2,
    ),
    404,
  );
  await checked(
    await request(
      `printing/delivery-notes/${confirmed.id}/preview`,
      'POST',
      renderInput(confirmed, next, cal.id),
    ),
    404,
  );
  const pdf = await request('printing/calibration-test', 'POST', {
    templateRevisionId: template.id,
    calibrationId: revision.id,
  });
  assert.equal(pdf.status, 200);
  await checked(
    await request(
      'printing/calibration-test',
      'POST',
      { templateRevisionId: template.id, calibrationId: null },
      1,
    ),
    403,
  );
});
async function physicalState() {
  return {
    movements: await client.inventoryMovement.findMany({ orderBy: { id: 'asc' } }),
    balances: await client.inventoryBalance.findMany({ orderBy: { id: 'asc' } }),
    document: await client.deliveryNote.findUnique({
      where: { id: confirmed.id },
      include: { lines: { include: { allocations: true } } },
    }),
  };
}
test('Printing: generación concurrente idempotente, exact reprint y cero cambios DeliveryNote/OUTBOUND/balance', async () => {
  const before = await physicalState();
  const calibration = await client.printerCalibration.findFirstOrThrow({
    where: { organizationId: org, templateRevisionId: template.id },
  });
  const input = {
    id: randomUUID(),
    templateRevisionId: template.id,
    expectedVersion: confirmed.version,
    calibrationId: calibration.id,
  };
  const responses = await Promise.all([
    request(`printing/delivery-notes/${confirmed.id}/artifacts`, 'POST', input, 1),
    request(`printing/delivery-notes/${confirmed.id}/artifacts`, 'POST', input, 1),
  ]);
  const a = printArtifactSchema.parse(await checked(responses[0]!));
  const b = printArtifactSchema.parse(await checked(responses[1]!));
  assert.equal(a.id, b.id);
  assert.equal(a.calibrationId, calibration.id);
  const r = await request(`printing/artifacts/${a.id}/pdf`, 'GET', undefined, 1);
  assert.equal(r.status, 200);
  const bytes = Buffer.from(await r.arrayBuffer());
  const reprintId = randomUUID();
  const reprint = printArtifactSchema.parse(
    await checked(
      await request(`printing/artifacts/${a.id}/reprint`, 'POST', { id: reprintId }, 1),
    ),
  );
  assert.equal(reprint.contentHash, a.contentHash);
  assert.equal(reprint.reprintOfId, a.id);
  assert.equal(reprint.templateRevisionId, a.templateRevisionId);
  assert.equal(reprint.calibrationId, a.calibrationId);
  assert.equal(reprint.documentVersion, a.documentVersion);
  const retry = printArtifactSchema.parse(
    await checked(
      await request(`printing/artifacts/${a.id}/reprint`, 'POST', { id: reprintId }, 1),
    ),
  );
  assert.equal(retry.id, reprint.id);
  assert.deepEqual(
    Buffer.from(await (await request(`printing/artifacts/${reprint.id}/pdf`)).arrayBuffer()),
    bytes,
  );
  assert.deepEqual(await physicalState(), before);
  assert.equal(await client.printArtifact.count({ where: { organizationId: org } }), 2);
  assert.equal(
    await client.auditEvent.count({
      where: { organizationId: org, action: 'DELIVERY_NOTE_PRINT_ARTIFACT_GENERATED' },
    }),
    2,
  );
  await checked(await request(`printing/artifacts/${a.id}/pdf`, 'GET', undefined, 2), 404);
  await checked(
    await request(`printing/artifacts/${a.id}/reprint`, 'POST', { id: randomUUID() }, 2),
    404,
  );
  await checked(
    await request(`printing/delivery-notes/${confirmed.id}/artifacts`, 'GET', undefined, 2),
    404,
  );
  await checked(
    await request(
      `printing/delivery-notes/${confirmed.id}/artifacts`,
      'POST',
      { ...input, expectedVersion: 1 },
      1,
    ),
    409,
  );
  await assert.rejects(
    client.printArtifact.update({ where: { id: a.id }, data: { contentHash: 'a'.repeat(64) } }),
  );
  const record = await client.printArtifact.findUniqueOrThrow({ where: { id: a.id } });
  await assert.rejects(
    client.printArtifact.create({
      data: { ...record, id: randomUUID(), calibrationId: null, reprintOfId: a.id },
    }),
  );
  await assert.rejects(
    client.printArtifact.create({
      data: { ...record, id: randomUUID(), contentHash: 'a'.repeat(64) },
    }),
  );
  await assert.rejects(
    client.printAsset.update({
      where: {
        id: (await client.printArtifact.findUniqueOrThrow({ where: { id: a.id } })).assetId,
      },
      data: { byteSize: 1 },
    }),
  );
});
test('Printing: fallo de auditoría revierte registro/asset y limpia archivo privado', async () => {
  const audit = app.get(AuditService),
    original = audit.success;
  const storage = app.get<LocalPrivatePrintStorage>(PRINT_STORAGE);
  const disk = async () => readdir(join(folder, org));
  const before = await physicalState(),
    files = await disk(),
    count = await client.printAsset.count();
  audit.success = () => {
    throw new Error('Injected audit failure');
  };
  try {
    await assert.rejects(
      app.get(PrintingService).generate(actors[0]!, confirmed.id, {
        id: randomUUID(),
        templateRevisionId: template.id,
        expectedVersion: confirmed.version,
        calibrationId: null,
      }),
    );
  } finally {
    audit.success = original;
  }
  assert.ok(storage);
  assert.deepEqual(await disk(), files);
  assert.equal(await client.printAsset.count(), count);
  assert.deepEqual(await physicalState(), before);
});
test('Printing: plantilla activa bloquea confirmación directa con overflow, guarda atomicidad e idempotencia', async () => {
  const d = await draft();
  await checked(
    await request(`printing/templates/${template.id}/publish`, 'POST', { activate: true }),
  );
  await client.customer.update({ where: { id: customer }, data: { name: 'W'.repeat(160) } });
  const before = await client.inventoryMovement.count(),
    balance = await client.inventoryBalance.findMany();
  const input = { expectedVersion: d.version, operationId: randomUUID() };
  const rejected = await request(`delivery-notes/${d.id}/confirm`, 'POST', input, 1);
  await checked(rejected, 409);
  assert.equal(
    (await client.deliveryNote.findUniqueOrThrow({ where: { id: d.id } })).status,
    'DRAFT',
  );
  assert.equal(await client.inventoryMovement.count(), before);
  assert.deepEqual(await client.inventoryBalance.findMany(), balance);
  await client.customer.update({ where: { id: customer }, data: { name: 'Cliente de prueba' } });
  const first = deliveryNoteSchema.parse(
    await checked(await request(`delivery-notes/${d.id}/confirm`, 'POST', input, 1)),
  );
  const replay = deliveryNoteSchema.parse(
    await checked(await request(`delivery-notes/${d.id}/confirm`, 'POST', input, 1)),
  );
  assert.equal(first.movementId, replay.movementId);
  assert.equal(replay.replayed, true);
  assert.equal(await client.inventoryMovement.count(), before + 1);
  const audit = await client.auditEvent.findMany({
    where: { organizationId: org, action: { startsWith: 'PRINT_' } },
  });
  assert.ok(audit.some((a) => a.action === 'PRINT_TEMPLATE_CREATED'));
  assert.ok(audit.some((a) => a.action === 'PRINT_TEMPLATE_PUBLISHED'));
  assert.ok(audit.some((a) => a.action === 'PRINT_CALIBRATION_UPDATED'));
  assert.ok(audit.every((a) => !JSON.stringify(a.metadata).includes('PRIVADO')));
});

test('Printing: WARNING permite confirmar; calibración insegura bloquea overlay sin tocar stock', async () => {
  const input = printingTemplateInput(background);
  input.definition.fields[0]!.paddingMm = 0.2;
  const warning = printTemplateSchema.parse(
    await checked(await request('printing/templates', 'POST', input)),
  );
  await checked(
    await request(`printing/templates/${warning.id}/publish`, 'POST', { activate: true }),
  );
  try {
    const d = await draft();
    const evaluation = printEvaluationSchema.parse(
      await checked(
        await request(
          `printing/delivery-notes/${d.id}/evaluate`,
          'POST',
          renderInput(d, warning),
          1,
        ),
      ),
    );
    assert.equal(evaluation.state, 'WARNING');
    const beforeCount = await client.inventoryMovement.count();
    const confirmedWarning = deliveryNoteSchema.parse(
      await checked(
        await request(
          `delivery-notes/${d.id}/confirm`,
          'POST',
          { expectedVersion: d.version, operationId: randomUUID() },
          1,
        ),
      ),
    );
    assert.equal(confirmedWarning.status, 'CONFIRMED');
    assert.equal(await client.inventoryMovement.count(), beforeCount + 1);
    const calibration = printCalibrationSchema.parse(
      await checked(
        await request('printing/calibrations', 'POST', {
          id: randomUUID(),
          templateRevisionId: warning.id,
          name: 'Desplazamiento inseguro de prueba',
          offsetXmm: -4,
          offsetYmm: 0,
        }),
      ),
    );
    const physicalBefore = await physicalState();
    const artifactCount = await client.printArtifact.count();
    const blocked = printEvaluationSchema.parse(
      await checked(
        await request(
          `printing/delivery-notes/${confirmedWarning.id}/evaluate`,
          'POST',
          renderInput(confirmedWarning, warning, calibration.id),
          1,
        ),
      ),
    );
    assert.equal(blocked.state, 'BLOCKED');
    await checked(
      await request(
        `printing/delivery-notes/${confirmedWarning.id}/artifacts`,
        'POST',
        {
          id: randomUUID(),
          templateRevisionId: warning.id,
          expectedVersion: confirmedWarning.version,
          calibrationId: calibration.id,
        },
        1,
      ),
      409,
    );
    assert.equal(await client.printArtifact.count(), artifactCount);
    assert.deepEqual(await physicalState(), physicalBefore);
  } finally {
    await checked(
      await request(`printing/templates/${template.id}/publish`, 'POST', { activate: true }),
    );
  }
});

test(
  'Printing BFF real: Next compilado → API → PostgreSQL/storage → PDF privado y worker local',
  {
    skip: process.env.MAXBIO_PRINT_BFF_SMOKE !== '1',
    timeout: 60000,
  },
  async () => {
    // Opt-in because this smoke needs a prior web build and an available port 3000.
    const web = resolve('../web');
    const server = spawn(
      process.execPath,
      [
        join(web, 'node_modules', 'next', 'dist', 'bin', 'next'),
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        '3000',
      ],
      {
        cwd: web,
        env: {
          ...process.env,
          NODE_ENV: 'production',
          WEB_ORIGIN: 'http://localhost:3000',
          API_BASE_URL: base,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let logs = '';
    server.stdout.on('data', (d) => {
      logs += String(d);
    });
    server.stderr.on('data', (d) => {
      logs += String(d);
    });
    const closed = new Promise<void>((resolve) => server.once('exit', () => resolve()));
    async function bff(path: string, body?: unknown, cookie = cookies[1]!) {
      return fetch('http://localhost:3000/api/printing/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'X-Maxbio-Csrf': '1',
          'Content-Type': 'application/json',
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    }
    try {
      let ready = false;
      for (let n = 0; n < 80; n++) {
        if (server.exitCode !== null) throw new Error(logs);
        try {
          ready = (
            await fetch('http://localhost:3000/api/system-status', {
              signal: AbortSignal.timeout(500),
            })
          ).ok;
        } catch {
          /* startup */
        }
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, logs);
      const before = await physicalState();
      for (const q of [
        confirmed.documentPrefix + '-' + confirmed.documentNumber,
        'Cliente de prueba',
      ]) {
        const response = await fetch('http://localhost:3000/api/delivery-notes/search', {
          method: 'POST',
          headers: {
            Origin: 'http://localhost:3000',
            'X-Maxbio-Csrf': '1',
            'Content-Type': 'application/json',
            Cookie: cookies[0]!,
          },
          body: JSON.stringify({ q, page: '1', limit: '20', includeArchived: 'false' }),
        });
        const list = deliveryNoteListSchema.parse(await checked(response));
        assert.ok(list.items.some((note) => note.id === confirmed.id));
        const selected = list.items.find((note) => note.id === confirmed.id)!;
        assert.equal(selected.customerName, confirmed.customer.name);
        assert.equal(selected.documentDate, confirmed.documentDate);
      }
      const worker = await fetch('http://localhost:3000/api/printing/pdf-worker');
      assert.equal(worker.status, 200, logs);
      assert.match(worker.headers.get('content-type')!, /javascript/);
      assert.ok((await worker.text()).includes('WorkerMessageHandler'));
      const input = renderInput(confirmed);
      const result = printEvaluationSchema.parse(
        await checked(await bff(`delivery-notes/${confirmed.id}/evaluate`, input)),
      );
      assert.equal(result.state, 'SAFE');
      const preview = await bff(`delivery-notes/${confirmed.id}/preview`, input);
      assert.equal(preview.status, 200, logs);
      assert.match(preview.headers.get('content-type')!, /application\/pdf/);
      assert.match(preview.headers.get('cache-control')!, /no-store/);
      assert.equal(Buffer.from(await preview.arrayBuffer()).toString('ascii', 0, 5), '%PDF-');
      const generated = printArtifactSchema.parse(
        await checked(
          await bff(`delivery-notes/${confirmed.id}/artifacts`, {
            id: randomUUID(),
            templateRevisionId: template.id,
            expectedVersion: confirmed.version,
            calibrationId: null,
          }),
        ),
      );
      const first = Buffer.from(await (await bff(`artifacts/${generated.id}/pdf`)).arrayBuffer());
      const reprint = printArtifactSchema.parse(
        await checked(await bff(`artifacts/${generated.id}/reprint`, { id: randomUUID() })),
      );
      assert.deepEqual(
        Buffer.from(await (await bff(`artifacts/${reprint.id}/pdf`)).arrayBuffer()),
        first,
      );
      assert.deepEqual(await physicalState(), before);
      await checked(await bff(`artifacts/${generated.id}/pdf`, undefined, cookies[2]!), 404);
      const page = await fetch('http://localhost:3000/remitos/impresion');
      assert.equal(page.status, 200, logs);
    } finally {
      server.kill();
      await closed;
    }
  },
);

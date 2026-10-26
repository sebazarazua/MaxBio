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
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { createDatabaseClient } from '@maxbio/database';
import {
  printTemplateSchema,
  printArtifactSchema,
  printCalibrationSchema,
  printEvaluationSchema,
  printGeometryPreviewSchema,
  printDraftPreviewSchema,
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
    await client.deliveryNoteNumbering.create({
      data: { organizationId: org, prefix: '00001', nextNumber: 1n, numberWidth: 8 },
    });
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

test('PRINT TEST HTTP: same overlay for sample and document, preview background, isolated calibration and no writes', async () => {
  const d = await draft({
    lines: [{ id: randomUUID(), productId: product, quantity: '5', allocations: [] }],
  });
  const before = {
    physical: await physicalState(),
    artifacts: await client.printArtifact.count(),
    assets: await client.printAsset.count(),
    audits: await client.auditEvent.count(),
    disk: await readdir(join(folder, org)),
  };
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const inspect = async (path: string, body: object) => {
    const response = await request('printing/' + path, 'POST', body);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/pdf');
    assert.match(response.headers.get('cache-control')!, /no-store/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false });
    try {
      const pdf = await task.promise;
      const text = (await (await pdf.getPage(1)).getTextContent()).items
        .flatMap((i) => ('str' in i ? [i.str] : []))
        .join(' ');
      const structure = await PDFDocument.load(bytes);
      assert.equal(structure.getPageCount(), 1);
      assert.equal(structure.catalog.getOrCreateViewerPreferences().getPrintScaling(), 'None');
      assert.ok(
        Math.abs(structure.getPage(0).getWidth() - (template.pageWidthMm * 72) / 25.4) < 1e-6,
      );
      const images =
        structure.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)?.keys()
          .length ?? 0;
      return { text, images };
    } finally {
      await task.destroy();
    }
  };
  const body = { templateRevisionId: template.id, calibrationId: null };
  for (const extra of [{}, { document: { id: d.id, expectedVersion: d.version } }]) {
    const overlay = await inspect('print-test', { ...body, ...extra });
    assert.equal(overlay.images, 0);
    assert.match(overlay.text, /Producto X/);
    assert.doesNotMatch(overlay.text, /PRUEBA|TAMANO REAL|X 0 mm|BORRADOR|VISTA PREVIA/);
    const preview = await inspect('print-test-preview', { ...body, ...extra });
    assert.equal(preview.images, 1);
    assert.equal(preview.text, overlay.text);
  }
  const calibration = await inspect('calibration-test', body);
  assert.match(calibration.text, /PRUEBA - TAMANO REAL 100%/);
  assert.match(calibration.text, /X 0 mm \/ Y 0 mm/);
  await checked(await request('printing/print-test', 'POST', body, 1), 403);
  await checked(await request('printing/print-test', 'POST', body, 2), 404);
  await checked(
    await request('printing/print-test', 'POST', {
      ...body,
      document: { id: randomUUID(), expectedVersion: 1 },
    }),
    404,
  );
  await checked(
    await request('printing/print-test', 'POST', {
      ...body,
      document: { id: d.id, expectedVersion: 99 },
    }),
    409,
  );
  await checked(await request('printing/print-test', 'POST', { ...body, guides: true }), 400);
  assert.deepEqual(
    {
      physical: await physicalState(),
      artifacts: await client.printArtifact.count(),
      assets: await client.printAsset.count(),
      audits: await client.auditEvent.count(),
      disk: await readdir(join(folder, org)),
    },
    before,
  );
});
test('Editor HTTP: geometría no guardada ADMIN, aislamiento, versión y nueva revisión DRAFT exacta', async () => {
  const template = printTemplateSchema.parse(
    await checked(await request('printing/templates', 'POST', printingTemplateInput(background))),
  );
  const d = await draft();
  const physicalBefore = await physicalState();
  const noteBefore = await client.deliveryNote.findUnique({ where: { id: d.id } });
  const definition = structuredClone(template.definition);
  definition.fields[0]!.xMm += 0.5;
  const input = {
    templateRevisionId: template.id,
    expectedVersion: d.version,
    calibrationId: null,
    definition,
  };
  const route = `printing/delivery-notes/${d.id}/geometry-preview`;
  const result = printGeometryPreviewSchema.parse(
    await checked(await request(route, 'POST', input)),
  );
  assert.equal(Buffer.from(result.pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(result.envelopes.filter((e) => e.region === definition.fields[0]!.id).length, 1);
  assert.equal(result.evaluation.state, 'SAFE');
  assert.deepEqual(
    (await client.printTemplate.findUnique({ where: { id: template.id } }))!.definition,
    template.definition,
  );
  await checked(await request(route, 'POST', input, 1), 403);
  await checked(await request(route, 'POST', input, 2), 404);
  await checked(await request(route, 'POST', { ...input, expectedVersion: d.version + 1 }), 409);
  await checked(await request(route, 'POST', { ...input, calibrationId: randomUUID() }), 404);
  const invalid = structuredClone(definition);
  invalid.fields[0]!.xMm = 179;
  await checked(await request(route, 'POST', { ...input, definition: invalid }), 400);
  await checked(await request(route, 'POST', { ...input, zoom: 2 }), 400);
  const saved = printTemplateSchema.parse(
    await checked(
      await request('printing/templates', 'POST', {
        ...printingTemplateInput(background),
        sourceTemplateId: template.id,
        definition,
      }),
    ),
  );
  assert.equal(saved.status, 'DRAFT');
  assert.equal(saved.publishedAt, null);
  assert.equal(saved.familyId, template.familyId);
  assert.deepEqual(saved.definition, definition);
  assert.deepEqual(await client.deliveryNote.findUnique({ where: { id: d.id } }), noteBefore);
  assert.deepEqual(await physicalState(), physicalBefore);
});

test('Editor HTTP: muestra en memoria sin remito guardado, privada y solo ADMIN', async () => {
  const before = {
    physical: await physicalState(),
    notes: await client.deliveryNote.count(),
    assets: await client.printAsset.count(),
    templates: await client.printTemplate.count(),
  };
  const route = `printing/templates/${template.id}/geometry-preview`;
  const input = { calibrationId: null, definition: template.definition };
  const response = printGeometryPreviewSchema.parse(
    await checked(await request(route, 'POST', input)),
  );
  assert.equal(response.evaluation.rowCount, 2);
  assert.equal(Buffer.from(response.pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  await checked(await request(route, 'POST', input, 1), 403);
  await checked(await request(route, 'POST', input, 2), 404);
  await checked(await request(route, 'POST', { ...input, calibrationId: randomUUID() }), 404);
  await checked(await request(route, 'POST', { ...input, documentNumber: 'evil' }), 400);
  assert.deepEqual(
    {
      physical: await physicalState(),
      notes: await client.deliveryNote.count(),
      assets: await client.printAsset.count(),
      templates: await client.printTemplate.count(),
    },
    before,
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
      const noteCount = await client.deliveryNote.count();
      const artifactCount = await client.printArtifact.count();
      for (const path of ['print-test', 'print-test-preview', 'calibration-test']) {
        const response = await bff(
          path,
          { templateRevisionId: template.id, calibrationId: null },
          cookies[0]!,
        );
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/pdf');
        assert.match(response.headers.get('cache-control')!, /private, no-store/);
        assert.equal(
          Buffer.from(await response.arrayBuffer())
            .subarray(0, 5)
            .toString(),
          '%PDF-',
        );
      }
      for (const body of [
        {},
        {
          customerId: customer,
          documentDate: '2026-10-22',
          patientName: 'Paciente BFF',
          lines: [
            {
              productId: product,
              quantity: '1',
              allocations: [{ positionId: position, quantity: '1' }],
            },
          ],
        },
      ]) {
        const transient = printDraftPreviewSchema.parse(
          await checked(await bff('draft-preview', body)),
        );
        assert.equal(Buffer.from(transient.pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
        assert.equal('envelopes' in transient, false);
      }
      assert.equal(await client.deliveryNote.count(), noteCount);
      assert.equal(await client.printArtifact.count(), artifactCount);
      assert.deepEqual(await physicalState(), before);
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
      const definition = structuredClone(template.definition);
      definition.fields[0]!.xMm += 0.1;
      const geometryInput = {
        templateRevisionId: template.id,
        expectedVersion: confirmed.version,
        calibrationId: null,
        definition,
      };
      const geometryRoute = `delivery-notes/${confirmed.id}/geometry-preview`;
      const geometryResponse = await bff(geometryRoute, geometryInput, cookies[0]!);
      assert.match(geometryResponse.headers.get('cache-control')!, /private, no-store/);
      const geometry = printGeometryPreviewSchema.parse(await checked(geometryResponse));
      assert.equal(Buffer.from(geometry.pdfBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
      assert.equal(
        geometry.envelopes.filter((e) => e.region === definition.fields[0]!.id).length,
        1,
      );
      await checked(await bff(geometryRoute, geometryInput), 403);
      const savedGeometry = printTemplateSchema.parse(
        await checked(
          await bff(
            'templates',
            {
              ...printingTemplateInput(background),
              sourceTemplateId: template.id,
              definition,
            },
            cookies[0]!,
          ),
        ),
      );
      assert.equal(savedGeometry.status, 'DRAFT');
      assert.deepEqual(savedGeometry.definition, definition);
      const sampleResponse = printGeometryPreviewSchema.parse(
        await checked(
          await bff(
            `templates/${savedGeometry.id}/geometry-preview`,
            { definition, calibrationId: null },
            cookies[0]!,
          ),
        ),
      );
      assert.equal(sampleResponse.evaluation.rowCount, 2);
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

test('Preview efímera HTTP: parcial, datos autoritativos, OPERATOR, tenant y cero escrituras', async () => {
  const stockBeforeEdit = await physicalState();
  const source = await client.printTemplate.findUniqueOrThrow({ where: { id: template.id } });
  const newAsset = (await checked(
    await request('printing/assets', 'POST', { pngBase64: printingPng().toString('base64') }),
  )) as { id: string };
  const input = printingTemplateInput(newAsset.id);
  input.sourceTemplateId = template.id;
  const style = input.definition.fields[0]!;
  input.definition.fields.push(
    { ...style, id: 'patient', binding: 'patient.name', yMm: 210 },
    { ...style, id: 'affiliate', binding: 'patient.affiliateNumber', yMm: 225 },
  );
  const liveTemplate = printTemplateSchema.parse(
    await checked(await request('printing/templates', 'POST', input)),
  );
  assert.equal(liveTemplate.status, 'DRAFT');
  assert.equal(liveTemplate.familyId, template.familyId);
  assert.notEqual(liveTemplate.backgroundAssetId, template.backgroundAssetId);
  assert.deepEqual(
    await client.printTemplate.findUniqueOrThrow({ where: { id: template.id } }),
    source,
  );
  assert.deepEqual(await physicalState(), stockBeforeEdit);
  await checked(
    await request(`printing/templates/${liveTemplate.id}/publish`, 'POST', { activate: true }),
  );
  await checked(await request('printing/draft-preview', 'POST', {}, 2), 409);
  const foreignAsset = (await checked(
    await request('printing/assets', 'POST', { pngBase64: printingPng().toString('base64') }, 2),
  )) as { id: string };
  const foreignTemplate = printTemplateSchema.parse(
    await checked(
      await request('printing/templates', 'POST', printingTemplateInput(foreignAsset.id), 2),
    ),
  );
  await checked(await request('printing/draft-preview', 'POST', {}, 2), 409);
  await checked(
    await request(
      `printing/templates/${foreignTemplate.id}/publish`,
      'POST',
      { activate: true },
      2,
    ),
  );
  await client.customer.create({
    data: { organizationId: foreign, name: 'Cliente ajeno', kind: 'COMPANY' },
  });
  // Establish the usual authenticated session activity before taking the business snapshot.
  await checked(await request('printing/config', 'GET', undefined, 1));
  const snapshot = async () => ({
    notes: await client.deliveryNote.findMany({
      include: { lines: { include: { allocations: true } } },
    }),
    physical: await physicalState(),
    customers: await client.customer.findMany(),
    products: await client.product.findMany(),
    artifacts: await client.printArtifact.findMany(),
    assets: await client.printAsset.findMany(),
    templates: await client.printTemplate.findMany(),
    audits: await client.auditEvent.findMany(),
    disk: await readdir(join(folder, org)),
  });
  const balance = await client.inventoryBalance.findUniqueOrThrow({
    where: { id: position },
    include: { lot: true },
  });
  const serial = await client.inventorySerial.create({
    data: {
      organizationId: org,
      productId: product,
      serialNumber: 'SERIE-LIVE-1',
      normalizedSerialNumber: 'SERIE-LIVE-1',
    },
  });
  const serialPosition = await client.inventoryBalance.create({
    data: {
      organizationId: org,
      productId: product,
      locationId: balance.locationId,
      serialId: serial.id,
      lotId: balance.lotId,
      condition: 'USABLE',
      quantity: 0,
    },
  });
  const before = await snapshot();
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  async function preview(body: object, actor = 1) {
    const r = await request('printing/draft-preview', 'POST', body, actor);
    assert.match(r.headers.get('cache-control')!, /no-store/);
    const result = printDraftPreviewSchema.parse(await checked(r));
    assert.equal(result.evaluation.templateRevisionId, liveTemplate.id);
    assert.equal('envelopes' in result, false);
    const task = getDocument({
      data: Uint8Array.from(Buffer.from(result.pdfBase64, 'base64')),
      useSystemFonts: false,
    });
    try {
      const pdf = await task.promise;
      const page = await pdf.getPage(1);
      const text = (await page.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join(' ');
      return { text, result };
    } finally {
      await task.destroy();
    }
  }
  try {
    const empty = await preview({});
    assert.equal(empty.text.trim(), '');
    assert.equal(empty.result.evaluation.rowCount, 0);
    const selected = await preview({ customerId: customer });
    assert.match(selected.text, /Cliente de prueba/);
    assert.match(selected.text, /Calle 123/);
    for (const date of ['2026-10-22', '2026-11-09']) {
      const dated = await preview({ documentDate: date });
      assert.ok(dated.text.includes(date.split('-').reverse().join('/')));
    }
    assert.match((await preview({ patientName: 'Paciente actual' })).text, /Paciente actual/);
    assert.match((await preview({ affiliateNumber: 'AF-2026' })).text, /AF-2026/);
    const line = {
      productId: product,
      quantity: '1',
      allocations: [] as { positionId: string; quantity: string }[],
    };
    assert.match((await preview({ lines: [line] })).text, /Producto X/);
    const allocated = await preview({
      lines: [{ ...line, allocations: [{ positionId: position, quantity: '1' }] }],
    });
    assert.ok(allocated.text.includes(balance.lot!.lotNumber!));
    assert.ok(
      allocated.text.includes(
        balance.lot!.expirationDate!.toISOString().slice(0, 10).split('-').reverse().join('/'),
      ),
    );
    const serialized = await preview({
      lines: [{ ...line, allocations: [{ positionId: serialPosition.id, quantity: '1' }] }],
    });
    assert.match(serialized.text, /SERIE-LIVE-1/);
    const otherCustomer = await client.customer.findFirst({ where: { organizationId: foreign } });
    for (const body of [
      { customerId: otherCustomer?.id ?? randomUUID() },
      { lines: [{ ...line, productId: randomUUID() }] },
      { lines: [{ ...line, allocations: [{ positionId: randomUUID(), quantity: '1' }] }] },
    ])
      await checked(await request('printing/draft-preview', 'POST', body, 1), 404);
    for (const body of [
      { customerName: 'Inventado' },
      { templateRevisionId: liveTemplate.id },
      { organizationId: foreign },
      { guides: true },
      { lines: [{ ...line, productName: 'Inventado' }] },
    ])
      await checked(await request('printing/draft-preview', 'POST', body, 1), 400);
    await checked(
      await request('printing/draft-preview', 'POST', { customerId: customer }, 2),
      404,
    );
    await checked(
      await request(
        'printing/draft-preview',
        'POST',
        { lines: [{ ...line, allocations: [{ positionId: position, quantity: '1' }] }] },
        2,
      ),
      404,
    );
    const response = await fetch(base + '/api/v1/printing/draft-preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://localhost:3000',
        'X-Maxbio-Csrf': '1',
      },
      body: '{}',
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await snapshot(), before);
  } finally {
    await checked(
      await request(`printing/templates/${template.id}/publish`, 'POST', { activate: true }),
    );
  }
});

test('Operational overlay without Inventory uses confirmed document and published template', async () => {
  const d = await draft({
    lines: [{ id: randomUUID(), productId: product, quantity: '5', allocations: [] }],
  });
  const confirmedNoStock = deliveryNoteSchema.parse(
    await checked(
      await request(
        `delivery-notes/${d.id}/confirm`,
        'POST',
        { operationId: randomUUID(), expectedVersion: d.version },
        1,
      ),
    ),
  );
  assert.equal(confirmedNoStock.movementId, null);
  await checked(
    await request(
      `printing/delivery-notes/${d.id}/artifacts`,
      'POST',
      { id: randomUUID(), ...renderInput(confirmedNoStock), guides: undefined },
      1,
    ),
  );
});

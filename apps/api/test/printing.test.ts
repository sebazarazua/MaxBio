import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  printTemplateCreateSchema,
  printRenderInputSchema,
  printingRouteContract,
  bourbonProvisionalTemplate,
  printTemplateSchema,
} from '@maxbio/contracts';
import {
  mmToPt,
  ptToMm,
  layoutDocument,
  formatPrintValue,
  projectRows,
  fieldValue,
  printingEnvelopes,
} from '../src/modules/printing/domain/geometry.js';
import {
  loadPrintMetrics,
  renderPdf,
  renderCalibrationTest,
} from '../src/modules/printing/infrastructure/pdf-renderer.js';
import { LocalPrivatePrintStorage } from '../src/modules/printing/infrastructure/private-print-storage.js';
import { printSampleDocument } from '../src/modules/printing/domain/sample-document.js';
import {
  printingTemplate,
  printingTemplateInput,
  printingDocument,
  printingPng,
} from './printing-fixtures.js';

test('Printing: mm/pt, contratos estrictos, límites físicos, columnas y namespaces de binding', () => {
  assert.equal(mmToPt(25.4), 72);
  assert.equal(ptToMm(72), 25.4);
  const v = printingTemplateInput();
  assert.equal(printTemplateCreateSchema.safeParse(v).success, true);
  for (const changes of [
    { pageWidthMm: 0 },
    { definition: { ...v.definition, code: 'evil()' } },
    {
      definition: {
        ...v.definition,
        fields: [{ ...v.definition.fields[0], binding: 'customer.password' }],
      },
    },
    { definition: { ...v.definition, fields: [{ ...v.definition.fields[0], xMm: 175 }] } },
    { safeToleranceXmm: 10 },
    { scaleX: 0.9 },
    { organizationId: randomUUID() },
  ])
    assert.equal(printTemplateCreateSchema.safeParse({ ...v, ...changes }).success, false);
  assert.equal(
    printRenderInputSchema.safeParse({ templateRevisionId: v.id, expectedVersion: 1, zoom: 2 })
      .success,
    false,
  );
  assert.equal(
    printingRouteContract(`delivery-notes/${randomUUID()}/preview`, 'POST')?.binary,
    'application/pdf',
  );
  assert.equal(printingRouteContract('arbitrary/path', 'GET'), null);
});
test('Printing: SAFE/WARNING/BLOCKED con métricas embebidas, texto largo y caja desplazada', async () => {
  const t = printingTemplate(),
    d = printingDocument(),
    metrics = await loadPrintMetrics();
  const safe = layoutDocument(d, t, metrics);
  assert.equal(safe.evaluation.state, 'SAFE', JSON.stringify(safe.evaluation));
  assert.ok(safe.bounds[0]!.safe.widthMm < t.definition.fields[0]!.widthMm);
  const warning = structuredClone(t);
  warning.definition.fields[0]!.paddingMm = 0.2;
  assert.equal(layoutDocument(d, warning, metrics).evaluation.state, 'WARNING');
  const long = structuredClone(d);
  long.customer.name = 'W'.repeat(160);
  assert.equal(layoutDocument(long, t, metrics).evaluation.state, 'BLOCKED');
  const shifted = layoutDocument(d, t, metrics, { offsetXmm: -4, offsetYmm: 0 });
  assert.equal(shifted.evaluation.state, 'BLOCKED');
  assert.equal(shifted.texts[0]!.xMm, safe.texts[0]!.xMm - 4);
  const unsupported = structuredClone(d);
  unsupported.customer.name = 'Cliente 😀';
  assert.equal(layoutDocument(unsupported, t, metrics).evaluation.state, 'BLOCKED');
});
test('Printing: multiline, opcionales vacíos, cantidades exactas y fechas de calendario', async () => {
  assert.equal(formatPrintValue('2026-10-19', 'date'), '19/10/2026');
  assert.equal(formatPrintValue('0.123456', 'quantity'), '0,123456');
  assert.equal(formatPrintValue('20123456786', 'cuit'), '20-12345678-6');
  assert.equal(formatPrintValue(null, 'date'), '');
  const t = printingTemplate(),
    d = printingDocument(),
    metrics = await loadPrintMetrics();
  const address = t.definition.fields.find((f) => f.id === 'address')!;
  d.customer.addressLine = 'Primera línea\nSegunda línea';
  const layout = layoutDocument(d, t, metrics);
  assert.equal(layout.evaluation.state, 'SAFE');
  assert.equal(layout.texts.filter((t) => t.region === 'address').length, 2);
  address.lineHeightPt = 9;
  assert.equal(layoutDocument(d, t, metrics).evaluation.state, 'BLOCKED');
  address.lineHeightPt = 13;
  address.maxLines = 1;
  assert.equal(layoutDocument(d, t, metrics).evaluation.state, 'BLOCKED');
  address.maxLines = 2;
  d.customer.addressLine = null;
  assert.equal(
    layoutDocument(d, t, metrics).texts.some((t) => t.region === 'address'),
    false,
  );
});
test('Printing: allocations múltiples, series, reconciliación, columnas faltantes y demasiadas filas', async () => {
  const d = printingDocument(),
    t = printingTemplate(),
    columns = t.definition.productRegion.columns;
  const rows = projectRows(d, columns);
  assert.deepEqual(
    rows.rows.map((r) => [r.quantity, r.lotNumber]),
    [
      ['2', 'A'],
      ['2', 'B'],
    ],
  );
  assert.equal(rows.issues.length, 0);
  d.lines[0]!.quantity = '2';
  d.lines[0]!.physicalTraces.forEach((a, i) => {
    a.quantity = '1';
    a.serialNumber = 'S' + i;
  });
  assert.deepEqual(
    projectRows(d, columns).rows.map((r) => r.serialNumber),
    ['S0', 'S1'],
  );
  assert.ok(
    projectRows(
      d,
      columns.filter((c) => c.binding !== 'serialNumber'),
    ).issues.some((i) => i.state === 'BLOCKED'),
  );
  d.lines[0]!.quantity = '3';
  assert.equal(projectRows(d, columns).issues.length, 0);
  assert.deepEqual(
    projectRows(d, columns).rows.map((r) => r.quantity),
    ['1', '1', '1'],
  );
  d.lines[0]!.quantity = '1';
  assert.ok(projectRows(d, columns).issues.some((i) => i.state === 'BLOCKED'));
  d.lines[0]!.quantity = '2';
  t.definition.productRegion.heightMm = t.definition.productRegion.rowHeightMm;
  const evaluated = layoutDocument(d, t, await loadPrintMetrics()).evaluation;
  assert.equal(evaluated.state, 'BLOCKED');
  assert.equal(evaluated.rowCount, 2);
  assert.equal(evaluated.maxRows, 1);
});

test('Printing: no stock and partial stock preserve all documentary rows in preview and overlay', async () => {
  const template = printingTemplate(),
    document = printingDocument();
  document.lines[0]!.quantity = '5';
  document.lines[0]!.physicalTraces = [];
  for (const mode of ['PREVIEW', 'PRINT_OVERLAY'] as const) {
    const result = await renderPdf({
      template,
      document,
      calibration: null,
      mode,
      background: printingPng(),
    });
    assert.equal(result.layout.evaluation.state, 'SAFE');
    assert.match(await content(result.bytes), /Producto X/);
    assert.deepEqual(
      projectRows(document, template.definition.productRegion.columns).rows.map((r) => [
        r.quantity,
        r.lotNumber,
        r.expirationDate,
        r.serialNumber,
      ]),
      [['5', '', '', '']],
    );
  }
  document.lines[0]!.physicalTraces = printingDocument().lines[0]!.physicalTraces.slice(0, 1);
  const projection = projectRows(document, template.definition.productRegion.columns);
  assert.deepEqual(
    projection.rows.map((r) => [r.quantity, r.lotNumber]),
    [
      ['2', 'A'],
      ['3', ''],
    ],
  );
  assert.equal(
    projection.rows.reduce((sum, r) => sum + Number(r.quantity), 0),
    5,
  );
  assert.equal(projection.issues.length, 0);
  document.lines[0]!.quantity = '1.999999';
  assert.ok(
    projectRows(document, template.definition.productRegion.columns).issues.some(
      (i) => i.state === 'BLOCKED',
    ),
  );
});

test('PRINT_OVERLAY: Bourbon page, only variable text, no background or technical operators', async () => {
  const template = printTemplateSchema.parse({
    ...printingTemplate(),
    ...bourbonProvisionalTemplate(randomUUID(), randomUUID()),
  });
  const document = printSampleDocument();
  const result = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PRINT_OVERLAY',
    background: printingPng(),
    guides: true,
  });
  assert.notEqual(
    result.layout.evaluation.state,
    'BLOCKED',
    JSON.stringify(result.layout.evaluation),
  );
  const pdf = await PDFDocument.load(result.bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.equal(pdf.getPage(0).getWidth(), mmToPt(203));
  assert.equal(pdf.getPage(0).getHeight(), mmToPt(271));
  assert.equal(pdf.catalog.getOrCreateViewerPreferences().getPrintScaling(), 'None');
  assert.equal(imageCount(pdf), 0);
  assert.doesNotMatch(operators(pdf), /\bre\b|\bDo\b|\bS\b|\bB\b/);
  const text = await content(result.bytes);
  for (const value of [
    'OSUTHGRA',
    'AV. DE MAYO',
    'CABA',
    '20-12345678-6',
    'CORIA',
    '20-91552262-6/01',
    'ABC-001',
    '31/12/2028',
  ])
    assert.ok(text.includes(value), value);
  assert.doesNotMatch(
    text,
    /PRUEBA|TAMANO REAL|X \/ Y|X\/Y|offset|safe|guide|BORRADOR|VISTA PREVIA/i,
  );
});

test('CALIBRATION SHEET: technical text and measurement crosses stay present', async () => {
  const bytes = await renderCalibrationTest(printingTemplate(), null);
  assert.match(await content(bytes), /PRUEBA - TAMANO REAL 100%/);
  assert.match(await content(bytes), /X 0 mm \/ Y 0 mm/);
  assert.match(operators(await PDFDocument.load(bytes)), /\bS\b/);
});
async function content(pdf: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({ data: Uint8Array.from(pdf), useSystemFonts: false });
  try {
    const doc = await task.promise;
    return (await (await doc.getPage(1)).getTextContent()).items
      .filter((i): i is typeof i & { str: string } => 'str' in i)
      .map((i) => i.str)
      .join(' ');
  } finally {
    await task.destroy();
  }
}
function imageCount(pdf: PDFDocument) {
  const x = pdf.getPage(0).node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
  return x?.keys().length ?? 0;
}
function operators(pdf: PDFDocument) {
  const page = pdf.getPage(0),
    stream = page.node.Contents();
  if (!stream) return '';
  const objects = 'asArray' in stream ? stream.asArray() : [stream];
  return objects
    .map((ref) => pdf.context.lookup(ref))
    .filter((s): s is PDFRawStream => s instanceof PDFRawStream)
    .map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString('ascii'))
    .join('\n');
}
test('PDF: página custom, fuente embebida, fondo solo PREVIEW, texto, una página y offsets exactos', async () => {
  const template = printingTemplate(),
    document = printingDocument();
  const preview = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PREVIEW',
    background: printingPng(),
    guides: true,
  });
  const overlay = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PRINT_OVERLAY',
    background: printingPng(),
    guides: true,
  });
  const p = await PDFDocument.load(preview.bytes),
    o = await PDFDocument.load(overlay.bytes);
  assert.equal(p.getPageCount(), 1);
  assert.equal(o.getPageCount(), 1);
  assert.ok(Math.abs(o.getPage(0).getWidth() - mmToPt(180)) < 0.000001);
  assert.ok(Math.abs(o.getPage(0).getHeight() - mmToPt(240)) < 0.000001);
  assert.equal(imageCount(p), 1);
  assert.equal(imageCount(o), 0);
  for (const pdf of [p, o]) {
    assert.equal(pdf.getPage(0).getWidth(), mmToPt(template.pageWidthMm));
    assert.equal(pdf.getPage(0).getHeight(), mmToPt(template.pageHeightMm));
    assert.equal(pdf.catalog.getOrCreateViewerPreferences().getPrintScaling(), 'None');
  }
  assert.equal(
    o.context
      .enumerateIndirectObjects()
      .some(
        ([, object]) =>
          object instanceof PDFRawStream &&
          object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
      ),
    false,
  );
  assert.doesNotMatch(operators(o), /\bre\b|\bDo\b|\bS\b/);
  assert.match(operators(o), /0 0 0 rg/);
  const withoutGuides = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PREVIEW',
    background: printingPng(),
  });
  const plainPreview = await PDFDocument.load(withoutGuides.bytes);
  assert.match(operators(p), /\bB\b/);
  assert.doesNotMatch(operators(plainPreview), /\bS\b|\bB\b/);
  const fontObjects = o.context
    .enumerateIndirectObjects()
    .map(([, v]) => v)
    .filter((v): v is PDFDict => v instanceof PDFDict);
  assert.ok(
    fontObjects.some((v) => v.has(PDFName.of('FontFile2')) || v.has(PDFName.of('FontFile3'))),
  );
  assert.match(await content(preview.bytes), /BORRADOR/);
  const text = await content(overlay.bytes);
  assert.match(text, /Cliente de prueba/);
  assert.match(text, /19\/10\/2026/);
  assert.match(text, /Producto X/);
  assert.doesNotMatch(text, /BORRADOR|VISTA PREVIA/);
  const calibrated = await renderPdf({
    template,
    document,
    calibration: { offsetXmm: 0.2, offsetYmm: 0.1 } as never,
    mode: 'PRINT_OVERLAY',
  });
  const moved = await PDFDocument.load(calibrated.bytes);
  assert.equal(moved.getPage(0).getWidth(), o.getPage(0).getWidth());
  assert.equal(moved.getPage(0).getHeight(), o.getPage(0).getHeight());
  const matrix = (s: string) => {
    const match = s.match(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/);
    assert.ok(match);
    return [Number(match[1]), Number(match[2])];
  };
  const a = matrix(operators(o)),
    b = matrix(operators(moved));
  assert.ok(Math.abs(b[0]! - a[0]! - mmToPt(0.2)) < 0.000001);
  assert.ok(Math.abs(b[1]! - a[1]! + mmToPt(0.1)) < 0.000001);
  const testPdf = await PDFDocument.load(await renderCalibrationTest(template, null));
  assert.equal(testPdf.getPageCount(), 1);
  assert.equal(testPdf.getPage(0).getWidth(), o.getPage(0).getWidth());
  assert.equal(testPdf.getPage(0).getHeight(), o.getPage(0).getHeight());
  assert.equal(testPdf.catalog.getOrCreateViewerPreferences().getPrintScaling(), 'None');
  assert.equal(imageCount(testPdf), 0);
  const shiftedTest = await PDFDocument.load(
    await renderCalibrationTest(template, {
      offsetXmm: 2,
      offsetYmm: -3,
    } as never),
  );
  const firstCross = (pdf: PDFDocument) => {
    const match = operators(pdf).match(/([\d.-]+) ([\d.-]+) m/);
    assert.ok(match);
    return [Number(match[1]), Number(match[2])];
  };
  const nominalCross = firstCross(testPdf),
    shiftedCross = firstCross(shiftedTest);
  assert.ok(Math.abs(shiftedCross[0]! - nominalCross[0]! - mmToPt(2)) < 0.000001);
  assert.ok(Math.abs(shiftedCross[1]! - nominalCross[1]! - mmToPt(3)) < 0.000001);
});

test('Printing: alineación en ambos ejes, wrapping y umbral de tolerancia sin duplicar offsets', async () => {
  const template = printingTemplate(),
    document = printingDocument(),
    metrics = await loadPrintMetrics();
  document.customer.name = 'Cliente';
  const field = template.definition.fields[0]!;
  for (const align of ['left', 'center', 'right'] as const)
    for (const verticalAlign of ['top', 'middle', 'bottom'] as const) {
      field.align = align;
      field.verticalAlign = verticalAlign;
      const nominal = layoutDocument(document, template, metrics);
      const { safe, text } = nominal.bounds[0]!;
      assert.ok(text);
      assert.equal(nominal.evaluation.state, 'SAFE');
      const horizontal =
        align === 'left'
          ? text.xMm - safe.xMm
          : align === 'right'
            ? safe.xMm + safe.widthMm - text.xMm - text.widthMm
            : text.xMm + text.widthMm / 2 - safe.xMm - safe.widthMm / 2;
      const vertical =
        verticalAlign === 'top'
          ? text.yMm - safe.yMm
          : verticalAlign === 'bottom'
            ? safe.yMm + safe.heightMm - text.yMm - text.heightMm
            : text.yMm + text.heightMm / 2 - safe.yMm - safe.heightMm / 2;
      assert.ok(Math.abs(horizontal) < 0.000001);
      assert.ok(Math.abs(vertical) < 0.000001);
      const moved = layoutDocument(document, template, metrics, { offsetXmm: 0.1, offsetYmm: 0.2 });
      assert.ok(Math.abs(moved.texts[0]!.xMm - nominal.texts[0]!.xMm - 0.1) < 0.000001);
      assert.ok(
        Math.abs(moved.texts[0]!.baselineMm - nominal.texts[0]!.baselineMm - 0.2) < 0.000001,
      );
    }
  field.align = 'left';
  field.verticalAlign = 'top';
  assert.equal(
    layoutDocument(document, template, metrics, { offsetXmm: -0.3, offsetYmm: 0 }).evaluation.state,
    'WARNING',
  );
  assert.equal(
    layoutDocument(document, template, metrics, { offsetXmm: -0.5, offsetYmm: 0 }).evaluation.state,
    'BLOCKED',
  );
  assert.equal(
    layoutDocument(document, template, metrics, { offsetXmm: 0, offsetYmm: -0.5 }).evaluation.state,
    'BLOCKED',
  );
  document.customer.name = 'Cliente de prueba con nombre extenso';
  field.widthMm = 40;
  field.heightMm = 15;
  const wrapped = layoutDocument(document, template, metrics);
  assert.equal(wrapped.evaluation.state, 'SAFE');
  assert.deepEqual(
    wrapped.texts.filter((text) => text.region === field.id).map((text) => text.text),
    ['Cliente de prueba con', 'nombre extenso'],
  );
  field.maxLines = 1;
  assert.equal(layoutDocument(document, template, metrics).evaluation.state, 'BLOCKED');
});
test('Storage privado: traversal y claves no scoped se rechazan antes de leer', async () => {
  const storage = new LocalPrivatePrintStorage();
  assert.throws(() => storage.read('../public/file'), /Invalid/);
  assert.throws(() => storage.read(randomUUID()), /Invalid/);
});

test('Bourbon: bindings de fecha sin zona horaria y domicilio desde el snapshot existente', () => {
  const d = printingDocument();
  for (const date of ['2024-02-29', '2026-01-01', '2026-12-31']) {
    d.documentDate = date;
    assert.equal(fieldValue(d, 'document.dateDay'), date.slice(8, 10));
    assert.equal(fieldValue(d, 'document.dateMonth'), date.slice(5, 7));
    assert.equal(fieldValue(d, 'document.dateYear'), date.slice(0, 4));
    assert.equal(fieldValue(d, 'document.date'), date);
  }
  d.customer.addressLine = 'AV. DE MAYO 930';
  d.customer.locality = 'CABA';
  d.customer.province = 'Buenos Aires';
  assert.equal(fieldValue(d, 'customer.addressLine'), 'AV. DE MAYO 930');
  assert.equal(fieldValue(d, 'customer.locality'), 'CABA');
  assert.equal(fieldValue(d, 'customer.address'), 'AV. DE MAYO 930 · CABA · Buenos Aires');
  d.customer.addressLine = null;
  d.customer.locality = null;
  assert.equal(fieldValue(d, 'customer.addressLine'), '');
  assert.equal(fieldValue(d, 'customer.locality'), '');
});

function bourbonTemplate() {
  return printTemplateSchema.parse({
    ...printingTemplate(),
    ...bourbonProvisionalTemplate(randomUUID(), randomUUID()),
    status: 'DRAFT',
    publishedAt: null,
  });
}
test('Bourbon: envolvente única usa bbox PDF, ±4/±3, fuente, contenido, multiline y calibración', async () => {
  const t = bourbonTemplate(),
    d = printingDocument(),
    metrics = await loadPrintMetrics();
  const f = t.definition.fields.find((f) => f.id === 'customer')!;
  f.fontSizePt = 9;
  d.customer.name = 'OSDE';
  function measure() {
    const layout = layoutDocument(d, t, metrics);
    const bound = layout.bounds.find((b) => b.region === f.id)!;
    const envelope = printingEnvelopes(layout, t).find((e) => e.region === f.id)!;
    assert.ok(bound.text);
    assert.equal(envelope.rect.xMm, bound.text.xMm - 4);
    assert.equal(envelope.rect.yMm, bound.text.yMm - 3);
    assert.equal(envelope.rect.widthMm, bound.text.widthMm + 8);
    assert.equal(envelope.rect.heightMm, bound.text.heightMm + 6);
    return { layout, envelope };
  }
  const nominal = measure();
  assert.ok(Math.abs(nominal.envelope.rect.widthMm - ptToMm(metrics.width('OSDE', 9)) - 8) < 1e-9);
  f.fontSizePt = 12;
  const larger = measure();
  assert.ok(larger.envelope.rect.widthMm > nominal.envelope.rect.widthMm);
  assert.ok(larger.envelope.rect.heightMm > nominal.envelope.rect.heightMm);
  f.fontSizePt = 9;
  d.customer.name = 'OSUTHGRA';
  assert.ok(measure().envelope.rect.widthMm > nominal.envelope.rect.widthMm);
  d.customer.name = 'OSDE\nOSUTHGRA';
  f.heightMm = 14;
  f.maxLines = 2;
  const multiline = measure();
  assert.ok(multiline.envelope.rect.heightMm > nominal.envelope.rect.heightMm);
  assert.equal(multiline.layout.texts.filter((p) => p.region === f.id).length, 2);
  assert.equal(printingEnvelopes(multiline.layout, t).filter((e) => e.region === f.id).length, 1);
  f.maxLines = 1;
  assert.equal(measure().envelope.state, 'BLOCKED');
  const shifted = printingEnvelopes(
    layoutDocument(d, t, metrics, { offsetXmm: 1.2, offsetYmm: -0.7 }),
    t,
  ).find((e) => e.region === f.id)!;
  assert.ok(Math.abs(shifted.rect.xMm - multiline.envelope.rect.xMm - 1.2) < 1e-9);
  assert.ok(Math.abs(shifted.rect.yMm - multiline.envelope.rect.yMm + 0.7) < 1e-9);
  assert.equal(shifted.rect.widthMm, multiline.envelope.rect.widthMm);
  assert.equal(shifted.rect.heightMm, multiline.envelope.rect.heightMm);
  d.customer.name = 'OSDE OSUTHGRA OSDE OSUTHGRA';
  f.widthMm = 35;
  f.heightMm = 30;
  f.maxLines = 5;
  assert.ok(measure().layout.texts.filter((p) => p.region === f.id).length > 1);
  const beforeStep = measure().envelope.rect.heightMm;
  f.lineHeightPt = 17;
  assert.ok(measure().envelope.rect.heightMm > beforeStep);
});

test('Bourbon: 203×271, no número/preimpresos, un recuadro por texto y overlay sin cajas', async () => {
  const template = bourbonTemplate(),
    document = printingDocument();
  assert.equal(template.name, 'Bourbon Remito 203x271 - Provisional');
  assert.equal(template.status, 'DRAFT');
  assert.equal(template.safeToleranceXmm, 4);
  assert.equal(template.safeToleranceYmm, 3);
  assert.equal(
    template.definition.fields.some((f) => f.binding === 'document.number'),
    false,
  );
  const preview = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PREVIEW',
    guides: true,
  });
  const pdf = await PDFDocument.load(preview.bytes);
  // Filled-and-stroked paths are the envelopes. The preview banner is fill-only.
  assert.equal(
    (operators(pdf).match(/\bB\b/g) ?? []).length,
    printingEnvelopes(preview.layout, template).length,
  );
  assert.equal(
    printingEnvelopes(preview.layout, template).length,
    preview.layout.bounds.filter((b) => b.text).length,
  );
  assert.equal(
    new Set(printingEnvelopes(preview.layout, template).map((e) => e.region)).size,
    printingEnvelopes(preview.layout, template).length,
  );
  assert.ok(preview.layout.bounds.filter((b) => b.region.startsWith('row-')).length >= 10);
  const result = await renderPdf({
    template,
    document,
    calibration: null,
    mode: 'PRINT_OVERLAY',
    guides: true,
    background: printingPng(),
  });
  const overlay = await PDFDocument.load(result.bytes);
  assert.equal(overlay.getPage(0).getWidth(), mmToPt(203));
  assert.equal(overlay.getPage(0).getHeight(), mmToPt(271));
  assert.equal(imageCount(overlay), 0);
  assert.doesNotMatch(operators(overlay), /\bre\b|\bDo\b|\bS\b|\bB\b|\bm\b|\bl\b/);
  assert.doesNotMatch(await content(result.bytes), /00003897|Bourbon|REMITO|COD 91|CAI/);
});

test('Bourbon: referencia revisada, fecha en encabezado y paciente/afiliado dentro del área libre', async () => {
  const template = bourbonTemplate();
  const sample = printSampleDocument();
  const layout = layoutDocument(sample, template, await loadPrintMetrics());
  assert.equal(layout.evaluation.rowCount, 2);
  assert.equal(layout.evaluation.maxRows, 5);
  assert.equal(sample.documentNumber, null);
  assert.equal(sample.customer.name, 'OSUTHGRA');
  assert.equal(sample.lines[0]!.physicalTraces.length, 2);
  const year = template.definition.fields.find((f) => f.id === 'year')!;
  assert.equal(year.yMm, 28.3);
  for (const id of ['patient', 'affiliate']) {
    const field = template.definition.fields.find((f) => f.id === id)!;
    assert.ok(field.yMm >= 186.8 && field.yMm + field.heightMm <= 214);
  }
  assert.ok(layout.texts.some((t) => t.region === 'row-1-serialNumber'));
  assert.ok(layout.texts.some((t) => t.region === 'row-2-lotNumber'));
});

test('Stage 5: GTIN observado es imprimible cuando la plantilla lo pide; no se sustituye por GTIN preferido', () => {
  const document = printingDocument(),
    template = printingTemplate();
  document.lines[0]!.physicalTraces[0]!.scannedGtinSnapshot = '04006381333931';
  const columns = [
    ...template.definition.productRegion.columns,
    {
      ...template.definition.productRegion.columns[0]!,
      binding: 'scannedGtin' as const,
      formatter: 'text' as const,
    },
  ];
  const projection = projectRows(document, columns);
  assert.equal(projection.rows[0]!.scannedGtin, '04006381333931');
  assert.equal(projection.rows[1]!.scannedGtin, '');
  assert.equal(projection.issues.length, 0);
});

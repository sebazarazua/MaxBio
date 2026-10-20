import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PDFDocument, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  printTemplateCreateSchema,
  printRenderInputSchema,
  printingRouteContract,
} from '@maxbio/contracts';
import {
  mmToPt,
  ptToMm,
  layoutDocument,
  formatPrintValue,
  projectRows,
} from '../src/modules/printing/domain/geometry.js';
import {
  loadPrintMetrics,
  renderPdf,
  renderCalibrationTest,
} from '../src/modules/printing/infrastructure/pdf-renderer.js';
import { LocalPrivatePrintStorage } from '../src/modules/printing/infrastructure/private-print-storage.js';
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
  d.lines[0]!.allocations.forEach((a, i) => {
    a.quantity = '1';
    a.serialNumber = 'S' + i;
    a.serialId = randomUUID();
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
  assert.ok(projectRows(d, columns).issues.some((i) => i.message.includes('exactamente')));
  d.lines[0]!.quantity = '2';
  t.definition.productRegion.heightMm = t.definition.productRegion.rowHeightMm;
  const evaluated = layoutDocument(d, t, await loadPrintMetrics()).evaluation;
  assert.equal(evaluated.state, 'BLOCKED');
  assert.equal(evaluated.rowCount, 2);
  assert.equal(evaluated.maxRows, 1);
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
  assert.match(operators(p), /\bS\b/);
  assert.doesNotMatch(operators(plainPreview), /\bS\b/);
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

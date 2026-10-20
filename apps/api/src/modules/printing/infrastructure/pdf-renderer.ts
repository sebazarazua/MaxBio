import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PDFDocument, PrintScaling, rgb, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { DeliveryNoteView, PrintTemplate, PrintCalibration } from '@maxbio/contracts';
import { layoutDocument, mmToPt, type Layout, type Metrics } from '../domain/geometry.js';

const require = createRequire(import.meta.url);
let fontBytes: Promise<Buffer> | undefined, metricsPromise: Promise<Metrics> | undefined;
function bytes() {
  return (fontBytes ??= readFile(
    require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
  ));
}
async function font(doc: PDFDocument) {
  doc.registerFontkit(fontkit);
  return doc.embedFont(await bytes(), { subset: true });
}
export function pdfMetrics(font: PDFFont): Metrics {
  const supported = new Set(font.getCharacterSet());
  return {
    width: (s, n) => font.widthOfTextAtSize(s, n),
    height: (n) => font.heightAtSize(n, { descender: true }),
    descent: (n) =>
      font.heightAtSize(n, { descender: true }) - font.heightAtSize(n, { descender: false }),
    supports: (s) =>
      Array.from(s).every(
        (c) => ['\n', '\r', '\t'].includes(c) || supported.has(c.codePointAt(0)!),
      ),
  };
}
export function loadPrintMetrics() {
  return (metricsPromise ??= PDFDocument.create().then(async (doc) => pdfMetrics(await font(doc))));
}
export async function evaluatePrint(
  doc: DeliveryNoteView,
  template: PrintTemplate,
  calibration: PrintCalibration | null,
) {
  return layoutDocument(doc, template, await loadPrintMetrics(), calibration);
}
export async function renderPdf(input: {
  template: PrintTemplate;
  document: DeliveryNoteView;
  calibration: PrintCalibration | null;
  mode: 'PREVIEW' | 'PRINT_OVERLAY';
  background?: Uint8Array;
  guides?: boolean;
}): Promise<{ bytes: Uint8Array; layout: Layout }> {
  const pdf = await PDFDocument.create(),
    embedded = await font(pdf);
  const t = input.template,
    height = mmToPt(t.pageHeightMm);
  const page = pdf.addPage([mmToPt(t.pageWidthMm), height]);
  const layout = layoutDocument(input.document, t, pdfMetrics(embedded), input.calibration);
  pdf.setTitle('MaxBio');
  pdf.setProducer('MaxBio printing');
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  // The overlay branch never reads/embeds the background, even as a hidden object.
  if (input.mode === 'PREVIEW' && input.background) {
    const image = await pdf.embedPng(input.background);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height });
  }
  for (const text of layout.texts)
    page.drawText(text.text, {
      font: embedded,
      size: text.fontSizePt,
      x: mmToPt(text.xMm),
      y: height - mmToPt(text.baselineMm),
      color: rgb(0, 0, 0),
    });
  if (input.mode === 'PREVIEW') {
    if (input.guides)
      for (const b of layout.bounds) {
        for (const [r, color] of [
          [b.outer, rgb(0.8, 0.2, 0.2)],
          [b.safe, rgb(0.1, 0.5, 0.3)],
        ] as const)
          page.drawRectangle({
            x: mmToPt(r.xMm),
            y: height - mmToPt(r.yMm + r.heightMm),
            width: mmToPt(r.widthMm),
            height: mmToPt(r.heightMm),
            borderWidth: 0.4,
            borderColor: color,
          });
        if (b.text)
          page.drawRectangle({
            x: mmToPt(b.text.xMm - t.safeToleranceXmm),
            y: height - mmToPt(b.text.yMm + b.text.heightMm + t.safeToleranceYmm),
            width: mmToPt(b.text.widthMm + 2 * t.safeToleranceXmm),
            height: mmToPt(b.text.heightMm + 2 * t.safeToleranceYmm),
            borderWidth: 0.3,
            borderColor: rgb(0.2, 0.3, 0.8),
          });
      }
    const badge =
      input.document.status === 'DRAFT'
        ? 'BORRADOR / VISTA PREVIA'
        : 'VISTA PREVIA / NO IMPRIMIR EN TALONARIO';
    const size = Math.min(10, page.getWidth() / 35);
    page.drawRectangle({
      x: 0,
      y: height - 16,
      width: page.getWidth(),
      height: 16,
      color: rgb(1, 0.96, 0.8),
    });
    page.drawText(badge, { x: 4, y: height - 12, size, font: embedded, color: rgb(0.45, 0.18, 0) });
  }
  return { bytes: await pdf.save(), layout };
}
export async function renderCalibrationTest(t: PrintTemplate, c: PrintCalibration | null) {
  const pdf = await PDFDocument.create(),
    f = await font(pdf),
    h = mmToPt(t.pageHeightMm);
  const p = pdf.addPage([mmToPt(t.pageWidthMm), h]);
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const dx = c?.offsetXmm ?? 0,
    dy = c?.offsetYmm ?? 0;
  const anchors = [
    [10, 20],
    [t.pageWidthMm - 10, 20],
    [10, t.pageHeightMm - 10],
    [t.pageWidthMm - 10, t.pageHeightMm - 10],
  ];
  p.drawText('PRUEBA - TAMANO REAL 100%', { x: mmToPt(3), y: h - mmToPt(6), font: f, size: 7 });
  p.drawText(`X ${dx} mm / Y ${dy} mm`, { x: mmToPt(3), y: h - mmToPt(11), font: f, size: 7 });
  for (const [x, y] of anchors) {
    const px = mmToPt(x! + dx),
      py = h - mmToPt(y! + dy);
    p.drawLine({
      start: { x: px - mmToPt(2), y: py },
      end: { x: px + mmToPt(2), y: py },
      thickness: 0.5,
    });
    p.drawLine({
      start: { x: px, y: py - mmToPt(2) },
      end: { x: px, y: py + mmToPt(2) },
      thickness: 0.5,
    });
    p.drawText(`${x},${y} mm`, {
      x: Math.min(px, p.getWidth() - 55),
      y: py - 10,
      font: f,
      size: 6,
    });
  }
  return pdf.save();
}

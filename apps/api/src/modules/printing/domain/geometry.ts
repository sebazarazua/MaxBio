import type {
  DeliveryNoteView,
  PrintTemplate,
  PrintField,
  PrintColumn,
  PrintEvaluation,
  PrintCalibration,
} from '@maxbio/contracts';
import { amount, quantity } from '../../inventory/domain/quantity.js';

export const mmToPt = (mm: number) => (mm * 72) / 25.4;
export const ptToMm = (pt: number) => (pt * 25.4) / 72;
export type Rect = { xMm: number; yMm: number; widthMm: number; heightMm: number };
export type Metrics = {
  width(text: string, size: number): number;
  height(size: number): number;
  descent(size: number): number;
  supports(text: string): boolean;
};
export type PlacedText = {
  region: string;
  text: string;
  xMm: number;
  baselineMm: number;
  fontSizePt: number;
};
export type Bounds = { region: string; outer: Rect; safe: Rect; text: Rect | null };
export type Layout = { evaluation: PrintEvaluation; texts: PlacedText[]; bounds: Bounds[] };
export function printingEnvelopes(layout: Layout, template: PrintTemplate) {
  return layout.bounds.flatMap(({ region, text }) => {
    if (!text) return [];
    const issues = layout.evaluation.issues.filter(
      (i) =>
        i.region === region ||
        (region.startsWith('row-') && (i.region === 'products' || i.region.startsWith('product-'))),
    );
    return [
      {
        region,
        rect: {
          xMm: text.xMm - template.safeToleranceXmm,
          yMm: text.yMm - template.safeToleranceYmm,
          widthMm: text.widthMm + 2 * template.safeToleranceXmm,
          heightMm: text.heightMm + 2 * template.safeToleranceYmm,
        },
        state: issues.some((i) => i.state === 'BLOCKED')
          ? ('BLOCKED' as const)
          : issues.length
            ? ('WARNING' as const)
            : ('SAFE' as const),
      },
    ];
  });
}
export type ProductRow = Record<PrintColumn['binding'], string>;
const unitLabels = {
  UNIT: 'Un.',
  PAIR: 'Par',
  METER: 'm',
  CENTIMETER: 'cm',
  LITER: 'l',
  MILLILITER: 'ml',
  KILOGRAM: 'kg',
  GRAM: 'g',
};
export function formatPrintValue(value: string | null, formatter: PrintField['formatter']) {
  if (!value) return '';
  if (formatter === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value.split('-').reverse().join('/');
  if (formatter === 'quantity') return quantity(amount(value)).replace('.', ',');
  if (formatter === 'cuit' && /^\d{11}$/.test(value))
    return value.slice(0, 2) + '-' + value.slice(2, 10) + '-' + value.slice(10);
  return value;
}
export function fieldValue(doc: DeliveryNoteView, binding: PrintField['binding']) {
  const c = doc.customer;
  const values = {
    'document.number': doc.documentNumber ? `${doc.documentPrefix}-${doc.documentNumber}` : '',
    'document.date': doc.documentDate,
    'document.dateDay': doc.documentDate.slice(8, 10),
    'document.dateMonth': doc.documentDate.slice(5, 7),
    'document.dateYear': doc.documentDate.slice(0, 4),
    'customer.name': c.name,
    'customer.legalName': c.legalName,
    'customer.cuit': c.cuit,
    'customer.taxCondition': c.taxConditionText,
    'customer.address': [c.addressLine, c.locality, c.province, c.postalCode]
      .filter(Boolean)
      .join(' · '),
    'customer.addressLine': c.addressLine,
    'customer.locality': c.locality,
    'patient.name': doc.patientName,
    'patient.affiliateNumber': doc.affiliateNumber,
    notes: doc.notes,
  };
  return values[binding] ?? '';
}
export function projectRows(doc: DeliveryNoteView, columns: PrintColumn[]) {
  const physical = columns.some((c) =>
    ['lotNumber', 'expirationDate', 'serialNumber'].includes(c.binding),
  );
  const rows: ProductRow[] = [];
  const issues: PrintEvaluation['issues'] = [];
  for (const [index, l] of doc.lines.entries()) {
    const region = `product-${index + 1}`;
    for (const key of ['lotNumber', 'expirationDate', 'serialNumber'] as const) {
      if (l.allocations.some((a) => Boolean(a[key])) && !columns.some((c) => c.binding === key))
        issues.push({
          state: 'BLOCKED',
          region,
          message: `El formulario no tiene columna para ${
            { lotNumber: 'lote', expirationDate: 'vencimiento', serialNumber: 'serie' }[key]
          }; no se puede omitir esa información física.`,
        });
    }
    if (l.allocations.reduce((n, a) => n + amount(a.quantity), 0n) !== amount(l.quantity))
      issues.push({
        state: 'BLOCKED',
        region,
        message: 'Las existencias seleccionadas no cubren exactamente la cantidad documental.',
      });
    const base = {
      quantity: l.quantity,
      unit: unitLabels[l.unitOfMeasure],
      productName: l.productName,
      presentation: l.presentation ?? '',
      lotNumber: '',
      expirationDate: '',
      serialNumber: '',
    };
    if (physical && l.allocations.length)
      for (const a of l.allocations) {
        if (a.serialNumber && amount(a.quantity) !== 1000000n)
          issues.push({
            state: 'BLOCKED',
            region,
            message: 'Cada serie debe representar una unidad.',
          });
        rows.push({
          ...base,
          quantity: a.quantity,
          lotNumber: a.lotNumber ?? '',
          expirationDate: a.expirationDate ?? '',
          serialNumber: a.serialNumber ?? '',
        });
      }
    else rows.push(base);
  }
  return { rows, issues };
}
function wrap(text: string, maxWidthPt: number, size: number, metrics: Metrics) {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? line + ' ' + word : word;
      if (line && metrics.width(candidate, size) > maxWidthPt) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }
    lines.push(line);
  }
  return lines;
}
const labels: Partial<Record<PrintField['binding'], string>> = {
  'customer.name': 'El nombre del cliente',
  'customer.legalName': 'La razón social',
  'customer.address': 'El domicilio',
  notes: 'Las observaciones',
  'patient.name': 'El nombre del paciente',
};
export function layoutDocument(
  doc: DeliveryNoteView,
  template: PrintTemplate,
  metrics: Metrics,
  calibration: Pick<PrintCalibration, 'offsetXmm' | 'offsetYmm'> | null = null,
): Layout {
  const { rows, issues } = projectRows(doc, template.definition.productRegion.columns);
  const texts: PlacedText[] = [],
    bounds: Bounds[] = [];
  const tx = template.safeToleranceXmm,
    ty = template.safeToleranceYmm;
  const dx = calibration?.offsetXmm ?? 0,
    dy = calibration?.offsetYmm ?? 0;
  function place(
    region: string,
    box: Rect,
    style: PrintField | PrintColumn,
    raw: string,
    label: string,
  ) {
    const safe = {
      xMm: box.xMm + tx + style.paddingMm,
      yMm: box.yMm + ty + style.paddingMm,
      widthMm: box.widthMm - 2 * (tx + style.paddingMm),
      heightMm: box.heightMm - 2 * (ty + style.paddingMm),
    };
    const value = formatPrintValue(raw, style.formatter);
    if (!value) {
      bounds.push({ region, outer: box, safe, text: null });
      return;
    }
    if (!metrics.supports(value)) {
      issues.push({
        state: 'BLOCKED',
        region,
        message: `${label} contiene caracteres que la fuente no puede representar.`,
      });
      bounds.push({ region, outer: box, safe, text: null });
      return;
    }
    const lines = wrap(value, mmToPt(safe.widthMm), style.fontSizePt, metrics);
    const height = ptToMm(metrics.height(style.fontSizePt));
    if (lines.length > 1 && style.lineHeightPt < metrics.height(style.fontSizePt))
      issues.push({
        state: 'BLOCKED',
        region,
        message: `${label} necesita mayor interlineado para evitar superposición entre renglones.`,
      });
    const step = ptToMm(style.lineHeightPt),
      totalHeight = height + (lines.length - 1) * step;
    const top =
      safe.yMm +
      (style.verticalAlign === 'bottom'
        ? safe.heightMm - totalHeight
        : style.verticalAlign === 'middle'
          ? (safe.heightMm - totalHeight) / 2
          : 0) +
      dy;
    let minX = Infinity,
      maxX = -Infinity;
    for (const [index, text] of lines.entries()) {
      const w = ptToMm(metrics.width(text, style.fontSizePt));
      const x =
        safe.xMm +
        (style.align === 'right'
          ? safe.widthMm - w
          : style.align === 'center'
            ? (safe.widthMm - w) / 2
            : 0) +
        dx;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + w);
      texts.push({
        region,
        text,
        xMm: x,
        baselineMm: top + index * step + height - ptToMm(metrics.descent(style.fontSizePt)),
        fontSizePt: style.fontSizePt,
      });
    }
    const textBox = { xMm: minX, yMm: top, widthMm: maxX - minX, heightMm: totalHeight };
    bounds.push({ region, outer: box, safe, text: textBox });
    const clearance = Math.min(
      textBox.xMm - tx - box.xMm,
      box.xMm + box.widthMm - (maxX + tx),
      top - ty - box.yMm,
      box.yMm + box.heightMm - (top + totalHeight + ty),
      minX - tx,
      template.pageWidthMm - maxX - tx,
      top - ty,
      template.pageHeightMm - top - totalHeight - ty,
    );
    if (lines.length > style.maxLines || clearance <= 0.000001)
      issues.push({
        state: 'BLOCKED',
        region,
        message: `${label} no entra en su región segura; puede invadir una línea, columna o borde.`,
      });
    else if (
      clearance < 0.4 ||
      totalHeight > safe.heightMm * 0.9 ||
      maxX - minX > safe.widthMm * 0.95
    )
      issues.push({
        state: 'WARNING',
        region,
        message: `${label} está cerca del límite seguro. Revisá la vista previa.`,
      });
  }
  for (const field of template.definition.fields)
    place(
      field.id,
      field,
      field,
      fieldValue(doc, field.binding),
      labels[field.binding] ?? 'El campo ' + field.binding,
    );
  const r = template.definition.productRegion,
    maxRows = Math.floor((r.heightMm + 0.000001) / r.rowHeightMm);
  if (rows.length > maxRows)
    issues.push({
      state: 'BLOCKED',
      region: 'products',
      message: `Hay ${rows.length} filas de productos y el formulario admite ${maxRows}. Prepará remitos separados antes de confirmar.`,
    });
  for (const [index, row] of rows.entries()) {
    let xMm = r.xMm;
    for (const c of r.columns) {
      place(
        `row-${index + 1}-${c.binding}`,
        { xMm, yMm: r.yMm + index * r.rowHeightMm, widthMm: c.widthMm, heightMm: r.rowHeightMm },
        c,
        row[c.binding],
        c.binding === 'productName'
          ? `La descripción de la fila ${index + 1}`
          : `La columna ${c.binding} de la fila ${index + 1}`,
      );
      xMm += c.widthMm;
    }
  }
  return {
    texts,
    bounds,
    evaluation: {
      state: issues.some((i) => i.state === 'BLOCKED')
        ? 'BLOCKED'
        : issues.length
          ? 'WARNING'
          : 'SAFE',
      issues,
      documentVersion: doc.version,
      templateRevisionId: template.id,
      rowCount: rows.length,
      maxRows,
    },
  };
}

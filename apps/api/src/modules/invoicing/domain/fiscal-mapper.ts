import { BadRequestException } from '@nestjs/common';
import {
  deliveryNoteCustomerSchema,
  invoiceLineAmounts,
  moneyCents,
  formatCents,
  validCuit,
  type WsfeReferences,
} from '@maxbio/contracts';
import type { InvoiceRecord } from '../application/invoice-view.js';
import { businessDate } from '../../inventory/domain/quantity.js';
import {
  wsfeInvoiceSchema,
  wsfeRegisteredInvoiceSchema,
  type WsfeInvoice,
  type WsfeComparableInvoice,
} from '../../fiscal/arca/wsfe-types.js';

export const fiscalDocumentTypes = { INVOICE_A: 1, INVOICE_B: 6, INVOICE_C: 11 } as const;
export const fiscalClass = (type: string) =>
  ({ INVOICE_A: 'A', INVOICE_B: 'B', INVOICE_C: 'C' })[type] as 'A' | 'B' | 'C' | undefined;
const rates = {
  VAT_0: [3, 0n],
  VAT_10_5: [4, 105n],
  VAT_21: [5, 210n],
  VAT_27: [6, 270n],
} as const;
function fail(message: string): never {
  throw new BadRequestException(message);
}
export function validateFiscalDate(issueDate: string, now: Date, previousDate?: string) {
  const today = businessDate(now),
    date = issueDate.replaceAll('-', '');
  const difference =
    (Date.parse(issueDate + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000;
  if (
    !Number.isFinite(difference) ||
    Math.abs(difference) > 5 ||
    issueDate.slice(0, 7) !== today.slice(0, 7)
  )
    fail('Para bienes, elegí una fecha del mismo mes y dentro de los cinco días de hoy.');
  if (previousDate && date < previousDate)
    fail('La fecha no puede ser anterior al último comprobante de este punto de venta y tipo.');
}
export function mapFiscalInvoice(
  i: InvoiceRecord,
  issuer: { cuit: string | null; vatCondition: string | null },
  pointOfSale: number,
  references: WsfeReferences,
  now: Date,
): WsfeInvoice {
  if (i.status !== 'READY' || !i.invoiceType)
    return fail('La factura debe estar lista para autorizar.');
  const cls = fiscalClass(i.invoiceType)!,
    documentType = fiscalDocumentTypes[i.invoiceType];
  if (!issuer.cuit || !validCuit(issuer.cuit)) return fail('Revisá el CUIT del emisor.');
  if (
    (issuer.vatCondition === 'RESPONSABLE_INSCRIPTO' && cls === 'C') ||
    (['MONOTRIBUTO', 'EXENTO'].includes(issuer.vatCondition ?? '') && cls !== 'C') ||
    !['RESPONSABLE_INSCRIPTO', 'MONOTRIBUTO', 'EXENTO'].includes(issuer.vatCondition ?? '')
  )
    fail(
      'El tipo de factura no corresponde a la condición IVA del emisor admitida en esta versión.',
    );
  if (!references.documentTypes.some((r) => r.id === documentType))
    fail('ARCA no habilita este tipo de comprobante.');
  if (!references.points.includes(pointOfSale))
    fail('El punto de venta configurado no está habilitado por ARCA para CAE.');
  if (
    !i.receiverVatConditionId ||
    !references.conditions[cls].some((r) => r.id === i.receiverVatConditionId)
  )
    fail('Completá una condición IVA del receptor compatible con este tipo de factura.');
  const customer = deliveryNoteCustomerSchema.parse(i.customerSnapshot);
  if (!customer.cuit || !validCuit(customer.cuit))
    fail('Esta versión requiere el CUIT del receptor. Completalo y volvé a preparar la factura.');
  const issueDate = i.issueDate.toISOString().slice(0, 10);
  validateFiscalDate(issueDate, now);
  let total = 0n,
    vat = 0n,
    net = 0n,
    notTaxed = 0n,
    exempt = 0n;
  const groups = new Map<number, { base: bigint; amount: bigint; ratio: bigint }>();
  for (const line of i.lines) {
    if (!line.vatRate || !line.unitPrice || !line.netAmount || !line.vatAmount || !line.totalAmount)
      fail('Revisá los importes de todas las líneas.');
    const recomputed = invoiceLineAmounts(
      line.quantity.toFixed(),
      line.unitPrice.toFixed(2),
      line.vatRate,
    );
    if (
      recomputed.netAmount !== line.netAmount.toFixed(2) ||
      recomputed.vatAmount !== line.vatAmount.toFixed(2) ||
      recomputed.totalAmount !== line.totalAmount.toFixed(2)
    )
      fail('Los importes comerciales no coinciden con sus líneas.');
    const base = moneyCents(recomputed.netAmount),
      amount = moneyCents(recomputed.vatAmount);
    total += base + amount;
    vat += amount;
    if (cls === 'C') {
      if (amount !== 0n || !['VAT_0', 'EXEMPT', 'NOT_TAXED'].includes(line.vatRate))
        fail('La factura C no discrimina IVA. Revisá sus líneas.');
      net += base;
    } else if (line.vatRate === 'EXEMPT') exempt += base;
    else if (line.vatRate === 'NOT_TAXED') notTaxed += base;
    else {
      const [id, ratio] = rates[line.vatRate];
      if (!references.ivaTypes.some((r) => r.id === id))
        fail('ARCA no admite una de las alícuotas de la factura.');
      net += base;
      const group = groups.get(id) ?? { base: 0n, amount: 0n, ratio };
      group.base += base;
      group.amount += amount;
      groups.set(id, group);
    }
  }
  if (
    formatCents(total) !== i.totalAmount.toFixed(2) ||
    formatCents(vat) !== i.vatAmount.toFixed(2) ||
    formatCents(net + notTaxed + exempt) !== i.netAmount.toFixed(2)
  )
    fail('Los totales comerciales cambiaron. Volvé a preparar la factura.');
  for (const group of groups.values()) {
    const expected = group.base * group.ratio,
      actual = group.amount * 1000n;
    const difference = expected > actual ? expected - actual : actual - expected;
    if (difference > 1000n && difference * 10000n > expected)
      fail(
        'El redondeo del IVA por líneas supera la tolerancia fiscal por alícuota. Corregí la factura antes de autorizar.',
      );
  }
  if (total <= 0n || total > 999999999999999n)
    fail(
      'El total debe ser mayor a cero y respetar el límite de importes de ARCA (13 enteros y 2 decimales).',
    );
  return wsfeInvoiceSchema.parse({
    issuerCuit: issuer.cuit,
    pointOfSale,
    documentType,
    number: null,
    issueDate: issueDate.replaceAll('-', ''),
    docType: 80,
    docNumber: customer.cuit,
    receiverVatConditionId: i.receiverVatConditionId,
    concept: 1,
    currency: 'PES',
    exchangeRate: '1',
    total: formatCents(total),
    net: formatCents(net),
    vat: formatCents(vat),
    notTaxed: formatCents(notTaxed),
    exempt: formatCents(exempt),
    tributes: '0.00',
    iva: [...groups.entries()]
      .filter(([, g]) => g.base > 0n)
      .sort(([a], [b]) => a - b)
      .map(([id, g]) => ({ id, base: formatCents(g.base), amount: formatCents(g.amount) })),
  });
}
export function sameFiscalInvoice(expected: WsfeInvoice, actual: WsfeComparableInvoice) {
  const ordered = (i: WsfeComparableInvoice) => ({
    ...i,
    iva: [...i.iva].sort((a, b) => a.id - b.id),
  });
  // Schema construction supplies a stable key order, independent of JSON or XML order.
  return (
    JSON.stringify(ordered(wsfeRegisteredInvoiceSchema.parse(expected))) ===
    JSON.stringify(ordered(wsfeRegisteredInvoiceSchema.parse(actual)))
  );
}

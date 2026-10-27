import { z } from 'zod';
import { queryInteger, unitOfMeasureSchema, versionInputSchema } from './catalog.js';
import { deliveryNoteCustomerSchema } from './delivery-notes.js';
import { inventoryQuantitySchema } from './inventory.js';

// Facturación V1: factura comercial interna. READY = validada internamente y lista para
// autorizar en una integración fiscal futura; nunca significa autorizada por ARCA.
export const invoiceStatusSchema = z.enum(['DRAFT', 'READY']);
export const invoiceTypeSchema = z.enum(['INVOICE_A', 'INVOICE_B', 'INVOICE_C']);
// Semántica interna: los códigos externos se mapean en la integración futura.
export const invoiceVatRateSchema = z.enum([
  'VAT_0',
  'VAT_10_5',
  'VAT_21',
  'VAT_27',
  'EXEMPT',
  'NOT_TAXED',
]);
export type InvoiceVatRate = z.infer<typeof invoiceVatRateSchema>;
export const invoiceStatusLabels: Record<z.infer<typeof invoiceStatusSchema>, string> = {
  DRAFT: 'Borrador',
  READY: 'Lista para autorizar',
};
export const invoiceTypeLabels: Record<z.infer<typeof invoiceTypeSchema>, string> = {
  INVOICE_A: 'Factura A',
  INVOICE_B: 'Factura B',
  INVOICE_C: 'Factura C',
};
export const invoiceVatRateLabels: Record<InvoiceVatRate, string> = {
  VAT_0: 'IVA 0 %',
  VAT_10_5: 'IVA 10,5 %',
  VAT_21: 'IVA 21 %',
  VAT_27: 'IVA 27 %',
  EXEMPT: 'Exento',
  NOT_TAXED: 'No gravado',
};

// ---- Dinero exacto (sin float). Cantidad: escala 6; dinero: escala 2 (centavos). ----
// Política única de redondeo, replicada en la migración (round de PostgreSQL):
// neto = round(cantidad × precio, 2); IVA = round(neto × alícuota, 2); total = neto + IVA;
// totales de factura = suma exacta de las líneas. Mitad hacia arriba (todos los valores ≥ 0).
const VAT_PER_MILLE: Record<InvoiceVatRate, bigint> = {
  VAT_0: 0n,
  VAT_10_5: 105n,
  VAT_21: 210n,
  VAT_27: 270n,
  EXEMPT: 0n,
  NOT_TAXED: 0n,
};
// NUMERIC(18,2): 16 dígitos enteros.
export const MAX_MONEY_CENTS = 999999999999999999n;
const moneyPattern = /^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/;
const quantityPattern = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
export function moneyCents(value: string): bigint {
  if (!moneyPattern.test(value)) throw new Error('Importe inválido.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function formatCents(cents: bigint): string {
  if (cents < 0n) throw new Error('Importe inválido.');
  return (cents / 100n).toString() + '.' + (cents % 100n).toString().padStart(2, '0');
}
function quantityMicros(value: string): bigint {
  if (!quantityPattern.test(value)) throw new Error('Cantidad inválida.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole!) * 1000000n + BigInt(fraction.padEnd(6, '0'));
}
const divideHalfUp = (value: bigint, divisor: bigint) => (value + divisor / 2n) / divisor;
export type InvoiceLineAmounts = { netAmount: string; vatAmount: string; totalAmount: string };
export function invoiceLineAmounts(
  quantity: string,
  unitPrice: string,
  vatRate: InvoiceVatRate,
): InvoiceLineAmounts {
  // micros × cents = 1e-8 → centavos dividiendo por 1e6.
  const net = divideHalfUp(quantityMicros(quantity) * moneyCents(unitPrice), 1000000n);
  const vat = divideHalfUp(net * VAT_PER_MILLE[vatRate], 1000n);
  const total = net + vat;
  if (total > MAX_MONEY_CENTS) throw new Error('El importe es demasiado grande.');
  return {
    netAmount: formatCents(net),
    vatAmount: formatCents(vat),
    totalAmount: formatCents(total),
  };
}
export function invoiceTotals(
  lines: { netAmount: string | null; vatAmount: string | null }[],
): InvoiceLineAmounts & { complete: boolean } {
  let net = 0n,
    vat = 0n;
  for (const l of lines) {
    if (l.netAmount !== null) net += moneyCents(l.netAmount);
    if (l.vatAmount !== null) vat += moneyCents(l.vatAmount);
  }
  if (net + vat > MAX_MONEY_CENTS) throw new Error('El importe es demasiado grande.');
  return {
    netAmount: formatCents(net),
    vatAmount: formatCents(vat),
    totalAmount: formatCents(net + vat),
    complete: lines.every((l) => l.netAmount !== null),
  };
}

// ---- Requests (strict; el backend deriva snapshots, montos y cliente). ----
const text = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) =>
      Array.from(v).every((c) => {
        const code = c.charCodeAt(0);
        return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
      }),
    );
export const invoiceMoneySchema = z
  .string()
  .regex(moneyPattern, 'Usá un importe con hasta 2 decimales.');
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;
export const invoiceCreateSchema = z
  .object({
    id: z.uuidv4(),
    deliveryNoteIds: z.array(z.uuidv4()).min(1).max(20).refine(uniqueIds, 'Remitos repetidos.'),
  })
  .strict();
export const invoiceUpdateSchema = z
  .object({
    expectedVersion: versionInputSchema.shape.expectedVersion,
    invoiceType: invoiceTypeSchema.nullable(),
    issueDate: z.iso.date(),
    notes: text(0, 1000)
      .nullable()
      .transform((v) => v || null),
    lines: z
      .array(
        z
          .object({
            id: z.uuidv4(),
            description: text(1, 500),
            unitPrice: invoiceMoneySchema.nullable(),
            vatRate: invoiceVatRateSchema.nullable(),
          })
          .strict(),
      )
      .max(500)
      .refine((lines) => uniqueIds(lines.map((l) => l.id)), 'Líneas repetidas.'),
  })
  .strict();
export const invoiceTransitionSchema = z
  .object({ expectedVersion: versionInputSchema.shape.expectedVersion, operationId: z.uuidv4() })
  .strict();
const dateFilters = {
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
};
const search = z
  .string()
  .trim()
  .max(128)
  .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  .default('');
const dateOrder = (v: { dateFrom?: string; dateTo?: string }) =>
  !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo;
export const invoicePendingQuerySchema = z
  .object({
    search,
    customerId: z.uuidv4().optional(),
    ...dateFilters,
    page: queryInteger('1', 10000),
    limit: queryInteger('25', 100),
  })
  .strict()
  .refine(dateOrder, 'La fecha desde no puede ser posterior a la fecha hasta.');
export const invoiceListQuerySchema = z
  .object({
    search,
    status: invoiceStatusSchema.optional(),
    customerId: z.uuidv4().optional(),
    ...dateFilters,
    page: queryInteger('1', 10000),
    limit: queryInteger('25', 100),
  })
  .strict()
  .refine(dateOrder, 'La fecha desde no puede ser posterior a la fecha hasta.');

// ---- Views ----
const money = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);
const reference = z.object({ id: z.uuidv4(), name: z.string() }).strict();
export const invoicePendingListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.uuidv4(),
          number: z.string(),
          documentDate: z.iso.date(),
          customer: reference,
          lineCount: z.number().int().nonnegative(),
          // Only whether the Remito carries patient/affiliate data, never the values.
          patientLinked: z.boolean(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    customer: reference.nullable(),
  })
  .strict();
export const invoiceHistoryActionSchema = z.enum([
  'INVOICE_CREATED',
  'INVOICE_UPDATED',
  'INVOICE_MARKED_READY',
  'INVOICE_RETURNED_TO_DRAFT',
]);
export const invoiceHistoryLabels: Record<z.infer<typeof invoiceHistoryActionSchema>, string> = {
  INVOICE_CREATED: 'Creada desde Remitos',
  INVOICE_UPDATED: 'Borrador actualizado',
  INVOICE_MARKED_READY: 'Marcada lista para autorizar',
  INVOICE_RETURNED_TO_DRAFT: 'Vuelta a borrador',
};
export const invoiceSchema = z
  .object({
    id: z.uuidv4(),
    status: invoiceStatusSchema,
    version: z.number().int().positive(),
    invoiceType: invoiceTypeSchema.nullable(),
    issueDate: z.iso.date(),
    currency: z.literal('ARS'),
    notes: z.string().nullable(),
    // Live Customer while DRAFT; frozen snapshot once READY.
    customer: deliveryNoteCustomerSchema,
    customerArchived: z.boolean(),
    netAmount: money,
    vatAmount: money,
    totalAmount: money,
    complete: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    readyAt: z.iso.datetime().nullable(),
    readyBy: z.string().nullable(),
    replayed: z.boolean(),
    deliveryNotes: z.array(
      z
        .object({
          id: z.uuidv4(),
          number: z.string(),
          documentDate: z.iso.date(),
          lineCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    lines: z.array(
      z
        .object({
          id: z.uuidv4(),
          deliveryNoteId: z.uuidv4(),
          productId: z.uuidv4(),
          description: z.string(),
          productName: z.string(),
          presentation: z.string().nullable(),
          unitOfMeasure: unitOfMeasureSchema,
          quantity: inventoryQuantitySchema,
          unitPrice: money.nullable(),
          vatRate: invoiceVatRateSchema.nullable(),
          netAmount: money.nullable(),
          vatAmount: money.nullable(),
          totalAmount: money.nullable(),
        })
        .strict(),
    ),
    history: z.array(
      z
        .object({
          action: invoiceHistoryActionSchema,
          at: z.iso.datetime(),
          actor: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export const invoiceListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.uuidv4(),
          status: invoiceStatusSchema,
          invoiceType: invoiceTypeSchema.nullable(),
          issueDate: z.iso.date(),
          customer: reference,
          deliveryNoteNumbers: z.array(z.string()),
          totalAmount: money,
          complete: z.boolean(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    customer: reference.nullable(),
  })
  .strict();
export const invoiceDiscardedSchema = z
  .object({ id: z.uuidv4(), discarded: z.literal(true) })
  .strict();
export type InvoiceCreate = z.infer<typeof invoiceCreateSchema>;
export type InvoiceUpdate = z.infer<typeof invoiceUpdateSchema>;
export type InvoiceTransition = z.infer<typeof invoiceTransitionSchema>;
export type InvoicePendingQuery = z.infer<typeof invoicePendingQuerySchema>;
export type InvoiceListQuery = z.infer<typeof invoiceListQuerySchema>;
export type InvoiceView = z.infer<typeof invoiceSchema>;
export type InvoiceList = z.infer<typeof invoiceListSchema>;
export type InvoicePendingList = z.infer<typeof invoicePendingListSchema>;

export function invoiceRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (path === 'invoices' && method === 'GET')
    return { body: null, query: invoiceListQuerySchema, response: invoiceListSchema };
  if (path === 'invoices' && method === 'POST')
    return { body: invoiceCreateSchema, query: null, response: invoiceSchema };
  if (path === 'invoices/pending-delivery-notes' && method === 'GET')
    return { body: null, query: invoicePendingQuerySchema, response: invoicePendingListSchema };
  if (new RegExp(`^invoices/${id}$`).test(path)) {
    if (method === 'GET') return { body: null, query: null, response: invoiceSchema };
    if (method === 'PATCH')
      return { body: invoiceUpdateSchema, query: null, response: invoiceSchema };
  }
  if (new RegExp(`^invoices/${id}/(ready|reopen)$`).test(path) && method === 'POST')
    return { body: invoiceTransitionSchema, query: null, response: invoiceSchema };
  if (new RegExp(`^invoices/${id}/discard$`).test(path) && method === 'POST')
    return {
      body: versionInputSchema,
      query: null,
      response: invoiceDiscardedSchema,
    };
  return null;
}

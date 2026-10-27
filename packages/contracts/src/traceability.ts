import { z } from 'zod';
import { queryInteger, unitOfMeasureSchema } from './catalog.js';
import { inventoryQuantitySchema } from './inventory.js';

// Read model over DeliveryNoteLineTrace of CONFIRMED Remitos. STOCK = origin INVENTORY
// (real allocation); DOCUMENTARY = origin DECLARED (only what the Remito states).
export const traceabilitySourceSchema = z.enum(['STOCK', 'DOCUMENTARY']);
export const traceabilitySourceLabels: Record<z.infer<typeof traceabilitySourceSchema>, string> = {
  STOCK: 'Vinculado a Stock',
  DOCUMENTARY: 'Solo documental',
};
const searchText = z
  .string()
  .trim()
  .max(128)
  .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
  .default('');
export const traceabilityQuerySchema = z
  .object({
    search: searchText,
    productId: z.uuidv4().optional(),
    customerId: z.uuidv4().optional(),
    source: traceabilitySourceSchema.optional(),
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
    page: queryInteger('1', 10000),
    limit: queryInteger('25', 100),
  })
  .strict()
  .refine(
    (v) => !v.dateFrom || !v.dateTo || v.dateFrom <= v.dateTo,
    'La fecha desde no puede ser posterior a la fecha hasta.',
  );
const reference = z.object({ id: z.uuidv4(), name: z.string() }).strict();
const deliveryNoteReference = z
  .object({ id: z.uuidv4(), number: z.string(), documentDate: z.iso.date() })
  .strict();
export const traceabilityItemSchema = z
  .object({
    traceId: z.uuidv4(),
    deliveryNote: deliveryNoteReference,
    product: z
      .object({
        id: z.uuidv4(),
        name: z.string(),
        presentation: z.string().nullable(),
        unitOfMeasure: unitOfMeasureSchema,
      })
      .strict(),
    customer: reference,
    quantity: inventoryQuantitySchema,
    lotNumber: z.string().nullable(),
    expirationDate: z.iso.date().nullable(),
    serialNumber: z.string().nullable(),
    source: traceabilitySourceSchema,
    // Only whether the Remito carries patient/affiliate data; values stay in the detail.
    patientLinked: z.boolean(),
  })
  .strict();
export const traceabilityListSchema = z
  .object({
    items: z.array(traceabilityItemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
    match: z.enum(['EXACT', 'TEXT']).nullable(),
    filters: z.object({ product: reference.nullable(), customer: reference.nullable() }).strict(),
  })
  .strict();
export const traceabilityDetailSchema = traceabilityItemSchema
  .extend({
    deliveryNote: deliveryNoteReference.extend({ confirmedAt: z.iso.datetime() }).strict(),
    documentQuantity: inventoryQuantitySchema,
    patientName: z.string().nullable(),
    affiliateNumber: z.string().nullable(),
    stock: z.object({ movementId: z.uuidv4(), location: reference }).strict().nullable(),
    scannedGtin: z.string().nullable(),
    // ADMIN only; null for other roles.
    captureMethod: z.enum(['MANUAL', 'GS1', 'LEGACY']).nullable(),
  })
  .strict();
export type TraceabilityQuery = z.infer<typeof traceabilityQuerySchema>;
export type TraceabilityItem = z.infer<typeof traceabilityItemSchema>;
export type TraceabilityList = z.infer<typeof traceabilityListSchema>;
export type TraceabilityDetail = z.infer<typeof traceabilityDetailSchema>;
export function traceabilityRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  // Read-only module: every other method or path is rejected before reaching the API.
  if (method !== 'GET') return null;
  if (path === 'traceability')
    return { body: null, query: traceabilityQuerySchema, response: traceabilityListSchema };
  if (new RegExp(`^traceability/${id}$`).test(path))
    return { body: null, query: null, response: traceabilityDetailSchema };
  return null;
}

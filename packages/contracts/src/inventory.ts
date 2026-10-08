import { z } from 'zod';
import { unitOfMeasureSchema, catalogListQuerySchema } from './catalog.js';

export const inventoryConditionSchema = z.enum(['USABLE', 'DAMAGED', 'QUARANTINE']);
export const inventoryQuantitySchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/)
  .transform((v) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v));
const exactResult = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/);
const version = z.number().int().min(1).max(2147483646);
const physicalText = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((v) => !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const optionalText = physicalText.nullable().optional();
const date = z.iso.date();
export const inventoryPolicyInputSchema = z
  .object({
    expectedVersion: z.number().int().min(0).max(2147483646),
    lotRequired: z.boolean(),
    expirationRequired: z.boolean(),
    serialRequired: z.boolean(),
  })
  .strict();
export const inventoryPolicySchema = z
  .object({
    productId: z.uuid(),
    version,
    lotRequired: z.boolean(),
    expirationRequired: z.boolean(),
    serialRequired: z.boolean(),
  })
  .strict();
export const inventoryVersionSchema = z.object({ expectedVersion: version }).strict();
export const inventoryCreateReceiptSchema = z
  .object({ id: z.uuid(), supplierId: z.uuid(), notes: z.string().trim().max(1000).optional() })
  .strict();
export const inventoryCreateCountSchema = z
  .object({ id: z.uuid(), notes: z.string().trim().max(1000).optional() })
  .strict();
export const inventoryHeaderSchema = z
  .object({ expectedVersion: version, notes: z.string().trim().max(1000).nullable() })
  .strict();
export const inventoryScopeInputSchema = z
  .object({ expectedVersion: version, productId: z.uuid() })
  .strict();
export const inventoryLineInputSchema = z
  .object({
    expectedVersion: version,
    productId: z.uuid(),
    unitOfMeasure: unitOfMeasureSchema,
    quantity: inventoryQuantitySchema,
    lotId: z.uuid().nullable().optional(),
    lotNumber: optionalText,
    expirationDate: date.nullable().optional(),
    serialNumbers: z.array(physicalText).max(100).default([]),
    condition: inventoryConditionSchema.default('USABLE'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (['UNIT', 'PAIR'].includes(v.unitOfMeasure) && v.quantity.includes('.'))
      ctx.addIssue({ code: 'custom', message: 'Unidades y pares se cuentan con números enteros.' });
    if (new Set(v.serialNumbers).size !== v.serialNumbers.length)
      ctx.addIssue({ code: 'custom', message: 'Una serie está repetida.' });
    const whole = v.quantity.split('.')[0]!;
    if (/^[0-9]+$/.test(whole) && BigInt(whole) > 1000000000n)
      ctx.addIssue({ code: 'custom', message: 'La cantidad supera el límite por línea.' });
  });
export const inventoryConfirmSchema = z
  .object({
    operationId: z.uuid(),
    expectedVersion: version,
    completeCoverage: z.literal(true).optional(),
  })
  .strict();
const product = z
  .object({ id: z.uuid(), name: z.string(), unitOfMeasure: unitOfMeasureSchema })
  .strict();
const location = z.object({ id: z.uuid(), name: z.string() }).strict();
export const inventoryDocumentSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['RECEIPT', 'INITIAL_COUNT']),
    status: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']),
    version,
    supplier: z.object({ id: z.uuid(), name: z.string() }).strict().nullable(),
    location,
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
    movementId: z.uuid().nullable(),
    replayed: z.boolean(),
    canEdit: z.boolean(),
    lines: z.array(
      z
        .object({
          id: z.uuid(),
          product,
          quantity: exactResult,
          lotId: z.uuid().nullable(),
          lotNumber: z.string().nullable(),
          expirationDate: date.nullable(),
          serialNumbers: z.array(z.string()),
          condition: inventoryConditionSchema,
          policyVersion: version,
        })
        .strict(),
    ),
    scopes: z.array(
      z
        .object({
          id: z.uuid(),
          productId: z.uuid(),
          productName: z.string(),
          expectedScopeVersion: version,
          coverageConfirmed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export const inventoryDocumentListSchema = z
  .object({
    items: z.array(inventoryDocumentSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .strict();
export const inventoryStockItemSchema = z
  .object({
    product,
    physical: exactResult,
    available: exactResult,
    unavailable: exactResult,
    initializedAt: z.iso.datetime().nullable(),
    countInProgress: z.boolean(),
    nextExpirationDate: date.nullable(),
  })
  .strict();
export const inventoryStockListSchema = z
  .object({
    items: z.array(inventoryStockItemSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
    businessDate: date,
  })
  .strict();
export const inventoryStockDetailSchema = z
  .object({
    summary: inventoryStockItemSchema,
    businessDate: date,
    policy: inventoryPolicySchema.nullable(),
    scopeVersion: version.nullable(),
    positions: z.array(
      z
        .object({
          id: z.uuid(),
          location,
          lotId: z.uuid().nullable(),
          lotNumber: z.string().nullable(),
          expirationDate: date.nullable(),
          serialNumber: z.string().nullable(),
          condition: inventoryConditionSchema,
          quantity: exactResult,
          expired: z.boolean(),
          expiringSoon: z.boolean(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .strict();
export const inventoryHistorySchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.uuid(),
          type: z.enum(['RECEIPT', 'INITIAL_COUNT', 'ADJUSTMENT', 'OUTBOUND']),
          recordedAt: z.iso.datetime(),
          actorName: z.string(),
          supplierName: z.string().nullable(),
          notes: z.string().nullable(),
          sourceId: z.uuid().nullable(),
          change: exactResult,
          lines: z.array(
            z
              .object({
                quantityDelta: exactResult,
                unitOfMeasure: unitOfMeasureSchema,
                lotNumber: z.string().nullable(),
                expirationDate: date.nullable(),
                serialNumber: z.string().nullable(),
                condition: inventoryConditionSchema,
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    limit: z.number().int(),
  })
  .strict();
export const inventoryAdjustmentSchema = z
  .object({
    operationId: z.uuid(),
    positionId: z.uuid(),
    expectedScopeVersion: version,
    observedQuantity: inventoryQuantitySchema,
    reason: z.enum(['COUNT', 'ADMIN_ERROR', 'LOSS', 'DAMAGE_DISPOSAL', 'OTHER']),
    notes: z.string().trim().min(1).max(1000),
  })
  .strict();
export const inventoryAdjustmentResultSchema = z
  .object({ movementId: z.uuid(), replayed: z.boolean() })
  .strict();
export type InventoryLineInput = z.infer<typeof inventoryLineInputSchema>;
export type InventoryDocument = z.infer<typeof inventoryDocumentSchema>;
export type InventoryConfirm = z.infer<typeof inventoryConfirmSchema>;
export type InventoryPolicyInput = z.infer<typeof inventoryPolicyInputSchema>;
export type InventoryStockDetail = z.infer<typeof inventoryStockDetailSchema>;
export type InventoryAdjustment = z.infer<typeof inventoryAdjustmentSchema>;

export function inventoryRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  const read = (response: z.ZodType, query: z.ZodType | null = null) => ({
    response,
    query,
    body: null,
  });
  const write = (body: z.ZodType, response: z.ZodType = inventoryDocumentSchema) => ({
    body,
    response,
    query: null,
  });
  if (method === 'GET') {
    if (path === 'stock') return read(inventoryStockListSchema, catalogListQuerySchema);
    if (new RegExp(`^products/${id}$`).test(path))
      return read(inventoryStockDetailSchema, catalogListQuerySchema);
    if (new RegExp(`^products/${id}/history$`).test(path))
      return read(inventoryHistorySchema, catalogListQuerySchema);
    if (new RegExp(`^products/${id}/policy$`).test(path))
      return read(inventoryPolicySchema.nullable());
    if (/^(receipts|counts)$/.test(path))
      return read(inventoryDocumentListSchema, catalogListQuerySchema);
    if (new RegExp(`^(receipts|counts)/${id}$`).test(path)) return read(inventoryDocumentSchema);
  }
  if (method === 'POST') {
    if (path === 'receipts') return write(inventoryCreateReceiptSchema);
    if (path === 'counts') return write(inventoryCreateCountSchema);
    if (new RegExp(`^counts/${id}/scopes$`).test(path)) return write(inventoryScopeInputSchema);
    if (new RegExp(`^(receipts|counts)/${id}/confirm$`).test(path))
      return write(inventoryConfirmSchema);
    if (new RegExp(`^(receipts|counts)/${id}/cancel$`).test(path))
      return write(inventoryVersionSchema);
    if (path === 'adjustments')
      return write(inventoryAdjustmentSchema, inventoryAdjustmentResultSchema);
  }
  if (method === 'PATCH' && new RegExp(`^(receipts|counts)/${id}$`).test(path))
    return write(inventoryHeaderSchema);
  if (method === 'PUT') {
    if (new RegExp(`^products/${id}/policy$`).test(path))
      return write(inventoryPolicyInputSchema, inventoryPolicySchema);
    if (new RegExp(`^(receipts|counts)/${id}/lines/${id}$`).test(path))
      return write(inventoryLineInputSchema);
  }
  if (method === 'DELETE' && new RegExp(`^(receipts|counts)/${id}/lines/${id}$`).test(path))
    return write(inventoryVersionSchema);
  return null;
}

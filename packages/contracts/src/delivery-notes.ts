import { z } from 'zod';
import { catalogListQuerySchema, unitOfMeasureSchema, versionInputSchema } from './catalog.js';
import { customerKindSchema } from './customers.js';
import { inventoryQuantitySchema, inventoryConditionSchema } from './inventory.js';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) =>
      Array.from(v).every((c) => {
        const code = c.charCodeAt(0);
        return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
      }),
    )
    .nullable()
    .default(null);
const digits = z
  .string()
  .regex(/^[0-9]{1,12}$/)
  .nullable()
  .default(null);
const positive = inventoryQuantitySchema.refine(
  (v) => v !== '0' && BigInt(v.split('.')[0]!) <= 1000000000n,
  'Revisá la cantidad.',
);
const allocation = z.object({ positionId: z.uuidv4(), quantity: positive }).strict();
export const deliveryNoteLineInputSchema = z
  .object({
    id: z.uuidv4(),
    productId: z.uuidv4(),
    quantity: positive,
    allocations: z.array(allocation).max(100).default([]),
  })
  .strict();
const fields = {
  customerId: z.uuidv4(),
  documentDate: z.iso.date(),
  documentPrefix: digits,
  documentNumber: digits,
  patientName: text(160),
  affiliateNumber: text(80),
  notes: text(1000),
  lines: z.array(deliveryNoteLineInputSchema).max(50).default([]),
};
function validate(
  v: {
    documentPrefix: string | null;
    documentNumber: string | null;
    lines: { id: string; allocations: unknown[] }[];
  },
  ctx: z.RefinementCtx,
) {
  if ((v.documentPrefix === null) !== (v.documentNumber === null))
    ctx.addIssue({
      code: 'custom',
      message: 'Completá ambas partes del número.',
      path: ['documentNumber'],
    });
  if (new Set(v.lines.map((l) => l.id)).size !== v.lines.length)
    ctx.addIssue({ code: 'custom', message: 'Hay líneas repetidas.', path: ['lines'] });
  if (v.lines.reduce((n, l) => n + l.allocations.length, 0) > 500)
    ctx.addIssue({
      code: 'custom',
      message: 'Máximo 500 existencias por remito.',
      path: ['lines'],
    });
}
export const deliveryNoteCreateSchema = z
  .object({ id: z.uuidv4(), ...fields })
  .strict()
  .superRefine(validate);
// Atomic replacement of the editable document, protected by its version.
export const deliveryNoteUpdateSchema = z
  .object({ expectedVersion: versionInputSchema.shape.expectedVersion, ...fields })
  .strict()
  .superRefine(validate);
export const deliveryNoteConfirmSchema = z
  .object({ operationId: z.uuidv4(), expectedVersion: versionInputSchema.shape.expectedVersion })
  .strict();
export const deliveryNoteCustomerSchema = z
  .object({
    id: z.uuidv4(),
    name: z.string(),
    kind: customerKindSchema,
    legalName: z.string().nullable(),
    cuit: z.string().nullable(),
    taxConditionText: z.string().nullable(),
    addressLine: z.string().nullable(),
    locality: z.string().nullable(),
    province: z.string().nullable(),
    postalCode: z.string().nullable(),
  })
  .strict();
const allocationView = z
  .object({
    id: z.uuidv4(),
    positionId: z.uuidv4(),
    quantity: inventoryQuantitySchema,
    location: z.object({ id: z.uuidv4(), name: z.string() }).strict(),
    lotId: z.uuidv4().nullable(),
    lotNumber: z.string().nullable(),
    expirationDate: z.iso.date().nullable(),
    serialId: z.uuidv4().nullable(),
    serialNumber: z.string().nullable(),
    condition: inventoryConditionSchema,
  })
  .strict();
export const deliveryNoteSchema = z
  .object({
    id: z.uuidv4(),
    status: z.enum(['DRAFT', 'CONFIRMED', 'CANCELLED']),
    version: z.number().int().positive(),
    customer: deliveryNoteCustomerSchema,
    customerArchived: z.boolean(),
    documentDate: z.iso.date(),
    documentPrefix: z.string().nullable(),
    documentNumber: z.string().nullable(),
    patientName: z.string().nullable(),
    affiliateNumber: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.iso.datetime(),
    confirmedAt: z.iso.datetime().nullable(),
    confirmedBy: z.string().nullable(),
    movementId: z.uuidv4().nullable(),
    replayed: z.boolean(),
    lines: z.array(
      z
        .object({
          id: z.uuidv4(),
          productId: z.uuidv4(),
          productName: z.string(),
          presentation: z.string().nullable(),
          unitOfMeasure: unitOfMeasureSchema,
          gtin: z.string().nullable(),
          productArchived: z.boolean(),
          quantity: inventoryQuantitySchema,
          allocations: z.array(allocationView),
        })
        .strict(),
    ),
  })
  .strict();
export const deliveryNoteListSchema = z
  .object({
    items: z.array(
      deliveryNoteSchema
        .pick({
          id: true,
          status: true,
          documentDate: true,
          documentPrefix: true,
          documentNumber: true,
        })
        .extend({ customerName: z.string() })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  })
  .strict();
export const deliveryNoteListQuerySchema = catalogListQuerySchema;
export type DeliveryNoteCreate = z.infer<typeof deliveryNoteCreateSchema>;
export type DeliveryNoteUpdate = z.infer<typeof deliveryNoteUpdateSchema>;
export type DeliveryNoteConfirm = z.infer<typeof deliveryNoteConfirmSchema>;
export type DeliveryNoteView = z.infer<typeof deliveryNoteSchema>;
export function deliveryNoteRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (path === 'delivery-notes' && method === 'GET')
    return { body: null, query: deliveryNoteListQuerySchema, response: deliveryNoteListSchema };
  if (path === 'delivery-notes/search' && method === 'POST')
    return { body: deliveryNoteListQuerySchema, query: null, response: deliveryNoteListSchema };
  if (path === 'delivery-notes' && method === 'POST')
    return { body: deliveryNoteCreateSchema, query: null, response: deliveryNoteSchema };
  if (new RegExp(`^delivery-notes/${id}$`).test(path)) {
    if (method === 'GET') return { body: null, query: null, response: deliveryNoteSchema };
    if (method === 'PATCH')
      return { body: deliveryNoteUpdateSchema, query: null, response: deliveryNoteSchema };
  }
  if (new RegExp(`^delivery-notes/${id}/confirm$`).test(path) && method === 'POST')
    return { body: deliveryNoteConfirmSchema, query: null, response: deliveryNoteSchema };
  if (new RegExp(`^delivery-notes/${id}/cancel$`).test(path) && method === 'POST')
    return { body: versionInputSchema, query: null, response: deliveryNoteSchema };
  return null;
}

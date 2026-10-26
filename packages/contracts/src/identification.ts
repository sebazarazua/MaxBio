import { z } from 'zod';
import { productSchema, productCreateSchema, catalogListQuerySchema } from './catalog.js';
import { supplierCatalogItemSchema } from './supplier-catalog.js';

export const scanInputSchema = z
  .object({
    value: z.string().min(1).max(512),
    namespace: z.enum(['AUTO', 'INTERNAL_CODE']).default('AUTO'),
    supplierId: z.uuid().optional(),
  })
  .strict();
export const scanIdentitySchema = z
  .object({
    kind: z.enum(['GTIN', 'INTERNAL_CODE', 'INTERNAL_BARCODE', 'SUPPLIER_BARCODE']),
    value: z.string(),
    normalizedValue: z.string(),
    supplierId: z.uuid().nullable(),
  })
  .strict();
export const scanReasonCodeSchema = z.enum([
  'EMPTY_SCAN',
  'SCAN_TOO_LONG',
  'TOO_MANY_ELEMENTS',
  'TOO_MANY_ISSUES',
  'INVALID_CHARACTER',
  'INVALID_CONTROL',
  'MALFORMED_AI',
  'MIXED_FORMAT',
  'FORMAT_CONFLICT',
  'UNSUPPORTED_SYMBOLOGY',
  'UNSUPPORTED_FORMAT',
  'MISSING_GTIN',
  'INVALID_GTIN',
  'INVALID_EXPIRATION',
  'EXPIRATION_DAY_UNSPECIFIED',
  'INVALID_FIELD_LENGTH',
  'DUPLICATE_AI',
  'UNSUPPORTED_AI',
  'TRUNCATED_ELEMENT',
  'MISSING_SEPARATOR',
  'UNEXPECTED_SEPARATOR',
]);
// Backend interpretation of a GS1 reading. Never carries the raw scan, offsets or unknown AI values.
const gs1Text = z.string().regex(/^[!"%-?A-Z_a-z]{1,20}$/);
export const scanInterpretationSchema = z
  .object({
    format: z.literal('GS1'),
    status: z.enum(['VALID', 'PARTIAL', 'INVALID']),
    syntax: z.enum(['ELEMENT_STRING', 'HRI']),
    symbology: z.enum(['GS1_DATAMATRIX', 'GS1_128', 'GS1_QR']).nullable(),
    referenceYear: z.number().int(),
    fields: z
      .object({
        gtin14: z
          .string()
          .regex(/^[0-9]{14}$/)
          .optional(),
        lotNumber: gs1Text.optional(),
        expirationDate: z.iso.date().optional(),
        expiration: z
          .object({
            encoded: z.string().regex(/^[0-9]{6}$/),
            precision: z.enum(['DAY', 'MONTH']),
          })
          .strict()
          .optional(),
        serialNumber: gs1Text.optional(),
      })
      .strict(),
    issues: z
      .array(
        z
          .object({
            code: scanReasonCodeSchema,
            severity: z.enum(['ERROR', 'REVIEW']),
            ai: z
              .string()
              .regex(/^[0-9]{2,4}$/)
              .optional(),
          })
          .strict(),
      )
      .max(16),
    canApplyPhysicalData: z.boolean(),
  })
  .strict();
const unresolved = {
  identity: scanIdentitySchema,
  message: z.string(),
  scan: scanInterpretationSchema.optional(),
};
export const scanResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('KNOWN'),
      identity: scanIdentitySchema,
      product: productSchema,
      scan: scanInterpretationSchema.optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('ARCHIVED'),
      identity: scanIdentitySchema,
      product: productSchema,
      message: z.string(),
      scan: scanInterpretationSchema.optional(),
    })
    .strict(),
  z.object({ status: z.literal('UNKNOWN'), ...unresolved }).strict(),
  z
    .object({
      status: z.literal('CANDIDATES'),
      ...unresolved,
      candidates: z.array(supplierCatalogItemSchema),
      total: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ status: z.literal('AMBIGUOUS'), identity: scanIdentitySchema, message: z.string() })
    .strict(),
  z
    .object({
      status: z.enum(['INVALID', 'UNSUPPORTED']),
      message: z.string(),
      reasonCode: scanReasonCodeSchema.optional(),
      scan: scanInterpretationSchema.optional(),
    })
    .strict(),
]);
// Operator wording per reason code; shared by API messages and the web review panels.
export const scanReasonMessages: Record<z.infer<typeof scanReasonCodeSchema>, string> = {
  EMPTY_SCAN: 'La lectura está vacía. Volvé a escanear.',
  SCAN_TOO_LONG: 'La lectura es demasiado larga. Volvé a escanear.',
  TOO_MANY_ELEMENTS: 'La lectura contiene demasiados datos. Revisá la etiqueta.',
  TOO_MANY_ISSUES: 'La lectura tiene demasiados errores. Revisá la etiqueta.',
  INVALID_CHARACTER: 'La lectura contiene caracteres que no corresponden a un código GS1.',
  INVALID_CONTROL: 'La lectura contiene caracteres de control no admitidos. Volvé a escanear.',
  MALFORMED_AI: 'No pudimos interpretar la estructura del código GS1.',
  MIXED_FORMAT:
    'La lectura mezcla formatos. Escaneá nuevamente o ingresá el texto con paréntesis sin prefijo del lector.',
  FORMAT_CONFLICT:
    'El lector envió el código en un formato que no corresponde a GS1. Revisá la configuración del lector.',
  UNSUPPORTED_SYMBOLOGY: 'El tipo de código informado por el lector todavía no está soportado.',
  UNSUPPORTED_FORMAT:
    'Este formato de código (por ejemplo, un enlace web) todavía no está soportado.',
  MISSING_GTIN: 'El código GS1 no incluye el GTIN del producto.',
  INVALID_GTIN: 'El código GS1 tiene un GTIN inválido.',
  INVALID_EXPIRATION: 'La fecha de vencimiento del código no es válida.',
  EXPIRATION_DAY_UNSPECIFIED:
    'El código indica solo mes y año de vencimiento. Ingresá la fecha exacta desde la etiqueta.',
  INVALID_FIELD_LENGTH: 'Un dato del código tiene una longitud inválida.',
  DUPLICATE_AI: 'La lectura repite un dato; revisá la etiqueta.',
  UNSUPPORTED_AI: 'El código contiene datos que todavía no interpretamos.',
  TRUNCATED_ELEMENT: 'La lectura está incompleta. Volvé a escanear.',
  MISSING_SEPARATOR:
    'Un dato del código es demasiado largo; puede faltar un separador. Revisá la configuración del lector.',
  UNEXPECTED_SEPARATOR: 'La lectura tiene separadores en posiciones inválidas. Volvé a escanear.',
};
export const identificationProductInputSchema = productCreateSchema
  .pick({
    name: true,
    unitOfMeasure: true,
    presentation: true,
    brandId: true,
    categoryId: true,
  })
  .strict();
export const identificationConfirmSchema = z
  .object({
    operationId: z.uuid(),
    scan: scanInputSchema,
    referenceId: z.uuid(),
    expectedReferenceVersion: z.number().int().min(1).max(2147483646),
    target: z.discriminatedUnion('mode', [
      z
        .object({
          mode: z.literal('EXISTING'),
          productId: z.uuid(),
          expectedProductVersion: z.number().int().min(1).max(2147483646),
        })
        .strict(),
      z.object({ mode: z.literal('NEW'), product: identificationProductInputSchema }).strict(),
    ]),
  })
  .strict();
export const identificationConfirmationSchema = z
  .object({
    confirmationId: z.uuid(),
    referenceId: z.uuid(),
    supplierProductId: z.uuid(),
    product: productSchema,
    replayed: z.boolean(),
  })
  .strict();
export type ScanInput = z.infer<typeof scanInputSchema>;
export type ScanIdentity = z.infer<typeof scanIdentitySchema>;
export type ScanResult = z.infer<typeof scanResultSchema>;
export type ScanInterpretation = z.infer<typeof scanInterpretationSchema>;
export type ScanReasonCode = z.infer<typeof scanReasonCodeSchema>;
export type IdentificationConfirm = z.infer<typeof identificationConfirmSchema>;
export const supplierScanIdentifierListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.uuid(),
          value: z.string(),
          normalizedValue: z.string(),
          supplierId: z.uuid(),
          supplierProductId: z.uuid(),
          supplier: z
            .object({ id: z.uuid(), name: z.string(), archivedAt: z.iso.datetime().nullable() })
            .strict(),
          linkArchivedAt: z.iso.datetime().nullable(),
          archivedAt: z.iso.datetime().nullable(),
          createdAt: z.iso.datetime(),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().min(1).max(100),
  })
  .strict();
export function identificationRouteContract(path: string, method: string) {
  const uuid =
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (method === 'GET' && new RegExp(`^products/${uuid}/supplier-scan-identifiers$`).test(path))
    return { response: supplierScanIdentifierListSchema, query: catalogListQuerySchema };
  if (method !== 'POST') return null;
  if (path === 'catalog-scans/resolve')
    return { body: scanInputSchema, response: scanResultSchema, query: null };
  if (path === 'catalog-identifications/confirm')
    return {
      body: identificationConfirmSchema,
      response: identificationConfirmationSchema,
      query: null,
    };
  return null;
}

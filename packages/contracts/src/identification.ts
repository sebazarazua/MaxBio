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
const unresolved = { identity: scanIdentitySchema, message: z.string() };
export const scanResultSchema = z.discriminatedUnion('status', [
  z
    .object({ status: z.literal('KNOWN'), identity: scanIdentitySchema, product: productSchema })
    .strict(),
  z
    .object({
      status: z.literal('ARCHIVED'),
      identity: scanIdentitySchema,
      product: productSchema,
      message: z.string(),
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
  z.object({ status: z.literal('AMBIGUOUS'), ...unresolved }).strict(),
  z.object({ status: z.enum(['INVALID', 'UNSUPPORTED']), message: z.string() }).strict(),
]);
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

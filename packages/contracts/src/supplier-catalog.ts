import { z } from 'zod';
import { catalogListQuerySchema } from './catalog.js';

export const supplierCatalogLimits = {
  fileBytes: 10 * 1024 * 1024,
  rows: 10000,
  columns: 100,
  sheets: 20,
  expandedBytes: 40 * 1024 * 1024,
  cellCharacters: 4000,
  previewMinutes: 30,
} as const;
export const catalogMappingFields = {
  supplierCode: 'código del proveedor',
  description: 'descripción',
  brandText: 'marca',
  presentationText: 'presentación',
  reportedGtin: 'GTIN / EAN / UPC informado',
} as const;
const column = z
  .number()
  .int()
  .min(0)
  .max(supplierCatalogLimits.columns - 1);
export const catalogColumnMappingSchema = z
  .object({
    supplierCode: column,
    description: column,
    brandText: column.nullable(),
    presentationText: column.nullable(),
    reportedGtin: column.nullable(),
  })
  .strict()
  .refine((mapping) => {
    const columns = Object.values(mapping).filter((value) => value !== null);
    return columns.length === new Set(columns).size;
  }, 'Elegí una columna diferente para cada campo.');
export const catalogImportModeSchema = z.enum(['PARTIAL', 'COMPLETE']);
export const catalogPreviewInputSchema = z
  .object({
    uploadId: z.uuid(),
    sheet: z.string().min(1).max(31),
    headerRow: z.number().int().min(1).max(20),
    mapping: catalogColumnMappingSchema,
    mode: catalogImportModeSchema,
  })
  .strict();
export const catalogCommitInputSchema = z
  .object({
    previewHash: z.string().regex(/^[a-f0-9]{64}$/),
    excludeInvalidRows: z.boolean().default(false),
  })
  .strict();
const suggestion = z
  .object({
    supplierCode: column.nullable(),
    description: column.nullable(),
    brandText: column.nullable(),
    presentationText: column.nullable(),
    reportedGtin: column.nullable(),
  })
  .strict();
export const catalogInspectionSchema = z
  .object({
    uploadId: z.uuid(),
    fileName: z.string(),
    contentHash: z.string(),
    format: z.enum(['CSV', 'XLSX']),
    expiresAt: z.iso.datetime(),
    sheets: z.array(
      z
        .object({
          name: z.string(),
          rowCount: z.number().int().nonnegative(),
          headerRow: z.number().int().positive(),
          headers: z.array(z.string()),
          sample: z.array(z.array(z.string())),
          suggestedMapping: suggestion,
        })
        .strict(),
    ),
  })
  .strict();
export const supplierCatalogDataSchema = z
  .object({
    supplierCode: z.string().min(1).max(128),
    description: z.string().min(1).max(1000),
    brandText: z.string().max(160).nullable(),
    presentationText: z.string().max(200).nullable(),
    reportedGtin: z.string().max(128).nullable(),
    normalizedReportedGtin: z.string().max(14).nullable(),
  })
  .strict();
export const catalogRowOutcomeSchema = z.enum([
  'CREATED',
  'UPDATED',
  'UNCHANGED',
  'DUPLICATE',
  'EMPTY',
  'ERROR',
  'CONFLICT',
]);
export const catalogImportSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    duplicates: z.number().int().nonnegative(),
    empty: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
    missing: z.number().int().nonnegative(),
    absencesSuppressed: z.boolean(),
  })
  .strict();
const supplierBrief = z
  .object({ id: z.uuid(), name: z.string(), archivedAt: z.iso.datetime().nullable() })
  .strict();
export const supplierCatalogItemSchema = supplierCatalogDataSchema
  .extend({
    id: z.uuid(),
    supplierId: z.uuid(),
    supplier: supplierBrief,
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
    missingFromLatestCompleteListAt: z.iso.datetime().nullable(),
    supplierProductId: z.uuid().nullable(),
    supplierProduct: z
      .object({ id: z.uuid(), archivedAt: z.iso.datetime().nullable(), product: supplierBrief })
      .strict()
      .nullable(),
    associationStatus: z.enum(['UNASSOCIATED', 'ASSOCIATED']),
  })
  .strict();
const pageFields = {
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
};
export const supplierCatalogListSchema = z
  .object({ items: z.array(supplierCatalogItemSchema), ...pageFields })
  .strict();
export const supplierCatalogQuerySchema = catalogListQuerySchema
  .extend({
    supplierId: z.uuid().optional(),
    association: z.enum(['ALL', 'UNASSOCIATED', 'ASSOCIATED']).default('ALL'),
  })
  .strict();
export const catalogImportRowSchema = z
  .object({
    id: z.uuid(),
    rowNumber: z.number().int().positive(),
    outcome: catalogRowOutcomeSchema,
    itemId: z.uuid().nullable(),
    supplierCode: z.string().nullable(),
    data: supplierCatalogDataSchema.nullable(),
    messages: z.array(z.string()),
  })
  .strict();
export const catalogImportRowsSchema = z
  .object({ items: z.array(catalogImportRowSchema), ...pageFields })
  .strict();
export const catalogImportRowsQuerySchema = catalogListQuerySchema
  .extend({ outcome: catalogRowOutcomeSchema.optional() })
  .strict();
export const catalogImportSchema = z
  .object({
    id: z.uuid(),
    supplierId: z.uuid(),
    supplier: supplierBrief,
    actor: z.object({ id: z.uuid(), displayName: z.string() }).strict(),
    fileName: z.string(),
    contentHash: z.string(),
    format: z.enum(['CSV', 'XLSX']),
    sheetName: z.string(),
    headerRow: z.number().int().positive(),
    mapping: catalogColumnMappingSchema,
    mode: catalogImportModeSchema,
    status: z.enum(['PREVIEW', 'COMMITTED']),
    previewHash: z.string(),
    summary: catalogImportSummarySchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    committedAt: z.iso.datetime().nullable(),
    excludedInvalidRows: z.boolean(),
  })
  .strict();
export const catalogImportListSchema = z
  .object({ items: z.array(catalogImportSchema), ...pageFields })
  .strict();
export type CatalogColumnMapping = z.infer<typeof catalogColumnMappingSchema>;
export type CatalogPreviewInput = z.infer<typeof catalogPreviewInputSchema>;
export type CatalogCommitInput = z.infer<typeof catalogCommitInputSchema>;
export type SupplierCatalogData = z.infer<typeof supplierCatalogDataSchema>;
export type CatalogImportSummary = z.infer<typeof catalogImportSummarySchema>;
export type SupplierCatalogQuery = z.infer<typeof supplierCatalogQuerySchema>;
export type CatalogImportRowsQuery = z.infer<typeof catalogImportRowsQuerySchema>;
export type CatalogInspection = z.infer<typeof catalogInspectionSchema>;
export type CatalogImportView = z.infer<typeof catalogImportSchema>;
export type CatalogImportRowView = z.infer<typeof catalogImportRowSchema>;
export type SupplierCatalogItemView = z.infer<typeof supplierCatalogItemSchema>;

export function supplierCatalogRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (method === 'GET') {
    if (path === 'supplier-catalog-items')
      return { response: supplierCatalogListSchema, query: supplierCatalogQuerySchema };
    if (new RegExp(`^suppliers/${id}/catalog-items$`).test(path))
      return { response: supplierCatalogListSchema, query: supplierCatalogQuerySchema };
    if (new RegExp(`^supplier-catalog-items/${id}$`).test(path))
      return { response: supplierCatalogItemSchema };
    if (new RegExp(`^supplier-catalog-imports/${id}$`).test(path))
      return { response: catalogImportSchema };
    if (new RegExp(`^supplier-catalog-imports/${id}/rows$`).test(path))
      return { response: catalogImportRowsSchema, query: catalogImportRowsQuerySchema };
    if (new RegExp(`^suppliers/${id}/catalog-imports$`).test(path))
      return { response: catalogImportListSchema, query: catalogListQuerySchema };
  }
  if (method === 'POST') {
    if (new RegExp(`^suppliers/${id}/catalog-imports/preview$`).test(path))
      return { response: catalogImportSchema, body: catalogPreviewInputSchema };
    if (new RegExp(`^supplier-catalog-imports/${id}/commit$`).test(path))
      return { response: catalogImportSchema, body: catalogCommitInputSchema };
  }
  return undefined;
}

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
  manufacturerText: 'fabricante',
  modelText: 'modelo',
  categoryText: 'categoría',
  unitText: 'unidad',
  presentationText: 'presentación',
  reportedGtin: 'GTIN / EAN / UPC informado',
  alternateSupplierCode: 'código alternativo',
  price: 'precio',
  currency: 'moneda',
  vatRate: 'IVA declarado (%)',
} as const;
const column = z
  .number()
  .int()
  .min(0)
  .max(supplierCatalogLimits.columns - 1);
export const catalogColumnMappingSchema = z
  .object({
    supplierCode: column.nullable().default(null),
    description: column.nullable().default(null),
    brandText: column.nullable(),
    manufacturerText: column.nullable().default(null),
    modelText: column.nullable().default(null),
    categoryText: column.nullable().default(null),
    unitText: column.nullable().default(null),
    presentationText: column.nullable(),
    reportedGtin: column.nullable(),
    alternateSupplierCode: column.nullable().default(null),
    price: column.nullable().default(null),
    currency: column.nullable().default(null),
    vatRate: column.nullable().default(null),
  })
  .strict()
  .refine((mapping) => {
    const columns = Object.values(mapping).filter((value) => value !== null);
    return columns.length === new Set(columns).size;
  }, 'Elegí una columna diferente para cada campo.');
export const catalogImportModeSchema = z.enum(['PARTIAL', 'COMPLETE']);
export const catalogCommercialOptionsSchema = z
  .object({
    defaultCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default('ARS'),
    currencyConfirmed: z.boolean().default(true),
    priceIncludesVat: z.enum(['YES', 'NO', 'UNKNOWN']).default('UNKNOWN'),
    decimalSeparator: z.enum(['AUTO', 'COMMA', 'DOT']).default('AUTO'),
  })
  .strict();
export const catalogAnalysisInputSchema = z
  .object({
    uploadId: z.uuid(),
    sheet: z.string().min(1).max(31),
    headerRow: z.number().int().min(1).max(20),
  })
  .strict();
export const catalogPreviewInputSchema = z
  .object({
    uploadId: z.uuid(),
    mode: catalogImportModeSchema.default('PARTIAL'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    excludedRowNumbers: z
      .array(
        z
          .number()
          .int()
          .min(2)
          .max(supplierCatalogLimits.rows + 20),
      )
      .max(supplierCatalogLimits.rows)
      .default([]),
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
    manufacturerText: column.nullable().default(null),
    modelText: column.nullable().default(null),
    categoryText: column.nullable().default(null),
    unitText: column.nullable().default(null),
    presentationText: column.nullable(),
    reportedGtin: column.nullable(),
    alternateSupplierCode: column.nullable(),
    price: column.nullable(),
    currency: column.nullable(),
    vatRate: column.nullable(),
  })
  .strict();
export const catalogSheetInspectionSchema = z
  .object({
    name: z.string(),
    rowCount: z.number().int().nonnegative(),
    headerRow: z.number().int().positive(),
    headers: z.array(z.string()),
    sample: z.array(z.array(z.string())),
    suggestedMapping: suggestion,
    confidence: z.record(
      z.enum(
        Object.keys(catalogMappingFields) as [
          keyof typeof catalogMappingFields,
          ...Array<keyof typeof catalogMappingFields>,
        ],
      ),
      z.enum(['HIGH', 'REVIEW', 'MISSING']),
    ),
    tableConfidence: z.enum(['HIGH', 'REVIEW']),
    fingerprint: z.string(),
    profileApplied: z.boolean(),
    commercial: catalogCommercialOptionsSchema,
    warnings: z.array(z.string()),
  })
  .strict();
export const catalogInspectionSchema = z
  .object({
    uploadId: z.uuid(),
    fileName: z.string(),
    contentHash: z.string(),
    format: z.enum(['CSV', 'XLSX']),
    expiresAt: z.iso.datetime(),
    sheets: z.array(catalogSheetInspectionSchema),
    suggestedSheet: z.string().nullable(),
    warnings: z.array(z.string()),
  })
  .strict();
export const supplierCatalogDataSchema = z
  .object({
    internalReferenceCode: z
      .string()
      .regex(/^[A-Z]+[0-9]{6}$/)
      .nullable()
      .default(null),
    supplierCode: z.string().min(1).max(128).nullable(),
    description: z.string().min(1).max(1000).nullable(),
    brandText: z.string().max(160).nullable(),
    manufacturerText: z.string().max(200).nullable().default(null),
    modelText: z.string().max(160).nullable().default(null),
    categoryText: z.string().max(160).nullable().default(null),
    unitText: z.string().max(80).nullable().default(null),
    presentationText: z.string().max(200).nullable(),
    reportedGtin: z.string().max(128).nullable(),
    normalizedReportedGtin: z.string().max(14).nullable(),
    alternateSupplierCode: z.string().max(128).nullable().default(null),
    price: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,14})\.[0-9]{2}$/)
      .nullable()
      .default(null),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
    vatRate: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,2})(\.[0-9]{1,4})?$/)
      .nullable()
      .default(null),
    priceIncludesVat: z.enum(['YES', 'NO', 'UNKNOWN']).default('UNKNOWN'),
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
    internalReferenceCode: z.string().regex(/^[A-Z]+[0-9]{6}$/),
    referenceSequence: z.number().int().positive(),
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
    sort: z.enum(['CODE', 'SUPPLIER', 'DESCRIPTION', 'PRICE']).default('CODE'),
    direction: z.enum(['asc', 'desc']).default('asc'),
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
    commercial: catalogCommercialOptionsSchema,
    saveProfile: z.boolean(),
    formatFingerprint: z.string().nullable(),
  })
  .strict();
export const catalogImportListSchema = z
  .object({ items: z.array(catalogImportSchema), ...pageFields })
  .strict();
export type CatalogColumnMapping = z.infer<typeof catalogColumnMappingSchema>;
export type CatalogColumnMappingInput = z.input<typeof catalogColumnMappingSchema>;
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
export type CatalogCommercialOptions = z.infer<typeof catalogCommercialOptionsSchema>;
export type CatalogAnalysisInput = z.infer<typeof catalogAnalysisInputSchema>;
export type CatalogSheetInspection = z.infer<typeof catalogSheetInspectionSchema>;
export const catalogProfileListSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.uuid(),
          fingerprint: z.string(),
          sheetName: z.string(),
          headerRow: z.number(),
          headers: z.array(z.string()),
          mapping: catalogColumnMappingSchema,
          commercial: catalogCommercialOptionsSchema,
          updatedAt: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();
export const catalogProfileResetSchema = z
  .object({ deleted: z.number().int().nonnegative() })
  .strict();

export function supplierCatalogRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (method === 'GET') {
    if (new RegExp(`^suppliers/${id}/catalog-import-profiles$`).test(path))
      return { response: catalogProfileListSchema };
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
    if (new RegExp(`^suppliers/${id}/catalog-imports/analyze$`).test(path))
      return { response: catalogSheetInspectionSchema, body: catalogAnalysisInputSchema };
    if (new RegExp(`^suppliers/${id}/catalog-import-profiles/reset$`).test(path))
      return { response: catalogProfileResetSchema, body: z.object({}).strict() };
    if (new RegExp(`^suppliers/${id}/catalog-imports/preview$`).test(path))
      return { response: catalogImportSchema, body: catalogPreviewInputSchema };
    if (new RegExp(`^supplier-catalog-imports/${id}/commit$`).test(path))
      return { response: catalogImportSchema, body: catalogCommitInputSchema };
  }
  return undefined;
}

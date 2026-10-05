import { z } from 'zod';

export const unitOfMeasureSchema = z.enum([
  'UNIT',
  'PAIR',
  'METER',
  'CENTIMETER',
  'LITER',
  'MILLILITER',
  'KILOGRAM',
  'GRAM',
]);
export const identifierKindSchema = z.enum(['GTIN', 'INTERNAL_CODE', 'INTERNAL_BARCODE']);
export const unitLabels: Record<z.infer<typeof unitOfMeasureSchema>, string> = {
  UNIT: 'Unidad',
  PAIR: 'Par',
  METER: 'Metro',
  CENTIMETER: 'Centímetro',
  LITER: 'Litro',
  MILLILITER: 'Mililitro',
  KILOGRAM: 'Kilogramo',
  GRAM: 'Gramo',
};
export const identifierLabels: Record<z.infer<typeof identifierKindSchema>, string> = {
  GTIN: 'GTIN / EAN / UPC',
  INTERNAL_CODE: 'Código interno',
  INTERNAL_BARCODE: 'Código de barras interno',
};
const hasControlCharacter = (value: string) =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Completá este campo.')
    .max(max, 'Usá hasta ' + max + ' caracteres.')
    .refine((value) => !hasControlCharacter(value), 'No se permiten caracteres de control.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'Usá hasta ' + max + ' caracteres.')
    .refine((value) => !hasControlCharacter(value), 'No se permiten caracteres de control.')
    .nullable()
    .transform((value) => (value === '' ? null : value))
    .optional();
const version = z.number().int().min(1).max(2147483646);
export const versionInputSchema = z.object({ expectedVersion: version }).strict();
export const identifierInputSchema = z
  .object({ kind: identifierKindSchema, value: text(128) })
  .strict();
export const identifierMutationSchema = identifierInputSchema
  .extend({ expectedVersion: version })
  .strict();
const productFields = {
  name: text(200),
  description: z
    .string()
    .trim()
    .max(4000)
    .nullable()
    .transform((value) => (value === '' ? null : value))
    .optional(),
  presentation: optionalText(200),
  unitOfMeasure: unitOfMeasureSchema,
  model: optionalText(160),
  manufacturerName: optionalText(160),
  brandId: z.uuid().nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
};
export const productCreateSchema = z
  .object({ ...productFields, identifiers: z.array(identifierInputSchema).max(10).optional() })
  .strict();
export const productUpdateSchema = z
  .object(productFields)
  .partial()
  .extend({ expectedVersion: version })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== 'expectedVersion'),
    'Indicá qué información querés actualizar.',
  );
const supplierFields = {
  name: text(200),
  legalName: optionalText(200),
  contactName: optionalText(160),
  email: z
    .union([z.email().max(254), z.literal(''), z.null()])
    .transform((value) => (value === '' ? null : value))
    .optional(),
  phone: optionalText(50),
};
export const supplierCreateSchema = z.object(supplierFields).strict();
export const supplierUpdateSchema = z
  .object(supplierFields)
  .partial()
  .extend({ expectedVersion: version })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== 'expectedVersion'),
    'Indicá qué información querés actualizar.',
  );
export const namedCreateSchema = z.object({ name: text(160) }).strict();
export const namedUpdateSchema = namedCreateSchema.extend({ expectedVersion: version }).strict();
export const supplierProductCreateSchema = z
  .object({
    supplierId: z.uuid(),
    supplierCode: optionalText(128),
    supplierDescription: optionalText(1000),
    expectedVersion: version,
  })
  .strict();
export const supplierProductUpdateSchema = z
  .object({
    supplierCode: optionalText(128),
    supplierDescription: optionalText(1000),
    expectedVersion: version,
  })
  .strict()
  .refine(
    (data) => Object.keys(data).some((key) => key !== 'expectedVersion'),
    'Indicá qué información querés actualizar.',
  );

const queryInteger = (fallback: string, max: number) =>
  z
    .string()
    .regex(/^[1-9][0-9]*$/, 'Usá un número entero positivo.')
    .default(fallback)
    .transform(Number)
    .pipe(z.number().int().min(1).max(max));
export const catalogListQuerySchema = z
  .object({
    q: z.string().trim().max(128).default(''),
    page: queryInteger('1', 10000),
    limit: queryInteger('20', 100),
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();
export const productListQuerySchema = catalogListQuerySchema
  .extend({
    brandId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    supplierId: z.uuid().optional(),
  })
  .strict();
export const identifierLookupQuerySchema = identifierInputSchema;

const dates = {
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
};
const entity = { id: z.uuid(), version: z.number().int().positive(), ...dates };
export const namedEntitySchema = z.object({ ...entity, name: z.string() }).strict();
const classification = z
  .object({ id: z.uuid(), name: z.string(), archivedAt: z.iso.datetime().nullable() })
  .strict();
export const productSchema = z
  .object({
    ...entity,
    name: z.string(),
    description: z.string().nullable(),
    presentation: z.string().nullable(),
    unitOfMeasure: unitOfMeasureSchema,
    model: z.string().nullable(),
    manufacturerName: z.string().nullable(),
    brandId: z.uuid().nullable(),
    categoryId: z.uuid().nullable(),
    brand: classification.nullable(),
    category: classification.nullable(),
    internalCodes: z.array(z.string()),
  })
  .strict();
export const identifierSchema = z
  .object({
    id: z.uuid(),
    productId: z.uuid(),
    kind: identifierKindSchema,
    value: z.string(),
    normalizedValue: z.string(),
    ...dates,
  })
  .strict();
export const supplierSchema = z
  .object({
    ...entity,
    name: z.string(),
    legalName: z.string().nullable(),
    contactName: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  })
  .strict();
export const supplierProductSchema = z
  .object({
    ...entity,
    productId: z.uuid(),
    supplierId: z.uuid(),
    supplierCode: z.string().nullable(),
    supplierDescription: z.string().nullable(),
    supplier: classification,
    product: classification,
  })
  .strict();
const pageFields = {
  page: z.number().int().positive(),
  limit: z.number().int().min(1).max(100),
  total: z.number().int().nonnegative(),
};
export const productListSchema = z
  .object({ items: z.array(productSchema), ...pageFields })
  .strict();
export const supplierListSchema = z
  .object({ items: z.array(supplierSchema), ...pageFields })
  .strict();
export const namedListSchema = z
  .object({ items: z.array(namedEntitySchema), ...pageFields })
  .strict();
export const identifierListSchema = z
  .object({ items: z.array(identifierSchema), ...pageFields })
  .strict();
export const supplierProductListSchema = z
  .object({ items: z.array(supplierProductSchema), ...pageFields })
  .strict();
export const identifierMutationResultSchema = z
  .object({ identifier: identifierSchema, product: productSchema })
  .strict();
export const supplierProductMutationResultSchema = z
  .object({ link: supplierProductSchema, product: productSchema })
  .strict();

export type UnitOfMeasure = z.infer<typeof unitOfMeasureSchema>;
export type IdentifierKind = z.infer<typeof identifierKindSchema>;
export type IdentifierInput = z.infer<typeof identifierInputSchema>;
export type ProductCreate = z.infer<typeof productCreateSchema>;
export type ProductUpdate = z.infer<typeof productUpdateSchema>;
export type SupplierCreate = z.infer<typeof supplierCreateSchema>;
export type SupplierUpdate = z.infer<typeof supplierUpdateSchema>;
export type NamedCreate = z.infer<typeof namedCreateSchema>;
export type NamedUpdate = z.infer<typeof namedUpdateSchema>;
export type SupplierProductCreate = z.infer<typeof supplierProductCreateSchema>;
export type SupplierProductUpdate = z.infer<typeof supplierProductUpdateSchema>;
export type CatalogListQuery = z.infer<typeof catalogListQuerySchema>;
export type ProductListQuery = z.infer<typeof productListQuerySchema>;
export type ProductView = z.infer<typeof productSchema>;
export type SupplierView = z.infer<typeof supplierSchema>;
export type NamedEntity = z.infer<typeof namedEntitySchema>;
export type IdentifierView = z.infer<typeof identifierSchema>;
export type SupplierProductView = z.infer<typeof supplierProductSchema>;

// Contratos de rutas concretas. El proxy web solo puede transportar estas rutas.
export function catalogRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (path === 'product-identifiers/resolve' && method === 'GET')
    return { response: productSchema, query: identifierLookupQuerySchema };
  for (const entity of ['products', 'suppliers', 'brands', 'categories'] as const) {
    const response =
      entity === 'products'
        ? productSchema
        : entity === 'suppliers'
          ? supplierSchema
          : namedEntitySchema;
    if (path === entity && method === 'GET')
      return {
        response:
          entity === 'products'
            ? productListSchema
            : entity === 'suppliers'
              ? supplierListSchema
              : namedListSchema,
        query: entity === 'products' ? productListQuerySchema : catalogListQuerySchema,
      };
    if (path === entity && method === 'POST')
      return {
        response,
        body:
          entity === 'products'
            ? productCreateSchema
            : entity === 'suppliers'
              ? supplierCreateSchema
              : namedCreateSchema,
      };
    if (new RegExp(`^${entity}/${id}$`).test(path)) {
      if (method === 'GET' && (entity === 'products' || entity === 'suppliers'))
        return { response };
      if (method === 'PATCH')
        return {
          response,
          body:
            entity === 'products'
              ? productUpdateSchema
              : entity === 'suppliers'
                ? supplierUpdateSchema
                : namedUpdateSchema,
        };
    }
    if (new RegExp(`^${entity}/${id}/(archive|restore)$`).test(path) && method === 'POST')
      return { response, body: versionInputSchema };
  }
  if (new RegExp(`^products/${id}/identifiers$`).test(path)) {
    if (method === 'GET') return { response: identifierListSchema, query: catalogListQuerySchema };
    if (method === 'POST')
      return { response: identifierMutationResultSchema, body: identifierMutationSchema };
  }
  if (
    new RegExp(`^products/${id}/identifiers/${id}/(archive|restore)$`).test(path) &&
    method === 'POST'
  )
    return { response: identifierMutationResultSchema, body: versionInputSchema };
  if (new RegExp(`^(products|suppliers)/${id}/supplier-products$`).test(path) && method === 'GET')
    return { response: supplierProductListSchema, query: catalogListQuerySchema };
  if (new RegExp(`^products/${id}/supplier-products$`).test(path) && method === 'POST')
    return { response: supplierProductMutationResultSchema, body: supplierProductCreateSchema };
  if (new RegExp(`^supplier-products/${id}$`).test(path) && method === 'PATCH')
    return { response: supplierProductMutationResultSchema, body: supplierProductUpdateSchema };
  if (new RegExp(`^supplier-products/${id}/(archive|restore)$`).test(path) && method === 'POST')
    return { response: supplierProductMutationResultSchema, body: versionInputSchema };
  return undefined;
}

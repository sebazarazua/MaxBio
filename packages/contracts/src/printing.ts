import { z } from 'zod';
import { deliveryNoteCreateSchema, deliveryNoteLineInputSchema } from './delivery-notes.js';

// Partial, transient document data only. No template override or browser-supplied names.
export const printDraftPreviewInputSchema = z
  .object(deliveryNoteCreateSchema.shape)
  .omit({ id: true })
  .partial()
  .extend({
    lines: z
      .array(deliveryNoteLineInputSchema.omit({ id: true }))
      .max(50)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.lines.reduce((n, line) => n + line.allocations.length, 0) > 500)
      ctx.addIssue({
        code: 'custom',
        message: 'Máximo 500 existencias por remito.',
        path: ['lines'],
      });
  });
export type PrintDraftPreviewInput = z.infer<typeof printDraftPreviewInputSchema>;

const mm = z.number().finite().min(0).max(1000);
const sizeMm = z.number().finite().min(0.5).max(1000);
const label = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .refine((v) => Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127));
export const printBindingSchema = z.enum([
  'document.number',
  'document.date',
  'document.dateDay',
  'document.dateMonth',
  'document.dateYear',
  'customer.name',
  'customer.legalName',
  'customer.cuit',
  'customer.taxCondition',
  'customer.address',
  'customer.addressLine',
  'customer.locality',
  'patient.name',
  'patient.affiliateNumber',
  'notes',
]);
export const printRowBindingSchema = z.enum([
  'quantity',
  'unit',
  'productName',
  'presentation',
  'lotNumber',
  'expirationDate',
  'serialNumber',
]);
const typography = {
  font: z.literal('NotoSans').default('NotoSans'),
  fontSizePt: z.number().finite().min(6).max(36),
  lineHeightPt: z.number().finite().min(6).max(60),
  align: z.enum(['left', 'center', 'right']).default('left'),
  verticalAlign: z.enum(['top', 'middle', 'bottom']).default('top'),
  maxLines: z.number().int().min(1).max(20).default(1),
  formatter: z.enum(['text', 'date', 'quantity', 'cuit']).default('text'),
  overflow: z.literal('BLOCK').default('BLOCK'),
  paddingMm: z.number().finite().min(0).max(10).default(0.5),
};
const rect = { xMm: mm, yMm: mm, widthMm: sizeMm, heightMm: sizeMm };
export const printFieldSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,47}$/),
    binding: printBindingSchema,
    ...rect,
    ...typography,
  })
  .strict();
export const printColumnSchema = z
  .object({
    binding: printRowBindingSchema,
    widthMm: sizeMm,
    ...typography,
  })
  .strict();
export const printDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    fields: z.array(printFieldSchema).max(40),
    productRegion: z
      .object({
        ...rect,
        rowHeightMm: sizeMm,
        columns: z.array(printColumnSchema).min(2).max(7),
      })
      .strict(),
  })
  .strict();
const templateFields = {
  name: label,
  pageWidthMm: z.number().finite().min(40).max(1000).multipleOf(0.001),
  pageHeightMm: z.number().finite().min(40).max(1000).multipleOf(0.001),
  safeToleranceXmm: z.number().finite().min(0).max(10).multipleOf(0.001),
  safeToleranceYmm: z.number().finite().min(0).max(10).multipleOf(0.001),
  backgroundAssetId: z.uuidv4(),
  definition: printDefinitionSchema,
};
export const printTemplateCreateSchema = z
  .object({
    id: z.uuidv4(),
    sourceTemplateId: z.uuidv4().optional(),
    ...templateFields,
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: 'custom', message, path: ['definition'] });
    const r = v.definition.productRegion;
    const boxes = [...v.definition.fields, r];
    for (const b of boxes) {
      if (b.xMm + b.widthMm > v.pageWidthMm || b.yMm + b.heightMm > v.pageHeightMm)
        issue('Todas las regiones deben estar dentro de la página.');
    }
    if (new Set(v.definition.fields.map((f) => f.id)).size !== v.definition.fields.length)
      issue('Los campos deben tener identificadores únicos.');
    if (
      new Set(r.columns.map((c) => c.binding)).size !== r.columns.length ||
      !r.columns.some((c) => c.binding === 'quantity') ||
      !r.columns.some((c) => c.binding === 'productName')
    )
      issue('Las columnas deben ser únicas e incluir quantity y productName.');
    if (
      r.columns.reduce((n, c) => n + c.widthMm, 0) > r.widthMm + 0.000001 ||
      r.rowHeightMm > r.heightMm
    )
      issue('Revisá los anchos de columnas y la altura de renglón.');
    for (const b of [
      ...v.definition.fields,
      ...r.columns.map((c) => ({ ...c, heightMm: r.rowHeightMm })),
    ]) {
      if (
        b.widthMm <= 2 * (v.safeToleranceXmm + b.paddingMm) ||
        b.heightMm <= 2 * (v.safeToleranceYmm + b.paddingMm) ||
        b.lineHeightPt < b.fontSizePt
      )
        issue('La tolerancia, el margen interno y la tipografía deben dejar espacio útil.');
    }
    for (const f of v.definition.fields) {
      if (
        (f.formatter === 'date' && f.binding !== 'document.date') ||
        f.formatter === 'quantity' ||
        (f.formatter === 'cuit' && f.binding !== 'customer.cuit')
      )
        issue('El formato elegido no corresponde al tipo de dato del campo.');
    }
    for (const c of r.columns) {
      if (
        (c.formatter === 'date' && c.binding !== 'expirationDate') ||
        (c.formatter === 'quantity' && c.binding !== 'quantity') ||
        c.formatter === 'cuit'
      )
        issue('El formato elegido no corresponde al tipo de dato de la columna.');
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!,
          b = boxes[j]!;
        if (
          a.xMm < b.xMm + b.widthMm &&
          a.xMm + a.widthMm > b.xMm &&
          a.yMm < b.yMm + b.heightMm &&
          a.yMm + a.heightMm > b.yMm
        )
          issue('Las regiones de campos y productos no pueden superponerse.');
      }
  });
export const printTemplateSchema = z
  .object({
    id: z.uuidv4(),
    familyId: z.uuidv4(),
    revision: z.number().int().positive(),
    status: z.enum(['DRAFT', 'PUBLISHED']),
    ...templateFields,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    publishedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const printTemplateListSchema = z.object({ items: z.array(printTemplateSchema) }).strict();
export const printTemplatePublishSchema = z
  .object({ activate: z.boolean().default(true) })
  .strict();
export const printCalibrationCreateSchema = z
  .object({
    id: z.uuidv4(),
    sourceCalibrationId: z.uuidv4().optional(),
    templateRevisionId: z.uuidv4(),
    name: label,
    printerDescription: label.nullable().default(null),
    trayDescription: label.nullable().default(null),
    offsetXmm: z.number().finite().min(-20).max(20).multipleOf(0.001),
    offsetYmm: z.number().finite().min(-20).max(20).multipleOf(0.001),
  })
  .strict();
export const printCalibrationSchema = printCalibrationCreateSchema
  .omit({ sourceCalibrationId: true })
  .extend({
    familyId: z.uuidv4(),
    revision: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const printConfigSchema = z
  .object({
    activeTemplate: printTemplateSchema.nullable(),
    calibrations: z.array(printCalibrationSchema),
  })
  .strict();
export const printAssetUploadSchema = z
  .object({
    pngBase64: z
      .string()
      .min(12)
      .max(5600000)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
export const printAssetSchema = z
  .object({ id: z.uuidv4(), contentHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const printRenderInputSchema = z
  .object({
    templateRevisionId: z.uuidv4(),
    calibrationId: z.uuidv4().nullable().default(null),
    expectedVersion: z.number().int().positive(),
    guides: z.boolean().default(false),
  })
  .strict();
export const printGenerateInputSchema = printRenderInputSchema
  .omit({ guides: true })
  .extend({
    id: z.uuidv4(),
  })
  .strict();
export const printReprintInputSchema = z.object({ id: z.uuidv4() }).strict();
export const printTestInputSchema = z
  .object({
    templateRevisionId: z.uuidv4(),
    calibrationId: z.uuidv4().nullable().default(null),
  })
  .strict();
export const printEvaluationSchema = z
  .object({
    state: z.enum(['SAFE', 'WARNING', 'BLOCKED']),
    documentVersion: z.number().int().positive(),
    templateRevisionId: z.uuidv4(),
    rowCount: z.number().int().nonnegative(),
    maxRows: z.number().int().nonnegative(),
    issues: z.array(
      z
        .object({
          state: z.enum(['WARNING', 'BLOCKED']),
          region: z.string(),
          message: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export const printArtifactSchema = z
  .object({
    id: z.uuidv4(),
    deliveryNoteId: z.uuidv4(),
    templateRevisionId: z.uuidv4(),
    calibrationId: z.uuidv4().nullable(),
    mode: z.literal('PRINT_OVERLAY'),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    documentVersion: z.number().int().positive(),
    generatedAt: z.iso.datetime(),
    generatedBy: z.uuidv4(),
    reprintOfId: z.uuidv4().nullable(),
  })
  .strict();
export const printDraftPreviewSchema = z
  .object({
    pdfBase64: z.string().min(1),
    evaluation: printEvaluationSchema,
  })
  .strict();
export const printArtifactListSchema = z.object({ items: z.array(printArtifactSchema) }).strict();
export type PrintTemplateCreate = z.infer<typeof printTemplateCreateSchema>;
export type PrintTemplate = z.infer<typeof printTemplateSchema>;
export type PrintDefinition = z.infer<typeof printDefinitionSchema>;
export type PrintField = z.infer<typeof printFieldSchema>;
export type PrintColumn = z.infer<typeof printColumnSchema>;
export type PrintCalibrationCreate = z.infer<typeof printCalibrationCreateSchema>;
export type PrintCalibration = z.infer<typeof printCalibrationSchema>;
export type PrintRenderInput = z.infer<typeof printRenderInputSchema>;
export type PrintGenerateInput = z.infer<typeof printGenerateInputSchema>;
export type PrintEvaluation = z.infer<typeof printEvaluationSchema>;
export type PrintArtifactView = z.infer<typeof printArtifactSchema>;

// An unsaved geometry preview is ADMIN-only. The stored revision supplies page size,
// tolerances, private background and calibration compatibility.
export const printGeometryInputSchema = printRenderInputSchema
  .omit({ guides: true })
  .extend({
    definition: printDefinitionSchema,
  })
  .strict();
const geometryRectSchema = z
  .object({
    xMm: z.number().finite(),
    yMm: z.number().finite(),
    widthMm: z.number().finite().nonnegative(),
    heightMm: z.number().finite().nonnegative(),
  })
  .strict();
export const printGeometryPreviewSchema = z
  .object({
    pdfBase64: z.string().min(1),
    evaluation: printEvaluationSchema,
    envelopes: z.array(
      z
        .object({
          region: z.string(),
          rect: geometryRectSchema,
          state: z.enum(['SAFE', 'WARNING', 'BLOCKED']),
        })
        .strict(),
    ),
  })
  .strict();
export type PrintGeometryInput = z.infer<typeof printGeometryInputSchema>;
export type PrintGeometryPreview = z.infer<typeof printGeometryPreviewSchema>;
export const printSampleGeometryInputSchema = printGeometryInputSchema.omit({
  templateRevisionId: true,
  expectedVersion: true,
});
export type PrintSampleGeometryInput = z.infer<typeof printSampleGeometryInputSchema>;

// BFF allowlist: binary responses are explicit and never parsed as JSON.
export function printingRouteContract(path: string, method: string) {
  const uuid =
    '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  const json = (body: z.ZodType | null, response: z.ZodType) => ({ body, response, binary: null });
  const binary = (body: z.ZodType | null, mime: string) => ({ body, response: null, binary: mime });
  if (path === 'config' && method === 'GET') return json(null, printConfigSchema);
  if (path === 'draft-preview' && method === 'POST')
    return json(printDraftPreviewInputSchema, printDraftPreviewSchema);
  if (path === 'templates') {
    if (method === 'GET') return json(null, printTemplateListSchema);
    if (method === 'POST') return json(printTemplateCreateSchema, printTemplateSchema);
  }
  if (new RegExp(`^templates/${uuid}/publish$`).test(path) && method === 'POST')
    return json(printTemplatePublishSchema, printTemplateSchema);
  if (new RegExp(`^templates/${uuid}/geometry-preview$`).test(path) && method === 'POST')
    return json(printSampleGeometryInputSchema, printGeometryPreviewSchema);
  if (path === 'calibrations' && method === 'POST')
    return json(printCalibrationCreateSchema, printCalibrationSchema);
  if (path === 'calibration-test' && method === 'POST')
    return binary(printTestInputSchema, 'application/pdf');
  if (path === 'assets' && method === 'POST') return json(printAssetUploadSchema, printAssetSchema);
  if (new RegExp(`^assets/${uuid}$`).test(path) && method === 'GET')
    return binary(null, 'image/png');
  if (new RegExp(`^delivery-notes/${uuid}/evaluate$`).test(path) && method === 'POST')
    return json(printRenderInputSchema, printEvaluationSchema);
  if (new RegExp(`^delivery-notes/${uuid}/preview$`).test(path) && method === 'POST')
    return binary(printRenderInputSchema, 'application/pdf');
  if (new RegExp(`^delivery-notes/${uuid}/geometry-preview$`).test(path) && method === 'POST')
    return json(printGeometryInputSchema, printGeometryPreviewSchema);
  if (new RegExp(`^delivery-notes/${uuid}/artifacts$`).test(path)) {
    if (method === 'POST') return json(printGenerateInputSchema, printArtifactSchema);
    if (method === 'GET') return json(null, printArtifactListSchema);
  }
  if (new RegExp(`^artifacts/${uuid}/reprint$`).test(path) && method === 'POST')
    return json(printReprintInputSchema, printArtifactSchema);
  if (new RegExp(`^artifacts/${uuid}/pdf$`).test(path) && method === 'GET')
    return binary(null, 'application/pdf');
  return null;
}

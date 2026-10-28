import { z } from 'zod';

export const invoiceFiscalStatusSchema = z.enum([
  'NOT_SUBMITTED',
  'AUTHORIZING',
  'AUTHORIZED',
  'REJECTED',
  'UNCERTAIN',
  'CONFLICT',
]);
export const invoiceFiscalStatusLabels = {
  NOT_SUBMITTED: 'Sin enviar a ARCA',
  AUTHORIZING: 'Autorizando con ARCA…',
  AUTHORIZED: 'Autorizada por ARCA',
  REJECTED: 'No autorizada por ARCA',
  UNCERTAIN: 'Pendiente de verificar con ARCA',
  CONFLICT: 'Requiere revisión fiscal',
} as const;
export const fiscalMessageSchema = z
  .object({ code: z.string().max(80), message: z.string().max(500) })
  .strict();
const date = z.iso.datetime().nullable();
export const fiscalAttemptViewSchema = z
  .object({
    id: z.uuidv4(),
    status: z.enum([
      'PREPARING',
      'AUTHORIZING',
      'AUTHORIZED',
      'REJECTED',
      'UNCERTAIN',
      'CONFLICT',
      'NOT_FOUND',
      'ABORTED',
    ]),
    pointOfSale: z.number().int().positive(),
    documentType: z.number().int().positive(),
    documentNumber: z.number().int().positive().nullable(),
    cae: z
      .string()
      .regex(/^\d{14}$/)
      .nullable(),
    caeExpiration: z.iso.date().nullable(),
    authorizedAt: date,
    createdAt: z.iso.datetime(),
    sentAt: date,
    completedAt: date,
    verifiedAt: date,
    messages: z.array(fiscalMessageSchema),
    observations: z.array(fiscalMessageSchema),
    reconciliation: z.string().nullable(),
  })
  .strict();
export const invoiceFiscalSchema = z
  .object({
    status: invoiceFiscalStatusSchema,
    receiverVatConditionId: z.number().int().positive().nullable(),
    receiverVatConditionLabel: z.string().nullable(),
    attempts: z.array(fiscalAttemptViewSchema),
  })
  .strict();
export const arcaVatConditionSchema = z
  .object({ id: z.number().int().positive(), label: z.string().max(180) })
  .strict();
export const wsfeReferencesSchema = z
  .object({
    points: z.array(z.number().int().min(1).max(99999)),
    conditions: z
      .object({
        A: z.array(arcaVatConditionSchema),
        B: z.array(arcaVatConditionSchema),
        C: z.array(arcaVatConditionSchema),
      })
      .strict(),
    documentTypes: z.array(arcaVatConditionSchema),
    ivaTypes: z.array(arcaVatConditionSchema),
  })
  .strict();
export const wsfeConfigurationSchema = z
  .object({
    environment: z.literal('HOMOLOGATION'),
    version: z.number().int().nonnegative(),
    pointOfSale: z.number().int().positive().nullable(),
    checkedAt: date,
    ready: z.boolean(),
    reasons: z.array(z.string()),
    references: wsfeReferencesSchema.nullable(),
  })
  .strict();
export const wsfeSelectPointSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    pointOfSale: z.number().int().min(1).max(99999),
  })
  .strict();
export const invoiceFiscalReceiverSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    conditionId: z.number().int().positive(),
  })
  .strict();
export const invoiceFiscalReadinessSchema = z
  .object({
    ready: z.boolean(),
    reasons: z.array(z.string()),
    pointOfSale: z.number().int().positive().nullable(),
    conditions: z.array(arcaVatConditionSchema),
    receiverVatConditionId: z.number().int().positive().nullable(),
  })
  .strict();
export type WsfeReferences = z.infer<typeof wsfeReferencesSchema>;
export type WsfeConfiguration = z.infer<typeof wsfeConfigurationSchema>;
export type FiscalMessage = z.infer<typeof fiscalMessageSchema>;

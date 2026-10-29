import { z } from 'zod';
import { cuitSchema, validCuit } from './customers.js';
import { wsfeConfigurationSchema, wsfeSelectPointSchema } from './invoice-fiscal.js';

// Internal semantics, deliberately independent from ARCA's numeric catalogs.
export const fiscalVatConditionSchema = z.enum([
  'RESPONSABLE_INSCRIPTO',
  'MONOTRIBUTO',
  'EXENTO',
  'CONSUMIDOR_FINAL',
  'NO_ALCANZADO',
]);
export const fiscalVatLabels: Record<z.infer<typeof fiscalVatConditionSchema>, string> = {
  RESPONSABLE_INSCRIPTO: 'Responsable inscripto',
  MONOTRIBUTO: 'Monotributista',
  EXENTO: 'Exento',
  CONSUMIDOR_FINAL: 'Consumidor final',
  NO_ALCANZADO: 'No alcanzado',
};
export const grossIncomeRegimeSchema = z.enum([
  'LOCAL',
  'MULTILATERAL_AGREEMENT',
  'EXEMPT',
  'NOT_APPLICABLE',
]);
export const grossIncomeLabels: Record<z.infer<typeof grossIncomeRegimeSchema>, string> = {
  LOCAL: 'Local',
  MULTILATERAL_AGREEMENT: 'Convenio Multilateral',
  EXEMPT: 'Exento',
  NOT_APPLICABLE: 'No corresponde',
};
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(
      (v) => Array.from(v).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
      'No se permiten caracteres de control.',
    )
    .nullable()
    .transform((v) => v || null);
const optionalCuit = z.union([cuitSchema, z.literal('').transform(() => null), z.null()]);
export const fiscalFieldsSchema = z
  .object({
    legalName: text(200),
    tradeName: text(200),
    cuit: optionalCuit,
    vatCondition: fiscalVatConditionSchema.nullable(),
    grossIncomeRegime: grossIncomeRegimeSchema.nullable(),
    grossIncomeNumber: text(40),
    addressLine: text(250),
    locality: text(120),
    province: text(100),
    postalCode: text(20),
    country: z.literal('AR').nullable(),
    nationalActivityCode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
    multilateralActivityCode: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
  })
  .strict();
export const fiscalProfileUpdateSchema = fiscalFieldsSchema
  .extend({ expectedVersion: z.number().int().nonnegative() })
  .strict();
export function fiscalCompleteness(
  p: (Omit<z.infer<typeof fiscalFieldsSchema>, 'country'> & { country: string | null }) | null,
): 'COMPLETE' | 'INCOMPLETE' {
  return p?.legalName &&
    p.cuit &&
    validCuit(p.cuit) &&
    p.vatCondition &&
    p.addressLine &&
    p.locality &&
    p.province &&
    p.postalCode &&
    p.country === 'AR' &&
    p.grossIncomeRegime &&
    (!['LOCAL', 'MULTILATERAL_AGREEMENT'].includes(p.grossIncomeRegime) || p.grossIncomeNumber)
    ? 'COMPLETE'
    : 'INCOMPLETE';
}
export const formatFiscalCuit = (cuit: string) =>
  validCuit(cuit) ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit;
export const fiscalProfileSchema = fiscalFieldsSchema
  .extend({
    id: z.uuidv4(),
    version: z.number().int().positive(),
    completeness: z.enum(['COMPLETE', 'INCOMPLETE']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const fiscalProfileResponseSchema = z
  .object({ profile: fiscalProfileSchema.nullable() })
  .strict();
export const arcaCredentialSchema = z
  .object({
    id: z.uuidv4(),
    commonName: z.string(),
    status: z.enum(['CSR_READY', 'CERTIFICATE_INSTALLED', 'ACTIVE', 'REPLACED', 'DISCARDED']),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    replacedAt: z.iso.datetime().nullable(),
    discardedAt: z.iso.datetime().nullable(),
    secretsDeletedAt: z.iso.datetime().nullable(),
    fingerprint: z.string().nullable(),
    serial: z.string().nullable(),
    subject: z.string().nullable(),
    issuer: z.string().nullable(),
    validFrom: z.iso.datetime().nullable(),
    validTo: z.iso.datetime().nullable(),
    certificateState: z.enum(['MISSING', 'VALID', 'EXPIRING_SOON', 'EXPIRED', 'INVALID']),
  })
  .strict();
export const arcaReadinessSchema = z
  .object({
    environment: z.literal('HOMOLOGATION'),
    service: z.literal('wsfe'),
    version: z.number().int().nonnegative(),
    fiscalProfile: z.enum(['COMPLETE', 'INCOMPLETE']),
    cuitValid: z.boolean(),
    cuit: z.string().nullable(),
    lastVerifiedAt: z.iso.datetime().nullable(),
    openssl: z.enum(['AVAILABLE', 'UNAVAILABLE']),
    privateKey: z.boolean(),
    csr: z.boolean(),
    certificateInstalled: z.boolean(),
    certificateMatchesKey: z.boolean(),
    canTest: z.boolean(),
    activeCredentialId: z.uuidv4().nullable(),
    pendingCredentialId: z.uuidv4().nullable(),
    credentials: z.array(arcaCredentialSchema),
    access: z
      .object({
        status: z.enum(['PENDING', 'AUTHENTICATED', 'ERROR', 'WAITING']),
        state: z
          .enum([
            'ACTIVE',
            'EXPIRING',
            'LOST_TICKET',
            'UNCERTAIN',
            'ERROR',
            'RENEWAL_PENDING',
            'NEVER_AUTHENTICATED',
          ])
          .optional(),
        obtainedAt: z.iso.datetime().nullable(),
        expiresAt: z.iso.datetime().nullable(),
        retryAfter: z.iso.datetime().nullable(),
        message: z.string().nullable(),
        lastResultCode: z.string().max(40).nullable(),
        lastAttemptAt: z.iso.datetime().nullable(),
        lastError: z.string().nullable(),
        testBlockedReason: z.string().nullable(),
      })
      .strict(),
    trust: z.enum(['PENDING_WSAA', 'VERIFIED_BY_WSAA']),
    wsfeImplemented: z.boolean(),
    productionEnabled: z.literal(false),
  })
  .strict();
export const arcaGenerateSchema = z
  .object({
    operationId: z.uuidv4(),
    expectedVersion: z.number().int().nonnegative(),
    commonName: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/),
    replacePending: z.boolean().default(false),
  })
  .strict();
export const arcaCertificateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    certificateBase64: z
      .string()
      .min(4)
      .max(136536)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export const arcaActivateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedConfigVersion: z.number().int().positive(),
  })
  .strict();
export const arcaDiscardSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const arcaCsrSchema = z
  .object({
    credentialId: z.uuidv4(),
    pem: z
      .string()
      .max(20000)
      .regex(
        /^-----BEGIN CERTIFICATE REQUEST-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE REQUEST-----\s*$/,
      ),
  })
  .strict();
export const arcaTestSchema = z.object({}).strict();
export type FiscalProfileUpdate = z.infer<typeof fiscalProfileUpdateSchema>;
export type FiscalProfile = z.infer<typeof fiscalProfileSchema>;
export type ArcaReadiness = z.infer<typeof arcaReadinessSchema>;
export type ArcaGenerate = z.infer<typeof arcaGenerateSchema>;
export type ArcaCertificate = z.infer<typeof arcaCertificateSchema>;
export type ArcaActivate = z.infer<typeof arcaActivateSchema>;
export type ArcaDiscard = z.infer<typeof arcaDiscardSchema>;
export function fiscalRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (path === 'fiscal/arca/invoicing' && method === 'GET')
    return { body: null, response: wsfeConfigurationSchema };
  if (path === 'fiscal/arca/invoicing/refresh' && method === 'POST')
    return { body: arcaTestSchema, response: wsfeConfigurationSchema };
  if (path === 'fiscal/arca/invoicing/point-of-sale' && method === 'POST')
    return { body: wsfeSelectPointSchema, response: wsfeConfigurationSchema };
  if (path === 'fiscal/profile' && method === 'GET')
    return { body: null, response: fiscalProfileResponseSchema };
  if (path === 'fiscal/profile' && method === 'PUT')
    return { body: fiscalProfileUpdateSchema, response: fiscalProfileResponseSchema };
  if (path === 'fiscal/arca/readiness' && method === 'GET')
    return { body: null, response: arcaReadinessSchema };
  if (path === 'fiscal/arca/credentials/generate' && method === 'POST')
    return { body: arcaGenerateSchema, response: arcaReadinessSchema };
  if (new RegExp(`^fiscal/arca/credentials/${id}/csr$`).test(path) && method === 'GET')
    return { body: null, response: arcaCsrSchema };
  if (new RegExp(`^fiscal/arca/credentials/${id}/certificate$`).test(path) && method === 'POST')
    return { body: arcaCertificateSchema, response: arcaReadinessSchema };
  if (new RegExp(`^fiscal/arca/credentials/${id}/activate$`).test(path) && method === 'POST')
    return { body: arcaActivateSchema, response: arcaReadinessSchema };
  if (new RegExp(`^fiscal/arca/credentials/${id}/discard$`).test(path) && method === 'POST')
    return { body: arcaDiscardSchema, response: arcaReadinessSchema };
  if (new RegExp(`^fiscal/arca/credentials/${id}/cleanup$`).test(path) && method === 'POST')
    return { body: arcaTestSchema, response: arcaReadinessSchema };
  if (path === 'fiscal/arca/wsaa/test' && method === 'POST')
    return { body: arcaTestSchema, response: arcaReadinessSchema };
  return null;
}

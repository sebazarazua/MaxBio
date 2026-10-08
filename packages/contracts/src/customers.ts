import { z } from 'zod';
import { catalogListQuerySchema, versionInputSchema } from './catalog.js';

export const customerKindSchema = z.enum(['HEALTH_INSURER', 'INSTITUTION', 'COMPANY', 'OTHER']);
export const customerKindLabels: Record<z.infer<typeof customerKindSchema>, string> = {
  HEALTH_INSURER: 'Obra social',
  INSTITUTION: 'Institución',
  COMPANY: 'Empresa',
  OTHER: 'Otro',
};

// Local mathematical validation only: this does not verify registration at ARCA.
export function validCuit(value: string): boolean {
  if (!/^[0-9]{11}$/.test(value) || /^0+$/.test(value)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce((total, weight, index) => total + Number(value[index]) * weight, 0);
  const check = (11 - (sum % 11)) % 11;
  return check < 10 && check === Number(value[10]);
}
export const cuitSchema = z
  .string()
  .trim()
  .max(32)
  .regex(
    /^(?:[0-9]{11}|[0-9]{2}\s*-\s*[0-9]{8}\s*-\s*[0-9])$/,
    'Usá 11 dígitos o el formato XX-XXXXXXXX-X.',
  )
  .transform((value) => value.replace(/[\s-]/g, ''))
  .refine(validCuit, 'Revisá el CUIT y su dígito verificador.');
const noControls = (value: string) =>
  Array.from(value).every(
    (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
  );
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1, 'Completá este campo.')
    .max(max)
    .refine(noControls, 'No se permiten caracteres de control.');
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine(noControls, 'No se permiten caracteres de control.')
    .nullable()
    .transform((value) => (value === '' ? null : value))
    .optional();
const fields = {
  name: text(200),
  kind: customerKindSchema,
  legalName: optionalText(200),
  cuit: z
    .union([
      cuitSchema,
      z
        .string()
        .trim()
        .length(0)
        .transform(() => null),
      z.null(),
    ])
    .optional(),
  taxConditionText: optionalText(80),
  addressLine: optionalText(250),
  locality: optionalText(120),
  province: optionalText(100),
  postalCode: optionalText(20),
  contactName: optionalText(160),
  phone: optionalText(50),
  email: z
    .string()
    .trim()
    .max(254)
    .refine((value) => value === '' || z.email().safeParse(value).success, 'Revisá el email.')
    .nullable()
    .transform((value) => (value === '' ? null : value))
    .optional(),
  notes: z
    .string()
    .trim()
    .max(1000)
    .refine(
      (value) =>
        Array.from(value).every((character) => {
          const code = character.charCodeAt(0);
          return (code >= 32 && code !== 127) || [9, 10, 13].includes(code);
        }),
      'No se permiten caracteres de control.',
    )
    .nullable()
    .transform((value) => (value === '' ? null : (value?.replace(/\r\n?/g, '\n') ?? null)))
    .optional(),
};
export const customerCreateSchema = z.object({ id: z.uuidv4(), ...fields }).strict();
export const customerUpdateSchema = z
  .object(fields)
  .partial()
  .extend({ expectedVersion: versionInputSchema.shape.expectedVersion })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion'),
    'Indicá qué información querés actualizar.',
  );
export const customerVersionSchema = versionInputSchema;
export const customerListQuerySchema = catalogListQuerySchema;
export const customerSchema = z
  .object({
    id: z.uuidv4(),
    name: z.string(),
    kind: customerKindSchema,
    legalName: z.string().nullable(),
    cuit: z
      .string()
      .regex(/^[0-9]{11}$/)
      .nullable(),
    taxConditionText: z.string().nullable(),
    addressLine: z.string().nullable(),
    locality: z.string().nullable(),
    province: z.string().nullable(),
    postalCode: z.string().nullable(),
    contactName: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    notes: z.string().nullable(),
    version: z.number().int().positive(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    archivedAt: z.iso.datetime().nullable(),
  })
  .strict();
export const customerListSchema = z
  .object({
    items: z.array(customerSchema),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  })
  .strict();
export type CustomerCreate = z.infer<typeof customerCreateSchema>;
export type CustomerUpdate = z.infer<typeof customerUpdateSchema>;
export type CustomerView = z.infer<typeof customerSchema>;
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export function customerRouteContract(path: string, method: string) {
  const id = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';
  if (method === 'GET' && path === 'customers')
    return { body: null, query: customerListQuerySchema, response: customerListSchema };
  if (method === 'GET' && new RegExp(`^customers/${id}$`).test(path))
    return { body: null, query: null, response: customerSchema };
  if (method === 'POST' && path === 'customers')
    return { body: customerCreateSchema, query: null, response: customerSchema };
  if (method === 'PATCH' && new RegExp(`^customers/${id}$`).test(path))
    return { body: customerUpdateSchema, query: null, response: customerSchema };
  if (method === 'POST' && new RegExp(`^customers/${id}/(archive|restore)$`).test(path))
    return { body: customerVersionSchema, query: null, response: customerSchema };
  return null;
}

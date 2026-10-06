import { z } from 'zod';
export * from './catalog.js';
export * from './supplier-catalog.js';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('maxbio-api'),
  database: z.literal('ok'),
  checkedAt: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const apiErrorSchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  code: z.string(),
  message: z.string(),
  requestId: z.uuid(),
  timestamp: z.iso.datetime(),
  path: z.string(),
  details: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

const organizationAccessSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    membershipId: z.uuid(),
    role: z.enum(['ADMIN', 'OPERATOR']),
  })
  .strict();
export const identityResponseSchema = z
  .object({
    user: z.object({ id: z.uuid(), email: z.email(), displayName: z.string() }).strict(),
    session: z
      .object({ id: z.uuid(), expiresAt: z.iso.datetime(), absoluteExpiresAt: z.iso.datetime() })
      .strict(),
    activeOrganization: organizationAccessSchema.nullable(),
    organizations: z.array(organizationAccessSchema),
  })
  .strict();
export type IdentityResponse = z.infer<typeof identityResponseSchema>;

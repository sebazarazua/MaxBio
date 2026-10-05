import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createDatabaseClient } from '@maxbio/database';
import type { PrismaClient } from '@maxbio/database';
import { z } from 'zod';
import { hashPassword } from './password.js';

const inputSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.trim().toLowerCase()),
  displayName: z.string().trim().min(1).max(160),
  password: z.string().min(15).max(128),
});

export async function bootstrapAdmin(client: PrismaClient, input: unknown) {
  const data = inputSchema.parse(input);
  const passwordHash = await hashPassword(data.password);
  return client.$transaction(async (tx) => {
    // Un solo primer admin, incluso con dos comandos simultáneos.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(68421931)`;
    const organization = await tx.organization.findUnique({ where: { slug: 'maxbio' } });
    if (!organization || organization.archivedAt)
      throw new Error('Prepará una organización MaxBio activa con db:seed.');
    if (
      await tx.membership.count({
        where: {
          organizationId: organization.id,
          role: 'ADMIN',
          revokedAt: null,
          user: { disabledAt: null },
        },
      })
    ) {
      const existing = await tx.membership.findFirst({
        where: {
          organizationId: organization.id,
          role: 'ADMIN',
          revokedAt: null,
          user: { email: data.email, disabledAt: null, passwordHash: { not: null } },
        },
      });
      if (existing) return { created: false };
      throw new Error('Ya existe un administrador. Este comando solo crea el primero.');
    }
    // Nunca toma una identidad existente ni cambia su contraseña/rol por repetición.
    if (await tx.user.findUnique({ where: { email: data.email } }))
      throw new Error('La identidad ya existe; requiere gestión explícita.');
    const user = await tx.user.create({
      data: { email: data.email, displayName: data.displayName, passwordHash },
    });
    await tx.membership.create({
      data: { userId: user.id, organizationId: organization.id, role: 'ADMIN' },
    });
    await tx.auditEvent.create({
      data: {
        organizationId: organization.id,
        actorUserId: user.id,
        action: 'INITIAL_ADMIN_CREATED',
        resourceType: 'User',
        resourceId: user.id,
        result: 'SUCCESS',
        requestId: randomUUID(),
        metadata: {},
      },
    });
    return { created: true };
  });
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL.');
  const password = process.env.MAXBIO_BOOTSTRAP_PASSWORD;
  const email = process.env.MAXBIO_BOOTSTRAP_EMAIL;
  const displayName = process.env.MAXBIO_BOOTSTRAP_NAME;
  delete process.env.MAXBIO_BOOTSTRAP_PASSWORD;
  if (!password || !email || !displayName)
    throw new Error(
      'Definí las tres variables temporales MAXBIO_BOOTSTRAP_EMAIL, MAXBIO_BOOTSTRAP_NAME y MAXBIO_BOOTSTRAP_PASSWORD.',
    );
  const client = createDatabaseClient(url);
  try {
    const result = await bootstrapAdmin(client, { email, displayName, password });
    console.info(
      result.created
        ? 'Primer administrador creado.'
        : 'El administrador ya estaba preparado; credenciales sin cambios.',
    );
  } finally {
    await client.$disconnect();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      'No se creó el administrador. Revisá variables, base migrada y ausencia de otro admin. No se modificaron credenciales existentes.',
    );
    process.exitCode = 1;
  });
}

import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { validCuit } from '@maxbio/contracts';
import { AppModule } from '../../../app.module.js';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { FiscalService } from './fiscal.service.js';
import { WsfeConfigurationService } from './wsfe-configuration.service.js';
import { OpenSslArcaCrypto } from '../arca/openssl-crypto.js';
import { ArcaError } from '../arca/arca-errors.js';

export async function readLocalCredential(path: string) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 102400)
    throw new Error('Archivo local inválido.');
  if (process.platform !== 'win32' && stat.mode & 0o077)
    throw new Error('El archivo requiere permisos privados (chmod 600).');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (current.ino !== stat.ino || current.size > 102400) throw new Error('El archivo cambió.');
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      organization: { type: 'string' },
      'create-organization': { type: 'boolean' },
      'issuer-name': { type: 'string' },
      'issuer-cuit': { type: 'string' },
      'holder-cuit': { type: 'string' },
      'actor-email': { type: 'string' },
      key: { type: 'string' },
      csr: { type: 'string' },
      certificate: { type: 'string' },
      activate: { type: 'boolean' },
      check: { type: 'boolean' },
      status: { type: 'boolean' },
    },
  });
  const input = z
    .object({
      organization: z.string().regex(/^[a-z0-9-]{1,80}$/),
      'issuer-cuit': z.string().refine(validCuit),
      'holder-cuit': z.string().refine(validCuit),
      'actor-email': z.email(),
      key: z.string().min(1),
      csr: z.string().min(1),
      certificate: z.string().min(1),
      'issuer-name': z.string().trim().min(1).max(200).optional(),
      'create-organization': z.boolean().optional(),
      activate: z.boolean().optional(),
      check: z.boolean().optional(),
      status: z.boolean().optional(),
    })
    .strict()
    .parse(values);
  if (process.env.NODE_ENV === 'production') throw new Error('Solo homologación local.');
  // Load sequentially so every allocated private buffer is wiped even if another read fails.
  const buffers: Buffer[] = [];
  let app: Awaited<ReturnType<typeof NestFactory.createApplicationContext>> | undefined;
  let sessionId: string | undefined;
  try {
    const key = await readLocalCredential(input.key);
    buffers.push(key);
    const csr = await readLocalCredential(input.csr);
    buffers.push(csr);
    const certificate = await readLocalCredential(input.certificate);
    buffers.push(certificate);
    await new OpenSslArcaCrypto().validateImport(
      csr,
      key,
      certificate,
      input['holder-cuit'],
      new Date(),
    );
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    const db = app.get(DatabaseService).client;
    const context = await db.$transaction(async (tx) => {
      const actor = await tx.user.findUniqueOrThrow({ where: { email: input['actor-email'] } });
      if (
        actor.disabledAt ||
        !(await tx.membership.count({
          where: {
            userId: actor.id,
            role: 'ADMIN',
            revokedAt: null,
            organization: { archivedAt: null },
          },
        }))
      )
        throw new Error('Se requiere un administrador activo.');
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`arca-import:${input.organization}`},0))`;
      let org = await tx.organization.findUnique({ where: { slug: input.organization } });
      if (!org) {
        if (!input['create-organization'] || !input['issuer-name'])
          throw new Error('Organización inexistente.');
        org = await tx.organization.create({
          data: { slug: input.organization, name: input['issuer-name'] },
        });
        await tx.organizationFiscalProfile.create({
          data: {
            organizationId: org.id,
            legalName: input['issuer-name'],
            cuit: input['issuer-cuit'],
            country: 'AR',
          },
        });
        await tx.membership.create({
          data: { organizationId: org.id, userId: actor.id, role: 'ADMIN' },
        });
        await tx.auditEvent.create({
          data: {
            organizationId: org.id,
            actorUserId: actor.id,
            action: 'FISCAL_ORGANIZATION_CREATED',
            resourceType: 'Organization',
            resourceId: org.id,
            result: 'SUCCESS',
            requestId: randomUUID(),
            metadata: { source: 'local-credential-import' },
          },
        });
      }
      if (org.archivedAt) throw new Error('Organización archivada.');
      const membership = await tx.membership.findFirstOrThrow({
        where: { organizationId: org.id, userId: actor.id, role: 'ADMIN', revokedAt: null },
      });
      const profile = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: org.id },
      });
      if (profile?.cuit !== input['issuer-cuit'])
        throw new Error('El emisor no coincide. No se modifica el perfil existente.');
      const session = await tx.session.create({
        data: {
          userId: actor.id,
          activeMembershipId: membership.id,
          tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
          deviceName: 'Importación administrativa local',
          expiresAt: new Date(Date.now() + 600000),
          absoluteExpiresAt: new Date(Date.now() + 600000),
        },
      });
      return {
        organizationId: org.id,
        userId: actor.id,
        membershipId: membership.id,
        sessionId: session.id,
        role: 'ADMIN' as const,
        requestId: randomUUID(),
      };
    });
    sessionId = context.sessionId;
    const fiscal = app.get(FiscalService);
    const config = await db.arcaIntegrationConfig.findUnique({
      where: { organizationId: context.organizationId },
    });
    const result = await fiscal.importCredential(context, {
      issuerCuit: input['issuer-cuit'],
      certificateHolderCuit: input['holder-cuit'],
      privateKey: key,
      csr,
      certificate,
      expectedVersion: config?.version ?? 0,
    });
    console.info(
      JSON.stringify({
        organizationId: context.organizationId,
        ...result,
        environment: 'HOMOLOGATION',
      }),
    );
    if (input.activate && result.status !== 'ACTIVE') {
      const state = await fiscal.readiness(context),
        credential = state.credentials.find((c) => c.id === result.id)!;
      if (state.activeCredentialId)
        throw new Error(
          'La activación local no reemplaza una credencial activa. Revisá el reemplazo desde la UI.',
        );
      await fiscal.activate(context, result.id, {
        expectedVersion: credential.version,
        expectedConfigVersion: state.version,
      });
      console.info('Credencial activada.');
    }
    if (input.status) {
      // Read-only: database and encrypted ticket storage. No WSAA/WSFE network call.
      const state = await fiscal.readiness(context),
        wsfe = await app.get(WsfeConfigurationService).get(context);
      console.info(
        JSON.stringify({
          issuerCuit: state.cuit,
          fiscalProfile: state.fiscalProfile,
          canTest: state.canTest,
          activeCredentialId: state.activeCredentialId,
          credentials: state.credentials.map((c) => ({
            id: c.id,
            commonName: c.commonName,
            status: c.status,
            issuerCuit: c.issuerCuit,
            certificateHolderCuit: c.certificateHolderCuit,
          })),
          access: {
            status: state.access.status,
            state: state.access.state ?? null,
            obtainedAt: state.access.obtainedAt,
            expiresAt: state.access.expiresAt,
            retryAfter: state.access.retryAfter,
            lastResultCode: state.access.lastResultCode,
          },
          wsfe: {
            ready: wsfe.ready,
            checkedAt: wsfe.checkedAt,
            pointOfSale: wsfe.pointOfSale,
            points: wsfe.references?.points ?? null,
            checks: wsfe.checks,
            reasons: wsfe.reasons,
          },
        }),
      );
    }
    if (input.check) {
      // These ports only authenticate and read references. Never invoke authorize/FECAESolicitar.
      await fiscal.testConnection(context);
      const wsfe = await app.get(WsfeConfigurationService).refresh(context);
      console.info(
        JSON.stringify({
          wsaa: 'VERIFIED',
          wsfeCheckedAt: wsfe.checkedAt,
          points: wsfe.references?.points ?? null,
          reasons: wsfe.reasons,
        }),
      );
    }
  } finally {
    for (const buffer of buffers) buffer.fill(0);
    if (app) {
      try {
        if (sessionId)
          await app
            .get(DatabaseService)
            .client.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
      } finally {
        await app.close();
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // Public service exceptions contain only mapped/sanitized fiscal diagnostics.
    // Never print filesystem, OpenSSL stderr, HTTP transport or arbitrary error objects.
    // ArcaError messages are fixed catalog strings (arca-errors.ts): safe to show, never secret-bearing.
    if (error instanceof HttpException || error instanceof ArcaError) console.error(error.message);
    console.error(
      'No se completó la operación local. Revisá identidad, vigencia, permisos, perfil fiscal y estado pendiente. Los archivos originales y credenciales activas se conservan. No se emitieron comprobantes.',
    );
    process.exitCode = 1;
  });
}

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import {
  fiscalCompleteness,
  fiscalFieldsSchema,
  arcaReadinessSchema,
  validCuit,
  type ArcaActivate,
  type ArcaCertificate,
  type ArcaGenerate,
  type ArcaReadiness,
  type ArcaDiscard,
  type FiscalProfileUpdate,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import {
  CREDENTIAL_STORAGE,
  type PrivateCredentialStorage,
} from '../infrastructure/private-credential-storage.js';
import { OpenSslArcaCrypto, CMS_SIGNER, type CmsSigner } from '../arca/openssl-crypto.js';
import {
  ARCA_CLOCK,
  ArcaError,
  arcaMessages,
  TICKET_MARGIN_MS,
  UNCERTAIN_WINDOW_MS,
  WSAA_RETRY_MS,
  wsaaRetryCategory,
  type ArcaClock,
  type ArcaErrorCode,
} from '../arca/arca-errors.js';
import { ArcaWsaaClient } from '../arca/wsaa-client.js';
import { TraFactory } from '../arca/wsaa-xml.js';
import { ArcaTicketProvider } from '../arca/ticket-provider.js';

type Tx = Prisma.TransactionClient;
type Credential = Prisma.ArcaCredentialGetPayload<object>;
type Profile = Prisma.OrganizationFiscalProfileGetPayload<object>;
const scope = (org: string) => ({ organizationId: org, environment: 'HOMOLOGATION' as const });
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
// Also fail closed if a restored/corrupt database is missing the partial unique index.
export function uniqueActive<T extends { status: string }>(rows: T[]): T | undefined {
  const active = rows.filter((row) => row.status === 'ACTIVE');
  if (active.length > 1)
    throw new ConflictException(
      'La configuración ARCA es inconsistente: hay varias credenciales activas.',
    );
  return active[0];
}
function profileView(p: Profile | null) {
  if (!p) return null;
  return {
    id: p.id,
    ...fiscalFieldsSchema.parse(
      Object.fromEntries(
        Object.keys(fiscalFieldsSchema.shape).map((k) => [k, p[k as keyof Profile]]),
      ),
    ),
    version: p.version,
    completeness: fiscalCompleteness(p),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export function certificateState(
  c: Pick<Credential, 'certificateStorageKey' | 'validFrom' | 'validTo'>,
  now: Date,
) {
  if (!c.certificateStorageKey) return 'MISSING' as const;
  if (!c.validFrom || !c.validTo || c.validFrom > now) return 'INVALID' as const;
  if (c.validTo <= now) return 'EXPIRED' as const;
  return c.validTo.getTime() - now.getTime() < 30 * 86400000
    ? ('EXPIRING_SOON' as const)
    : ('VALID' as const);
}
@Injectable()
export class FiscalService {
  private readonly logger = new Logger(FiscalService.name);
  private readonly tra = new TraFactory();
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CREDENTIAL_STORAGE) private readonly storage: PrivateCredentialStorage,
    @Inject(OpenSslArcaCrypto) private readonly crypto: OpenSslArcaCrypto,
    @Inject(CMS_SIGNER) private readonly signer: CmsSigner,
    @Inject(ArcaWsaaClient) private readonly wsaa: ArcaWsaaClient,
    @Inject(ArcaTicketProvider) private readonly tickets: ArcaTicketProvider,
    @Inject(ARCA_CLOCK) private readonly clock: ArcaClock,
  ) {}
  private admin(c: RequestActorContext) {
    if (c.role !== 'ADMIN') throw new ForbiddenException('Esta acción requiere un administrador.');
  }
  private async access(c: RequestActorContext, tx: Tx) {
    this.admin(c);
    const now = this.clock.now();
    const [membership, session] = await Promise.all([
      tx.membership.findFirst({
        where: {
          id: c.membershipId,
          organizationId: c.organizationId,
          userId: c.userId,
          role: 'ADMIN',
          revokedAt: null,
          user: { disabledAt: null },
          organization: { archivedAt: null },
        },
      }),
      tx.session.findFirst({
        where: {
          id: c.sessionId,
          userId: c.userId,
          activeMembershipId: c.membershipId,
          revokedAt: null,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
      }),
    ]);
    if (!membership || !session)
      throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
  }
  private async write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>) {
    this.admin(c);
    try {
      return await this.db.client.$transaction(
        async (tx) => {
          // One lock order for profile, generation, install, activation and durable login reservation.
          await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`fiscal:${c.organizationId}`},0))`;
          await this.access(c, tx);
          return fn(tx);
        },
        { timeout: 30000, maxWait: 5000 },
      );
    } catch (e) {
      if (e instanceof ArcaError) throw new BadRequestException(e.message);
      if (typeof e === 'object' && e !== null && 'code' in e) {
        if (['P2002', 'P2034'].includes(String(e.code)))
          throw new ConflictException('La configuración cambió. Volvé a cargarla.');
        if (['P2003', 'P2025'].includes(String(e.code))) throw new NotFoundException();
      }
      throw e;
    }
  }
  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw new ConflictException(
        'La configuración cambió desde otra sesión. Cargá la información actual antes de continuar.',
      );
  }
  private async credential(tx: Tx, c: RequestActorContext, id: string) {
    const row = await tx.arcaCredential.findFirst({ where: { ...scope(c.organizationId), id } });
    if (!row) throw new NotFoundException();
    return row;
  }
  private async active(tx: Tx, org: string) {
    return uniqueActive(
      await tx.arcaCredential.findMany({
        where: { ...scope(org), status: 'ACTIVE' },
        take: 2,
      }),
    );
  }
  private async config(tx: Tx, org: string) {
    return tx.arcaIntegrationConfig.upsert({
      where: { organizationId: org },
      create: { organizationId: org },
      update: {},
    });
  }
  private complete(
    profile: Profile | null,
  ): asserts profile is Profile & { legalName: string; cuit: string } {
    if (fiscalCompleteness(profile) !== 'COMPLETE')
      throw new BadRequestException('Completá los datos fiscales antes de configurar la conexión.');
  }
  async getProfile(c: RequestActorContext) {
    this.admin(c);
    return {
      profile: profileView(
        await this.db.client.organizationFiscalProfile.findUnique({
          where: { organizationId: c.organizationId },
        }),
      ),
    };
  }
  async updateProfile(c: RequestActorContext, input: FiscalProfileUpdate) {
    return this.write(c, async (tx) => {
      const prior = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: c.organizationId },
      });
      this.version(prior?.version ?? 0, input.expectedVersion);
      const fields = fiscalFieldsSchema.parse(
        Object.fromEntries(
          Object.keys(fiscalFieldsSchema.shape).map((k) => [
            k,
            input[k as keyof FiscalProfileUpdate],
          ]),
        ),
      );
      const row = prior
        ? await tx.organizationFiscalProfile.update({
            where: { organizationId: c.organizationId, version: input.expectedVersion },
            data: { ...fields, version: { increment: 1 } },
          })
        : await tx.organizationFiscalProfile.create({
            data: { organizationId: c.organizationId, ...fields },
          });
      await this.audit.success(
        c,
        'FISCAL_PROFILE_UPDATED',
        'OrganizationFiscalProfile',
        row.id,
        tx,
      );
      return { profile: profileView(row) };
    });
  }
  async readiness(c: RequestActorContext): Promise<ArcaReadiness> {
    this.admin(c);
    // Probed outside the transaction: a missing executable must not hold a DB connection.
    const openssl = (await this.crypto.availability()).available;
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const p = await tx.organizationFiscalProfile.findUnique({
          where: { organizationId: c.organizationId },
        });
        const config = await tx.arcaIntegrationConfig.findUnique({
          where: { organizationId: c.organizationId },
        });
        const current = await tx.arcaCredential.findMany({
          where: {
            ...scope(c.organizationId),
            status: { in: ['ACTIVE', 'CSR_READY', 'CERTIFICATE_INSTALLED'] },
          },
          orderBy: { createdAt: 'desc' },
        });
        const history = await tx.arcaCredential.findMany({
          where: { ...scope(c.organizationId), status: { in: ['REPLACED', 'DISCARDED'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 20,
        });
        const records = [...current, ...history];
        const active = uniqueActive(current),
          pending = current.find((r) => ['CSR_READY', 'CERTIFICATE_INSTALLED'].includes(r.status));
        const verified = active
          ? await tx.auditEvent.findFirst({
              where: {
                organizationId: c.organizationId,
                resourceType: 'ArcaCredential',
                resourceId: active.id,
                action: 'ARCA_WSAA_TEST_SUCCEEDED',
                result: 'SUCCESS',
              },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            })
          : null;
        const ticket = active ? this.tickets.peek(c.organizationId, active.id) : undefined;
        const lastAttempt = active
          ? await tx.auditEvent.findFirst({
              where: {
                organizationId: c.organizationId,
                resourceId: active.id,
                action: { in: ['ARCA_WSAA_LOGIN_STARTED', 'ARCA_WSAA_TEST_FAILED'] },
              },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            })
          : null;
        const now = this.clock.now(),
          complete = fiscalCompleteness(p) === 'COMPLETE';
        let filesValid = false;
        if (
          active &&
          active.cuit === p?.cuit &&
          active.certificateStorageKey &&
          ['VALID', 'EXPIRING_SOON'].includes(certificateState(active, now))
        ) {
          try {
            const [key, cert] = await Promise.all([
              this.storage.read(c.organizationId, active.privateKeyStorageKey),
              this.storage.read(c.organizationId, active.certificateStorageKey),
            ]);
            try {
              const checked = await this.crypto.certificate(cert, key, active.cuit, now);
              filesValid = checked.fingerprint === active.certificateFingerprint;
            } finally {
              key.fill(0);
            }
          } catch {
            filesValid = false;
          }
        }
        const usable = Boolean(
          ticket &&
          ticket.expiresAt.getTime() - now.getTime() > TICKET_MARGIN_MS &&
          filesValid &&
          complete,
        );
        const waiting = Boolean(
          config?.authBlockedUntil && config.authBlockedUntil > now && !usable,
        );
        const code = config?.lastResultCode as ArcaErrorCode | undefined;
        const lastError =
          code && code in arcaMessages && !['WAITING', 'EXPIRING_TICKET'].includes(code)
            ? arcaMessages[code]
            : code === 'WAITING' || code === ('IN_PROGRESS' as string)
              ? 'No quedó registrado el resultado original del último intento. El proceso pudo interrumpirse; no se puede descartar que ARCA haya emitido un acceso.'
              : null;
        const testBlockedReason = waiting
          ? code === ('SUCCESS' as string)
            ? 'El acceso anterior sigue vigente en ARCA, pero no está disponible en este proceso. Hay que esperar su vencimiento.'
            : code === 'ALREADY_AUTHENTICATED'
              ? arcaMessages.ALREADY_AUTHENTICATED
              : code &&
                  code in arcaMessages &&
                  ['CORRECTABLE', 'TRANSIENT'].includes(wsaaRetryCategory(code))
                ? 'Hay una pausa mínima de seguridad. Corregí la causa informada antes de volver a probar.'
                : 'El último intento quedó sin un acceso utilizable y pudo haber creado un TA. Se conserva la espera por seguridad.'
          : !complete
            ? 'Completá los datos fiscales del emisor.'
            : !filesValid
              ? 'Se requiere una credencial activa vigente y un certificado que corresponda a su clave.'
              : !openssl && !usable
                ? 'OpenSSL no está disponible en el servidor.'
                : null;
        return arcaReadinessSchema.parse({
          environment: 'HOMOLOGATION',
          service: 'wsfe',
          version: config?.version ?? 0,
          fiscalProfile: complete ? 'COMPLETE' : 'INCOMPLETE',
          cuitValid: Boolean(p?.cuit && validCuit(p.cuit)),
          cuit: p?.cuit ?? null,
          lastVerifiedAt: verified?.createdAt.toISOString() ?? null,
          openssl: openssl ? 'AVAILABLE' : 'UNAVAILABLE',
          privateKey: Boolean(active || pending),
          csr: Boolean(active || pending),
          certificateInstalled: Boolean(
            active?.certificateStorageKey || pending?.certificateStorageKey,
          ),
          certificateMatchesKey: filesValid,
          canTest: Boolean(complete && filesValid && (openssl || usable) && (!waiting || usable)),
          activeCredentialId: active?.id ?? null,
          pendingCredentialId: pending?.id ?? null,
          credentials: records.map((r) => ({
            id: r.id,
            commonName: r.commonName,
            status: r.status,
            version: r.version,
            createdAt: r.createdAt.toISOString(),
            replacedAt: r.replacedAt?.toISOString() ?? null,
            discardedAt: r.discardedAt?.toISOString() ?? null,
            secretsDeletedAt: r.secretsDeletedAt?.toISOString() ?? null,
            fingerprint: r.certificateFingerprint,
            serial: r.certificateSerial,
            subject: r.certificateSubject,
            issuer: r.certificateIssuer,
            validFrom: r.validFrom?.toISOString() ?? null,
            validTo: r.validTo?.toISOString() ?? null,
            certificateState: certificateState(r, now),
          })),
          access: {
            lastResultCode: config?.lastResultCode ?? null,
            lastAttemptAt: lastAttempt?.createdAt.toISOString() ?? null,
            lastError,
            testBlockedReason,
            status: usable
              ? 'AUTHENTICATED'
              : waiting &&
                  !(
                    code &&
                    code in arcaMessages &&
                    ['CORRECTABLE', 'TRANSIENT'].includes(wsaaRetryCategory(code))
                  )
                ? 'WAITING'
                : code && code !== ('SUCCESS' as string)
                  ? 'ERROR'
                  : 'PENDING',
            obtainedAt: config?.lastObtainedAt?.toISOString() ?? null,
            expiresAt: config?.lastTicketExpiresAt?.toISOString() ?? null,
            retryAfter: waiting ? config!.authBlockedUntil!.toISOString() : null,
            message: usable
              ? 'Acceso activo'
              : waiting
                ? arcaMessages.WAITING
                : code && code in arcaMessages
                  ? arcaMessages[code]
                  : null,
          },
          trust: usable ? 'VERIFIED_BY_WSAA' : 'PENDING_WSAA',
          wsfeImplemented: true,
          productionEnabled: false,
        });
      },
      { isolationLevel: 'RepeatableRead', timeout: 30000 },
    );
  }
  // Files created before commit are removed only after confirming no committed row references them.
  private async cleanup(org: string, id: string, keys: string[]) {
    try {
      const row = await this.db.client.arcaCredential.findFirst({
        where: { organizationId: org, id },
      });
      const retained = new Set([
        row?.privateKeyStorageKey,
        row?.csrStorageKey,
        row?.certificateStorageKey,
      ]);
      for (const key of keys)
        if (!retained.has(key)) await this.storage.remove(org, key).catch(() => {});
    } catch {
      /* DB outcome uncertain: keep files, never delete a possibly committed credential. */
    }
  }
  async generate(c: RequestActorContext, input: ArcaGenerate) {
    const id = randomUUID(),
      keys: string[] = [];
    let retiredId: string | undefined;
    try {
      await this.write(c, async (tx) => {
        const hash = digest(input),
          prior = await tx.arcaCredential.findFirst({
            where: { organizationId: c.organizationId, generationOperationId: input.operationId },
          });
        if (prior) {
          if (prior.generationHash !== hash)
            throw new ConflictException('Esta solicitud ya se utilizó con otros datos.');
          if (['DISCARDED', 'REPLACED'].includes(prior.status))
            throw new ConflictException(
              'Esta solicitud ya no puede utilizarse. Creá una nueva solicitud.',
            );
          return;
        }
        await this.active(tx, c.organizationId);
        const priorConfig = await tx.arcaIntegrationConfig.findUnique({
          where: { organizationId: c.organizationId },
        });
        const pending = await tx.arcaCredential.findFirst({
          where: {
            ...scope(c.organizationId),
            status: { in: ['CSR_READY', 'CERTIFICATE_INSTALLED'] },
          },
        });
        if (pending && !input.replacePending) return;
        this.version(priorConfig?.version ?? 0, input.expectedVersion);
        await this.config(tx, c.organizationId);
        const p = await tx.organizationFiscalProfile.findUnique({
          where: { organizationId: c.organizationId },
        });
        this.complete(p);
        const generated = await this.crypto.generate(p.legalName, p.cuit, input.commonName);
        try {
          keys.push(await this.storage.put(c.organizationId, generated.privateKey));
          keys.push(await this.storage.put(c.organizationId, generated.csr));
        } finally {
          generated.privateKey.fill(0);
        }
        if (pending) {
          await tx.arcaCredential.update({
            where: { id: pending.id, organizationId: c.organizationId },
            data: { status: 'DISCARDED', discardedAt: this.clock.now(), version: { increment: 1 } },
          });
          await this.audit.success(
            c,
            'ARCA_CREDENTIAL_DISCARDED',
            'ArcaCredential',
            pending.id,
            tx,
          );
          retiredId = pending.id;
        }
        await tx.arcaCredential.create({
          data: {
            id,
            organizationId: c.organizationId,
            commonName: input.commonName,
            legalName: p.legalName,
            cuit: p.cuit,
            generationOperationId: input.operationId,
            generationHash: hash,
            privateKeyStorageKey: keys[0]!,
            csrStorageKey: keys[1]!,
          },
        });
        await tx.arcaIntegrationConfig.update({
          where: { organizationId: c.organizationId },
          data: { version: { increment: 1 } },
        });
        await this.audit.success(c, 'ARCA_CREDENTIAL_GENERATED', 'ArcaCredential', id, tx);
      });
    } catch (e) {
      await this.cleanup(c.organizationId, id, keys);
      throw e;
    }
    if (retiredId) await this.purgeRetired(c, retiredId);
    return this.readiness(c);
  }
  async csr(c: RequestActorContext, id: string) {
    this.admin(c);
    const row = await this.credential(this.db.client, c, id);
    if (!['CSR_READY', 'CERTIFICATE_INSTALLED'].includes(row.status))
      throw new ConflictException('Esta solicitud ya no está pendiente.');
    return {
      credentialId: row.id,
      pem: (await this.storage.read(c.organizationId, row.csrStorageKey)).toString('utf8'),
    };
  }
  async install(c: RequestActorContext, id: string, input: ArcaCertificate) {
    const keys: string[] = [];
    try {
      await this.write(c, async (tx) => {
        const row = await this.credential(tx, c, id);
        this.version(row.version, input.expectedVersion);
        if (row.status !== 'CSR_READY')
          throw new ConflictException(
            'Generá una nueva solicitud para reemplazar un certificado instalado.',
          );
        const p = await tx.organizationFiscalProfile.findUnique({
          where: { organizationId: c.organizationId },
        });
        this.complete(p);
        if (p.cuit !== row.cuit) throw new ArcaError('CUIT_MISMATCH');
        const key = await this.storage.read(c.organizationId, row.privateKeyStorageKey);
        let checked;
        try {
          checked = await this.crypto.certificate(
            Buffer.from(input.certificateBase64, 'base64'),
            key,
            p.cuit,
            this.clock.now(),
          );
        } finally {
          key.fill(0);
        }
        keys.push(await this.storage.put(c.organizationId, Buffer.from(checked.pem)));
        await tx.arcaCredential.update({
          where: { id, organizationId: c.organizationId, version: input.expectedVersion },
          data: {
            status: 'CERTIFICATE_INSTALLED',
            version: { increment: 1 },
            certificateStorageKey: keys[0],
            certificateFingerprint: checked.fingerprint,
            certificateSerial: checked.serial,
            certificateSubject: checked.subject,
            certificateIssuer: checked.issuer,
            validFrom: checked.validFrom,
            validTo: checked.validTo,
          },
        });
        await tx.arcaIntegrationConfig.update({
          where: { organizationId: c.organizationId },
          data: { version: { increment: 1 } },
        });
        await this.audit.success(c, 'ARCA_CERTIFICATE_INSTALLED', 'ArcaCredential', id, tx);
      });
    } catch (e) {
      await this.cleanup(c.organizationId, id, keys);
      throw e;
    }
    return this.readiness(c);
  }
  async activate(c: RequestActorContext, id: string, input: ArcaActivate) {
    let retiredId: string | undefined;
    await this.write(c, async (tx) => {
      const row = await this.credential(tx, c, id),
        config = await this.config(tx, c.organizationId);
      const active = await this.active(tx, c.organizationId);
      this.version(row.version, input.expectedVersion);
      this.version(config.version, input.expectedConfigVersion);
      if (row.status !== 'CERTIFICATE_INSTALLED' || !row.certificateStorageKey)
        throw new ArcaError('CERTIFICATE_MISSING');
      const p = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: c.organizationId },
      });
      this.complete(p);
      if (row.cuit !== p.cuit) throw new ArcaError('CUIT_MISMATCH');
      const key = await this.storage.read(c.organizationId, row.privateKeyStorageKey);
      try {
        await this.crypto.certificate(
          await this.storage.read(c.organizationId, row.certificateStorageKey),
          key,
          p.cuit,
          this.clock.now(),
        );
      } finally {
        key.fill(0);
      }
      if (active) {
        await tx.arcaCredential.update({
          where: { id: active.id, organizationId: c.organizationId },
          data: { status: 'REPLACED', replacedAt: this.clock.now(), version: { increment: 1 } },
        });
        retiredId = active.id;
      }
      await tx.arcaCredential.update({
        where: { id, organizationId: c.organizationId },
        data: { status: 'ACTIVE', version: { increment: 1 } },
      });
      // Do not clear a durable reservation during rotation: an old in-flight request may finish.
      await tx.arcaIntegrationConfig.update({
        where: { organizationId: c.organizationId },
        data: {
          version: { increment: 1 },
          lastResultCode: null,
          lastObtainedAt: null,
          lastTicketExpiresAt: null,
        },
      });
      await this.audit.success(c, 'ARCA_CREDENTIAL_ACTIVATED', 'ArcaCredential', id, tx);
    });
    this.tickets.invalidate(c.organizationId);
    if (retiredId) await this.purgeRetired(c, retiredId);
    return this.readiness(c);
  }
  async discard(c: RequestActorContext, id: string, input: ArcaDiscard) {
    // Commit a terminal state and its audit BEFORE touching storage. A failed commit keeps files.
    await this.write(c, async (tx) => {
      const row = await this.credential(tx, c, id);
      await this.active(tx, c.organizationId);
      if (row.status === 'DISCARDED') return; // Retry resumes any interrupted deletion.
      if (!['CSR_READY', 'CERTIFICATE_INSTALLED'].includes(row.status))
        throw new ConflictException(
          'Solo se pueden descartar solicitudes pendientes. La credencial activa se conserva.',
        );
      this.version(row.version, input.expectedVersion);
      // Pending states have no fiscal references: auth resolves ACTIVE exclusively. This model
      // has no invoice/TA FK to a credential; the audit resource is intentionally retained.
      await tx.arcaCredential.update({
        where: { id, organizationId: c.organizationId },
        data: { status: 'DISCARDED', discardedAt: this.clock.now(), version: { increment: 1 } },
      });
      await tx.arcaIntegrationConfig.update({
        where: { organizationId: c.organizationId },
        data: { version: { increment: 1 } },
      });
      await this.audit.success(c, 'ARCA_CREDENTIAL_DISCARDED', 'ArcaCredential', id, tx);
    });
    await this.purgeRetired(c, id);
    return this.readiness(c);
  }
  private async purgeRetired(c: RequestActorContext, id: string) {
    await this.write(c, async (tx) => {
      const row = await this.credential(tx, c, id);
      if (!['DISCARDED', 'REPLACED'].includes(row.status))
        throw new ConflictException('La limpieza solo admite solicitudes descartadas o historial.');
      if (row.secretsDeletedAt) return;
      const keys = [row.privateKeyStorageKey, row.csrStorageKey, row.certificateStorageKey].filter(
        (key): key is string => key !== null,
      );
      // Check every column, including cross-column references in legacy/corrupt data. Never
      // delete a file another credential could need, even if it belongs to another tenant.
      const referenced = await tx.arcaCredential.count({
        where: {
          id: { not: id },
          OR: [
            { privateKeyStorageKey: { in: keys } },
            { csrStorageKey: { in: keys } },
            { certificateStorageKey: { in: keys } },
          ],
        },
      });
      if (referenced)
        throw new ConflictException(
          'Hay referencias compartidas. Se requiere revisar la configuración ARCA.',
        );
      try {
        for (const key of new Set(keys)) await this.storage.remove(c.organizationId, key);
      } catch {
        throw new ServiceUnavailableException(
          'La solicitud ya está retirada. La limpieza quedó pendiente; volvé a intentar para completarla.',
        );
      }
      await tx.arcaCredential.update({
        where: { id, organizationId: c.organizationId },
        data: { secretsDeletedAt: this.clock.now() },
      });
      await this.audit.success(c, 'ARCA_CREDENTIAL_SECRETS_REMOVED', 'ArcaCredential', id, tx);
    });
  }
  async cleanupRetired(c: RequestActorContext, id: string) {
    await this.purgeRetired(c, id);
    return this.readiness(c);
  }
  // Server-only port: never exposed through a controller/contract.
  async authenticate(c: RequestActorContext, recordTest = false) {
    this.admin(c);
    // Authorize every caller before it can join an in-flight authentication.
    const identity = await this.write(c, async (tx) => {
      const active = await this.active(tx, c.organizationId);
      if (!active) throw new BadRequestException('No hay una credencial ARCA activa.');
      const p = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: c.organizationId },
      });
      this.complete(p);
      if (!active?.certificateStorageKey) throw new ArcaError('CERTIFICATE_MISSING');
      if (active.cuit !== p.cuit) throw new ArcaError('CUIT_MISMATCH');
      const state = certificateState(active, this.clock.now());
      if (state === 'EXPIRED') throw new ArcaError('CERTIFICATE_EXPIRED');
      if (state === 'INVALID') throw new ArcaError('CERTIFICATE_INVALID');
      if (recordTest)
        await this.audit.append(
          {
            ...this.auditContext(c, active.id),
            action: 'ARCA_WSAA_TEST_STARTED',
            result: 'SUCCESS',
          },
          tx,
        );
      return active;
    });
    try {
      const ticket = await this.tickets.get(c.organizationId, identity.id, async () => {
        const key = await this.storage.read(c.organizationId, identity.privateKeyStorageKey);
        try {
          const certificate = await this.storage.read(
            c.organizationId,
            identity.certificateStorageKey!,
          );
          // WSAA echoes the certificate DN as destination: its CN is the WSASS alias, not the CSR CN.
          const { commonName } = await this.crypto.certificate(
            certificate,
            key,
            identity.cuit,
            this.clock.now(),
          );
          const tra = this.tra.create(this.clock.now()),
            cms = await this.signer.sign(tra.xml, key, certificate);
          // Commit reservation BEFORE network I/O. A lost response or restart cannot provoke duplicate loginCms.
          await this.write(c, async (tx) => {
            const row = await this.credential(tx, c, identity.id),
              config = await this.config(tx, c.organizationId);
            await this.active(tx, c.organizationId);
            const p = await tx.organizationFiscalProfile.findUnique({
              where: { organizationId: c.organizationId },
            });
            this.complete(p);
            if (row.status !== 'ACTIVE' || row.version !== identity.version || row.cuit !== p.cuit)
              throw new ConflictException('La credencial cambió. Volvé a cargarla.');
            if (config.authBlockedUntil && config.authBlockedUntil > this.clock.now())
              throw new ArcaError('WAITING');
            await tx.arcaIntegrationConfig.update({
              where: { organizationId: c.organizationId },
              data: {
                authBlockedUntil: new Date(this.clock.now().getTime() + UNCERTAIN_WINDOW_MS),
                lastResultCode: 'IN_PROGRESS',
              },
            });
            await this.audit.append(
              {
                ...this.auditContext(c, identity.id),
                action: 'ARCA_WSAA_LOGIN_STARTED',
                result: 'SUCCESS',
                metadata: { code: 'IN_PROGRESS' },
              },
              tx,
            );
          });
          this.logger.log({
            event: 'arca_wsaa_login_started',
            requestId: c.requestId,
            code: 'IN_PROGRESS',
          });
          try {
            const ticket = await this.wsaa.login(
              cms,
              { cuit: identity.cuit, commonName },
              this.clock.now(),
            );
            if (ticket.expiresAt.getTime() - this.clock.now().getTime() <= TICKET_MARGIN_MS)
              throw new ArcaError('TICKET_TIME_INVALID');
            await this.write(c, async (tx) => {
              const row = await this.credential(tx, c, identity.id);
              if (row.status !== 'ACTIVE' || row.version !== identity.version)
                throw new ConflictException('La credencial cambió. Volvé a cargarla.');
              await tx.arcaIntegrationConfig.update({
                where: { organizationId: c.organizationId },
                data: {
                  authBlockedUntil: ticket.expiresAt,
                  lastTicketExpiresAt: ticket.expiresAt,
                  lastObtainedAt: ticket.obtainedAt,
                  lastResultCode: 'SUCCESS',
                },
              });
              await this.audit.append(
                {
                  ...this.auditContext(c, identity.id),
                  action: 'ARCA_WSAA_LOGIN_SUCCEEDED',
                  result: 'SUCCESS',
                  metadata: { code: 'SUCCESS', retryAfter: ticket.expiresAt.toISOString() },
                },
                tx,
              );
            });
            this.logger.log({
              event: 'arca_wsaa_login_succeeded',
              requestId: c.requestId,
              code: 'SUCCESS',
            });
            return ticket;
          } catch (e) {
            // A late response from a retired credential must not overwrite the new ACTIVE's
            // readiness or shorten its durable reservation during rotation.
            if (e instanceof ConflictException) throw e;
            const error = e instanceof ArcaError ? e : new ArcaError('NETWORK_ERROR');
            await this.write(c, async (tx) => {
              const row = await this.credential(tx, c, identity.id);
              if (row.status !== 'ACTIVE' || row.version !== identity.version) return;
              // Unknown delivery/response outcome stays blocked for the maximum TA lifetime.
              const category = wsaaRetryCategory(error.code);
              const uncertain = ['UNCERTAIN', 'EXISTING_TICKET', 'WAITING'].includes(category);
              await tx.arcaIntegrationConfig.update({
                where: { organizationId: c.organizationId },
                data: {
                  lastResultCode: error.code,
                  ...(uncertain
                    ? {}
                    : { authBlockedUntil: new Date(this.clock.now().getTime() + WSAA_RETRY_MS) }),
                },
              });
              await this.audit.append(
                {
                  ...this.auditContext(c, identity.id),
                  action: 'ARCA_WSAA_LOGIN_FAILED',
                  result: 'FAILURE',
                  metadata: { code: error.code },
                },
                tx,
              );
            });
            this.logger.warn({
              event: 'arca_wsaa_login_failed',
              requestId: c.requestId,
              code: error.code,
              category: wsaaRetryCategory(error.code),
            });
            throw error;
          }
        } finally {
          key.fill(0);
        }
      });
      await this.write(c, async (tx) => {
        const active = await this.active(tx, c.organizationId);
        if (active?.id !== identity.id || active.version !== identity.version)
          throw new ConflictException('La credencial cambió. Volvé a cargarla.');
        if (recordTest)
          await this.audit.success(
            c,
            'ARCA_WSAA_TEST_SUCCEEDED',
            'ArcaCredential',
            identity.id,
            tx,
          );
      });
      return { ticket, cuit: identity.cuit, credentialId: identity.id };
    } catch (e) {
      if (recordTest)
        await this.write(c, async (tx) => {
          const config = await tx.arcaIntegrationConfig.findUnique({
            where: { organizationId: c.organizationId },
          });
          // write() converts ArcaError to a public HTTP exception. Preserve the internal code
          // for locally blocked calls without replacing the original login result in config.
          const waiting = e instanceof BadRequestException && e.message === arcaMessages.WAITING;
          const code = e instanceof ArcaError ? e.code : waiting ? 'WAITING' : 'UNEXPECTED_ERROR';
          await this.audit.append(
            {
              organizationId: c.organizationId,
              actorUserId: c.userId,
              sessionId: c.sessionId,
              requestId: c.requestId,
              action: 'ARCA_WSAA_TEST_FAILED',
              resourceType: 'ArcaCredential',
              resourceId: identity.id,
              result: 'FAILURE',
              metadata: {
                code,
                ...(config?.authBlockedUntil
                  ? { retryAfter: config.authBlockedUntil.toISOString() }
                  : {}),
              },
            },
            tx,
          );
          this.logger.warn({ event: 'arca_wsaa_test_failed', requestId: c.requestId, code });
        });
      if (e instanceof ArcaError) throw new BadRequestException(e.message);
      throw e;
    }
  }
  private auditContext(c: RequestActorContext, id: string) {
    return {
      organizationId: c.organizationId,
      actorUserId: c.userId,
      sessionId: c.sessionId,
      requestId: c.requestId,
      resourceType: 'ArcaCredential',
      resourceId: id,
    };
  }
  async testConnection(c: RequestActorContext) {
    await this.authenticate(c, true);
    return this.readiness(c);
  }
}

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  wsfeReferencesSchema,
  type WsfeConfiguration,
  type WsfeReferences,
} from '@maxbio/contracts';
import type { Prisma } from '@maxbio/database';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { FISCAL_PROVIDER, WsfeError, type FiscalProvider } from '../arca/wsfe-types.js';
import { ARCA_CLOCK, type ArcaClock } from '../arca/arca-errors.js';
import { FiscalService, uniqueActive } from './fiscal.service.js';
import { requireFiscalAdmin } from './fiscal-access.js';
export const REFERENCES_TTL_MS = 15 * 60 * 1000;
@Injectable()
export class WsfeConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FiscalService) private readonly fiscal: FiscalService,
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
    @Inject(ARCA_CLOCK) private readonly clock: ArcaClock,
  ) {}
  async get(c: RequestActorContext): Promise<WsfeConfiguration> {
    const readiness = await this.fiscal.readiness(c);
    const config = await this.db.client.arcaIntegrationConfig.findUnique({
      where: { organizationId: c.organizationId },
    });
    const parsed = wsfeReferencesSchema.safeParse(config?.wsfeReferences);
    const refs = parsed.success ? parsed.data : null,
      reasons: string[] = [];
    if (readiness.fiscalProfile !== 'COMPLETE' || !readiness.certificateMatchesKey)
      reasons.push('Completá el perfil fiscal y verificá la credencial activa de homologación.');
    if (readiness.access.status !== 'AUTHENTICATED')
      reasons.push(
        readiness.access.retryAfter
          ? `El acceso WSAA debe renovarse después de ${new Date(readiness.access.retryAfter).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false })} (Buenos Aires).`
          : 'Consultá ARCA para obtener acceso WSAA y las referencias de facturación.',
      );
    if (
      !refs ||
      !config?.wsfeCheckedAt ||
      this.clock.now().getTime() - config.wsfeCheckedAt.getTime() > REFERENCES_TTL_MS ||
      config.wsfeCuit !== readiness.cuit ||
      config.wsfeCredentialId !== readiness.activeCredentialId
    )
      reasons.push('Consultá nuevamente las referencias de ARCA.');
    if (
      !config?.pointOfSale ||
      config.pointOfSaleCuit !== readiness.cuit ||
      !refs?.points.includes(config.pointOfSale)
    )
      reasons.push('Elegí y confirmá un punto de venta habilitado por ARCA para CAE.');
    return {
      environment: 'HOMOLOGATION',
      version: config?.version ?? 0,
      pointOfSale: config?.pointOfSale ?? null,
      checkedAt: config?.wsfeCheckedAt?.toISOString() ?? null,
      ready: reasons.length === 0,
      reasons,
      references: refs,
    };
  }
  async fetchReferences(c: RequestActorContext) {
    // Authorization before any external call, including service-level invocations.
    await this.db.client.$transaction((tx) => requireFiscalAdmin(tx, c, this.clock.now()));
    try {
      return await this.provider.references(c);
    } catch (e) {
      if (e instanceof WsfeError)
        throw new ServiceUnavailableException(
          e.message +
            (e.details.length
              ? ' ' + e.details.map((m) => `${m.code}: ${m.message}`).join(' ')
              : ''),
        );
      throw e;
    }
  }
  private async save(
    c: RequestActorContext,
    ref: { references: WsfeReferences; cuit: string; credentialId: string },
    point?: { number: number; version: number },
  ) {
    await this.db.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`fiscal:${c.organizationId}`},0))`;
      await requireFiscalAdmin(tx, c, this.clock.now());
      const active = uniqueActive(
        await tx.arcaCredential.findMany({
          where: {
            organizationId: c.organizationId,
            environment: 'HOMOLOGATION',
            status: 'ACTIVE',
          },
          take: 2,
        }),
      );
      const profile = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: c.organizationId },
      });
      if (active?.id !== ref.credentialId || profile?.cuit !== ref.cuit)
        throw new ConflictException('La configuración ARCA cambió. Volvé a consultar.');
      const prior = await tx.arcaIntegrationConfig.findUnique({
        where: { organizationId: c.organizationId },
      });
      if (point && point.version !== (prior?.version ?? 0))
        throw new ConflictException('La configuración cambió. Cargá la información actual.');
      if (point && !ref.references.points.includes(point.number))
        throw new BadRequestException('El punto de venta no está habilitado por ARCA para CAE.');
      const data = {
        wsfeReferences: ref.references as unknown as Prisma.InputJsonValue,
        wsfeCheckedAt: this.clock.now(),
        wsfeCuit: ref.cuit,
        wsfeCredentialId: ref.credentialId,
        ...(point
          ? {
              pointOfSale: point.number,
              pointOfSaleCuit: ref.cuit,
              pointOfSaleValidatedAt: this.clock.now(),
            }
          : {}),
      };
      await tx.arcaIntegrationConfig.upsert({
        where: { organizationId: c.organizationId },
        create: { organizationId: c.organizationId, ...data },
        update: { ...data, version: { increment: 1 } },
      });
      await this.audit.success(
        c,
        point ? 'ARCA_POINT_OF_SALE_CONFIGURED' : 'ARCA_WSFE_REFERENCES_REFRESHED',
        'ArcaIntegrationConfig',
        c.organizationId,
        tx,
      );
    });
    return this.get(c);
  }
  async refresh(c: RequestActorContext) {
    return this.save(c, await this.fetchReferences(c));
  }
  async selectPoint(
    c: RequestActorContext,
    input: { pointOfSale: number; expectedVersion: number },
  ) {
    return this.save(c, await this.fetchReferences(c), {
      number: input.pointOfSale,
      version: input.expectedVersion,
    });
  }
}

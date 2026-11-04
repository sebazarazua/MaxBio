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
  private readonly preparations = new Map<string, Promise<WsfeConfiguration>>();
  private readonly failures = new Map<string, { until: number; message: string }>();

  // Only preparation performs automatic network I/O. GET remains observational.
  async prepare(c: RequestActorContext): Promise<WsfeConfiguration> {
    await this.db.client.$transaction((tx) => requireFiscalAdmin(tx, c, this.clock.now()));
    const pending = this.preparations.get(c.organizationId);
    if (pending) return pending;
    const run = this.prepareConfiguration(c).finally(() =>
      this.preparations.delete(c.organizationId),
    );
    this.preparations.set(c.organizationId, run);
    return run;
  }
  private async prepareConfiguration(c: RequestActorContext): Promise<WsfeConfiguration> {
    let cfg = await this.get(c);
    const failed = this.failures.get(c.organizationId);
    if (failed && failed.until > this.clock.now().getTime())
      return {
        ...cfg,
        ready: false,
        reasons: [failed.message],
        retryAfter: new Date(failed.until).toISOString(),
      };
    this.failures.delete(c.organizationId);
    if (!cfg.checks.find((v) => v.id === 'credential')?.ready)
      return {
        ...cfg,
        reasons: [
          'Completá los datos fiscales del emisor y su conexión con ARCA en Configuración.',
        ],
      };
    if (
      cfg.retryAfter &&
      new Date(cfg.retryAfter) > this.clock.now() &&
      !cfg.checks.find((v) => v.id === 'wsaa')?.ready
    )
      return {
        ...cfg,
        reasons: [
          `ARCA todavía no permite renovar el acceso. Disponible después de ${new Date(cfg.retryAfter).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false })} (Buenos Aires).`,
        ],
      };
    try {
      if (!cfg.checks.find((v) => v.id === 'wsaa')?.ready) {
        // Restores encrypted persisted access, reuses single-flight and existing durable WSAA lock.
        await this.fiscal.authenticate(c);
        cfg = await this.get(c);
      }
      if (!cfg.checks.find((v) => v.id === 'references')?.ready) cfg = await this.refresh(c);
      return cfg;
    } catch {
      cfg = await this.get(c);
      const message = cfg.retryAfter
        ? (cfg.reasons.find((v) => v.includes('renovar')) ??
          'ARCA todavía no permite renovar el acceso. Esperá hasta el horario indicado.')
        : 'No pudimos conectarnos con ARCA. Reintentá en unos momentos. Si el problema continúa, revisá la configuración de ARCA.';
      const until = Math.max(
        this.clock.now().getTime() + 60000,
        cfg.retryAfter ? Date.parse(cfg.retryAfter) : 0,
      );
      for (const [key, value] of this.failures)
        if (value.until <= this.clock.now().getTime()) this.failures.delete(key);
      if (this.failures.size >= 1000) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(c.organizationId, { until, message });
      return {
        ...cfg,
        ready: false,
        reasons: [message],
        retryAfter: new Date(until).toISOString(),
      };
    }
  }

  async receiverConditions(c: RequestActorContext) {
    const cfg = await this.prepare(c);
    if (!cfg.checks.find((v) => v.id === 'references')?.ready || !cfg.references)
      throw new ServiceUnavailableException(
        cfg.reasons[0] ?? 'No pudimos actualizar la información de ARCA.',
      );
    return [
      ...new Map(
        Object.values(cfg.references.conditions)
          .flat()
          .map((v) => [v.id, v]),
      ).values(),
    ];
  }

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
    const credentialReady = readiness.cuitValid && readiness.certificateMatchesKey;
    const referencesReady = Boolean(
      refs &&
      config?.wsfeCheckedAt &&
      this.clock.now().getTime() - config.wsfeCheckedAt.getTime() <= REFERENCES_TTL_MS &&
      config.wsfeCuit === readiness.cuit &&
      config.wsfeCredentialId === readiness.activeCredentialId,
    );
    const pointReady = Boolean(
      config?.pointOfSale &&
      config.pointOfSaleCuit === readiness.cuit &&
      refs?.points.includes(config.pointOfSale),
    );
    if (!readiness.certificateMatchesKey || !readiness.cuitValid)
      reasons.push('Verificá el CUIT emisor y la credencial activa de homologación.');
    if (readiness.fiscalProfile !== 'COMPLETE')
      reasons.push(
        'Completá y verificá los datos fiscales (IVA, domicilio e Ingresos Brutos) antes de emitir. Las consultas de conexión no emiten comprobantes.',
      );
    if (readiness.access.status !== 'AUTHENTICATED')
      reasons.push(
        readiness.access.retryAfter
          ? `ARCA todavía no permite renovar el acceso. Disponible después de ${new Date(readiness.access.retryAfter).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour12: false })} (Buenos Aires).`
          : 'No pudimos obtener el acceso a ARCA. Reintentá la preparación.',
      );
    if (
      !refs ||
      !config?.wsfeCheckedAt ||
      this.clock.now().getTime() - config.wsfeCheckedAt.getTime() > REFERENCES_TTL_MS ||
      config.wsfeCuit !== readiness.cuit ||
      config.wsfeCredentialId !== readiness.activeCredentialId
    )
      reasons.push('No pudimos actualizar la información de ARCA. Reintentá la preparación.');
    if (
      !config?.pointOfSale ||
      config.pointOfSaleCuit !== readiness.cuit ||
      !refs?.points.includes(config.pointOfSale)
    )
      reasons.push(
        referencesReady && !refs?.points.length
          ? 'ARCA no informa puntos de venta habilitados para facturar con MaxBio. Configurá uno en ARCA y después elegilo en Configuración.'
          : 'Elegí y confirmá el punto de venta que querés usar con MaxBio.',
      );
    return {
      retryAfter: readiness.access.retryAfter,
      checks: [
        { id: 'credential', label: 'Credencial ARCA', ready: credentialReady },
        { id: 'wsaa', label: 'Acceso WSAA', ready: readiness.access.status === 'AUTHENTICATED' },
        { id: 'references', label: 'Referencias WSFE', ready: referencesReady },
        {
          id: 'point',
          label: `Punto de venta${config?.pointOfSale ? ' ' + String(config.pointOfSale).padStart(5, '0') : ''}`,
          ready: pointReady,
        },
      ],
      environment: 'HOMOLOGATION',
      version: config?.version ?? 0,
      pointOfSale: config?.pointOfSale ?? null,
      checkedAt: config?.wsfeCheckedAt?.toISOString() ?? null,
      ready: reasons.length === 0,
      reasons,
      references: referencesReady ? refs : null,
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

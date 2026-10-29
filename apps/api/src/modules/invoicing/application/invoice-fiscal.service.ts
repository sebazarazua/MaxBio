import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import {
  fiscalCompleteness,
  deliveryNoteCustomerSchema,
  validCuit,
  type InvoiceTransition,
  type InvoiceView,
  type FiscalMessage,
} from '@maxbio/contracts';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { ARCA_CLOCK, type ArcaClock } from '../../fiscal/arca/arca-errors.js';
import {
  FISCAL_PROVIDER,
  WsfeError,
  wsfeInvoiceSchema,
  type FiscalProvider,
  type WsfeInvoice,
  type WsfeResult,
  type WsfeRegistered,
} from '../../fiscal/arca/wsfe-types.js';
import { WsfeConfigurationService } from '../../fiscal/application/wsfe-configuration.service.js';
import { requireFiscalAdmin } from '../../fiscal/application/fiscal-access.js';
import {
  mapFiscalInvoice,
  localFiscalReasons,
  fiscalClass,
  validateFiscalDate,
  sameFiscalInvoice,
} from '../domain/fiscal-mapper.js';
import { invoiceInclude, invoiceView, invoiceHistory } from './invoice-view.js';

type Tx = Prisma.TransactionClient;
type Attempt = Prisma.InvoiceFiscalAttemptGetPayload<object>;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const LEASE_MS = 90000,
  ABSENCE_DELAY_MS = 120000,
  ABSENCE_INTERVAL_MS = 60000;
const seqScope = (a: { organizationId: string; pointOfSale: number; documentType: number }) => ({
  organizationId: a.organizationId,
  environment: 'HOMOLOGATION' as const,
  pointOfSale: a.pointOfSale,
  documentType: a.documentType,
});
const seqWhere = (a: { organizationId: string; pointOfSale: number; documentType: number }) => ({
  organizationId_environment_pointOfSale_documentType: seqScope(a),
});
@Injectable()
export class InvoiceFiscalService {
  private readonly sequenceChecks = new Map<
    string,
    { number: number | null; checkedAt: Date; message: string | null }
  >();
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FISCAL_PROVIDER) private readonly provider: FiscalProvider,
    @Inject(WsfeConfigurationService) private readonly configuration: WsfeConfigurationService,
    @Inject(ARCA_CLOCK) private readonly clock: ArcaClock,
  ) {}
  private async write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>) {
    if (c.role !== 'ADMIN') throw new ForbiddenException('Esta acción requiere un administrador.');
    try {
      return await this.db.client.$transaction(
        async (tx) => {
          await requireFiscalAdmin(tx, c, this.clock.now());
          return fn(tx);
        },
        { timeout: 15000, maxWait: 5000 },
      );
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e) {
        if (['P2002', 'P2034'].includes(String(e.code)))
          throw new ConflictException(
            'La operación fiscal cambió. Cargá la información actual y verificá con ARCA.',
          );
        if (['P2003', 'P2025'].includes(String(e.code))) throw new NotFoundException();
      }
      throw e;
    }
  }
  private async record(tx: Tx, c: RequestActorContext, id: string) {
    const i = await tx.invoice.findFirst({
      where: { organizationId: c.organizationId, id },
      include: invoiceInclude,
    });
    if (!i) throw new NotFoundException();
    return i;
  }
  private async view(c: RequestActorContext, id: string, replayed = false): Promise<InvoiceView> {
    const i = await this.record(this.db.client, c, id);
    return invoiceView(i, await invoiceHistory(this.db.client, c.organizationId, id), replayed);
  }
  private async lockSequence(
    tx: Tx,
    c: RequestActorContext,
    a: { pointOfSale: number; documentType: number },
  ) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`invoice-fiscal:${c.organizationId}:HOMOLOGATION:${a.pointOfSale}:${a.documentType}`},0))`;
  }
  private async lockInvoice(tx: Tx, c: RequestActorContext, id: string) {
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    return this.record(tx, c, id);
  }
  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw new ConflictException(
        'La factura cambió. Cargá la información actual antes de continuar.',
      );
  }
  async readiness(c: RequestActorContext, id: string) {
    const i = await this.write(c, (tx) => this.record(tx, c, id));
    const cfg = await this.configuration.get(c),
      reasons = [...cfg.reasons],
      cls = i.invoiceType ? fiscalClass(i.invoiceType) : undefined;
    const conditions = cls ? (cfg.references?.conditions[cls] ?? []) : [];
    if (i.status !== 'READY') reasons.push('Marcá la factura como lista para autorizar.');
    if (i.fiscalStatus !== 'NOT_SUBMITTED')
      reasons.push(
        'Esta factura ya tiene una operación fiscal. Revisá su resultado antes de continuar.',
      );
    const p = await this.db.client.organizationFiscalProfile.findUnique({
      where: { organizationId: c.organizationId },
    });
    const localReasons = localFiscalReasons(i, p, this.clock.now());
    reasons.push(...localReasons);
    if (fiscalCompleteness(p) !== 'COMPLETE')
      reasons.push('Falta completar los datos fiscales del emisor.');
    if (cfg.references && cls) {
      if (i.receiverVatConditionId && !conditions.some((r) => r.id === i.receiverVatConditionId))
        reasons.push(
          'Elegí una condición IVA del receptor admitida por ARCA para este tipo de factura.',
        );
    }
    if (cfg.references && cfg.pointOfSale && p && i.status === 'READY' && !localReasons.length) {
      try {
        mapFiscalInvoice(i, p, cfg.pointOfSale, cfg.references, this.clock.now());
      } catch (e) {
        reasons.push(
          e instanceof BadRequestException ? e.message : 'Revisá los datos fiscales de la factura.',
        );
      }
    }
    const canCheckSequence = reasons.length === 0;
    const key = hash([c.organizationId, id, i.version, p?.version, cfg.version, cfg.pointOfSale]);
    const cached = this.sequenceChecks.get(key);
    const validUntil = cached ? new Date(cached.checkedAt.getTime() + 5 * 60000) : null;
    const sequence = validUntil && validUntil > this.clock.now() ? cached : undefined;
    const sequenceReady = Boolean(
      canCheckSequence && sequence && sequence.number !== null && !sequence.message,
    );
    if (!sequenceReady)
      reasons.push(
        sequence?.message ??
          'Falta comprobar la numeración de este punto de venta y tipo en ARCA. Esta consulta no emite comprobantes.',
      );
    const customer = deliveryNoteCustomerSchema.safeParse(i.customerSnapshot);
    return {
      ready: reasons.length === 0,
      reasons: [...new Set(reasons)],
      canCheckSequence,
      retryAfter: cfg.retryAfter,
      sequence: {
        status: sequenceReady
          ? ('VERIFIED' as const)
          : sequence?.message
            ? ('ERROR' as const)
            : ('PENDING' as const),
        checkedAt: sequence?.checkedAt.toISOString() ?? null,
        validUntil: sequence ? validUntil!.toISOString() : null,
        lastNumber: sequence?.number ?? null,
        message: sequence?.message ?? null,
      },
      checks: [
        ...(cfg.checks ?? []),
        {
          id: 'issuer',
          label: 'Perfil fiscal del emisor',
          ready: fiscalCompleteness(p) === 'COMPLETE',
        },
        {
          id: 'receiver-cuit',
          label: 'CUIT receptor',
          ready: Boolean(customer.success && customer.data.cuit && validCuit(customer.data.cuit)),
        },
        {
          id: 'receiver-vat',
          label: 'Condición IVA receptor',
          ready: Boolean(
            i.receiverVatConditionId && conditions.some((v) => v.id === i.receiverVatConditionId),
          ),
        },
        {
          id: 'invoice',
          label: 'Factura lista y datos locales completos',
          ready: i.status === 'READY' && i.fiscalStatus === 'NOT_SUBMITTED' && !localReasons.length,
        },
        { id: 'sequence', label: 'Secuencia ARCA', ready: sequenceReady },
      ],
      pointOfSale: cfg.pointOfSale,
      conditions,
      receiverVatConditionId: i.receiverVatConditionId,
    };
  }
  async checkSequence(c: RequestActorContext, id: string) {
    const before = await this.readiness(c, id);
    if (!before.canCheckSequence)
      throw new BadRequestException(
        'Completá los requisitos de la factura y la conexión antes de consultar la numeración.',
      );
    const i = await this.write(c, (tx) => this.record(tx, c, id));
    const cfg = await this.configuration.get(c);
    const p = await this.db.client.organizationFiscalProfile.findUnique({
      where: { organizationId: c.organizationId },
    });
    if (!p || !cfg.ready || !cfg.references || !cfg.pointOfSale)
      throw new BadRequestException('La configuración cambió. Volvé a cargar los requisitos.');
    const base = mapFiscalInvoice(i, p, cfg.pointOfSale, cfg.references, this.clock.now());
    const key = hash([c.organizationId, id, i.version, p.version, cfg.version, cfg.pointOfSale]);
    // Explicit read-only action: no number reservation and no authorization call.
    try {
      const number = await this.provider.last(c, base);
      if (!Number.isSafeInteger(number) || number < 0 || number >= 99999999)
        throw new BadRequestException(
          'La secuencia de ARCA no tiene un número siguiente disponible.',
        );
      if (number > 0) {
        const previous = await this.provider.consult(c, base, number);
        if (!previous)
          throw new BadRequestException('ARCA no pudo confirmar los datos del último comprobante.');
        validateFiscalDate(
          i.issueDate.toISOString().slice(0, 10),
          this.clock.now(),
          previous.invoice.issueDate,
        );
      }
      this.sequenceChecks.set(key, { number, checkedAt: this.clock.now(), message: null });
      await this.write(c, (tx) =>
        this.audit.success(c, 'INVOICE_ARCA_SEQUENCE_CHECKED', 'Invoice', id, tx),
      );
    } catch (e) {
      this.sequenceChecks.set(key, {
        number: null,
        checkedAt: this.clock.now(),
        message:
          e instanceof WsfeError || e instanceof BadRequestException
            ? e.message
            : 'No pudimos comprobar la numeración con ARCA. Volvé a consultar antes de autorizar.',
      });
    }
    for (const [k, entry] of this.sequenceChecks)
      if (entry.checkedAt.getTime() + 5 * 60000 <= this.clock.now().getTime())
        this.sequenceChecks.delete(k);
    if (this.sequenceChecks.size > 1000)
      this.sequenceChecks.delete(this.sequenceChecks.keys().next().value!);
    return this.readiness(c, id);
  }
  async setReceiver(
    c: RequestActorContext,
    id: string,
    input: { expectedVersion: number; conditionId: number },
  ) {
    await this.write(c, (tx) => this.record(tx, c, id));
    const source = await this.configuration.fetchReferences(c);
    await this.write(c, async (tx) => {
      const initial = await this.record(tx, c, id);
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE "organizationId"=${c.organizationId}::uuid AND id=${initial.customerId}::uuid FOR UPDATE`;
      const i = await this.lockInvoice(tx, c, id);
      this.version(i.version, input.expectedVersion);
      if (i.fiscalStatus !== 'NOT_SUBMITTED' || !i.invoiceType)
        throw new ConflictException(
          'Elegí el tipo y corregí la factura antes de cambiar sus datos fiscales.',
        );
      const cls = fiscalClass(i.invoiceType)!;
      const condition = source.references.conditions[cls].find((r) => r.id === input.conditionId);
      if (!condition)
        throw new BadRequestException(
          'Elegí una condición IVA que ARCA admita para este tipo de factura.',
        );
      await tx.customer.update({
        where: { id: i.customerId },
        data: {
          arcaVatConditionId: condition.id,
          arcaVatConditionLabel: condition.label,
          version: { increment: 1 },
        },
      });
      await tx.invoice.update({
        where: { id },
        data: {
          receiverVatConditionId: condition.id,
          receiverVatConditionLabel: condition.label,
          version: { increment: 1 },
        },
      });
      await this.audit.success(c, 'INVOICE_ARCA_RECEIVER_CONFIGURED', 'Invoice', id, tx);
    });
    return this.view(c, id);
  }
  async authorize(c: RequestActorContext, id: string, input: InvoiceTransition) {
    const operationHash = hash({ id, ...input, actor: c.userId });
    const state = await this.write(c, async (tx) => {
      const invoice = await this.record(tx, c, id);
      const prior = await tx.invoiceFiscalAttempt.findUnique({
        where: {
          organizationId_operationId: {
            organizationId: c.organizationId,
            operationId: input.operationId,
          },
        },
      });
      return { invoice, prior };
    });
    const prior = state.prior;
    if (prior) {
      if (prior.invoiceId !== id || prior.operationHash !== operationHash)
        throw new ConflictException('Esta operación fiscal ya se utilizó con otros datos.');
      if (
        ['UNCERTAIN', 'PREPARING', 'AUTHORIZING'].includes(prior.status) &&
        (prior.status === 'UNCERTAIN' || prior.leaseUntil <= this.clock.now())
      )
        return this.verify(c, id);
      return this.view(c, id, true);
    }
    const initial = state.invoice;
    this.version(initial.version, input.expectedVersion);
    if (initial.status !== 'READY' || initial.fiscalStatus !== 'NOT_SUBMITTED')
      throw new ConflictException(
        'Solo puede autorizarse una factura lista sin una operación fiscal pendiente.',
      );
    const selected = await this.db.client.arcaIntegrationConfig.findUnique({
      where: { organizationId: c.organizationId },
    });
    if (!selected?.pointOfSale)
      throw new BadRequestException('Configurá el punto de venta consultándolo desde ARCA.');
    const source = await this.configuration.fetchReferences(c);
    const profile = await this.db.client.organizationFiscalProfile.findUnique({
      where: { organizationId: c.organizationId },
    });
    if (
      fiscalCompleteness(profile) !== 'COMPLETE' ||
      !profile ||
      profile.cuit !== source.cuit ||
      selected.pointOfSaleCuit !== source.cuit
    )
      throw new BadRequestException('Revisá el perfil fiscal y el punto de venta del emisor.');
    const base = mapFiscalInvoice(
      initial,
      profile,
      selected.pointOfSale,
      source.references,
      this.clock.now(),
    );
    const ownerId = randomUUID();
    const reserved = await this.write(c, async (tx) => {
      await this.lockSequence(tx, c, base);
      const duplicate = await tx.invoiceFiscalAttempt.findUnique({
        where: {
          organizationId_operationId: {
            organizationId: c.organizationId,
            operationId: input.operationId,
          },
        },
      });
      if (duplicate) {
        if (duplicate.operationHash !== operationHash)
          throw new ConflictException('La operación ya se utilizó con otros datos.');
        return { attempt: duplicate, owned: false };
      }
      const i = await this.lockInvoice(tx, c, id);
      this.version(i.version, input.expectedVersion);
      if (i.status !== 'READY' || i.fiscalStatus !== 'NOT_SUBMITTED')
        throw new ConflictException(
          'La factura ya tiene un resultado o una operación fiscal pendiente.',
        );
      const currentProfile = await tx.organizationFiscalProfile.findUnique({
        where: { organizationId: c.organizationId },
      });
      const config = await tx.arcaIntegrationConfig.findUnique({
        where: { organizationId: c.organizationId },
      });
      if (
        currentProfile?.version !== profile.version ||
        config?.pointOfSale !== base.pointOfSale ||
        config.pointOfSaleCuit !== base.issuerCuit
      )
        throw new ConflictException('La configuración fiscal cambió. No se envió la factura.');
      const scope = seqScope({ organizationId: c.organizationId, ...base });
      const seq = await tx.fiscalSequence.upsert({
        where: seqWhere(scope),
        create: scope,
        update: {},
      });
      if (seq.blockedAttemptId)
        throw new ConflictException(
          'Este punto de venta y tipo tiene un comprobante pendiente de verificar. Resolvelo antes de emitir otro.',
        );
      const ordinal =
        (await tx.invoiceFiscalAttempt.count({
          where: { organizationId: c.organizationId, invoiceId: id },
        })) + 1;
      const attempt = await tx.invoiceFiscalAttempt.create({
        data: {
          organizationId: c.organizationId,
          invoiceId: id,
          ordinal,
          operationId: input.operationId,
          operationHash,
          issuerCuit: base.issuerCuit,
          pointOfSale: base.pointOfSale,
          documentType: base.documentType,
          ownerId,
          leaseUntil: new Date(this.clock.now().getTime() + LEASE_MS),
          issuerSnapshot: json({
            cuit: profile.cuit,
            legalName: profile.legalName,
            tradeName: profile.tradeName,
            vatCondition: profile.vatCondition,
            version: profile.version,
          }),
          payload: json(base),
        },
      });
      await tx.fiscalSequence.update({
        where: seqWhere(scope),
        data: { blockedAttemptId: attempt.id },
      });
      await tx.invoice.update({
        where: { id },
        data: { fiscalStatus: 'AUTHORIZING', version: { increment: 1 } },
      });
      await this.audit.success(c, 'INVOICE_ARCA_AUTHORIZATION_REQUESTED', 'Invoice', id, tx);
      return { attempt, owned: true };
    });
    if (!reserved.owned) return this.view(c, id, true);
    const attempt = reserved.attempt;
    let payload: WsfeInvoice;
    try {
      const last = await this.provider.last(c, base);
      if (last >= 99999999)
        throw new BadRequestException('Se alcanzó el límite de numeración de esta secuencia.');
      const previous = last > 0 ? await this.provider.consult(c, base, last) : null;
      if (last > 0 && !previous)
        throw new ConflictException(
          'ARCA no devolvió el último comprobante de la secuencia. Revisá su estado.',
        );
      validateFiscalDate(
        initial.issueDate.toISOString().slice(0, 10),
        this.clock.now(),
        previous?.invoice.issueDate,
      );
      payload = { ...base, number: last + 1 };
      await this.write(c, async (tx) => {
        await this.lockSequence(tx, c, base);
        await this.lockInvoice(tx, c, id);
        const row = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        const seq = await tx.fiscalSequence.findUniqueOrThrow({ where: seqWhere(row) });
        const currentProfile = await tx.organizationFiscalProfile.findUnique({
          where: { organizationId: c.organizationId },
        });
        if (
          row.status !== 'PREPARING' ||
          row.ownerId !== ownerId ||
          row.leaseUntil <= this.clock.now() ||
          seq.blockedAttemptId !== row.id ||
          currentProfile?.version !== profile.version
        )
          throw new ConflictException(
            'La preparación fiscal cambió o venció. No se volvió a enviar.',
          );
        await tx.invoiceFiscalAttempt.update({
          where: { id: row.id },
          data: {
            status: 'AUTHORIZING',
            documentNumber: payload.number,
            payload: json(payload),
            requestHash: hash(payload),
            sentAt: this.clock.now(),
          },
        });
      });
    } catch (e) {
      await this.abortPreparation(c, attempt);
      if (e instanceof WsfeError) throw new ServiceUnavailableException(e.message);
      throw e;
    }
    try {
      const result = await this.provider.authorize(c, payload);
      await this.finish(c, attempt, result, false);
    } catch (e) {
      const detail: FiscalMessage = {
        code: e instanceof WsfeError ? 'WSFE_' + e.code : 'RESULT_NOT_PERSISTED',
        message:
          e instanceof WsfeError
            ? e.message
            : 'No se pudo confirmar el resultado. Verificá con ARCA antes de continuar.',
      };
      await this.write(c, async (tx) => {
        await this.lockSequence(tx, c, attempt);
        await this.lockInvoice(tx, c, id);
        const row = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        if (row.status !== 'AUTHORIZING') return;
        await tx.invoiceFiscalAttempt.update({
          where: { id: row.id },
          data: { status: 'UNCERTAIN', messages: json([detail]) },
        });
        await tx.invoice.update({
          where: { id },
          data: { fiscalStatus: 'UNCERTAIN', version: { increment: 1 } },
        });
        await this.audit.success(c, 'INVOICE_ARCA_RESULT_UNCERTAIN', 'Invoice', id, tx);
      });
    }
    return this.view(c, id);
  }
  private async abortPreparation(c: RequestActorContext, a: Attempt) {
    await this.write(c, async (tx) => {
      await this.lockSequence(tx, c, a);
      await this.lockInvoice(tx, c, a.invoiceId);
      const row = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: a.id } });
      if (row.status !== 'PREPARING') return;
      await tx.invoiceFiscalAttempt.update({
        where: { id: a.id },
        data: { status: 'ABORTED', completedAt: this.clock.now(), reconciliation: 'NOT_SENT' },
      });
      await tx.fiscalSequence.updateMany({
        where: { ...seqScope(a), blockedAttemptId: a.id },
        data: { blockedAttemptId: null },
      });
      await tx.invoice.update({
        where: { id: a.invoiceId },
        data: { fiscalStatus: 'NOT_SUBMITTED', version: { increment: 1 } },
      });
      await this.audit.success(c, 'INVOICE_ARCA_PREPARATION_ABORTED', 'Invoice', a.invoiceId, tx);
    });
  }
  private async finish(
    c: RequestActorContext,
    a: Attempt,
    result: WsfeResult,
    reconciled: boolean,
  ) {
    await this.write(c, async (tx) => {
      await this.lockSequence(tx, c, a);
      await this.lockInvoice(tx, c, a.invoiceId);
      const current = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: a.id } });
      if (current.status === 'AUTHORIZED') {
        if (current.cae !== result.cae)
          throw new ConflictException('El CAE devuelto no coincide. Requiere revisión.');
        return;
      }
      if (!['AUTHORIZING', 'UNCERTAIN', 'CONFLICT'].includes(current.status))
        throw new ConflictException('Este intento ya terminó. Verificá su historial.');
      if (
        !['A', 'R'].includes(result.result) ||
        (result.result === 'A' &&
          (!result.cae || !/^\d{14}$/.test(result.cae) || !result.caeExpiration))
      )
        throw new WsfeError('INVALID_RESPONSE');
      const authorized = result.result === 'A';
      await tx.invoiceFiscalAttempt.update({
        where: { id: a.id },
        data: {
          status: authorized ? 'AUTHORIZED' : 'REJECTED',
          result: result.result,
          cae: authorized ? result.cae : null,
          caeExpiration: authorized
            ? new Date(
                result.caeExpiration!.slice(0, 4) +
                  '-' +
                  result.caeExpiration!.slice(4, 6) +
                  '-' +
                  result.caeExpiration!.slice(6) +
                  'T00:00:00Z',
              )
            : null,
          authorizedAt: authorized ? this.clock.now() : null,
          completedAt: this.clock.now(),
          messages: json(result.messages),
          observations: json(result.observations),
          events: json(result.events),
          ...(reconciled ? { verifiedAt: this.clock.now(), reconciliation: 'MATCH' } : {}),
        },
      });
      await tx.invoice.update({
        where: { id: a.invoiceId },
        data: { fiscalStatus: authorized ? 'AUTHORIZED' : 'REJECTED', version: { increment: 1 } },
      });
      await tx.fiscalSequence.updateMany({
        where: { ...seqScope(a), blockedAttemptId: a.id },
        data: { blockedAttemptId: null },
      });
      await this.audit.success(
        c,
        reconciled
          ? 'INVOICE_ARCA_RECONCILED'
          : authorized
            ? 'INVOICE_ARCA_AUTHORIZED'
            : 'INVOICE_ARCA_REJECTED',
        'Invoice',
        a.invoiceId,
        tx,
      );
    });
  }
  async verify(c: RequestActorContext, id: string) {
    const i = await this.write(c, (tx) => this.record(tx, c, id)),
      a = i.fiscalAttempts[0];
    if (!a) throw new BadRequestException('Esta factura todavía no tiene un intento fiscal.');
    if (a.status === 'PREPARING') {
      if (a.leaseUntil <= this.clock.now()) await this.abortPreparation(c, a);
      return this.view(c, id);
    }
    if (a.status === 'AUTHORIZING' && a.leaseUntil > this.clock.now()) return this.view(c, id);
    if (
      !['AUTHORIZING', 'UNCERTAIN', 'CONFLICT', 'AUTHORIZED'].includes(a.status) ||
      !a.documentNumber
    )
      return this.view(c, id, true);
    const payload = wsfeInvoiceSchema.parse(a.payload);
    if (hash(payload) !== a.requestHash)
      throw new ConflictException(
        'El intento fiscal tiene una inconsistencia de integridad. Requiere revisión.',
      );
    await this.write(c, async (tx) => {
      await this.lockSequence(tx, c, a);
      await this.lockInvoice(tx, c, id);
      const seq = await tx.fiscalSequence.upsert({
        where: seqWhere(a),
        create: seqScope(a),
        update: {},
      });
      if (seq.blockedAttemptId && seq.blockedAttemptId !== a.id)
        throw new ConflictException(
          'Otra operación mantiene reservada esta secuencia. Verificala primero.',
        );
      await tx.fiscalSequence.update({ where: seqWhere(a), data: { blockedAttemptId: a.id } });
      const current = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: a.id } });
      if (current.status === 'AUTHORIZING' && current.leaseUntil <= this.clock.now()) {
        await tx.invoiceFiscalAttempt.update({
          where: { id: a.id },
          data: { status: 'UNCERTAIN' },
        });
        await tx.invoice.update({
          where: { id },
          data: { fiscalStatus: 'UNCERTAIN', version: { increment: 1 } },
        });
        await this.audit.success(c, 'INVOICE_ARCA_RESULT_UNCERTAIN', 'Invoice', id, tx);
      }
    });
    let found: WsfeRegistered | null = null;
    let divergent = false;
    try {
      found = await this.provider.consult(c, payload, a.documentNumber);
    } catch (e) {
      if (e instanceof WsfeError && e.code === 'DIVERGENT_RECORD') divergent = true;
      else {
        if (a.status === 'AUTHORIZED' && i.fiscalStatus !== 'CONFLICT')
          await this.write(c, (tx) =>
            tx.fiscalSequence.updateMany({
              where: { ...seqScope(a), blockedAttemptId: a.id },
              data: { blockedAttemptId: null },
            }),
          );
        throw new ServiceUnavailableException(
          e instanceof WsfeError
            ? e.message
            : 'No pudimos verificar con ARCA. El estado fiscal se conserva.',
        );
      }
    }
    if (
      found &&
      sameFiscalInvoice(payload, found.invoice) &&
      (a.status !== 'AUTHORIZED' ||
        (a.cae === found.result.cae &&
          a.caeExpiration?.toISOString().slice(0, 10).replaceAll('-', '') ===
            found.result.caeExpiration))
    ) {
      if (a.status === 'AUTHORIZED')
        await this.write(c, async (tx) => {
          await this.lockSequence(tx, c, a);
          await this.lockInvoice(tx, c, id);
          await tx.invoiceFiscalAttempt.update({
            where: { id: a.id },
            data: { verifiedAt: this.clock.now(), reconciliation: 'MATCH' },
          });
          await tx.invoice.update({
            where: { id },
            data: { fiscalStatus: 'AUTHORIZED', version: { increment: 1 } },
          });
          await tx.fiscalSequence.updateMany({
            where: { ...seqScope(a), blockedAttemptId: a.id },
            data: { blockedAttemptId: null },
          });
          await this.audit.success(c, 'INVOICE_ARCA_VERIFIED', 'Invoice', id, tx);
        });
      else await this.finish(c, a, found.result, true);
      return this.view(c, id);
    }
    let last: number | null;
    try {
      last = found || divergent ? null : await this.provider.last(c, payload);
    } catch (e) {
      throw new ServiceUnavailableException(
        e instanceof WsfeError
          ? e.message
          : 'No pudimos consultar la secuencia. El estado fiscal se conserva.',
      );
    }
    await this.write(c, async (tx) => {
      await this.lockSequence(tx, c, a);
      const currentInvoice = await this.lockInvoice(tx, c, id);
      const row = await tx.invoiceFiscalAttempt.findUniqueOrThrow({ where: { id: a.id } });
      if (!['AUTHORIZING', 'UNCERTAIN', 'CONFLICT', 'AUTHORIZED'].includes(row.status)) return;
      const conflict = Boolean(
        found ||
        divergent ||
        row.status === 'AUTHORIZED' ||
        last !== a.documentNumber! - 1 ||
        row.status === 'CONFLICT' ||
        currentInvoice.fiscalStatus === 'CONFLICT',
      );
      if (conflict) {
        await tx.invoiceFiscalAttempt.update({
          where: { id: a.id },
          data: {
            ...(row.status === 'AUTHORIZED' ? {} : { status: 'CONFLICT' }),
            verifiedAt: this.clock.now(),
            reconciliation: 'FISCAL_SEQUENCE_CONFLICT',
          },
        });
        await tx.invoice.update({
          where: { id },
          data: { fiscalStatus: 'CONFLICT', version: { increment: 1 } },
        });
        await this.audit.success(c, 'INVOICE_ARCA_SEQUENCE_CONFLICT', 'Invoice', id, tx);
        return;
      }
      const canCount =
        this.clock.now().getTime() - row.sentAt!.getTime() >= ABSENCE_DELAY_MS &&
        (!row.lastNotFoundAt ||
          this.clock.now().getTime() - row.lastNotFoundAt.getTime() >= ABSENCE_INTERVAL_MS);
      const checks = row.notFoundChecks + (canCount ? 1 : 0),
        absent = checks >= 2;
      await tx.invoiceFiscalAttempt.update({
        where: { id: a.id },
        data: {
          status: absent ? 'NOT_FOUND' : 'UNCERTAIN',
          verifiedAt: this.clock.now(),
          reconciliation: absent ? 'CONFIRMED_ABSENT' : 'ABSENCE_NOT_FINAL',
          notFoundChecks: checks,
          ...(canCount ? { lastNotFoundAt: this.clock.now() } : {}),
          ...(absent ? { completedAt: this.clock.now() } : {}),
        },
      });
      await tx.invoice.update({
        where: { id },
        data: { fiscalStatus: absent ? 'NOT_SUBMITTED' : 'UNCERTAIN', version: { increment: 1 } },
      });
      if (absent)
        await tx.fiscalSequence.updateMany({
          where: { ...seqScope(a), blockedAttemptId: a.id },
          data: { blockedAttemptId: null },
        });
      await this.audit.success(c, 'INVOICE_ARCA_RECONCILED', 'Invoice', id, tx);
    });
    return this.view(c, id);
  }
}

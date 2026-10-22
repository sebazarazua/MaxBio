import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import {
  deliveryNoteCustomerSchema,
  type CatalogListQuery,
  type DeliveryNoteCreate,
  type DeliveryNoteUpdate,
  type DeliveryNoteConfirm,
  type DeliveryNoteNumberingInput,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { InventoryService } from '../../inventory/application/inventory.service.js';
import { validQuantity } from '../../inventory/domain/quantity.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { textContains } from '../../catalog/domain/catalog-search.js';

import {
  deliveryNoteInclude as include,
  deliveryNoteView as view,
  customerView,
} from './delivery-note-view.js';
import { PrintingService } from '../../printing/application/printing.service.js';
import { numberingLock, loadNumbering, numberingView, allocateNumber } from './numbering.js';
type Tx = Prisma.TransactionClient;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
type Record = Prisma.DeliveryNoteGetPayload<{ include: typeof include }>;

@Injectable()
export class DeliveryNotesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(InventoryService) private readonly inventory: InventoryService,
    @Inject(PrintingService) private readonly printing: PrintingService,
  ) {}
  private async write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>, admin = false) {
    return this.inventory.deliveryTransaction(
      c,
      async (tx) => {
        try {
          return await fn(tx);
        } catch (e) {
          if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'P2002')
            throw new ConflictException(
              'Ya existe un remito con ese número o identificador de operación. Revisá los datos.',
            );
          throw e;
        }
      },
      admin,
    );
  }
  private async record(tx: Tx, c: RequestActorContext, id: string) {
    const d = await tx.deliveryNote.findFirst({
      where: { organizationId: c.organizationId, id },
      include,
    });
    if (!d) throw new NotFoundException();
    return d;
  }
  private async lock(tx: Tx, c: RequestActorContext, id: string) {
    await tx.$queryRaw`SELECT id FROM "DeliveryNote" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    return this.record(tx, c, id);
  }
  private editable(d: Record, version: number) {
    if (d.status !== 'DRAFT')
      throw new ConflictException(
        'Este remito ya fue confirmado o cancelado y no puede modificarse.',
      );
    if (d.version !== version)
      throw new ConflictException(
        'Este remito fue modificado desde otra sesión. Volvé a cargarlo.',
      );
  }
  private async customer(tx: Tx, c: RequestActorContext, id: string) {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const row = await tx.customer.findFirst({ where: { organizationId: c.organizationId, id } });
    if (!row) throw new NotFoundException();
    if (row.archivedAt)
      throw new ConflictException('El cliente está archivado. Revisalo antes de continuar.');
    return row;
  }
  private async lines(
    tx: Tx,
    c: RequestActorContext,
    id: string,
    input: DeliveryNoteCreate['lines'],
  ) {
    // Full replacement under parent lock; FK prevents using another tenant/product's position.
    for (const [ordinal, l] of input.entries()) {
      const p = await tx.product.findFirst({
        where: { organizationId: c.organizationId, id: l.productId },
      });
      if (!p) throw new NotFoundException();
      if (p.archivedAt) throw new ConflictException('Este producto está archivado.');
      try {
        validQuantity(l.quantity, p.unitOfMeasure);
        for (const a of l.allocations) validQuantity(a.quantity, p.unitOfMeasure);
      } catch (e) {
        throw new BadRequestException(e instanceof Error ? e.message : 'Revisá la cantidad.');
      }
      for (const a of l.allocations)
        if (
          !(await tx.inventoryBalance.findFirst({
            where: { organizationId: c.organizationId, productId: l.productId, id: a.positionId },
          }))
        )
          throw new NotFoundException();
      await tx.deliveryNoteLine.create({
        data: {
          id: l.id,
          organizationId: c.organizationId,
          deliveryNoteId: id,
          productId: l.productId,
          ordinal,
          quantity: l.quantity,
        },
      });
      if (l.allocations.length)
        await tx.deliveryNoteAllocation.createMany({
          data: l.allocations.map((a) => ({
            organizationId: c.organizationId,
            productId: l.productId,
            lineId: l.id,
            ...a,
          })),
        });
    }
  }
  private fields(input: DeliveryNoteCreate | DeliveryNoteUpdate) {
    return {
      customerId: input.customerId,
      documentDate: new Date(input.documentDate + 'T00:00:00Z'),
      patientName: input.patientName,
      affiliateNumber: input.affiliateNumber,
      notes: input.notes,
    };
  }
  async get(c: RequestActorContext, id: string) {
    return this.db.client.$transaction(async (tx) => view(await this.record(tx, c, id)), {
      isolationLevel: 'RepeatableRead',
    });
  }
  async numbering(c: RequestActorContext) {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return numberingView(tx, c.organizationId, await loadNumbering(tx, c.organizationId));
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async configureNumbering(c: RequestActorContext, input: DeliveryNoteNumberingInput) {
    return this.write(
      c,
      async (tx) => {
        await numberingLock(tx, c.organizationId);
        const current = await loadNumbering(tx, c.organizationId);
        if ((current?.version ?? 0) !== input.expectedVersion)
          throw new ConflictException('La numeración cambió. Volvé a cargarla antes de guardar.');
        if (current?.prefix === input.prefix && BigInt(input.nextNumber) < current.nextNumber)
          throw new ConflictException(
            'El próximo número no puede retroceder. Elegí uno igual o superior.',
          );
        const state = await tx.deliveryNoteNumbering.upsert({
          where: { organizationId: c.organizationId },
          create: {
            organizationId: c.organizationId,
            prefix: input.prefix,
            nextNumber: BigInt(input.nextNumber),
            numberWidth: input.nextNumber.length,
          },
          update: {
            prefix: input.prefix,
            nextNumber: BigInt(input.nextNumber),
            numberWidth: input.nextNumber.length,
            version: { increment: 1 },
          },
        });
        await this.audit.append(
          {
            organizationId: c.organizationId,
            actorUserId: c.userId,
            sessionId: c.sessionId,
            requestId: c.requestId,
            action: 'DELIVERY_NOTE_NUMBERING_CHANGED',
            resourceType: 'DeliveryNoteNumbering',
            resourceId: c.organizationId,
            result: 'SUCCESS',
            metadata: {
              previousPrefix: current?.prefix,
              prefix: state.prefix,
              previousNextNumber: current?.nextNumber.toString(),
              nextNumber: state.nextNumber.toString(),
            },
          },
          tx,
        );
        return numberingView(tx, c.organizationId, state);
      },
      true,
    );
  }
  async create(c: RequestActorContext, input: DeliveryNoteCreate) {
    return this.write(c, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`delivery-create:${input.id}`},0))`;
      const prior = await tx.deliveryNote.findUnique({ where: { id: input.id }, include });
      const digest = hash({ actor: c.userId, input });
      if (prior) {
        if (prior.organizationId !== c.organizationId) throw new NotFoundException();
        if (prior.creationHash !== digest)
          throw new ConflictException('Este remito ya fue creado con otros datos. Cargá su ficha.');
        return view(prior, true);
      }
      await numberingLock(tx, c.organizationId);
      const number = await allocateNumber(tx, c.organizationId);
      await this.inventory.lockDeliveryProducts(
        tx,
        c,
        input.lines.map((l) => l.productId),
      );
      await this.customer(tx, c, input.customerId);
      await tx.deliveryNote.create({
        data: {
          id: input.id,
          organizationId: c.organizationId,
          creationHash: digest,
          ...this.fields(input),
          ...number,
        },
      });
      await this.lines(tx, c, input.id, input.lines);
      await this.audit.success(c, 'DELIVERY_NOTE_CREATED', 'DeliveryNote', input.id, tx);
      return view(await this.record(tx, c, input.id));
    });
  }
  async update(c: RequestActorContext, id: string, input: DeliveryNoteUpdate) {
    return this.write(c, async (tx) => {
      await numberingLock(tx, c.organizationId);
      // Same order as posting. Never acquire a Product/Customer lock after the document.
      await this.inventory.lockDeliveryProducts(
        tx,
        c,
        input.lines.map((l) => l.productId),
      );
      await this.customer(tx, c, input.customerId);
      const d = await this.lock(tx, c, id);
      this.editable(d, input.expectedVersion);
      const number = d.documentNumber ? {} : await allocateNumber(tx, c.organizationId);
      await tx.deliveryNoteAllocation.deleteMany({
        where: { organizationId: c.organizationId, line: { deliveryNoteId: id } },
      });
      await tx.deliveryNoteLine.deleteMany({
        where: { organizationId: c.organizationId, deliveryNoteId: id },
      });
      await this.lines(tx, c, id, input.lines);
      await tx.deliveryNote.update({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
        data: { ...this.fields(input), ...number, version: { increment: 1 } },
      });
      await this.audit.success(c, 'DELIVERY_NOTE_UPDATED', 'DeliveryNote', id, tx);
      return view(await this.record(tx, c, id));
    });
  }
  async confirm(c: RequestActorContext, id: string, input: DeliveryNoteConfirm) {
    const initial = await this.get(c, id);
    const digest = hash({ id, ...input, actor: c.userId });
    return this.write(c, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`delivery-confirm:${c.organizationId}:${input.operationId}`},0))`;
      const prior = await tx.deliveryNote.findFirst({
        where: { organizationId: c.organizationId, confirmationOperationId: input.operationId },
        include,
      });
      if (prior) {
        if (prior.requestHash !== digest)
          throw new ConflictException('Esta clave de confirmación ya se utilizó con otros datos.');
        return view(prior, true);
      }
      await this.inventory.lockDeliveryProducts(
        tx,
        c,
        initial.lines.map((l) => l.productId),
      );
      const customer = await this.customer(tx, c, initial.customer.id);
      const d = await this.lock(tx, c, id);
      this.editable(d, input.expectedVersion);
      // Protect the pre-lock read even if a caller guessed a future version.
      if (d.version !== initial.version)
        throw new ConflictException(
          'Este remito fue modificado desde otra sesión. Volvé a cargarlo.',
        );
      if (!d.documentPrefix || !d.documentNumber)
        throw new BadRequestException('Ingresá el número del talonario antes de confirmar.');
      // Pure geometry validation only. No PDF/storage work participates in stock posting.
      await this.printing.assertConfirmable(tx, c, view(d));
      await this.inventory.postDeliveryNote(tx, c, id);
      await tx.deliveryNote.update({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
        data: {
          status: 'CONFIRMED',
          version: { increment: 1 },
          confirmedAt: new Date(),
          confirmedByUserId: c.userId,
          confirmedByMembershipId: c.membershipId,
          confirmationOperationId: input.operationId,
          requestHash: digest,
          customerSnapshot: customerView(customer),
        },
      });
      await this.audit.success(c, 'DELIVERY_NOTE_CONFIRMED', 'DeliveryNote', id, tx);
      return view(await this.record(tx, c, id));
    });
  }
  async cancel(c: RequestActorContext, id: string, version: number) {
    return this.write(
      c,
      async (tx) => {
        const d = await this.lock(tx, c, id);
        this.editable(d, version);
        await tx.deliveryNote.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: { status: 'CANCELLED', version: { increment: 1 } },
        });
        await this.audit.success(c, 'DELIVERY_NOTE_CANCELLED', 'DeliveryNote', id, tx);
        return view(await this.record(tx, c, id));
      },
      true,
    );
  }
  async list(c: RequestActorContext, q: CatalogListQuery) {
    // Search is evaluated in PostgreSQL; patient/affiliate values are never returned in the list.
    const tokens = q.q.trim().split(/\s+/).filter(Boolean).slice(0, 8);
    const where: Prisma.DeliveryNoteWhereInput = {
      organizationId: c.organizationId,
      ...(q.includeArchived ? {} : { status: { not: 'CANCELLED' } }),
      AND: tokens.map((t) => {
        const contains = textContains(t);
        const parts = t.match(/^([0-9]+)-([0-9]+)$/);
        return {
          OR: [
            ...(parts ? [{ documentPrefix: parts[1], documentNumber: parts[2] }] : []),
            { documentPrefix: contains },
            { documentNumber: contains },
            { patientName: contains },
            { affiliateNumber: contains },
            { customer: { OR: [{ name: contains }, { legalName: contains }, { cuit: contains }] } },
            {
              customerSnapshot: {
                path: ['name'],
                string_contains: contains.contains,
                mode: 'insensitive',
              },
            },
            { customerSnapshot: { path: ['cuit'], string_contains: contains.contains } },
            {
              lines: {
                some: {
                  OR: [
                    { product: { name: contains } },
                    { productNameSnapshot: contains },
                    {
                      allocations: {
                        some: {
                          position: {
                            OR: [
                              { lot: { lotNumber: contains } },
                              { serial: { serialNumber: contains } },
                            ],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          ],
        };
      }),
    };
    return this.db.client.$transaction(
      async (tx) => {
        const rows = await tx.deliveryNote.findMany({
          where,
          include: { customer: true },
          orderBy: [{ documentDate: 'desc' }, { id: 'desc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        });
        return {
          items: rows.map((d) => ({
            id: d.id,
            status: d.status,
            documentDate: d.documentDate.toISOString().slice(0, 10),
            documentPrefix: d.documentPrefix,
            documentNumber: d.documentNumber,
            customerName:
              d.status === 'CONFIRMED'
                ? deliveryNoteCustomerSchema.parse(d.customerSnapshot).name
                : d.customer.name,
          })),
          total: await tx.deliveryNote.count({ where }),
          page: q.page,
          limit: q.limit,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}

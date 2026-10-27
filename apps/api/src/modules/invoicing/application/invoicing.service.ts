import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DbNull, type Prisma } from '@maxbio/database';
import {
  deliveryNoteCustomerSchema,
  invoiceLineAmounts,
  invoiceTotals,
  type InvoiceCreate,
  type InvoiceList,
  type InvoiceListQuery,
  type InvoicePendingList,
  type InvoicePendingQuery,
  type InvoiceTransition,
  type InvoiceUpdate,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { searchTokens, textContains } from '../../catalog/domain/catalog-search.js';
import { businessDate } from '../../inventory/domain/quantity.js';
import { customerView } from '../../delivery-notes/application/delivery-note-view.js';
import { deliveryNoteNumberSearch } from '../../traceability/domain/traceability-search.js';
import {
  deliveryNoteNumber,
  exactQuantity,
  invoiceHistory,
  invoiceInclude as include,
  invoiceView,
  type InvoiceRecord,
} from './invoice-view.js';

type Tx = Prisma.TransactionClient;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const MAX_LINES = 500;
const ALREADY_INVOICED = 'Este Remito ya fue incluido en otra factura.';
const day = (value: string) => new Date(value + 'T00:00:00Z');
function dateRange(q: { dateFrom?: string; dateTo?: string }) {
  return q.dateFrom || q.dateTo
    ? {
        ...(q.dateFrom ? { gte: day(q.dateFrom) } : {}),
        ...(q.dateTo ? { lte: day(q.dateTo) } : {}),
      }
    : undefined;
}
function numberWhere(search: string): Prisma.DeliveryNoteWhereInput | null {
  const number = deliveryNoteNumberSearch(search);
  return number
    ? {
        ...(number.prefixes ? { documentPrefix: { in: number.prefixes } } : {}),
        documentNumber: { in: number.numbers },
      }
    : null;
}
// Customer text uses the existing Customer search projection and the documented snapshot name.
function customerText(search: string) {
  return searchTokens(search)
    .slice(0, 8)
    .map((token) => {
      const contains = textContains(token);
      return { contains, customer: { searchText: contains } };
    });
}
function amounts(
  quantity: string,
  unitPrice: string | null,
  vatRate: InvoiceUpdate['lines'][number]['vatRate'],
) {
  if (unitPrice === null || vatRate === null)
    return { netAmount: null, vatAmount: null, totalAmount: null };
  try {
    return invoiceLineAmounts(quantity, unitPrice, vatRate);
  } catch {
    throw new BadRequestException('El importe de una línea es demasiado grande. Revisá el precio.');
  }
}

// Facturación V1: documento comercial interno. Nunca escribe Inventory, allocations ni traces.
@Injectable()
export class InvoicingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  private read<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  // ADMIN only (commercial/fiscal document); session and membership revalidated in the transaction.
  private async write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>) {
    if (c.role !== 'ADMIN') throw new ForbiddenException('Esta acción requiere un administrador.');
    try {
      return await this.db.client.$transaction(
        async (tx) => {
          const now = new Date();
          const membership = await tx.membership.findFirst({
            where: {
              id: c.membershipId,
              organizationId: c.organizationId,
              userId: c.userId,
              role: 'ADMIN',
              revokedAt: null,
              user: { disabledAt: null },
              organization: { archivedAt: null },
            },
          });
          const session = await tx.session.findFirst({
            where: {
              id: c.sessionId,
              userId: c.userId,
              activeMembershipId: c.membershipId,
              revokedAt: null,
              expiresAt: { gt: now },
              absoluteExpiresAt: { gt: now },
            },
          });
          if (!membership || !session)
            throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
          return fn(tx);
        },
        { timeout: 10000, maxWait: 5000 },
      );
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e) {
        // The only business uniques are "one invoice per Remito" and "one invoice line per Remito line".
        if (e.code === 'P2002') throw new ConflictException(ALREADY_INVOICED);
        if (e.code === 'P2003' || e.code === 'P2025') throw new NotFoundException();
        if (e.code === 'P2034')
          throw new ConflictException('Otra operación coincidió con ésta. Volvé a intentar.');
      }
      throw e;
    }
  }
  private async record(tx: Tx, c: RequestActorContext, id: string) {
    const i = await tx.invoice.findFirst({
      where: { organizationId: c.organizationId, id },
      include,
    });
    if (!i) throw new NotFoundException();
    return i;
  }
  private async view(tx: Tx, c: RequestActorContext, i: InvoiceRecord, replayed = false) {
    return invoiceView(i, await invoiceHistory(tx, c.organizationId, i.id), replayed);
  }
  // Customer (FOR SHARE, snapshot stability) before the invoice row, like Remitos.
  private async lock(tx: Tx, c: RequestActorContext, id: string) {
    const head = await tx.invoice.findFirst({
      where: { organizationId: c.organizationId, id },
      select: { customerId: true },
    });
    if (!head) throw new NotFoundException();
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE "organizationId"=${c.organizationId}::uuid AND id=${head.customerId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    return this.record(tx, c, id);
  }
  private version(i: InvoiceRecord, expected: number) {
    if (i.version !== expected)
      throw new ConflictException(
        'Esta factura fue modificada desde otra sesión. Volvé a cargarla.',
      );
  }
  private draft(i: InvoiceRecord) {
    if (i.status !== 'DRAFT')
      throw new ConflictException(
        'Esta factura está lista para autorizar. Volvé a borrador para modificarla.',
      );
  }

  async pending(c: RequestActorContext, q: InvoicePendingQuery): Promise<InvoicePendingList> {
    const organizationId = c.organizationId;
    return this.read(async (tx) => {
      const customer = q.customerId
        ? await tx.customer.findFirst({
            where: { organizationId, id: q.customerId },
            select: { id: true, name: true },
          })
        : null;
      if (q.customerId && !customer) throw new NotFoundException();
      const number = q.search ? numberWhere(q.search) : null;
      // Pending is derived, never stored: CONFIRMED and without an invoice link.
      const where: Prisma.DeliveryNoteWhereInput = {
        organizationId,
        status: 'CONFIRMED',
        invoiceLink: { is: null },
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(dateRange(q) ? { documentDate: dateRange(q) } : {}),
        ...(number ?? {}),
        ...(q.search && !number
          ? {
              AND: customerText(q.search).map((t) => ({
                OR: [
                  { customer: t.customer },
                  {
                    customerSnapshot: {
                      path: ['name'],
                      string_contains: t.contains.contains,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              })),
            }
          : {}),
      };
      const rows = await tx.deliveryNote.findMany({
        where,
        select: {
          id: true,
          documentPrefix: true,
          documentNumber: true,
          documentDate: true,
          customerSnapshot: true,
          patientName: true,
          affiliateNumber: true,
          _count: { select: { lines: true } },
        },
        orderBy: [{ documentDate: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      });
      return {
        items: rows.map((d) => {
          const snapshot = deliveryNoteCustomerSchema.parse(d.customerSnapshot);
          return {
            id: d.id,
            number: deliveryNoteNumber(d),
            documentDate: d.documentDate.toISOString().slice(0, 10),
            customer: { id: snapshot.id, name: snapshot.name },
            lineCount: d._count.lines,
            patientLinked: Boolean(d.patientName || d.affiliateNumber),
          };
        }),
        total: await tx.deliveryNote.count({ where }),
        page: q.page,
        limit: q.limit,
        customer,
      };
    });
  }

  async list(c: RequestActorContext, q: InvoiceListQuery): Promise<InvoiceList> {
    const organizationId = c.organizationId;
    return this.read(async (tx) => {
      const customer = q.customerId
        ? await tx.customer.findFirst({
            where: { organizationId, id: q.customerId },
            select: { id: true, name: true },
          })
        : null;
      if (q.customerId && !customer) throw new NotFoundException();
      const number = q.search ? numberWhere(q.search) : null;
      const where: Prisma.InvoiceWhereInput = {
        organizationId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.customerId ? { customerId: q.customerId } : {}),
        ...(dateRange(q) ? { issueDate: dateRange(q) } : {}),
        ...(number ? { deliveryNotes: { some: { deliveryNote: number } } } : {}),
        ...(q.search && !number
          ? {
              AND: customerText(q.search).map((t) => ({
                OR: [
                  { customer: t.customer },
                  {
                    customerSnapshot: {
                      path: ['name'],
                      string_contains: t.contains.contains,
                      mode: 'insensitive' as const,
                    },
                  },
                ],
              })),
            }
          : {}),
      };
      const rows = await tx.invoice.findMany({
        where,
        include: {
          customer: { select: { id: true, name: true } },
          deliveryNotes: {
            orderBy: { ordinal: 'asc' },
            take: 20,
            include: { deliveryNote: { select: { documentPrefix: true, documentNumber: true } } },
          },
          lines: { where: { netAmount: null }, select: { id: true }, take: 1 },
        },
        orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      });
      return {
        items: rows.map((i) => ({
          id: i.id,
          status: i.status,
          invoiceType: i.invoiceType,
          issueDate: i.issueDate.toISOString().slice(0, 10),
          customer:
            i.status === 'READY'
              ? {
                  id: i.customerId,
                  name: deliveryNoteCustomerSchema.parse(i.customerSnapshot).name,
                }
              : i.customer,
          deliveryNoteNumbers: i.deliveryNotes.map((k) => deliveryNoteNumber(k.deliveryNote)),
          totalAmount: i.totalAmount.toFixed(2),
          complete: i.lines.length === 0,
        })),
        total: await tx.invoice.count({ where }),
        page: q.page,
        limit: q.limit,
        customer,
      };
    });
  }

  async get(c: RequestActorContext, id: string) {
    return this.read(async (tx) => this.view(tx, c, await this.record(tx, c, id)));
  }

  async create(c: RequestActorContext, input: InvoiceCreate) {
    return this.write(c, async (tx) => {
      // Stable client UUID + payload hash: a retry or double click returns the same draft.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`invoice-create:${input.id}`},0))`;
      const digest = hash({ actor: c.userId, input });
      const prior = await tx.invoice.findUnique({ where: { id: input.id }, include });
      if (prior) {
        if (prior.organizationId !== c.organizationId) throw new NotFoundException();
        if (prior.creationHash !== digest)
          throw new ConflictException(
            'Esta factura ya fue creada con otros datos. Cargá su ficha.',
          );
        return this.view(tx, c, prior, true);
      }
      const ids = [...input.deliveryNoteIds].sort();
      // Two invoices competing for one Remito serialize here; the loser sees the link.
      await tx.$queryRaw`SELECT id FROM "DeliveryNote" WHERE "organizationId"=${c.organizationId}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
      const notes = await tx.deliveryNote.findMany({
        where: { organizationId: c.organizationId, id: { in: ids } },
        include: { lines: { orderBy: { ordinal: 'asc' } }, invoiceLink: { select: { id: true } } },
        orderBy: [{ documentDate: 'asc' }, { documentPrefix: 'asc' }, { documentNumber: 'asc' }],
      });
      if (notes.length !== ids.length) throw new NotFoundException();
      if (notes.some((d) => d.status !== 'CONFIRMED'))
        throw new ConflictException('Solo se pueden facturar Remitos confirmados.');
      if (new Set(notes.map((d) => d.customerId)).size > 1)
        throw new BadRequestException('Los Remitos seleccionados pertenecen a clientes distintos.');
      const invoiced = notes.find((d) => d.invoiceLink);
      if (invoiced)
        throw new ConflictException(
          `El Remito ${deliveryNoteNumber(invoiced)} ya fue incluido en otra factura.`,
        );
      const lines = notes.flatMap((d) => d.lines);
      if (lines.length > MAX_LINES)
        throw new BadRequestException('Una factura admite hasta 500 líneas. Elegí menos Remitos.');
      const customerId = notes[0]!.customerId;
      await tx.$queryRaw`SELECT id FROM "Customer" WHERE "organizationId"=${c.organizationId}::uuid AND id=${customerId}::uuid FOR SHARE`;
      const customer = await tx.customer.findFirst({
        where: { organizationId: c.organizationId, id: customerId },
      });
      if (!customer) throw new NotFoundException();
      if (customer.archivedAt)
        throw new ConflictException('El cliente está archivado. Revisalo antes de facturar.');
      await tx.invoice.create({
        data: {
          id: input.id,
          organizationId: c.organizationId,
          customerId,
          issueDate: day(businessDate()),
          creationHash: digest,
        },
      });
      await tx.invoiceDeliveryNote.createMany({
        data: notes.map((d, ordinal) => ({
          organizationId: c.organizationId,
          invoiceId: input.id,
          customerId,
          deliveryNoteId: d.id,
          ordinal,
        })),
      });
      // One invoice line per Remito line, copied from the Remito's confirmed snapshots.
      // No price is proposed: the user completes it.
      await tx.invoiceLine.createMany({
        data: notes
          .flatMap((d) => d.lines)
          .map((l, ordinal) => ({
            id: randomUUID(),
            organizationId: c.organizationId,
            invoiceId: input.id,
            deliveryNoteId: l.deliveryNoteId,
            deliveryNoteLineId: l.id,
            productId: l.productId,
            ordinal,
            description:
              l.productNameSnapshot! +
              (l.presentationSnapshot ? ' · ' + l.presentationSnapshot : ''),
            productNameSnapshot: l.productNameSnapshot!,
            presentationSnapshot: l.presentationSnapshot,
            unitOfMeasure: l.unitOfMeasureSnapshot!,
            quantity: l.quantity,
          })),
      });
      await this.audit.append(
        {
          organizationId: c.organizationId,
          actorUserId: c.userId,
          sessionId: c.sessionId,
          requestId: c.requestId,
          action: 'INVOICE_CREATED',
          resourceType: 'Invoice',
          resourceId: input.id,
          result: 'SUCCESS',
          metadata: { count: notes.length },
        },
        tx,
      );
      return this.view(tx, c, await this.record(tx, c, input.id));
    });
  }

  async update(c: RequestActorContext, id: string, input: InvoiceUpdate) {
    return this.write(c, async (tx) => {
      const i = await this.lock(tx, c, id);
      this.draft(i);
      this.version(i, input.expectedVersion);
      const changes = new Map(input.lines.map((l) => [l.id, l]));
      // Lines come from the Remitos: none can be added, removed or swapped.
      if (changes.size !== i.lines.length || i.lines.some((l) => !changes.has(l.id)))
        throw new BadRequestException('Las líneas de la factura no coinciden. Volvé a cargarla.');
      const next = i.lines.map((l) => {
        const change = changes.get(l.id)!;
        return {
          id: l.id,
          description: change.description,
          unitPrice: change.unitPrice,
          vatRate: change.vatRate,
          ...amounts(exactQuantity(l.quantity), change.unitPrice, change.vatRate),
        };
      });
      for (const [index, l] of next.entries()) {
        const before = i.lines[index]!;
        if (
          before.description === l.description &&
          (before.unitPrice?.toFixed(2) ?? null) === l.unitPrice &&
          before.vatRate === l.vatRate
        )
          continue;
        await tx.invoiceLine.update({
          where: { id: l.id },
          data: {
            description: l.description,
            unitPrice: l.unitPrice,
            vatRate: l.vatRate,
            netAmount: l.netAmount,
            vatAmount: l.vatAmount,
            totalAmount: l.totalAmount,
          },
        });
      }
      const totals = this.totals(next);
      await tx.invoice.update({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
        data: {
          invoiceType: input.invoiceType,
          issueDate: day(input.issueDate),
          notes: input.notes,
          netAmount: totals.netAmount,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
          version: { increment: 1 },
        },
      });
      await this.audit.success(c, 'INVOICE_UPDATED', 'Invoice', id, tx);
      return this.view(tx, c, await this.record(tx, c, id));
    });
  }
  private totals(lines: { netAmount: string | null; vatAmount: string | null }[]) {
    try {
      return invoiceTotals(lines);
    } catch {
      throw new BadRequestException('El total de la factura es demasiado grande.');
    }
  }

  // Transitions are replay-safe by operationId and protected by expectedVersion.
  private async transition(
    c: RequestActorContext,
    id: string,
    input: InvoiceTransition,
    action: 'ready' | 'reopen',
    apply: (tx: Tx, i: InvoiceRecord, digest: string) => Promise<void>,
  ) {
    const digest = hash({ id, ...input, action, actor: c.userId });
    return this.write(c, async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`invoice-operation:${c.organizationId}:${input.operationId}`},0))`;
      const prior = await tx.invoice.findFirst({
        where: { organizationId: c.organizationId, lastOperationId: input.operationId },
        include,
      });
      if (prior) {
        if (prior.lastOperationHash !== digest)
          throw new ConflictException('Esta clave de operación ya se utilizó con otros datos.');
        return this.view(tx, c, prior, true);
      }
      const i = await this.lock(tx, c, id);
      await apply(tx, i, digest);
      return this.view(tx, c, await this.record(tx, c, id));
    });
  }

  async ready(c: RequestActorContext, id: string, input: InvoiceTransition) {
    return this.transition(c, id, input, 'ready', async (tx, i, digest) => {
      if (i.status !== 'DRAFT')
        throw new ConflictException('Esta factura ya está lista para autorizar.');
      this.version(i, input.expectedVersion);
      if (!i.invoiceType) throw new BadRequestException('Elegí el tipo de factura.');
      if (!i.deliveryNotes.length)
        throw new BadRequestException('La factura necesita al menos un Remito.');
      for (const l of i.lines) {
        if (!l.unitPrice)
          throw new BadRequestException(`Completá el precio unitario de “${l.description}”.`);
        if (!l.vatRate) throw new BadRequestException(`Revisá el IVA de “${l.description}”.`);
      }
      // Backend authority: every amount is recomputed from quantity, price and VAT.
      const lines = i.lines.map((l) => {
        const computed = amounts(exactQuantity(l.quantity), l.unitPrice!.toFixed(2), l.vatRate);
        if (
          computed.netAmount !== l.netAmount?.toFixed(2) ||
          computed.vatAmount !== l.vatAmount?.toFixed(2)
        )
          throw new ConflictException('Los importes cambiaron. Volvé a cargar la factura.');
        return computed;
      });
      const totals = this.totals(lines);
      if (
        totals.netAmount !== i.netAmount.toFixed(2) ||
        totals.vatAmount !== i.vatAmount.toFixed(2)
      )
        throw new ConflictException('Los totales cambiaron. Volvé a cargar la factura.');
      const sources = await tx.deliveryNote.findMany({
        where: {
          organizationId: c.organizationId,
          id: { in: i.deliveryNotes.map((k) => k.deliveryNote.id) },
        },
        select: { status: true, customerId: true },
      });
      if (sources.some((d) => d.status !== 'CONFIRMED' || d.customerId !== i.customerId))
        throw new ConflictException('Revisá los Remitos de esta factura.');
      if (i.customer.archivedAt)
        throw new ConflictException('El cliente está archivado. Revisalo antes de continuar.');
      if (i.invoiceType === 'INVOICE_A' && !i.customer.cuit)
        throw new BadRequestException('La factura A requiere el CUIT del cliente.');
      if (i.invoiceType === 'INVOICE_C' && totals.vatAmount !== '0.00')
        throw new BadRequestException(
          'Las facturas C no discriminan IVA. Revisá el IVA de las líneas.',
        );
      await tx.invoice.update({
        where: { organizationId_id: { organizationId: c.organizationId, id: i.id } },
        data: {
          status: 'READY',
          version: { increment: 1 },
          // Frozen commercial snapshot: later Customer edits never rewrite this invoice.
          customerSnapshot: customerView(i.customer),
          readyAt: new Date(),
          readyByUserId: c.userId,
          readyByMembershipId: c.membershipId,
          lastOperationId: input.operationId,
          lastOperationHash: digest,
        },
      });
      await this.audit.success(c, 'INVOICE_MARKED_READY', 'Invoice', i.id, tx);
    });
  }

  // Allowed only because no fiscal authorization exists yet (V1).
  async reopen(c: RequestActorContext, id: string, input: InvoiceTransition) {
    return this.transition(c, id, input, 'reopen', async (tx, i, digest) => {
      if (i.status !== 'READY') throw new ConflictException('Esta factura ya es un borrador.');
      this.version(i, input.expectedVersion);
      await tx.invoice.update({
        where: { organizationId_id: { organizationId: c.organizationId, id: i.id } },
        data: {
          status: 'DRAFT',
          version: { increment: 1 },
          customerSnapshot: DbNull,
          readyAt: null,
          readyByUserId: null,
          readyByMembershipId: null,
          lastOperationId: input.operationId,
          lastOperationHash: digest,
        },
      });
      await this.audit.success(c, 'INVOICE_RETURNED_TO_DRAFT', 'Invoice', i.id, tx);
    });
  }

  // A draft never had fiscal value; discarding it frees its Remitos for a new invoice.
  async discard(c: RequestActorContext, id: string, expectedVersion: number) {
    return this.write(c, async (tx) => {
      const i = await this.lock(tx, c, id);
      this.draft(i);
      this.version(i, expectedVersion);
      const scope = { organizationId: c.organizationId, invoiceId: id };
      await tx.invoiceLine.deleteMany({ where: scope });
      await tx.invoiceDeliveryNote.deleteMany({ where: scope });
      await tx.invoice.delete({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
      });
      await this.audit.success(c, 'INVOICE_DRAFT_DISCARDED', 'Invoice', id, tx);
      return { id, discarded: true as const };
    });
  }
}

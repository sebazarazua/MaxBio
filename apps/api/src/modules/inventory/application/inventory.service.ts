import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import type {
  CatalogListQuery,
  InventoryLineInput,
  InventoryConfirm,
  InventoryPolicyInput,
  InventoryAdjustment,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { normalizeIdentifier } from '../../catalog/domain/identifiers.js';
import {
  amount,
  quantity,
  validQuantity,
  MAX_AMOUNT,
  SCALE,
  businessDate,
  EXPIRING_SOON_DAYS,
} from '../domain/quantity.js';

export type DocumentKind = 'receipts' | 'counts';
type Tx = Prisma.TransactionClient;
const named = { id: true, name: true } as const;
const productSelect = { id: true, name: true, unitOfMeasure: true } as const;
const lineOrder = [{ createdAt: 'asc' }, { id: 'asc' }] as const;
const receiptInclude = {
  supplier: { select: named },
  location: { select: named },
  lines: { orderBy: [...lineOrder] },
} satisfies Prisma.InventoryReceiptInclude;
const countInclude = {
  location: { select: named },
  scopes: {
    orderBy: [{ productId: 'asc' }],
    include: { product: { select: productSelect }, lines: { orderBy: [...lineOrder] } },
  },
} satisfies Prisma.InventoryCountSessionInclude;
type PostingLine = Prisma.InventoryMovementLineCreateManyInput;
const dateText = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const page = <T>(items: T[], total: number, q: CatalogListQuery) => ({
  items,
  total,
  page: q.page,
  limit: q.limit,
});
const window = (q: CatalogListQuery) => ({ skip: (q.page - 1) * q.limit, take: q.limit });

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw new ConflictException(
        'Otra persona cambió esta operación. Volvé a cargarla antes de continuar.',
      );
  }
  private async authorize(tx: Tx, c: RequestActorContext, admin = false) {
    if (admin && c.role !== 'ADMIN')
      throw new ForbiddenException('Esta acción requiere un administrador.');
    const now = new Date();
    const member = await tx.membership.findFirst({
      where: {
        id: c.membershipId,
        userId: c.userId,
        organizationId: c.organizationId,
        role: c.role,
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
    if (!member || !session)
      throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
  }
  private async write<T>(c: RequestActorContext, fn: (tx: Tx) => Promise<T>, admin = false) {
    try {
      return await this.db.client.$transaction(
        async (tx) => {
          await this.authorize(tx, c, admin);
          return fn(tx);
        },
        { timeout: 10000, maxWait: 5000 },
      );
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e) {
        if (e.code === 'P2002')
          throw new ConflictException(
            'La operación entró en conflicto con otra confirmación, lote o serie. Revisá los datos.',
          );
        if (e.code === 'P2003' || e.code === 'P2025') throw new NotFoundException();
        if (e.code === 'P2034')
          throw new ConflictException(
            'Otra operación coincidió con ésta. Reintentá con la misma confirmación.',
          );
      }
      throw e;
    }
  }
  private async advisory(tx: Tx, key: string) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${key},0))`;
  }
  private async lockProducts(tx: Tx, c: RequestActorContext, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      await tx.$queryRaw`SELECT id FROM "Product" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
      const p = await tx.product.findFirst({ where: { organizationId: c.organizationId, id } });
      if (!p) throw new NotFoundException();
      if (p.archivedAt)
        throw new ConflictException(
          'Este producto está archivado. Pedí su revisión a un administrador.',
        );
    }
  }
  private async location(tx: Tx, c: RequestActorContext) {
    await this.advisory(tx, `inventory-location:${c.organizationId}`);
    return tx.inventoryLocation.upsert({
      where: { organizationId_code: { organizationId: c.organizationId, code: 'MAIN' } },
      create: { organizationId: c.organizationId, code: 'MAIN', name: 'Depósito principal' },
      update: {},
    });
  }
  private async scope(tx: Tx, c: RequestActorContext, productId: string, locationId: string) {
    return tx.inventoryStockScope.upsert({
      where: {
        organizationId_productId_locationId: {
          organizationId: c.organizationId,
          productId,
          locationId,
        },
      },
      create: { organizationId: c.organizationId, productId, locationId },
      update: {},
    });
  }
  private async document(
    tx: Tx,
    c: RequestActorContext,
    kind: DocumentKind,
    id: string,
    owned = false,
  ) {
    if (kind === 'receipts') {
      const record = await tx.inventoryReceipt.findFirst({
        where: { organizationId: c.organizationId, id },
        include: receiptInclude,
      });
      if (
        !record ||
        ((owned || record.status !== 'CONFIRMED') &&
          record.actorUserId !== c.userId &&
          !owned &&
          c.role !== 'ADMIN')
      )
        throw new NotFoundException();
      if (owned && record.actorUserId !== c.userId)
        throw new ForbiddenException(
          'Retomá una operación propia. Un administrador puede cancelar una operación abandonada.',
        );
      return {
        record,
        lines: record.lines,
        scopes: [],
        supplier: record.supplier,
        location: record.location,
        ownedByActor: record.actorUserId === c.userId,
      };
    }
    const record = await tx.inventoryCountSession.findFirst({
      where: { organizationId: c.organizationId, id },
      include: countInclude,
    });
    if (
      !record ||
      ((owned || record.status !== 'CONFIRMED') &&
        record.actorUserId !== c.userId &&
        !owned &&
        c.role !== 'ADMIN')
    )
      throw new NotFoundException();
    if (owned && record.actorUserId !== c.userId)
      throw new ForbiddenException('Retomá una sesión propia.');
    return {
      record,
      lines: record.scopes.flatMap((s) => s.lines),
      scopes: record.scopes,
      supplier: null,
      location: record.location,
      ownedByActor: record.actorUserId === c.userId,
    };
  }
  private view(
    kind: DocumentKind,
    d: Awaited<ReturnType<InventoryService['document']>>,
    movementId: string | null,
    replayed = false,
  ) {
    return {
      id: d.record.id,
      kind: kind === 'receipts' ? ('RECEIPT' as const) : ('INITIAL_COUNT' as const),
      status: d.record.status,
      version: d.record.version,
      supplier: d.supplier,
      location: d.location,
      notes: d.record.notes,
      createdAt: d.record.createdAt.toISOString(),
      confirmedAt: d.record.confirmedAt?.toISOString() ?? null,
      movementId,
      replayed,
      canEdit: d.ownedByActor && d.record.status === 'DRAFT',
      lines: d.lines.map((l) => ({
        id: l.id,
        product: { id: l.productId, name: l.productName, unitOfMeasure: l.unitOfMeasure },
        quantity: quantity(amount(l.quantity.toString())),
        lotId: l.lotId,
        lotNumber: l.lotNumber,
        expirationDate: dateText(l.expirationDate),
        serialNumbers: l.serialNumbers as string[],
        condition: l.condition,
        policyVersion: l.policyVersion,
      })),
      scopes: d.scopes.map((s) => ({
        id: s.id,
        productId: s.productId,
        productName: s.product.name,
        expectedScopeVersion: s.expectedScopeVersion,
        coverageConfirmed: s.coverageConfirmed,
      })),
    };
  }
  async getDocument(c: RequestActorContext, kind: DocumentKind, id: string) {
    const d = await this.document(this.db.client, c, kind, id);
    const movement = await this.db.client.inventoryMovement.findFirst({
      where: {
        organizationId: c.organizationId,
        ...(kind === 'receipts' ? { receiptId: id } : { countSessionId: id }),
        postedAt: { not: null },
      },
      select: { id: true },
    });
    return this.view(kind, d, movement?.id ?? null);
  }
  async listDocuments(c: RequestActorContext, kind: DocumentKind, q: CatalogListQuery) {
    const where = {
      organizationId: c.organizationId,
      ...(c.role === 'ADMIN'
        ? {}
        : { OR: [{ actorUserId: c.userId }, { status: 'CONFIRMED' as const }] }),
    };
    return this.db.client.$transaction(
      async (tx) => {
        const rows =
          kind === 'receipts'
            ? await tx.inventoryReceipt.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                ...window(q),
                select: { id: true },
              })
            : await tx.inventoryCountSession.findMany({
                where,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                ...window(q),
                select: { id: true },
              });
        const total =
          kind === 'receipts'
            ? await tx.inventoryReceipt.count({ where })
            : await tx.inventoryCountSession.count({ where });
        const items = [];
        for (const r of rows) {
          const d = await this.document(tx, c, kind, r.id);
          const m = await tx.inventoryMovement.findFirst({
            where: {
              organizationId: c.organizationId,
              ...(kind === 'receipts' ? { receiptId: r.id } : { countSessionId: r.id }),
            },
            select: { id: true },
          });
          items.push(this.view(kind, d, m?.id ?? null));
        }
        return page(items, total, q);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async createDocument(
    c: RequestActorContext,
    kind: DocumentKind,
    input: { id: string; supplierId?: string; notes?: string },
  ) {
    return this.write(c, async (tx) => {
      await this.advisory(tx, `inventory-draft:${c.organizationId}:${kind}:${input.id}`);
      const prior =
        kind === 'receipts'
          ? await tx.inventoryReceipt.findUnique({ where: { id: input.id } })
          : await tx.inventoryCountSession.findUnique({ where: { id: input.id } });
      if (prior) {
        if (prior.organizationId !== c.organizationId || prior.actorUserId !== c.userId)
          throw new NotFoundException();
        if (
          prior.notes !== (input.notes ?? null) ||
          ('supplierId' in prior && prior.supplierId !== input.supplierId)
        )
          throw new ConflictException('Este borrador ya fue creado con otros datos.');
        return this.view(kind, await this.document(tx, c, kind, input.id, true), null);
      }
      const loc = await this.location(tx, c);
      if (loc.archivedAt) throw new ConflictException('El depósito está archivado.');
      const data = {
        id: input.id,
        organizationId: c.organizationId,
        locationId: loc.id,
        actorUserId: c.userId,
        membershipId: c.membershipId,
        sessionId: c.sessionId,
        notes: input.notes ?? null,
      };
      if (kind === 'receipts') {
        const supplier = await tx.supplier.findFirst({
          where: { organizationId: c.organizationId, id: input.supplierId, archivedAt: null },
        });
        if (!supplier || !input.supplierId) throw new NotFoundException();
        await tx.inventoryReceipt.create({ data: { ...data, supplierId: supplier.id } });
      } else await tx.inventoryCountSession.create({ data });
      return this.view(kind, await this.document(tx, c, kind, input.id, true), null);
    });
  }
  private async lockDocument(tx: Tx, c: RequestActorContext, kind: DocumentKind, id: string) {
    if (kind === 'receipts')
      await tx.$queryRaw`SELECT id FROM "InventoryReceipt" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM "InventoryCountSession" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const d = await this.document(tx, c, kind, id, true);
    if (d.record.status !== 'DRAFT')
      throw new ConflictException(
        'Esta operación ya está cerrada. Un error confirmado se corrige con un nuevo ajuste administrativo.',
      );
    return d;
  }
  private async bump(tx: Tx, c: RequestActorContext, kind: DocumentKind, id: string) {
    if (kind === 'receipts')
      await tx.inventoryReceipt.update({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
        data: { version: { increment: 1 } },
      });
    else
      await tx.inventoryCountSession.update({
        where: { organizationId_id: { organizationId: c.organizationId, id } },
        data: { version: { increment: 1 } },
      });
  }
  async updateHeader(
    c: RequestActorContext,
    kind: DocumentKind,
    id: string,
    input: { expectedVersion: number; notes: string | null },
  ) {
    return this.write(c, async (tx) => {
      const d = await this.lockDocument(tx, c, kind, id);
      this.version(d.record.version, input.expectedVersion);
      if (kind === 'receipts')
        await tx.inventoryReceipt.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: { notes: input.notes, version: { increment: 1 } },
        });
      else
        await tx.inventoryCountSession.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: { notes: input.notes, version: { increment: 1 } },
        });
      return this.view(kind, await this.document(tx, c, kind, id, true), null);
    });
  }
  async getPolicy(c: RequestActorContext, productId: string) {
    if (
      !(await this.db.client.product.findFirst({
        where: { organizationId: c.organizationId, id: productId },
      }))
    )
      throw new NotFoundException();
    const p = await this.db.client.productInventoryPolicy.findUnique({
      where: { organizationId_productId: { organizationId: c.organizationId, productId } },
    });
    return p ? this.policyView(p) : null;
  }
  private policyView(p: {
    productId: string;
    version: number;
    lotRequired: boolean;
    expirationRequired: boolean;
    serialRequired: boolean;
  }) {
    return {
      productId: p.productId,
      version: p.version,
      lotRequired: p.lotRequired,
      expirationRequired: p.expirationRequired,
      serialRequired: p.serialRequired,
    };
  }
  async setPolicy(c: RequestActorContext, productId: string, input: InventoryPolicyInput) {
    return this.write(
      c,
      async (tx) => {
        await this.lockProducts(tx, c, [productId]);
        const product = await tx.product.findFirstOrThrow({
          where: { organizationId: c.organizationId, id: productId },
        });
        if (input.serialRequired && !['UNIT', 'PAIR'].includes(product.unitOfMeasure))
          throw new BadRequestException(
            'Las series individuales requieren una unidad indivisible: Unidad o Par.',
          );
        const old = await tx.productInventoryPolicy.findUnique({
          where: { organizationId_productId: { organizationId: c.organizationId, productId } },
        });
        if (
          old &&
          old.lotRequired === input.lotRequired &&
          old.expirationRequired === input.expirationRequired &&
          old.serialRequired === input.serialRequired
        )
          return this.policyView(old);
        this.version(old?.version ?? 0, input.expectedVersion);
        const history = await tx.inventoryMovementLine.findFirst({
          where: { organizationId: c.organizationId, productId },
          select: { id: true },
        });
        const initial = await tx.inventoryCountScope.findFirst({
          where: { organizationId: c.organizationId, productId, confirmedAt: { not: null } },
          select: { id: true },
        });
        const hold = await tx.inventoryStockScope.findFirst({
          where: {
            organizationId: c.organizationId,
            productId,
            activeCountSessionId: { not: null },
          },
          select: { id: true },
        });
        if (history || initial || hold)
          throw new ConflictException(
            'No se puede cambiar la política con historia de stock o un conteo activo. Requiere una regularización administrativa posterior.',
          );
        const { expectedVersion: _, ...flags } = input;
        void _;
        const p = old
          ? await tx.productInventoryPolicy.update({
              where: { organizationId_productId: { organizationId: c.organizationId, productId } },
              data: { ...flags, version: { increment: 1 } },
            })
          : await tx.productInventoryPolicy.create({
              data: { organizationId: c.organizationId, productId, ...flags },
            });
        await this.audit.success(c, 'INVENTORY_POLICY_UPDATED', 'ProductInventoryPolicy', p.id, tx);
        return this.policyView(p);
      },
      true,
    );
  }
  async addScope(
    c: RequestActorContext,
    id: string,
    input: { productId: string; expectedVersion: number },
  ) {
    return this.write(c, async (tx) => {
      await this.lockProducts(tx, c, [input.productId]);
      const d = await this.lockDocument(tx, c, 'counts', id);
      if (d.scopes.some((s) => s.productId === input.productId))
        return this.view('counts', d, null);
      this.version(d.record.version, input.expectedVersion);
      if (d.scopes.length >= 10)
        throw new BadRequestException(
          'Confirmá esta sesión antes de agregar más de diez productos.',
        );
      if (
        !(await tx.productInventoryPolicy.findUnique({
          where: {
            organizationId_productId: {
              organizationId: c.organizationId,
              productId: input.productId,
            },
          },
        }))
      )
        throw new ConflictException(
          'Un administrador debe revisar qué datos físicos necesita este producto antes de contarlo.',
        );
      const s = await this.scope(tx, c, input.productId, d.record.locationId);
      if (
        s.initializedAt ||
        (await tx.inventoryMovementLine.findFirst({
          where: {
            organizationId: c.organizationId,
            productId: input.productId,
            locationId: d.record.locationId,
          },
          select: { id: true },
        }))
      )
        throw new ConflictException(
          'Este producto ya tiene inventario inicial o movimientos en el depósito. Requiere ajuste administrativo, no otro inventario inicial.',
        );
      if (s.activeCountSessionId)
        throw new ConflictException(
          'Este producto está siendo contado en otra sesión. Retomá o cancelá esa sesión.',
        );
      await tx.inventoryStockScope.update({
        where: { id: s.id },
        data: { activeCountSessionId: id, version: { increment: 1 } },
      });
      await tx.inventoryCountScope.create({
        data: {
          organizationId: c.organizationId,
          productId: input.productId,
          locationId: d.record.locationId,
          sessionId: id,
          expectedScopeVersion: s.version + 1,
        },
      });
      await this.bump(tx, c, 'counts', id);
      return this.view('counts', await this.document(tx, c, 'counts', id, true), null);
    });
  }
  private async capture(
    tx: Tx,
    c: RequestActorContext,
    input: InventoryLineInput,
    allowZero: boolean,
  ) {
    const p = await tx.product.findFirstOrThrow({
      where: { organizationId: c.organizationId, id: input.productId },
    });
    const pol = await tx.productInventoryPolicy.findUnique({
      where: { organizationId_productId: { organizationId: c.organizationId, productId: p.id } },
    });
    if (!pol)
      throw new ConflictException(
        'Un administrador debe configurar los datos físicos de este producto.',
      );
    if (p.unitOfMeasure !== input.unitOfMeasure)
      throw new ConflictException(
        'La unidad del producto cambió. Volvé a reconocerlo antes de agregarlo.',
      );
    let units: bigint;
    try {
      units = validQuantity(input.quantity, p.unitOfMeasure, allowZero);
    } catch (e) {
      throw new BadRequestException(e instanceof Error ? e.message : 'Revisá la cantidad.');
    }
    if (pol.serialRequired) {
      if (units !== BigInt(input.serialNumbers.length) * SCALE)
        throw new BadRequestException(
          'La cantidad debe coincidir exactamente con las series ingresadas.',
        );
    } else if (input.serialNumbers.length)
      throw new BadRequestException(
        'Este producto no se maneja por serie. Un administrador debe revisar su política.',
      );
    let lotNumber = input.lotNumber ?? null;
    let expiration = input.expirationDate ?? null;
    if (input.lotId) {
      const lot = await tx.inventoryLot.findFirst({
        where: { organizationId: c.organizationId, productId: p.id, id: input.lotId },
      });
      if (!lot) throw new NotFoundException();
      if (
        (lotNumber !== null && lotNumber !== lot.lotNumber) ||
        (expiration !== null && expiration !== dateText(lot.expirationDate))
      )
        throw new ConflictException('El lote seleccionado tiene otros datos.');
      lotNumber = lot.lotNumber;
      expiration = dateText(lot.expirationDate);
    }
    if (units > 0n && pol.lotRequired && !lotNumber)
      throw new BadRequestException('Este producto requiere número de lote.');
    if (units > 0n && pol.expirationRequired && !expiration)
      throw new BadRequestException('Este producto requiere vencimiento.');
    if (expiration && dateText(new Date(expiration + 'T00:00:00.000Z')) !== expiration)
      throw new BadRequestException('La fecha de vencimiento no es válida.');
    return {
      organizationId: c.organizationId,
      productId: p.id,
      quantity: quantity(units),
      unitOfMeasure: p.unitOfMeasure,
      productName: p.name,
      policyVersion: pol.version,
      condition: input.condition,
      lotNumber,
      lotId: input.lotId ?? null,
      expirationDate: expiration ? new Date(expiration + 'T00:00:00.000Z') : null,
      serialNumbers: input.serialNumbers,
    };
  }
  async putLine(
    c: RequestActorContext,
    kind: DocumentKind,
    id: string,
    lineId: string,
    input: InventoryLineInput,
  ) {
    return this.write(c, async (tx) => {
      await this.lockProducts(tx, c, [input.productId]);
      const d = await this.lockDocument(tx, c, kind, id);
      const data = {
        ...(await this.capture(tx, c, input, kind === 'counts')),
        locationId: d.record.locationId,
      };
      const old = d.lines.find((l) => l.id === lineId);
      if (
        old &&
        digest({ ...data, serialNumbers: data.serialNumbers }) ===
          digest({
            organizationId: old.organizationId,
            productId: old.productId,
            quantity: quantity(amount(old.quantity.toString())),
            unitOfMeasure: old.unitOfMeasure,
            productName: old.productName,
            policyVersion: old.policyVersion,
            condition: old.condition,
            lotNumber: old.lotNumber,
            lotId: old.lotId,
            expirationDate: old.expirationDate,
            serialNumbers: old.serialNumbers,
            locationId: old.locationId,
          })
      )
        return this.view(kind, d, null);
      this.version(d.record.version, input.expectedVersion);
      if (!old && d.lines.length >= 50)
        throw new BadRequestException(
          'Confirmá la operación antes de agregar más de cincuenta líneas.',
        );
      const totalSeries =
        d.lines
          .filter((l) => l.id !== lineId)
          .reduce((n, l) => n + (l.serialNumbers as string[]).length, 0) +
        input.serialNumbers.length;
      if (totalSeries > 500)
        throw new BadRequestException(
          'Dividí la recepción en operaciones de hasta quinientas series.',
        );
      if (kind === 'receipts') {
        if (old) await tx.inventoryReceiptLine.update({ where: { id: lineId }, data });
        else await tx.inventoryReceiptLine.create({ data: { ...data, id: lineId, receiptId: id } });
      } else {
        const s = d.scopes.find((s) => s.productId === input.productId);
        if (!s)
          throw new ConflictException(
            'Iniciá el conteo de este producto antes de agregar sus datos físicos.',
          );
        if (old && old.productId !== input.productId)
          throw new BadRequestException('Quitá la línea anterior y agregá el producto correcto.');
        if (old) await tx.inventoryCountLine.update({ where: { id: lineId }, data });
        else await tx.inventoryCountLine.create({ data: { ...data, id: lineId, scopeId: s.id } });
      }
      await this.bump(tx, c, kind, id);
      return this.view(kind, await this.document(tx, c, kind, id, true), null);
    });
  }
  async removeLine(
    c: RequestActorContext,
    kind: DocumentKind,
    id: string,
    lineId: string,
    expectedVersion: number,
  ) {
    return this.write(c, async (tx) => {
      const d = await this.lockDocument(tx, c, kind, id);
      if (!d.lines.some((l) => l.id === lineId)) return this.view(kind, d, null);
      this.version(d.record.version, expectedVersion);
      if (kind === 'receipts')
        await tx.inventoryReceiptLine.deleteMany({
          where: { organizationId: c.organizationId, receiptId: id, id: lineId },
        });
      else
        await tx.inventoryCountLine.deleteMany({
          where: { organizationId: c.organizationId, id: lineId, scope: { sessionId: id } },
        });
      await this.bump(tx, c, kind, id);
      return this.view(kind, await this.document(tx, c, kind, id, true), null);
    });
  }
  async cancel(c: RequestActorContext, kind: DocumentKind, id: string, expectedVersion: number) {
    const initial = await this.document(this.db.client, c, kind, id);
    return this.write(c, async (tx) => {
      if (kind === 'counts')
        await this.lockProducts(
          tx,
          c,
          initial.scopes.map((s) => s.productId),
        );
      if (kind === 'receipts')
        await tx.$queryRaw`SELECT id FROM "InventoryReceipt" WHERE id=${id}::uuid AND "organizationId"=${c.organizationId}::uuid FOR UPDATE`;
      else
        await tx.$queryRaw`SELECT id FROM "InventoryCountSession" WHERE id=${id}::uuid AND "organizationId"=${c.organizationId}::uuid FOR UPDATE`;
      const d = await this.document(tx, c, kind, id);
      if (d.record.actorUserId !== c.userId && c.role !== 'ADMIN') throw new ForbiddenException();
      if (d.record.status === 'CANCELLED') return this.view(kind, d, null);
      if (d.record.status !== 'DRAFT')
        throw new ConflictException(
          'Una operación confirmada no se cancela. Requiere un nuevo ajuste administrativo.',
        );
      this.version(d.record.version, expectedVersion);
      if (kind === 'counts') {
        if (d.scopes.some((s) => !initial.scopes.some((i) => i.productId === s.productId)))
          throw new ConflictException('La sesión cambió. Volvé a cargarla.');
        await tx.inventoryStockScope.updateMany({
          where: { organizationId: c.organizationId, activeCountSessionId: id },
          data: { activeCountSessionId: null, version: { increment: 1 } },
        });
        await tx.inventoryCountSession.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: { status: 'CANCELLED', version: { increment: 1 } },
        });
      } else
        await tx.inventoryReceipt.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: { status: 'CANCELLED', version: { increment: 1 } },
        });
      await this.audit.success(
        c,
        'INVENTORY_DRAFT_CANCELLED',
        kind === 'receipts' ? 'InventoryReceipt' : 'InventoryCountSession',
        id,
        tx,
      );
      return this.view(kind, await this.document(tx, c, kind, id), null);
    });
  }
  private async resolveLot(
    tx: Tx,
    c: RequestActorContext,
    l: {
      productId: string;
      lotId: string | null;
      lotNumber: string | null;
      expirationDate: Date | null;
    },
  ) {
    if (l.lotId) {
      const lot = await tx.inventoryLot.findFirst({
        where: { organizationId: c.organizationId, productId: l.productId, id: l.lotId },
      });
      if (!lot) throw new NotFoundException();
      if (
        lot.lotNumber !== l.lotNumber ||
        dateText(lot.expirationDate) !== dateText(l.expirationDate)
      )
        throw new ConflictException('Los datos del lote seleccionado no coinciden.');
      return lot;
    }
    if (!l.lotNumber && !l.expirationDate) return null;
    const old = l.lotNumber
      ? await tx.inventoryLot.findUnique({
          where: {
            organizationId_productId_normalizedLotNumber: {
              organizationId: c.organizationId,
              productId: l.productId,
              normalizedLotNumber: l.lotNumber,
            },
          },
        })
      : null;
    if (old) {
      if (dateText(old.expirationDate) !== dateText(l.expirationDate))
        throw new ConflictException(
          'El lote ya está registrado con otro vencimiento. Pedí una revisión administrativa; no se sobrescribirá.',
        );
      return old;
    }
    return tx.inventoryLot.create({
      data: {
        organizationId: c.organizationId,
        productId: l.productId,
        lotNumber: l.lotNumber,
        normalizedLotNumber: l.lotNumber,
        expirationDate: l.expirationDate,
      },
    });
  }
  private async applyMovement(
    tx: Tx,
    c: RequestActorContext,
    header: Omit<
      Prisma.InventoryMovementUncheckedCreateInput,
      'actorUserId' | 'membershipId' | 'sessionId' | 'organizationId' | 'lines'
    >,
    lines: PostingLine[],
  ) {
    if (!lines.length) return null;
    const m = await tx.inventoryMovement.create({
      data: {
        occurredAt: new Date(),
        recordedAt: new Date(),
        ...header,
        organizationId: c.organizationId,
        actorUserId: c.userId,
        membershipId: c.membershipId,
        sessionId: c.sessionId,
      },
    });
    const deltas = new Map<string, { line: PostingLine; delta: bigint }>();
    for (const l of lines) {
      const key = [l.productId, l.locationId, l.lotId ?? '', l.serialId ?? '', l.condition].join(
        ':',
      );
      const prior = deltas.get(key);
      deltas.set(key, {
        line: l,
        delta: (prior?.delta ?? 0n) + amount(l.quantityDelta.toString()),
      });
    }
    for (const { line: l, delta } of [...deltas.values()].sort((a, b) =>
      a.delta < b.delta ? -1 : a.delta > b.delta ? 1 : 0,
    )) {
      const key = {
        organizationId: c.organizationId,
        productId: l.productId,
        locationId: l.locationId,
        lotId: l.lotId ?? null,
        serialId: l.serialId ?? null,
        condition: l.condition,
      };
      const b = await tx.inventoryBalance.findFirst({ where: key });
      const result = amount(b?.quantity.toString() ?? '0') + delta;
      if (result < 0n || result > MAX_AMOUNT || (l.serialId && result > 1n * SCALE))
        throw new ConflictException(
          'La operación dejaría una existencia negativa o duplicaría una serie.',
        );
      if (
        l.serialId &&
        result > 0n &&
        (await tx.inventoryBalance.findFirst({
          where: {
            organizationId: c.organizationId,
            serialId: l.serialId,
            quantity: { gt: 0 },
            ...(b ? { id: { not: b.id } } : {}),
          },
          select: { id: true },
        }))
      )
        throw new ConflictException('Esta serie ya existe físicamente en el depósito.');
      if (b)
        await tx.inventoryBalance.update({
          where: { organizationId_id: { organizationId: c.organizationId, id: b.id } },
          data: { quantity: { increment: quantity(delta) } },
        });
      else await tx.inventoryBalance.create({ data: { ...key, quantity: quantity(result) } });
    }
    await tx.inventoryMovementLine.createMany({
      data: lines.map((l) => ({ ...l, movementId: m.id })),
    });
    await tx.inventoryMovement.update({
      where: { organizationId_id: { organizationId: c.organizationId, id: m.id } },
      data: { postedAt: new Date() },
    });
    return m.id;
  }
  async confirm(c: RequestActorContext, kind: DocumentKind, id: string, input: InventoryConfirm) {
    const initial = await this.document(this.db.client, c, kind, id, true);
    const hash = digest({ kind, id, ...input });
    return this.write(c, async (tx) => {
      await this.advisory(tx, `inventory-confirm:${c.organizationId}:${kind}:${input.operationId}`);
      const old =
        kind === 'receipts'
          ? await tx.inventoryReceipt.findFirst({
              where: {
                organizationId: c.organizationId,
                confirmationOperationId: input.operationId,
              },
            })
          : await tx.inventoryCountSession.findFirst({
              where: {
                organizationId: c.organizationId,
                confirmationOperationId: input.operationId,
              },
            });
      if (old) {
        if (old.actorUserId !== c.userId || old.requestHash !== hash)
          throw new ConflictException('Esta clave de operación ya fue utilizada con otros datos.');
        const d = await this.document(tx, c, kind, old.id, true);
        const m = await tx.inventoryMovement.findFirst({
          where: {
            organizationId: c.organizationId,
            ...(kind === 'receipts' ? { receiptId: old.id } : { countSessionId: old.id }),
          },
          select: { id: true },
        });
        return this.view(kind, d, m?.id ?? null, true);
      }
      await this.lockProducts(tx, c, [
        ...initial.lines.map((l) => l.productId),
        ...initial.scopes.map((s) => s.productId),
      ]);
      if (kind === 'receipts') {
        if (!initial.supplier) throw new BadRequestException('Elegí proveedor.');
        await tx.$queryRaw`SELECT id FROM "Supplier" WHERE "organizationId"=${c.organizationId}::uuid AND id=${initial.supplier.id}::uuid FOR UPDATE`;
        if (
          !(await tx.supplier.findFirst({
            where: { organizationId: c.organizationId, id: initial.supplier.id, archivedAt: null },
          }))
        )
          throw new ConflictException('El proveedor está archivado.');
      }
      const d = await this.lockDocument(tx, c, kind, id);
      this.version(d.record.version, input.expectedVersion);
      if (!d.lines.length)
        throw new BadRequestException('Agregá al menos una línea antes de confirmar.');
      if (kind === 'counts' && input.completeCoverage !== true)
        throw new BadRequestException(
          'Confirmá que contaste todas las existencias de los productos incluidos.',
        );
      const products = [
        ...new Set([...d.lines.map((l) => l.productId), ...d.scopes.map((s) => s.productId)]),
      ].sort();
      for (const productId of products) {
        const s = await this.scope(tx, c, productId, d.record.locationId);
        if (kind === 'receipts' && s.activeCountSessionId)
          throw new ConflictException(
            'Este producto está en conteo. Esperá a que termine antes de confirmar el ingreso.',
          );
        if (kind === 'counts') {
          const counted = d.scopes.find((i) => i.productId === productId);
          if (
            !counted ||
            s.activeCountSessionId !== id ||
            s.version !== counted.expectedScopeVersion
          )
            throw new ConflictException('La toma de conteo cambió. Volvé a revisar la sesión.');
          if (
            s.initializedAt ||
            (await tx.inventoryMovementLine.findFirst({
              where: {
                organizationId: c.organizationId,
                productId,
                locationId: d.record.locationId,
              },
              select: { id: true },
            }))
          )
            throw new ConflictException(
              'Este producto ya tiene historia en el depósito y necesita ajuste administrativo.',
            );
          if (!d.lines.some((l) => l.productId === productId))
            throw new BadRequestException(
              'Registrá cantidad, incluso cero, para cada producto que estás contando.',
            );
        }
      }
      const lines: PostingLine[] = [];
      const seen = new Set<string>();
      for (const l of d.lines) {
        const validated = await this.capture(
          tx,
          c,
          {
            productId: l.productId,
            unitOfMeasure: l.unitOfMeasure,
            quantity: quantity(amount(l.quantity.toString())),
            lotId: l.lotId,
            lotNumber: l.lotNumber,
            expirationDate: dateText(l.expirationDate),
            serialNumbers: l.serialNumbers as string[],
            condition: l.condition,
            expectedVersion: d.record.version,
          },
          kind === 'counts',
        );
        if (validated.policyVersion !== l.policyVersion)
          throw new ConflictException(
            'La política del producto cambió. Quitá y revisá esa línea antes de confirmar.',
          );
        if (amount(l.quantity.toString()) === 0n) {
          if (d.lines.some((i) => i.productId === l.productId && i.id !== l.id))
            throw new BadRequestException(
              'Un conteo de cero debe ser la única línea de ese producto.',
            );
          continue;
        }
        const lot = await this.resolveLot(tx, c, l);
        const gtin = await tx.productIdentifier.findFirst({
          where: {
            organizationId: c.organizationId,
            productId: l.productId,
            kind: 'GTIN',
            archivedAt: null,
          },
          orderBy: { createdAt: 'asc' },
          select: { normalizedValue: true },
        });
        const base = {
          organizationId: c.organizationId,
          productId: l.productId,
          locationId: l.locationId,
          lotId: lot?.id ?? null,
          condition: l.condition,
          unitOfMeasure: l.unitOfMeasure,
          productName: l.productName,
          gtin: gtin?.normalizedValue ?? null,
          lotNumber: lot?.lotNumber ?? null,
          expirationDate: lot?.expirationDate ?? null,
          movementId: '',
          ...(kind === 'receipts' ? { receiptLineId: l.id } : { countLineId: l.id }),
        };
        const serials = l.serialNumbers as string[];
        if (serials.length)
          for (const number of serials) {
            const key = l.productId + ':' + number;
            if (seen.has(key))
              throw new BadRequestException(
                'La misma serie aparece en dos líneas de la operación.',
              );
            seen.add(key);
            const serial = await tx.inventorySerial.upsert({
              where: {
                organizationId_productId_normalizedSerialNumber: {
                  organizationId: c.organizationId,
                  productId: l.productId,
                  normalizedSerialNumber: number,
                },
              },
              create: {
                organizationId: c.organizationId,
                productId: l.productId,
                serialNumber: number,
                normalizedSerialNumber: number,
              },
              update: {},
            });
            if (
              await tx.inventoryBalance.findFirst({
                where: {
                  organizationId: c.organizationId,
                  serialId: serial.id,
                  quantity: { gt: 0 },
                },
                select: { id: true },
              })
            )
              throw new ConflictException('La serie ' + number + ' ya existe físicamente.');
            const prior = await tx.inventoryMovementLine.findFirst({
              where: { organizationId: c.organizationId, serialId: serial.id },
              orderBy: { movement: { recordedAt: 'desc' } },
              select: { lotId: true },
            });
            if (prior && prior.lotId !== (lot?.id ?? null))
              throw new ConflictException(
                'Esta serie estaba asignada a otro lote. Requiere revisión administrativa.',
              );
            lines.push({ ...base, serialId: serial.id, serialNumber: number, quantityDelta: '1' });
          }
        else
          lines.push({
            ...base,
            serialId: null,
            serialNumber: null,
            quantityDelta: quantity(amount(l.quantity.toString())),
          });
      }
      const movementId = await this.applyMovement(
        tx,
        c,
        {
          type: kind === 'receipts' ? 'RECEIPT' : 'INITIAL_COUNT',
          notes: d.record.notes,
          ...(kind === 'receipts' ? { receiptId: id } : { countSessionId: id }),
        },
        lines,
      );
      const now = new Date();
      for (const productId of products) {
        const s = await this.scope(tx, c, productId, d.record.locationId);
        const counted = d.scopes.find((i) => i.productId === productId);
        if (kind === 'counts' && counted)
          await tx.inventoryCountScope.update({
            where: { id: counted.id },
            data: { coverageConfirmed: true, confirmedAt: now },
          });
        await tx.inventoryStockScope.update({
          where: { id: s.id },
          data: {
            version: { increment: 1 },
            ...(kind === 'counts'
              ? { initializedAt: now, initialCountScopeId: counted!.id, activeCountSessionId: null }
              : {}),
          },
        });
      }
      const status = {
        status: 'CONFIRMED' as const,
        confirmedAt: now,
        confirmationOperationId: input.operationId,
        requestHash: hash,
        version: { increment: 1 },
      };
      if (kind === 'receipts')
        await tx.inventoryReceipt.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: status,
        });
      else
        await tx.inventoryCountSession.update({
          where: { organizationId_id: { organizationId: c.organizationId, id } },
          data: status,
        });
      await this.audit.success(
        c,
        kind === 'receipts' ? 'INVENTORY_RECEIPT_CONFIRMED' : 'INITIAL_INVENTORY_CONFIRMED',
        kind === 'receipts' ? 'InventoryReceipt' : 'InventoryCountSession',
        id,
        tx,
      );
      return this.view(kind, await this.document(tx, c, kind, id, true), movementId);
    });
  }

  private stockWhere(c: RequestActorContext, q: CatalogListQuery): Prisma.ProductWhereInput {
    const text = { contains: q.q, mode: 'insensitive' as const };
    let canonical: string | undefined;
    try {
      canonical = normalizeIdentifier({ kind: 'GTIN', value: q.q }).normalizedValue;
    } catch {
      /* Text searches do not require a GTIN. */
    }
    return {
      organizationId: c.organizationId,
      ...(q.includeArchived ? {} : { archivedAt: null }),
      ...(q.q
        ? {
            OR: [
              { name: text },
              { model: text },
              {
                identifiers: {
                  some: {
                    OR: [{ value: text }, ...(canonical ? [{ normalizedValue: canonical }] : [])],
                  },
                },
              },
              { supplierProducts: { some: { supplierCode: text } } },
              { inventoryLots: { some: { lotNumber: text } } },
              { inventorySerials: { some: { serialNumber: text } } },
            ],
          }
        : {}),
    };
  }
  private async summary(tx: Tx, c: RequestActorContext, productId: string, day: string) {
    const p = await tx.product.findFirst({
      where: { organizationId: c.organizationId, id: productId },
      select: productSelect,
    });
    if (!p) throw new NotFoundException();
    const rows = await tx.$queryRaw<
      Array<{ physical: string; available: string; nextExpirationDate: Date | null }>
    >`SELECT COALESCE(SUM(b.quantity),0)::text AS physical, COALESCE(SUM(CASE WHEN b.condition='USABLE' AND (l."expirationDate" IS NULL OR l."expirationDate">=${day}::date) THEN b.quantity ELSE 0 END),0)::text AS available, MIN(l."expirationDate") FILTER (WHERE b.quantity>0 AND b.condition='USABLE' AND l."expirationDate">=${day}::date) AS "nextExpirationDate" FROM "InventoryBalance" b LEFT JOIN "InventoryLot" l ON l.id=b."lotId" AND l."organizationId"=b."organizationId" AND l."productId"=b."productId" WHERE b."organizationId"=${c.organizationId}::uuid AND b."productId"=${productId}::uuid`;
    const r = rows[0]!;
    const physical = amount(r.physical),
      available = amount(r.available);
    const scopes = await tx.inventoryStockScope.findMany({
      where: { organizationId: c.organizationId, productId },
      select: { initializedAt: true, activeCountSessionId: true },
    });
    return {
      product: p,
      physical: quantity(physical),
      available: quantity(available),
      unavailable: quantity(physical - available),
      initializedAt:
        scopes.length && scopes.every((s) => s.initializedAt)
          ? scopes[0]!.initializedAt!.toISOString()
          : null,
      countInProgress: scopes.some((s) => s.activeCountSessionId),
      nextExpirationDate: dateText(r.nextExpirationDate),
    };
  }
  async stock(c: RequestActorContext, q: CatalogListQuery) {
    const day = businessDate();
    return this.db.client.$transaction(
      async (tx) => {
        const where = this.stockWhere(c, q);
        const rows = await tx.product.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          ...window(q),
          select: { id: true },
        });
        const total = await tx.product.count({ where });
        const items = [];
        for (const p of rows) items.push(await this.summary(tx, c, p.id, day));
        return { ...page(items, total, q), businessDate: day };
      },
      { isolationLevel: 'RepeatableRead', timeout: 10000 },
    );
  }
  async detail(c: RequestActorContext, productId: string, q: CatalogListQuery) {
    const day = businessDate();
    const soon = new Date(day + 'T00:00:00Z');
    soon.setUTCDate(soon.getUTCDate() + EXPIRING_SOON_DAYS);
    return this.db.client.$transaction(
      async (tx) => {
        const summary = await this.summary(tx, c, productId, day);
        const where = { organizationId: c.organizationId, productId, quantity: { gt: 0 } };
        const rows = await tx.inventoryBalance.findMany({
          where,
          include: { location: { select: named }, lot: true, serial: true },
          orderBy: [{ lot: { expirationDate: { sort: 'asc', nulls: 'last' } } }, { id: 'asc' }],
          ...window(q),
        });
        const total = await tx.inventoryBalance.count({ where });
        const pol = await tx.productInventoryPolicy.findUnique({
          where: { organizationId_productId: { organizationId: c.organizationId, productId } },
        });
        const s = await tx.inventoryStockScope.findFirst({
          where: { organizationId: c.organizationId, productId },
          orderBy: { locationId: 'asc' },
        });
        return {
          summary,
          businessDate: day,
          policy: pol ? this.policyView(pol) : null,
          scopeVersion: s?.version ?? null,
          positions: rows.map((b) => {
            const expiration = dateText(b.lot?.expirationDate ?? null);
            return {
              id: b.id,
              location: b.location,
              lotId: b.lotId,
              lotNumber: b.lot?.lotNumber ?? null,
              expirationDate: expiration,
              serialNumber: b.serial?.serialNumber ?? null,
              condition: b.condition,
              quantity: quantity(amount(b.quantity.toString())),
              expired: expiration !== null && expiration < day,
              expiringSoon:
                expiration !== null && expiration >= day && expiration <= dateText(soon)!,
            };
          }),
          total,
          page: q.page,
          limit: q.limit,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async history(c: RequestActorContext, productId: string, q: CatalogListQuery) {
    return this.db.client.$transaction(
      async (tx) => {
        if (
          !(await tx.product.findFirst({
            where: { organizationId: c.organizationId, id: productId },
            select: { id: true },
          }))
        )
          throw new NotFoundException();
        const where = {
          organizationId: c.organizationId,
          postedAt: { not: null },
          lines: { some: { productId } },
        };
        const rows = await tx.inventoryMovement.findMany({
          where,
          include: {
            membership: { include: { user: { select: { displayName: true } } } },
            receipt: { include: { supplier: { select: { name: true } } } },
            lines: { where: { productId }, orderBy: { id: 'asc' } },
          },
          orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
          ...window(q),
        });
        const total = await tx.inventoryMovement.count({ where });
        const items = rows.map((m) => ({
          id: m.id,
          type: m.type,
          recordedAt: m.recordedAt.toISOString(),
          actorName: m.membership.user.displayName,
          supplierName: m.receipt?.supplier.name ?? null,
          notes: m.notes,
          sourceId: m.receiptId ?? m.countSessionId,
          change: quantity(m.lines.reduce((n, l) => n + amount(l.quantityDelta.toString()), 0n)),
          lines: m.lines.map((l) => ({
            quantityDelta: quantity(amount(l.quantityDelta.toString())),
            unitOfMeasure: l.unitOfMeasure,
            lotNumber: l.lotNumber,
            expirationDate: dateText(l.expirationDate),
            serialNumber: l.serialNumber,
            condition: l.condition,
          })),
        }));
        const zero = await tx.inventoryCountScope.findFirst({
          where: {
            organizationId: c.organizationId,
            productId,
            confirmedAt: { not: null },
            lines: { every: { quantity: 0 } },
          },
          include: {
            session: {
              include: { membership: { include: { user: { select: { displayName: true } } } } },
            },
          },
        });
        const offset = (q.page - 1) * q.limit;
        if (zero && offset <= total && offset + q.limit > total)
          items.push({
            id: zero.id,
            type: 'INITIAL_COUNT',
            recordedAt: zero.confirmedAt!.toISOString(),
            actorName: zero.session.membership.user.displayName,
            supplierName: null,
            notes: 'Conteo completo: cero existencias.',
            sourceId: zero.sessionId,
            change: '0',
            lines: [],
          });
        return page(items, total + (zero ? 1 : 0), q);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async adjust(c: RequestActorContext, input: InventoryAdjustment) {
    const hash = digest(input);
    return this.write(
      c,
      async (tx) => {
        await this.advisory(tx, `inventory-adjustment:${c.organizationId}:${input.operationId}`);
        const prior = await tx.inventoryMovement.findFirst({
          where: { organizationId: c.organizationId, operationId: input.operationId },
        });
        if (prior) {
          if (prior.actorUserId !== c.userId || prior.requestHash !== hash)
            throw new ConflictException('Esta clave ya se usó con otro ajuste.');
          return { movementId: prior.id, replayed: true };
        }
        const before = await tx.inventoryBalance.findFirst({
          where: { organizationId: c.organizationId, id: input.positionId },
        });
        if (!before) throw new NotFoundException();
        await this.lockProducts(tx, c, [before.productId]);
        const b = await tx.inventoryBalance.findFirstOrThrow({
          where: { organizationId: c.organizationId, id: input.positionId },
          include: { product: true, lot: true, serial: true },
        });
        const s = await this.scope(tx, c, b.productId, b.locationId);
        if (s.activeCountSessionId) throw new ConflictException('Este producto está en conteo.');
        this.version(s.version, input.expectedScopeVersion);
        let observed: bigint;
        try {
          observed = validQuantity(input.observedQuantity, b.product.unitOfMeasure, true);
        } catch (e) {
          throw new BadRequestException(e instanceof Error ? e.message : 'Revisá la cantidad.');
        }
        if (b.serialId && observed > SCALE)
          throw new BadRequestException('Una serie representa una sola unidad.');
        const delta = observed - amount(b.quantity.toString());
        if (delta === 0n)
          throw new BadRequestException(
            'El conteo coincide con el saldo; no hay diferencia para ajustar.',
          );
        if (['LOSS', 'DAMAGE_DISPOSAL'].includes(input.reason) && delta > 0n)
          throw new BadRequestException(
            'Pérdida o desecho requieren una disminución física. Usá el motivo correcto para un aumento.',
          );
        const gtin = await tx.productIdentifier.findFirst({
          where: {
            organizationId: c.organizationId,
            productId: b.productId,
            kind: 'GTIN',
            archivedAt: null,
          },
          select: { normalizedValue: true },
        });
        const movementId = await this.applyMovement(
          tx,
          c,
          {
            type: 'ADJUSTMENT',
            operationId: input.operationId,
            requestHash: hash,
            reason: input.reason,
            notes: input.notes,
          },
          [
            {
              organizationId: c.organizationId,
              movementId: '',
              productId: b.productId,
              locationId: b.locationId,
              lotId: b.lotId,
              serialId: b.serialId,
              condition: b.condition,
              quantityDelta: quantity(delta),
              unitOfMeasure: b.product.unitOfMeasure,
              productName: b.product.name,
              gtin: gtin?.normalizedValue ?? null,
              lotNumber: b.lot?.lotNumber ?? null,
              expirationDate: b.lot?.expirationDate ?? null,
              serialNumber: b.serial?.serialNumber ?? null,
            },
          ],
        );
        await tx.inventoryStockScope.update({
          where: { id: s.id },
          data: { version: { increment: 1 } },
        });
        await this.audit.success(
          c,
          'INVENTORY_ADJUSTMENT_CONFIRMED',
          'InventoryMovement',
          movementId!,
          tx,
        );
        return { movementId: movementId!, replayed: false };
      },
      true,
    );
  }
}

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@maxbio/database';
import {
  deliveryNoteCustomerSchema,
  type TraceabilityDetail,
  type TraceabilityItem,
  type TraceabilityList,
  type TraceabilityQuery,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { searchTokens, textContains } from '../../catalog/domain/catalog-search.js';
import { amount, quantity } from '../../inventory/domain/quantity.js';
import { deliveryNoteNumberSearch, gtinSearch } from '../domain/traceability-search.js';

type Tx = Prisma.TransactionClient;
type Where = Prisma.DeliveryNoteLineTraceWhereInput;
const day = (d: Date) => d.toISOString().slice(0, 10);
// Historical snapshots of the confirmed Remito, never live Product/Customer masters.
const select = {
  id: true,
  quantity: true,
  lotNumber: true,
  expirationDate: true,
  serialNumber: true,
  origin: true,
  line: {
    select: {
      productId: true,
      productNameSnapshot: true,
      presentationSnapshot: true,
      unitOfMeasureSnapshot: true,
      deliveryNote: {
        select: {
          id: true,
          documentPrefix: true,
          documentNumber: true,
          documentDate: true,
          customerSnapshot: true,
          patientName: true,
          affiliateNumber: true,
        },
      },
    },
  },
} satisfies Prisma.DeliveryNoteLineTraceSelect;
type Row = Prisma.DeliveryNoteLineTraceGetPayload<{ select: typeof select }>;
// Most recent Remito first; ties broken by document, line and trace order so pages never shift.
const orderBy: Prisma.DeliveryNoteLineTraceOrderByWithRelationInput[] = [
  { line: { deliveryNote: { documentDate: 'desc' } } },
  { line: { deliveryNote: { confirmedAt: 'desc' } } },
  { deliveryNoteId: 'desc' },
  { line: { ordinal: 'asc' } },
  { ordinal: 'asc' },
  { id: 'asc' },
];

function item(t: Row): TraceabilityItem {
  const d = t.line.deliveryNote;
  const customer = deliveryNoteCustomerSchema.parse(d.customerSnapshot);
  return {
    traceId: t.id,
    deliveryNote: {
      id: d.id,
      number: d.documentPrefix + '-' + d.documentNumber,
      documentDate: day(d.documentDate),
    },
    product: {
      id: t.line.productId,
      name: t.line.productNameSnapshot!,
      presentation: t.line.presentationSnapshot,
      unitOfMeasure: t.line.unitOfMeasureSnapshot!,
    },
    customer: { id: customer.id, name: customer.name },
    quantity: quantity(amount(t.quantity.toString())),
    lotNumber: t.lotNumber,
    expirationDate: t.expirationDate ? day(t.expirationDate) : null,
    serialNumber: t.serialNumber,
    source: t.origin === 'INVENTORY' ? 'STOCK' : 'DOCUMENTARY',
    patientLinked: Boolean(d.patientName || d.affiliateNumber),
  };
}

// Identifiers compared by equality: serial (never contains), lot, Remito number and GTIN.
function exactSearch(organizationId: string, term: string): Where {
  const or: Where[] = [{ serialNumber: term }, { lotNumber: term }];
  const number = deliveryNoteNumberSearch(term);
  if (number)
    or.push({
      line: {
        deliveryNote: {
          ...(number.prefixes ? { documentPrefix: { in: number.prefixes } } : {}),
          documentNumber: { in: number.numbers },
        },
      },
    });
  const gtin = gtinSearch(term);
  if (gtin)
    or.push(
      { scannedGtinSnapshot: gtin },
      { line: { gtinSnapshot: gtin } },
      {
        line: {
          product: {
            identifiers: { some: { organizationId, kind: 'GTIN', normalizedValue: gtin } },
          },
        },
      },
    );
  return { OR: or };
}

// Controlled text fallback: lot contains, plus the existing catalog/customer search text
// and the historical snapshots. Serial and patient data are never searched by contains.
function textSearch(term: string): Where {
  return {
    AND: searchTokens(term)
      .slice(0, 8)
      .map((token) => {
        const contains = textContains(token);
        return {
          OR: [
            { lotNumber: contains },
            { line: { productNameSnapshot: contains } },
            { line: { product: { searchText: contains } } },
            { line: { deliveryNote: { customer: { searchText: contains } } } },
            {
              line: {
                deliveryNote: {
                  customerSnapshot: {
                    path: ['name'],
                    string_contains: contains.contains,
                    mode: 'insensitive',
                  },
                },
              },
            },
          ],
        };
      }),
  };
}

@Injectable()
export class TraceabilityService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  private read<T>(fn: (tx: Tx) => Promise<T>) {
    return this.db.client.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  async search(c: RequestActorContext, q: TraceabilityQuery): Promise<TraceabilityList> {
    const organizationId = c.organizationId;
    return this.read(async (tx) => {
      const product = q.productId
        ? await tx.product.findFirst({
            where: { organizationId, id: q.productId },
            select: { id: true, name: true },
          })
        : null;
      const customer = q.customerId
        ? await tx.customer.findFirst({
            where: { organizationId, id: q.customerId },
            select: { id: true, name: true },
          })
        : null;
      // Another tenant's Product/Customer is indistinguishable from a missing one.
      if ((q.productId && !product) || (q.customerId && !customer)) throw new NotFoundException();
      const scope: Where = {
        organizationId,
        ...(q.productId ? { productId: q.productId } : {}),
        ...(q.source ? { origin: q.source === 'STOCK' ? 'INVENTORY' : 'DECLARED' } : {}),
        line: {
          deliveryNote: {
            organizationId,
            status: 'CONFIRMED',
            ...(q.customerId ? { customerId: q.customerId } : {}),
            ...(q.dateFrom || q.dateTo
              ? {
                  documentDate: {
                    ...(q.dateFrom ? { gte: new Date(q.dateFrom + 'T00:00:00Z') } : {}),
                    ...(q.dateTo ? { lte: new Date(q.dateTo + 'T00:00:00Z') } : {}),
                  },
                }
              : {}),
          },
        },
      };
      let where = scope;
      let match: TraceabilityList['match'] = null;
      if (q.search) {
        // Exact identifiers win; text is only a fallback when nothing matches exactly.
        const exact: Where = { AND: [scope, exactSearch(organizationId, q.search)] };
        const found = await tx.deliveryNoteLineTrace.findFirst({
          where: exact,
          select: { id: true },
        });
        match = found ? 'EXACT' : 'TEXT';
        where = found ? exact : { AND: [scope, textSearch(q.search)] };
      }
      const rows = await tx.deliveryNoteLineTrace.findMany({
        where,
        select,
        orderBy,
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      });
      return {
        items: rows.map(item),
        total: await tx.deliveryNoteLineTrace.count({ where }),
        page: q.page,
        limit: q.limit,
        match,
        filters: { product, customer },
      };
    });
  }

  async detail(c: RequestActorContext, traceId: string): Promise<TraceabilityDetail> {
    return this.read(async (tx) => {
      const t = await tx.deliveryNoteLineTrace.findFirst({
        where: {
          organizationId: c.organizationId,
          id: traceId,
          line: { deliveryNote: { organizationId: c.organizationId, status: 'CONFIRMED' } },
        },
        select: {
          ...select,
          captureMethod: true,
          scannedGtinSnapshot: true,
          line: {
            select: {
              ...select.line.select,
              quantity: true,
              deliveryNote: {
                select: { ...select.line.select.deliveryNote.select, confirmedAt: true },
              },
            },
          },
          // Ledger line of the real OUTBOUND: historical location id, never current stock.
          inventoryAllocation: {
            select: {
              movementLine: {
                select: { movementId: true, location: { select: { id: true, name: true } } },
              },
            },
          },
        },
      });
      if (!t) throw new NotFoundException();
      const base = item(t);
      const movement = t.inventoryAllocation?.movementLine;
      return {
        ...base,
        deliveryNote: {
          ...base.deliveryNote,
          confirmedAt: t.line.deliveryNote.confirmedAt!.toISOString(),
        },
        documentQuantity: quantity(amount(t.line.quantity.toString())),
        patientName: t.line.deliveryNote.patientName,
        affiliateNumber: t.line.deliveryNote.affiliateNumber,
        stock:
          t.origin === 'INVENTORY' && movement
            ? { movementId: movement.movementId, location: movement.location }
            : null,
        scannedGtin: t.scannedGtinSnapshot,
        captureMethod: c.role === 'ADMIN' ? t.captureMethod : null,
      };
    });
  }
}

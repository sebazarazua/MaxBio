import type { Prisma } from '@maxbio/database';
import {
  deliveryNoteCustomerSchema,
  invoiceHistoryActionSchema,
  type InvoiceView,
} from '@maxbio/contracts';
import { amount, quantity } from '../../inventory/domain/quantity.js';
import { customerView } from '../../delivery-notes/application/delivery-note-view.js';

type Tx = Prisma.TransactionClient;
export const invoiceInclude = {
  customer: true,
  readyBy: { include: { user: { select: { displayName: true } } } },
  deliveryNotes: {
    orderBy: { ordinal: 'asc' },
    include: {
      deliveryNote: {
        select: {
          id: true,
          documentPrefix: true,
          documentNumber: true,
          documentDate: true,
          _count: { select: { lines: true } },
        },
      },
    },
  },
  lines: { orderBy: { ordinal: 'asc' } },
} satisfies Prisma.InvoiceInclude;
export type InvoiceRecord = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;
type History = InvoiceView['history'];

const day = (d: Date) => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal) => d.toFixed(2);
export const exactQuantity = (d: Prisma.Decimal) => quantity(amount(d.toFixed()));
export const deliveryNoteNumber = (d: {
  documentPrefix: string | null;
  documentNumber: string | null;
}) => d.documentPrefix + '-' + d.documentNumber;

// Basic audit trail of this invoice; no metadata values are exposed.
export async function invoiceHistory(tx: Tx, organizationId: string, id: string): Promise<History> {
  const events = await tx.auditEvent.findMany({
    where: {
      organizationId,
      resourceType: 'Invoice',
      resourceId: id,
      action: { in: invoiceHistoryActionSchema.options },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
    include: { actorUser: { select: { displayName: true } } },
  });
  return events.map((e) => ({
    action: invoiceHistoryActionSchema.parse(e.action),
    at: e.createdAt.toISOString(),
    actor: e.actorUser?.displayName ?? null,
  }));
}

export function invoiceView(i: InvoiceRecord, history: History, replayed = false): InvoiceView {
  const ready = i.status === 'READY';
  return {
    id: i.id,
    status: i.status,
    version: i.version,
    invoiceType: i.invoiceType,
    issueDate: day(i.issueDate),
    currency: 'ARS',
    notes: i.notes,
    customer: ready
      ? deliveryNoteCustomerSchema.parse(i.customerSnapshot)
      : customerView(i.customer),
    customerArchived: Boolean(i.customer.archivedAt),
    netAmount: money(i.netAmount),
    vatAmount: money(i.vatAmount),
    totalAmount: money(i.totalAmount),
    complete: i.lines.every((l) => l.netAmount !== null),
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    readyAt: i.readyAt?.toISOString() ?? null,
    readyBy: i.readyBy?.user.displayName ?? null,
    replayed,
    deliveryNotes: i.deliveryNotes.map((k) => ({
      id: k.deliveryNote.id,
      number: deliveryNoteNumber(k.deliveryNote),
      documentDate: day(k.deliveryNote.documentDate),
      lineCount: k.deliveryNote._count.lines,
    })),
    lines: i.lines.map((l) => ({
      id: l.id,
      deliveryNoteId: l.deliveryNoteId,
      productId: l.productId,
      description: l.description,
      productName: l.productNameSnapshot,
      presentation: l.presentationSnapshot,
      unitOfMeasure: l.unitOfMeasure,
      quantity: exactQuantity(l.quantity),
      unitPrice: l.unitPrice ? money(l.unitPrice) : null,
      vatRate: l.vatRate,
      netAmount: l.netAmount ? money(l.netAmount) : null,
      vatAmount: l.vatAmount ? money(l.vatAmount) : null,
      totalAmount: l.totalAmount ? money(l.totalAmount) : null,
    })),
    history,
  };
}

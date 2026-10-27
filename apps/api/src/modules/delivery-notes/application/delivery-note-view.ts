import type { Prisma } from '@maxbio/database';
import { deliveryNoteCustomerSchema, type DeliveryNoteView } from '@maxbio/contracts';
import { amount, quantity } from '../../inventory/domain/quantity.js';
export const deliveryNoteInclude = {
  customer: true,
  movement: { select: { id: true } },
  confirmedBy: { include: { user: { select: { displayName: true } } } },
  lines: {
    orderBy: { ordinal: 'asc' },
    include: {
      product: true,
      physicalTraces: { orderBy: [{ ordinal: 'asc' }, { id: 'asc' }] },
      allocations: {
        orderBy: { id: 'asc' },
        include: { position: { include: { location: true, lot: true, serial: true } } },
      },
    },
  },
} satisfies Prisma.DeliveryNoteInclude;
export const customerView = (c: Prisma.CustomerGetPayload<object>) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  legalName: c.legalName,
  cuit: c.cuit,
  taxConditionText: c.taxConditionText,
  addressLine: c.addressLine,
  locality: c.locality,
  province: c.province,
  postalCode: c.postalCode,
});
type Record = Prisma.DeliveryNoteGetPayload<{ include: typeof deliveryNoteInclude }>;
export function deliveryNoteView(d: Record, replayed = false): DeliveryNoteView {
  const confirmed = d.status === 'CONFIRMED';
  return {
    id: d.id,
    status: d.status,
    version: d.version,
    customer: confirmed
      ? deliveryNoteCustomerSchema.parse(d.customerSnapshot)
      : customerView(d.customer),
    customerArchived: Boolean(d.customer.archivedAt),
    documentDate: d.documentDate.toISOString().slice(0, 10),
    documentPrefix: d.documentPrefix,
    documentNumber: d.documentNumber,
    patientName: d.patientName,
    affiliateNumber: d.affiliateNumber,
    notes: d.notes,
    createdAt: d.createdAt.toISOString(),
    confirmedAt: d.confirmedAt?.toISOString() ?? null,
    confirmedBy: d.confirmedBy?.user.displayName ?? null,
    movementId: d.movement?.id ?? null,
    replayed,
    lines: d.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      productName: confirmed ? l.productNameSnapshot! : l.product.name,
      presentation: confirmed ? l.presentationSnapshot : l.product.presentation,
      unitOfMeasure: confirmed ? l.unitOfMeasureSnapshot! : l.product.unitOfMeasure,
      gtin: l.gtinSnapshot,
      productArchived: Boolean(l.product.archivedAt),
      quantity: quantity(amount(l.quantity.toString())),
      physicalTraces: l.physicalTraces.map((t) => ({
        id: t.id,
        quantity: quantity(amount(t.quantity.toString())),
        lotNumber: t.lotNumber,
        expirationDate: t.expirationDate?.toISOString().slice(0, 10) ?? null,
        serialNumber: t.serialNumber,
        inventoryAllocationId: t.inventoryAllocationId,
        origin: t.origin,
        captureMethod: t.captureMethod,
        scannedGtinSnapshot: t.scannedGtinSnapshot,
        preserveOnUnlink: t.preserveOnUnlink,
        reviewedPriorTraceIds: t.reviewedPriorTraceIds,
      })),
      allocations: l.allocations.map((a) => {
        const snapshot = confirmed
          ? l.physicalTraces.find((t) => t.inventoryAllocationId === a.id)
          : undefined;
        return {
          id: a.id,
          positionId: a.positionId,
          quantity: quantity(amount(a.quantity.toString())),
          location: { id: a.position.locationId, name: a.position.location.name },
          lotId: a.position.lotId,
          lotNumber: confirmed
            ? (snapshot?.lotNumber ?? null)
            : (a.position.lot?.lotNumber ?? null),
          expirationDate: confirmed
            ? (snapshot?.expirationDate?.toISOString().slice(0, 10) ?? null)
            : (a.position.lot?.expirationDate?.toISOString().slice(0, 10) ?? null),
          serialId: a.position.serialId,
          serialNumber: confirmed
            ? (snapshot?.serialNumber ?? null)
            : (a.position.serial?.serialNumber ?? null),
          condition: a.position.condition,
        };
      }),
    })),
  };
}

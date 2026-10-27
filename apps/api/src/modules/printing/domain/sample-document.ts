import { deliveryNoteSchema } from '@maxbio/contracts';

// In-memory example only: never creates a DeliveryNote, Customer, Product or stock.
export function printSampleDocument() {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const document = {
    id: id(1),
    status: 'DRAFT',
    version: 1,
    customer: {
      id: id(2),
      name: 'OSUTHGRA',
      kind: 'HEALTH_INSURER',
      legalName: null,
      cuit: '20123456786',
      taxConditionText: null,
      addressLine: 'AV. DE MAYO 930',
      locality: 'CABA',
      province: null,
      postalCode: null,
    },
    customerArchived: false,
    documentDate: '2026-10-21',
    documentPrefix: '0002',
    documentNumber: null,
    patientName: 'CORIA, MILAGROS',
    affiliateNumber: '20-91552262-6/01',
    notes: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    confirmedAt: null,
    confirmedBy: null,
    movementId: null,
    replayed: false,
    lines: [
      {
        id: id(3),
        productId: id(4),
        productName: 'Producto X',
        presentation: null,
        unitOfMeasure: 'UNIT',
        gtin: null,
        productArchived: false,
        quantity: '2',
        allocations: [1, 2].map((n) => ({
          id: id(10 + n),
          positionId: id(20 + n),
          quantity: '1',
          location: { id: id(5), name: 'Ejemplo sin stock real' },
          lotId: id(30 + n),
          lotNumber: `ABC-00${n}`,
          expirationDate: '2028-12-31',
          serialId: id(40 + n),
          serialNumber: `DEMO-00${n}`,
          condition: 'USABLE',
        })),
      },
    ],
  };
  return deliveryNoteSchema.parse({
    ...document,
    lines: document.lines.map((l) => ({
      ...l,
      physicalTraces: l.allocations.map((a) => ({
        id: a.id,
        quantity: a.quantity,
        lotNumber: a.lotNumber,
        expirationDate: a.expirationDate,
        serialNumber: a.serialNumber,
        inventoryAllocationId: a.id,
        origin: 'INVENTORY',
        captureMethod: 'LEGACY',
        scannedGtinSnapshot: null,
        preserveOnUnlink: false,
        reviewedPriorTraceIds: [],
      })),
    })),
  });
}

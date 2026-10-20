import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import {
  printTemplateCreateSchema,
  printTemplateSchema,
  deliveryNoteSchema,
  type PrintTemplate,
} from '@maxbio/contracts';

// Deliberately synthetic, nonstandard dimensions. Never installed as Bourbon's template.
export function printingTemplateInput(backgroundAssetId: string = randomUUID()) {
  const style = { font: 'NotoSans', fontSizePt: 9, lineHeightPt: 13, maxLines: 2 };
  return printTemplateCreateSchema.parse({
    id: randomUUID(),
    name: 'Formulario sintético de pruebas',
    pageWidthMm: 180,
    pageHeightMm: 240,
    safeToleranceXmm: 2,
    safeToleranceYmm: 1,
    backgroundAssetId,
    definition: {
      schemaVersion: 1,
      fields: [
        {
          id: 'customer',
          binding: 'customer.name',
          xMm: 10,
          yMm: 20,
          widthMm: 150,
          heightMm: 12,
          ...style,
        },
        {
          id: 'date',
          binding: 'document.date',
          xMm: 10,
          yMm: 35,
          widthMm: 35,
          heightMm: 15,
          ...style,
          formatter: 'date',
        },
        {
          id: 'address',
          binding: 'customer.address',
          xMm: 50,
          yMm: 35,
          widthMm: 110,
          heightMm: 22,
          ...style,
        },
      ],
      productRegion: {
        xMm: 10,
        yMm: 65,
        widthMm: 150,
        heightMm: 144,
        rowHeightMm: 24,
        columns: [
          { binding: 'quantity', widthMm: 18, ...style, formatter: 'quantity' },
          { binding: 'productName', widthMm: 54, ...style },
          { binding: 'lotNumber', widthMm: 25, ...style },
          { binding: 'expirationDate', widthMm: 28, ...style, formatter: 'date' },
          { binding: 'serialNumber', widthMm: 25, ...style },
        ],
      },
    },
  });
}
export function printingTemplate(): PrintTemplate {
  const input = printingTemplateInput();
  return printTemplateSchema.parse({
    ...input,
    familyId: input.id,
    revision: 1,
    status: 'PUBLISHED',
    createdAt: '2026-10-19T12:00:00.000Z',
    updatedAt: '2026-10-19T12:00:00.000Z',
    publishedAt: '2026-10-19T12:00:00.000Z',
  });
}
export function printingDocument() {
  return deliveryNoteSchema.parse({
    id: randomUUID(),
    status: 'DRAFT',
    version: 1,
    customer: {
      id: randomUUID(),
      name: 'Cliente de prueba',
      kind: 'HEALTH_INSURER',
      legalName: null,
      cuit: null,
      taxConditionText: null,
      addressLine: 'Calle 123',
      locality: null,
      province: null,
      postalCode: null,
    },
    customerArchived: false,
    documentDate: '2026-10-19',
    documentPrefix: '00001',
    documentNumber: '00003897',
    patientName: null,
    affiliateNumber: null,
    notes: null,
    createdAt: '2026-10-19T12:00:00.000Z',
    confirmedAt: null,
    confirmedBy: null,
    movementId: null,
    replayed: false,
    lines: [
      {
        id: randomUUID(),
        productId: randomUUID(),
        productName: 'Producto X',
        presentation: null,
        unitOfMeasure: 'UNIT',
        gtin: null,
        productArchived: false,
        quantity: '4',
        allocations: [
          {
            id: randomUUID(),
            positionId: randomUUID(),
            quantity: '2',
            location: { id: randomUUID(), name: 'Depósito' },
            lotId: randomUUID(),
            lotNumber: 'A',
            expirationDate: '2099-01-01',
            serialId: null,
            serialNumber: null,
            condition: 'USABLE',
          },
          {
            id: randomUUID(),
            positionId: randomUUID(),
            quantity: '2',
            location: { id: randomUUID(), name: 'Depósito' },
            lotId: randomUUID(),
            lotNumber: 'B',
            expirationDate: '2099-02-01',
            serialId: null,
            serialNumber: null,
            condition: 'USABLE',
          },
        ],
      },
    ],
  });
}
export function printingPng() {
  const png = new PNG({ width: 180, height: 240 });
  png.data.fill(255);
  // A visible blue reference line for preview QA, absent from overlays.
  for (let x = 5; x < 175; x++) {
    const i = (15 * 180 + x) * 4;
    png.data[i] = 40;
    png.data[i + 1] = 80;
  }
  return PNG.sync.write(png);
}

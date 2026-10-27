import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import type { DeliveryNoteCreate } from '@maxbio/contracts';
import { parseGs1 } from '../../../common/domain/scanning/gs1.js';
import { businessDate, amount, quantity, validQuantity } from '../../inventory/domain/quantity.js';
type Tx = Prisma.TransactionClient;
type Trace = Prisma.DeliveryNoteLineTraceGetPayload<object>;
type Physical = {
  lotNumber: string | null;
  expirationDate: string | null;
  serialNumber: string | null;
};
const day = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const same = (a: Physical, b: Trace) =>
  a.lotNumber === b.lotNumber &&
  a.expirationDate === day(b.expirationDate) &&
  a.serialNumber === b.serialNumber;

// No raw input leaves this function. Capture provenance is derived by the server.
export async function traceCapture(
  tx: Tx,
  organizationId: string,
  productId: string,
  physical: Physical,
  input: { scanValue?: string; scannedGtinSnapshot?: string | null; manualEdited?: boolean },
  previous?: Trace,
) {
  let captureMethod: Trace['captureMethod'] =
    previous && same(physical, previous) ? previous.captureMethod : 'MANUAL';
  let gtin = previous?.scannedGtinSnapshot ?? null;
  if (input.scanValue) {
    const parsed = parseGs1(input.scanValue, { referenceYear: Number(businessDate().slice(0, 4)) });
    if (parsed.kind !== 'GS1' || !parsed.canResolveIdentity || !parsed.fields.gtin14)
      throw new BadRequestException('Revisá la lectura GS1 antes de guardar los datos físicos.');
    gtin = parsed.fields.gtin14;
    captureMethod =
      parsed.canApplyPhysicalData &&
      physical.lotNumber === (parsed.fields.lotNumber ?? null) &&
      physical.expirationDate === (parsed.fields.expirationDate ?? null) &&
      physical.serialNumber === (parsed.fields.serialNumber ?? null)
        ? 'GS1'
        : 'MANUAL';
  }
  if (input.manualEdited) captureMethod = 'MANUAL';
  if (input.scannedGtinSnapshot !== undefined) {
    if (input.scannedGtinSnapshot !== null && input.scannedGtinSnapshot !== gtin)
      throw new BadRequestException('El GTIN observado debe provenir de la lectura original.');
    gtin = input.scannedGtinSnapshot;
  }
  if (
    gtin &&
    !(await tx.productIdentifier.findFirst({
      where: {
        organizationId,
        productId,
        kind: 'GTIN',
        normalizedValue: gtin,
        archivedAt: null,
      },
    }))
  )
    throw new ConflictException('El GTIN leído ya no está asociado a este producto.');
  return { captureMethod, scannedGtinSnapshot: gtin };
}

export async function writeLineTraces(
  tx: Tx,
  organizationId: string,
  deliveryNoteId: string,
  line: DeliveryNoteCreate['lines'][number],
  unit: string,
  previous: Trace[],
  seen: Set<string>,
) {
  const allocations = await tx.deliveryNoteAllocation.findMany({
    where: { organizationId, lineId: line.id },
    include: { position: { include: { lot: true, serial: true } } },
    orderBy: { id: 'asc' },
  });
  const rows: Prisma.DeliveryNoteLineTraceUncheckedCreateInput[] = [];
  const prior = (id?: string) =>
    previous.find((t) => t.id === id && t.productId === line.productId && t.lineId === line.id);
  for (const a of allocations) {
    const command = line.allocations.find((v) => v.positionId === a.positionId)!;
    const source = prior(command.sourceTraceId);
    const old = prior(command.traceId) ?? source;
    const physical = {
      lotNumber: a.position.lot?.lotNumber ?? null,
      expirationDate: day(a.position.lot?.expirationDate ?? null),
      serialNumber: a.position.serial?.serialNumber ?? null,
    };
    if (
      command.sourceTraceId &&
      (!source ||
        (source.lotNumber !== null && source.lotNumber !== physical.lotNumber) ||
        (source.expirationDate !== null &&
          day(source.expirationDate) !== physical.expirationDate) ||
        (source.serialNumber !== null && source.serialNumber !== physical.serialNumber))
    )
      throw new ConflictException(
        'Los datos registrados en el Remito no coinciden con la existencia elegida.',
      );
    const provenance = await traceCapture(
      tx,
      organizationId,
      line.productId,
      physical,
      command,
      old,
    );
    rows.push({
      id: command.traceId ?? randomUUID(),
      organizationId,
      deliveryNoteId,
      productId: line.productId,
      lineId: line.id,
      ordinal: rows.length,
      quantity: a.quantity,
      ...physical,
      expirationDate: physical.expirationDate
        ? new Date(physical.expirationDate + 'T00:00:00Z')
        : null,
      inventoryAllocationId: a.id,
      origin: 'INVENTORY',
      ...provenance,
      preserveOnUnlink:
        command.preserveOnUnlink ??
        old?.preserveOnUnlink ??
        Boolean(command.sourceTraceId || command.scanValue),
    });
  }
  for (const t of line.physicalTraces ?? []) {
    const old = prior(t.id);
    const provenance = await traceCapture(tx, organizationId, line.productId, t, t, old);
    if (!t.lotNumber && !t.expirationDate && !t.serialNumber && !provenance.scannedGtinSnapshot)
      throw new BadRequestException(
        'Completá lote, vencimiento o serie, o quitá el detalle vacío.',
      );
    rows.push({
      id: t.id,
      organizationId,
      deliveryNoteId,
      productId: line.productId,
      lineId: line.id,
      ordinal: rows.length,
      quantity: t.quantity,
      lotNumber: t.lotNumber,
      serialNumber: t.serialNumber,
      expirationDate: t.expirationDate ? new Date(t.expirationDate + 'T00:00:00Z') : null,
      origin: 'DECLARED',
      ...provenance,
      preserveOnUnlink: true,
    });
  }
  if (rows.reduce((s, t) => s + amount(t.quantity.toString()), 0n) > amount(line.quantity))
    throw new BadRequestException('El detalle físico supera la cantidad documental.');
  for (const t of rows) {
    try {
      validQuantity(t.quantity.toString(), unit);
    } catch {
      throw new BadRequestException('Revisá la cantidad y la unidad del detalle físico.');
    }
    if (t.serialNumber) {
      const key = line.productId + ':' + t.serialNumber;
      if (
        !['UNIT', 'PAIR'].includes(unit) ||
        amount(t.quantity.toString()) !== 1000000n ||
        seen.has(key)
      )
        throw new BadRequestException(
          'Cada serie debe aparecer una sola vez y representar una unidad.',
        );
      seen.add(key);
    }
    await tx.deliveryNoteLineTrace.create({ data: t });
  }
}

export async function findTraceHistory(
  tx: Tx,
  organizationId: string,
  criteria: {
    productId: string;
    lotNumber?: string;
    serialNumber?: string;
  },
  excludeDocument?: string,
) {
  const rows = await tx.deliveryNoteLineTrace.findMany({
    where: {
      organizationId,
      ...criteria,
      ...(excludeDocument ? { deliveryNoteId: { not: excludeDocument } } : {}),
      line: { deliveryNote: { status: 'CONFIRMED' } },
    },
    take: 101,
    orderBy: [{ deliveryNoteId: 'asc' }, { id: 'asc' }],
    include: { line: { include: { deliveryNote: true } } },
  });
  return {
    items: rows.slice(0, 100).map((t) => {
      const d = t.line.deliveryNote;
      return {
        traceId: t.id,
        deliveryNoteId: d.id,
        productId: t.productId,
        documentNumber: d.documentPrefix + '-' + d.documentNumber,
        customerName: (d.customerSnapshot as { name: string }).name,
        documentDate: day(d.documentDate)!,
        lotNumber: t.lotNumber,
        serialNumber: t.serialNumber,
        quantity: quantity(amount(t.quantity.toString())),
      };
    }),
    truncated: rows.length > 100,
  };
}

export async function confirmTraceHistory(
  tx: Tx,
  organizationId: string,
  deliveryNoteId: string,
  traces: Trace[],
  reviewed: string[],
) {
  const serials = traces
    .filter((t) => t.serialNumber)
    .sort((a, b) =>
      (a.productId + ':' + a.serialNumber).localeCompare(b.productId + ':' + b.serialNumber),
    );
  const expected = new Set<string>();
  for (const t of serials) {
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`delivery-serial:${organizationId}:${t.productId}:${t.serialNumber}`},0))`;
    const history = await findTraceHistory(
      tx,
      organizationId,
      { productId: t.productId, serialNumber: t.serialNumber! },
      deliveryNoteId,
    );
    if (history.truncated)
      throw new ConflictException(
        'Esta serie tiene demasiados antecedentes. Requiere revisión administrativa.',
      );
    const ids = history.items.map((h) => h.traceId).sort();
    ids.forEach((v) => expected.add(v));
    if (ids.some((id) => !reviewed.includes(id)))
      throw new ConflictException(
        'Esta serie ya figura en un Remito anterior. Revisá los antecedentes y confirmá nuevamente.',
      );
    await tx.deliveryNoteLineTrace.update({
      where: { id: t.id },
      data: { reviewedPriorTraceIds: ids },
    });
  }
  if (reviewed.length !== new Set(reviewed).size || reviewed.some((id) => !expected.has(id)))
    throw new BadRequestException(
      'Los antecedentes revisados no corresponden a las series de este remito.',
    );
}

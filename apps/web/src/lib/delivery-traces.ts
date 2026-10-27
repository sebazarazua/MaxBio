import type { DeliveryNoteCreate, DeliveryNoteView, ScanInterpretation } from '@maxbio/contracts';
import { decimal, scaled } from './delivery-match.ts';
export type DeclaredTrace = NonNullable<
  DeliveryNoteCreate['lines'][number]['physicalTraces']
>[number];
export type Allocation = DeliveryNoteCreate['lines'][number]['allocations'][number];
export function scannedDeclaration(
  scan: ScanInterpretation | undefined,
  scanValue: string,
): DeclaredTrace[] {
  const f = scan?.fields;
  if (!scan?.canApplyPhysicalData || !f || !(f.lotNumber || f.expirationDate || f.serialNumber))
    return [];
  return [
    {
      id: crypto.randomUUID(),
      quantity: '1',
      lotNumber: f.lotNumber ?? null,
      expirationDate: f.expirationDate ?? null,
      serialNumber: f.serialNumber ?? null,
      scannedGtinSnapshot: f.gtin14,
      scanValue,
    },
  ];
}
export function declaredFromView(
  t: DeliveryNoteView['lines'][number]['physicalTraces'][number],
): DeclaredTrace {
  return {
    id: t.id,
    quantity: t.quantity,
    lotNumber: t.lotNumber,
    expirationDate: t.expirationDate,
    serialNumber: t.serialNumber,
    scannedGtinSnapshot: t.scannedGtinSnapshot,
  };
}
// Exact split of a documentary portion, never an addition to the same quantity.
export function splitDeclaration(traces: DeclaredTrace[], id: string, raw: string) {
  const t = traces.find((v) => v.id === id),
    q = scaled(raw),
    total = t && scaled(t.quantity);
  if (!t || q === null || !total || q <= 0n || q > total)
    throw new Error('Revisá la cantidad a vincular.');
  return {
    source: t,
    traces: traces.flatMap((v) =>
      v.id !== id ? [v] : q === total ? [] : [{ ...v, quantity: decimal(total - q) }],
    ),
  };
}

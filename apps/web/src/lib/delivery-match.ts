import type { InventoryPhysicalMatch, ScanInterpretation, UnitOfMeasure } from '@maxbio/contracts';

// Pure helpers for the Remito scanner. The backend match is a proposal; confirmation revalidates.
type Position = InventoryPhysicalMatch['positions'][number];
const SCALE = 1000000n;

// Exact six-decimal arithmetic, like Inventory; null for anything that is not a plain quantity.
export function scaled(value: string): bigint | null {
  const v = value.trim().replace(',', '.');
  if (!/^(0|[1-9][0-9]{0,13})(\.[0-9]{1,6})?$/.test(v)) return null;
  const [whole, fraction = ''] = v.split('.');
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0'));
}
export function decimal(value: bigint) {
  const fraction = (value % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return (value / SCALE).toString() + (fraction ? '.' + fraction : '');
}

// Only exact physical data is a matching criterion. A day-00 expiration is month precision.
export function matchCriteria(scan: ScanInterpretation | undefined) {
  const f = scan?.fields;
  if (!f) return null;
  const criteria = {
    ...(f.serialNumber ? { serialNumber: f.serialNumber } : {}),
    ...(f.lotNumber ? { lotNumber: f.lotNumber } : {}),
    ...(f.expirationDate && f.expiration?.precision === 'DAY'
      ? { expirationDate: f.expirationDate }
      : {}),
  };
  return Object.keys(criteria).length ? criteria : null;
}
export const hasPhysicalData = (scan: ScanInterpretation | undefined) =>
  Boolean(scan?.fields.lotNumber || scan?.fields.expirationDate || scan?.fields.serialNumber);

export function allocatedByPosition(
  lines: Array<{ allocations: Array<{ positionId: string; quantity: string }> }>,
) {
  const allocated = new Map<string, bigint>();
  for (const line of lines)
    for (const a of line.allocations)
      allocated.set(a.positionId, (allocated.get(a.positionId) ?? 0n) + (scaled(a.quantity) ?? 0n));
  return allocated;
}
// What this draft can still propose from a position; other drafts are not reserved or visible.
export function remaining(position: Position, allocated: Map<string, bigint>) {
  if (!position.eligible) return 0n;
  const left = (scaled(position.quantity) ?? 0n) - (allocated.get(position.positionId) ?? 0n);
  return left > 0n ? left : 0n;
}

export type Selection = Record<string, string>;
// Builds the allocations of one new line; a serial always represents exactly one unit.
export function selectionAllocations(
  positions: Position[],
  selection: Selection,
  allocated: Map<string, bigint>,
  unit: UnitOfMeasure,
) {
  const chosen: Array<{ position: Position; quantity: string }> = [];
  let total = 0n;
  for (const [positionId, raw] of Object.entries(selection)) {
    if (!raw.trim()) continue;
    const position = positions.find((p) => p.positionId === positionId);
    const q = scaled(raw);
    if (!position || q === null || q === 0n) return { error: 'Revisá las cantidades elegidas.' };
    if ((['UNIT', 'PAIR'].includes(unit) || position.serialId) && q % SCALE !== 0n)
      return { error: 'Unidades, pares y series se eligen con números enteros.' };
    if (position.serialId && q !== SCALE)
      return { error: 'Cada serie representa una sola unidad.' };
    if (q > remaining(position, allocated))
      return { error: 'Elegiste más de lo disponible en Stock para esa existencia.' };
    total += q;
    chosen.push({ position, quantity: decimal(q) });
  }
  if (!chosen.length)
    return { error: 'Elegí al menos una existencia o agregá sin vincular Stock.' };
  return {
    quantity: decimal(total),
    allocations: chosen.map((c) => ({ positionId: c.position.positionId, quantity: c.quantity })),
    physical: chosen.map(({ position: p, quantity }) => ({
      id: p.positionId,
      positionId: p.positionId,
      quantity,
      location: p.location,
      lotId: p.lotId,
      lotNumber: p.lotNumber,
      expirationDate: p.expirationDate,
      serialId: p.serialId,
      serialNumber: p.serialNumber,
      condition: p.condition,
    })),
  };
}

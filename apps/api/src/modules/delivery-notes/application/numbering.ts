import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@maxbio/database';
type Tx = Prisma.TransactionClient;
export type Numbering = {
  prefix: string;
  nextNumber: bigint;
  numberWidth: number;
  version: number;
};
export const formatNumber = (n: bigint, width: number) => n.toString().padStart(width, '0');
export async function numberingLock(tx: Tx, organizationId: string) {
  // One active prefix per organization. This lock also serializes prefix changes and initialization.
  await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`delivery-numbering:${organizationId}`},0))`;
}
export async function loadNumbering(tx: Tx, organizationId: string): Promise<Numbering | null> {
  const stored = await tx.deliveryNoteNumbering.findUnique({ where: { organizationId } });
  if (stored) return stored;
  const rows = await tx.$queryRaw<
    Array<{ prefix: string; nextNumber: bigint; numberWidth: number }>
  >`
    SELECT "documentPrefix" AS prefix, MAX("documentNumber"::bigint)+1 AS "nextNumber", MAX(length("documentNumber")) AS "numberWidth"
    FROM "DeliveryNote" WHERE "organizationId"=${organizationId}::uuid AND "documentNumber" IS NOT NULL
    AND "documentPrefix"=(SELECT "documentPrefix" FROM "DeliveryNote" WHERE "organizationId"=${organizationId}::uuid
      AND "documentNumber" IS NOT NULL ORDER BY "createdAt" DESC, id DESC LIMIT 1) GROUP BY "documentPrefix"`;
  return rows[0] ? { ...rows[0], version: 0 } : null;
}
export async function availableNumber(tx: Tx, organizationId: string, numbering: Numbering) {
  const { prefix, nextNumber } = numbering;
  // Numeric comparison treats padded historical variants as used too. All statuses participate.
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
    SELECT n FROM (
      SELECT ${nextNumber}::bigint AS n UNION
      SELECT "documentNumber"::bigint+1 FROM "DeliveryNote"
      WHERE "organizationId"=${organizationId}::uuid AND "documentPrefix"=${prefix} AND "documentNumber"::bigint>=${nextNumber}
    ) candidates WHERE n BETWEEN ${nextNumber} AND 999999999999
    AND NOT EXISTS (SELECT 1 FROM "DeliveryNote" WHERE "organizationId"=${organizationId}::uuid
      AND "documentPrefix"=${prefix} AND "documentNumber"::bigint=n)
    ORDER BY n LIMIT 1`;
  return rows[0]?.n ?? null;
}
export async function numberingView(tx: Tx, organizationId: string, state: Numbering | null) {
  const free = state ? await availableNumber(tx, organizationId, state) : null;
  const suggestedNumber = state && free !== null ? formatNumber(free, state.numberWidth) : null;
  return {
    configured: Boolean(state),
    prefix: state?.prefix ?? null,
    nextNumber: state ? formatNumber(state.nextNumber, state.numberWidth) : null,
    numberWidth: state?.numberWidth ?? null,
    version: state?.version ?? 0,
    suggestedNumber,
    displayNumber: suggestedNumber && state ? state.prefix + '-' + suggestedNumber : null,
  };
}
export async function allocateNumber(tx: Tx, organizationId: string) {
  // Caller holds numberingLock, before acquiring product/customer/document locks.
  const state = await loadNumbering(tx, organizationId);
  if (!state)
    throw new ConflictException(
      'Un administrador debe configurar la numeración de remitos una sola vez.',
    );
  const n = await availableNumber(tx, organizationId, state);
  if (n === null)
    throw new ConflictException(
      'Se agotó la numeración de este talonario. Pedí a un administrador que lo cambie.',
    );
  const documentNumber = formatNumber(n, state.numberWidth);
  await tx.deliveryNoteNumbering.upsert({
    where: { organizationId },
    create: {
      organizationId,
      prefix: state.prefix,
      nextNumber: n + 1n,
      numberWidth: Math.max(state.numberWidth, documentNumber.length),
    },
    update: {
      nextNumber: n + 1n,
      numberWidth: Math.max(state.numberWidth, documentNumber.length),
      version: { increment: 1 },
    },
  });
  return { documentPrefix: state.prefix, documentNumber };
}

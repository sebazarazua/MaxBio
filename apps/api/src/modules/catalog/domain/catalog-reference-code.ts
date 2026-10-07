export function catalogPrefix(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1)
    throw new RangeError('Invalid catalog ordinal');
  let prefix = '';
  while (ordinal > 0) {
    ordinal--;
    prefix = String.fromCharCode(65 + (ordinal % 26)) + prefix;
    ordinal = Math.floor(ordinal / 26);
  }
  return prefix;
}
export function referenceCode(prefix: string, sequence: number): string {
  if (
    !/^[A-Z]{1,32}$/.test(prefix) ||
    !Number.isInteger(sequence) ||
    sequence < 1 ||
    sequence > 999999
  )
    throw new RangeError('Catalog reference sequence exhausted');
  return prefix + String(sequence).padStart(6, '0');
}

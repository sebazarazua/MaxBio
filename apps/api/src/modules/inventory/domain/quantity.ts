// Exact fixed scale arithmetic. PostgreSQL stores NUMERIC(20,6); no IEEE-754 amounts.
export const SCALE = 1000000n;
export const MAX_AMOUNT = 99999999999999999999n;
export function amount(value: string): bigint {
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value))
    throw new Error('Cantidad decimal inválida.');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const result = BigInt(whole!) * SCALE + BigInt(fraction.padEnd(6, '0'));
  return negative ? -result : result;
}
export function quantity(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const positive = value < 0n ? -value : value;
  const fraction = (positive % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return sign + (positive / SCALE).toString() + (fraction ? '.' + fraction : '');
}
export function validQuantity(value: string, unit: string, allowZero = false) {
  const result = amount(value);
  if (result < 0n || (!allowZero && result === 0n) || result > MAX_AMOUNT)
    throw new Error('Revisá la cantidad; debe ser válida y no negativa.');
  if (['UNIT', 'PAIR'].includes(unit) && result % SCALE !== 0n)
    throw new Error('Unidades y pares deben ser números enteros.');
  return result;
}
export function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export const EXPIRING_SOON_DAYS = 30;

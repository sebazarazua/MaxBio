import type { CatalogCommercialOptions } from '@maxbio/contracts';
import { CatalogRuleError } from './identifiers.js';

export const defaultCommercial: CatalogCommercialOptions = {
  defaultCurrency: 'ARS',
  currencyConfirmed: true,
  priceIncludesVat: 'UNKNOWN',
  decimalSeparator: 'AUTO',
};
// Parse decimal strings exactly; the separate ceilingPrice step normalizes prices.
export function commercialDecimal(
  input: string,
  scale: number,
  separator: CatalogCommercialOptions['decimalSeparator'] = 'AUTO',
  numeric = false,
): string {
  let value = input
    .trim()
    .replace(/^(?:ARS|USD|EUR|US\$|\$)\s*/i, '')
    .replace(/%$/, '')
    .trim();
  if (/\s/.test(value)) {
    if (!/^[0-9]{1,3}(?:[ \u00a0\u202f][0-9]{3})+(?:[.,][0-9]+)?$/.test(value))
      throw new CatalogRuleError('Revisá la agrupación del número declarado.');
    value = value.replace(/[ \u00a0\u202f]/g, '');
  }
  if (numeric && /e/i.test(value)) {
    const exponent = /^([0-9]+)(?:\.([0-9]+))?[eE]([+-]?[0-9]+)$/.exec(value);
    if (!exponent || Math.abs(Number(exponent[3])) > 20)
      throw new CatalogRuleError('Revisá el número declarado.');
    const digits = exponent[1]! + (exponent[2] ?? '');
    const point = exponent[1]!.length + Number(exponent[3]);
    value =
      point <= 0
        ? '0.' + '0'.repeat(-point) + digits
        : point >= digits.length
          ? digits + '0'.repeat(point - digits.length)
          : digits.slice(0, point) + '.' + digits.slice(point);
  }
  const commas = (value.match(/,/g) ?? []).length;
  const dots = (value.match(/\./g) ?? []).length;
  const selected = numeric ? 'DOT' : separator;
  if (commas || dots) {
    let decimal = selected === 'COMMA' ? ',' : selected === 'DOT' ? '.' : '';
    if (!decimal) {
      if (commas && dots) decimal = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
      else {
        const mark = commas ? ',' : '.';
        if (value.split(mark).length !== 2 || value.split(mark)[1]!.length === 3)
          throw new CatalogRuleError(
            'El separador decimal es ambiguo. Revisá el número en el archivo.',
          );
        decimal = mark;
      }
    }
    const group = decimal === ',' ? '.' : ',';
    const [whole, fraction] = value.split(decimal);
    if (
      value.split(decimal).length > 2 ||
      (whole!.includes(group) && !new RegExp(`^[0-9]{1,3}(?:\\${group}[0-9]{3})+$`).test(whole!))
    )
      throw new CatalogRuleError('Revisá los separadores del número declarado.');
    value = whole!.split(group).join('') + (fraction === undefined ? '' : '.' + fraction);
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value))
    throw new CatalogRuleError('Revisá el número declarado; debe ser no negativo.');
  const [whole, fraction = ''] = value.split('.');
  const normalizedWhole = whole!.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  if (normalizedWhole.length > 14 || normalizedFraction.length > scale)
    throw new CatalogRuleError(
      `El número excede la precisión permitida (hasta ${scale} decimales).`,
    );
  return normalizedWhole + (normalizedFraction ? '.' + normalizedFraction : '');
}
export function commercialCurrency(value: string): string | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized) return null;
  const aliases: Record<string, string> = {
    PESOS: 'ARS',
    'PESOS ARGENTINOS': 'ARS',
    DOLARES: 'USD',
    DÓLARES: 'USD',
    US$: 'USD',
    EUROS: 'EUR',
  };
  const code = aliases[normalized] ?? normalized;
  if (!/^[A-Z]{3}$/.test(code))
    throw new CatalogRuleError(
      'Revisá la moneda: usá un código como ARS o USD. El símbolo $ solo no determina la moneda.',
    );
  return code;
}
export function embeddedCurrency(value: string | null): string | null {
  const match = /^(ARS|USD|EUR|US\$)\s*/i.exec(value?.trim() ?? '');
  return match ? (match[1]!.toUpperCase() === 'US$' ? 'USD' : match[1]!.toUpperCase()) : null;
}

// Integer cents and discarded digits: no binary floating point, no rounding half up.
export function ceilingPrice(value: string): string {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value))
    throw new CatalogRuleError('El precio debe ser no negativo.');
  const [whole, fraction = ''] = value.split('.');
  const cents =
    BigInt(whole!) * 100n +
    BigInt(fraction.slice(0, 2).padEnd(2, '0')) +
    (/[1-9]/.test(fraction.slice(2)) ? 1n : 0n);
  if (cents >= 100000000000000000n)
    throw new CatalogRuleError('El precio excede la precisión permitida.');
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

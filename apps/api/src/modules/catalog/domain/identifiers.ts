import type { IdentifierInput } from '@maxbio/contracts';

export class CatalogRuleError extends Error {}

export function normalizeIdentifier(input: IdentifierInput) {
  const value = input.value.trim();
  if (
    !value ||
    value.length > 128 ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new CatalogRuleError('Revisá el identificador ingresado.');
  if (input.kind === 'GTIN') {
    if (!/^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(value))
      throw new CatalogRuleError(
        'El GTIN debe tener 8, 12, 13 o 14 dígitos, sin espacios ni guiones.',
      );
    let sum = 0;
    for (
      let index = value.length - 2, weight = 3;
      index >= 0;
      index--, weight = weight === 3 ? 1 : 3
    )
      sum += Number(value[index]) * weight;
    if ((10 - (sum % 10)) % 10 !== Number(value.at(-1)))
      throw new CatalogRuleError('El dígito de control del GTIN no es válido. Revisá el código.');
    return { kind: input.kind, value, normalizedValue: value.padStart(14, '0') };
  }
  if (input.kind === 'INTERNAL_BARCODE' && !/^MB-[A-Z0-9][A-Z0-9._-]{0,60}$/.test(value))
    throw new CatalogRuleError(
      'El código de barras interno debe comenzar con MB- y usar letras mayúsculas, números, punto, guion o guion bajo.',
    );
  return { kind: input.kind, value, normalizedValue: value };
}

export function normalizeName(input: string) {
  const name = input.trim().replace(/\s+/gu, ' ');
  return { name, normalizedName: name.toLowerCase() };
}

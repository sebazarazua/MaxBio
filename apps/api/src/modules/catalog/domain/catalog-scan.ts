import type { ScanInput, ScanIdentity } from '@maxbio/contracts';
import { normalizeIdentifier, CatalogRuleError } from './identifiers.js';

// AUTO never turns a failed GTIN checksum into a supplier barcode.
export function parseScan(
  input: ScanInput,
): ScanIdentity | { status: 'INVALID' | 'UNSUPPORTED'; message: string } {
  const value = input.value.trim();
  if (
    /\((?:01|10|17|21)\)|^\](?:C1|d2|Q3)/.test(value) ||
    value.includes(String.fromCharCode(29)) ||
    /^01[0-9]{14}(?:10|17|21)/.test(value)
  )
    return {
      status: 'UNSUPPORTED',
      message:
        'Lectura GS1 compuesta no soportada. Ingresá solamente el GTIN visible; los datos físicos se tratarán en un futuro incremento.',
    };
  try {
    if (input.namespace === 'INTERNAL_CODE') {
      return { ...normalizeIdentifier({ kind: 'INTERNAL_CODE', value }), supplierId: null };
    }
    if (/^[0-9]+$/.test(value) && [8, 12, 13, 14].includes(value.length))
      return { ...normalizeIdentifier({ kind: 'GTIN', value }), supplierId: null };
    if (value.startsWith('MB-'))
      return { ...normalizeIdentifier({ kind: 'INTERNAL_BARCODE', value }), supplierId: null };
    const normalized = normalizeIdentifier({ kind: 'INTERNAL_CODE', value });
    return {
      kind: 'SUPPLIER_BARCODE',
      value: normalized.value,
      normalizedValue: normalized.normalizedValue,
      supplierId: input.supplierId ?? null,
    };
  } catch (error) {
    if (error instanceof CatalogRuleError) return { status: 'INVALID', message: error.message };
    throw error;
  }
}

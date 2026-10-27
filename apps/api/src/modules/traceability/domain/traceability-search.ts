import { canonicalGtin, hasValidGtinCheckDigit } from '../../../common/domain/scanning/gtin.js';

// Every way a typed number can match a stored Remito number part (1–12 digits, zeros kept):
// "4122", "04122" and "00004122" all reach the stored "00004122". Bounded to 12 values.
export function numberPartCandidates(digits: string): string[] {
  if (!/^[0-9]{1,12}$/.test(digits)) return [];
  const bare = digits.replace(/^0+(?=.)/, '');
  return Array.from({ length: 13 - bare.length }, (_, i) => bare.padStart(bare.length + i, '0'));
}

// "00001-00004122" → prefix + number; "4122" → number with any prefix; otherwise not a Remito.
export function deliveryNoteNumberSearch(term: string) {
  const parts = term.match(/^([0-9]{1,12})-([0-9]{1,12})$/);
  if (parts)
    return {
      prefixes: numberPartCandidates(parts[1]!),
      numbers: numberPartCandidates(parts[2]!),
    };
  if (/^[0-9]{1,12}$/.test(term)) return { prefixes: null, numbers: numberPartCandidates(term) };
  return null;
}

// Exact GTIN only (8/12/13/14 digits with a valid check digit), canonical GTIN-14. Never fuzzy.
export function gtinSearch(term: string) {
  return /^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(term) && hasValidGtinCheckDigit(term)
    ? canonicalGtin(term)
    : null;
}

// Pure helpers for Facturación V1. Money travels as exact decimal strings ("1234.50"); the
// browser only previews with the shared contract arithmetic, the API recalculates.

// "1234.5" → "$ 1.234,50". No float conversion.
export function formatMoney(value: string) {
  const [whole = '0', fraction = ''] = value.split('.');
  return '$ ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + fraction.padEnd(2, '0');
}

// Accepts "1234,56", "1.234,56", "1234.56" or "1234". Returns the API string or null.
export function parseMoneyInput(input: string): string | null {
  const text = input.trim().replace(/^\$\s*/, '');
  if (!text) return null;
  let normalized = text;
  if (text.includes(',')) {
    if (!/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(text)) return null;
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) normalized = text.replace(/\./g, '');
  if (!/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(normalized.replace(/^0+(?=\d)/, '')))
    return null;
  return normalized.replace(/^0+(?=\d)/, '');
}

// API money "1234.50" → editable text "1234,50".
export const moneyInputText = (value: string | null) => (value ? value.replace('.', ',') : '');

export type PendingSelection = { customerId: string; customerName: string; ids: string[] };
// A selection never mixes customers: selecting a Remito of another customer is refused.
export function toggleSelection(
  selection: PendingSelection | null,
  note: { id: string; customer: { id: string; name: string } },
): PendingSelection | null | 'OTHER_CUSTOMER' {
  if (selection && selection.customerId !== note.customer.id) return 'OTHER_CUSTOMER';
  const ids = selection?.ids ?? [];
  const next = ids.includes(note.id) ? ids.filter((id) => id !== note.id) : [...ids, note.id];
  return next.length
    ? { customerId: note.customer.id, customerName: note.customer.name, ids: next }
    : null;
}

export const internalReference = (id: string) => 'Ref. interna ' + id.slice(0, 8).toUpperCase();

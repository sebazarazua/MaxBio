import { searchTokens } from '../../catalog/domain/catalog-search.js';

export function customerSearchTokens(query: string) {
  // Only complete human CUIT patterns are rewritten; names and phones stay text.
  const normalized = query.replace(
    /(?<![\p{L}\p{N}])[0-9]{2}\s*-\s*[0-9]{8}\s*-\s*[0-9](?![\p{L}\p{N}])/gu,
    (value) => value.replace(/[\s-]/g, ''),
  );
  return searchTokens(normalized);
}

// Every token must match a field, independently of order. Documents are folded by
// PostgreSQL unaccent on write. Bound token count and escape LIKE metacharacters.
export function searchTokens(query: string, foldAccents = true): string[] {
  const text = foldAccents ? query.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : query;
  return [...new Set(text.trim().toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 20);
}
export const textContains = (query: string) => ({
  contains: query.replace(/[\\%_]/g, '\\$&'),
  mode: 'insensitive' as const,
});

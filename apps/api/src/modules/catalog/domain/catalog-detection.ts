import {
  catalogMappingFields,
  type CatalogColumnMapping,
  type CatalogSheetInspection,
} from '@maxbio/contracts';
import type { CatalogImportProfile, IntermediateTable } from './catalog-table.js';
import { defaultCommercial } from './catalog-commercial.js';
import { createHash } from 'node:crypto';

export const normalizeHeader = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
const aliases: Record<keyof CatalogColumnMapping, string[]> = {
  supplierCode: [
    'codigo',
    'codigoproveedor',
    'cod',
    'sku',
    'art',
    'articulo',
    'ref',
    'referencia',
    'code',
  ],
  description: [
    'descripcion',
    'producto',
    'detalle',
    'articulodescripcion',
    'nombre',
    'description',
    'product',
    'name',
  ],
  alternateSupplierCode: ['codext', 'codigoexterno', 'codigoalternativo', 'alternatecode'],
  brandText: ['marca', 'marcacomercial', 'brand'],
  manufacturerText: ['fabricante', 'laboratorio', 'manufacturer'],
  modelText: ['modelo', 'model'],
  categoryText: ['categoria', 'rubro', 'familia', 'category'],
  unitText: ['unidad', 'um', 'unidaddemedida', 'unit'],
  presentationText: ['presentacion', 'empaque', 'presentation', 'pack'],
  reportedGtin: ['gtin', 'ean', 'upc', 'codigodebarras', 'barcode'],
  price: [
    'precio',
    'punitario',
    'preciounitario',
    'neto',
    'valor',
    'price',
    'unitprice',
    'precioconiva',
    'preciosiniva',
  ],
  vatRate: ['iva', 'tiva', 'alicuota', 'vatrate', 'vat'],
  currency: ['moneda', 'currency', 'divisa'],
};

// Exact legacy aliases remain authoritative. For longer headings, recognize a
// bounded vocabulary and whole-word grammar; never substring/fuzzy similarity.
const headingWords: Record<string, string> = {
  cod: 'codigo',
  code: 'codigo',
  art: 'producto',
  articulo: 'producto',
  product: 'producto',
  ref: 'referencia',
  nro: 'numero',
  num: 'numero',
  description: 'descripcion',
  name: 'nombre',
  brand: 'marca',
  laboratorio: 'fabricante',
  manufacturer: 'fabricante',
  model: 'modelo',
  rubro: 'categoria',
  familia: 'categoria',
  category: 'categoria',
  pack: 'presentacion',
  empaque: 'presentacion',
  price: 'precio',
  unit: 'unitario',
  ean: 'gtin',
  upc: 'gtin',
  barcode: 'gtin',
  vat: 'iva',
  t: 'tasa',
};
export function normalizeHeadingWords(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((word) => word && !['de', 'del', 'la', 'el', 'y'].includes(word))
    .map((word) => headingWords[word] ?? word);
}
function headingFields(header: string): Array<keyof CatalogColumnMapping> {
  const normalized = normalizeHeader(header);
  const exact = (Object.keys(aliases) as Array<keyof CatalogColumnMapping>).filter((field) =>
    aliases[field].some(
      (alias) => normalized === alias || new RegExp(`^${alias}[0-9]+$`).test(normalized),
    ),
  );
  if (exact.length) return exact;
  const words = normalizeHeadingWords(header);
  // Numbered variants also compete: "Precio de lista 2" cannot be picked over
  // "Precio de lista". Numeric GTIN forms are already covered by exact aliases.
  if (/^[0-9]+$/.test(words.at(-1) ?? '')) words.pop();
  const only = (...allowed: string[]) =>
    words.length > 0 && words.every((word) => allowed.includes(word));
  const has = (...anchors: string[]) => words.some((word) => anchors.includes(word));
  if (only('gtin') || (has('codigo') && has('barras') && only('codigo', 'barras')))
    return ['reportedGtin'];
  if (
    has('codigo') &&
    has('alternativo', 'externo') &&
    only('codigo', 'alternativo', 'externo', 'producto', 'proveedor')
  )
    return ['alternateSupplierCode'];
  if (
    (has('codigo', 'referencia') || (has('numero') && has('producto'))) &&
    only('codigo', 'referencia', 'numero', 'interno', 'producto', 'proveedor')
  )
    return ['supplierCode'];
  if (
    has('descripcion', 'detalle', 'nombre') &&
    only('descripcion', 'detalle', 'nombre', 'producto')
  )
    return ['description'];
  if (
    has('precio', 'valor', 'importe') &&
    only('precio', 'valor', 'importe', 'unitario', 'lista', 'neto')
  )
    return ['price'];
  if (
    has('precio') &&
    has('con', 'sin') &&
    has('iva') &&
    only('precio', 'unitario', 'lista', 'con', 'sin', 'iva')
  ) {
    // Contradictory commercial declarations must not select a price column.
    return has('con') && has('sin') ? [] : ['price'];
  }
  if (has('iva') && only('iva', 'alicuota', 'tasa', 'porcentaje')) return ['vatRate'];
  if (has('unidad') && only('unidad', 'medida')) return ['unitText'];
  for (const [anchor, field] of [
    ['marca', 'brandText'],
    ['fabricante', 'manufacturerText'],
    ['modelo', 'modelText'],
    ['categoria', 'categoryText'],
    ['presentacion', 'presentationText'],
  ] as const)
    if (has(anchor) && only(anchor, 'producto')) return [field];
  return [];
}
export function detectMapping(headers: string[], sample: string[][] = []) {
  const mapping = Object.fromEntries(
    Object.keys(catalogMappingFields).map((key) => [key, null]),
  ) as Record<keyof CatalogColumnMapping, number | null>;
  const confidence = Object.fromEntries(
    Object.keys(catalogMappingFields).map((key) => [key, 'MISSING']),
  ) as CatalogSheetInspection['confidence'];
  const used = new Set<number>();
  const classified = headers.map(headingFields);
  for (const field of Object.keys(aliases) as Array<keyof CatalogColumnMapping>) {
    const candidates = headers.flatMap((_, index) => {
      return classified[index]!.includes(field) ? [index] : [];
    });
    if (candidates.length > 1) {
      confidence[field] = 'REVIEW';
      continue;
    }
    if (candidates.length === 1 && !used.has(candidates[0]!)) {
      const index = candidates[0]!;
      mapping[field] = index;
      used.add(index);
      // A unique explicit heading identifies the column. Invalid cell values
      // belong in row validation (especially negative prices), not silently null.
      confidence[field] = 'HIGH';
    }
  }
  // Content may suggest essential fields for unknown headings, always requiring review.
  for (const field of ['supplierCode', 'description', 'reportedGtin', 'currency'] as const) {
    if (mapping[field] !== null || confidence[field] === 'REVIEW') continue;
    const candidates = headers.flatMap((_, index) => {
      if (used.has(index)) return [];
      const values = sample.map((row) => row[index]?.trim() ?? '').filter(Boolean);
      if (values.length < 2) return [];
      const ratio =
        values.filter((value) =>
          field === 'supplierCode'
            ? /^[\w./-]{1,128}$/.test(value) && /\d/.test(value)
            : field === 'description'
              ? value.length > 8 && /[a-zA-Z]/.test(value) && /\s/.test(value)
              : field === 'currency'
                ? /^(ARS|USD|EUR|BRL|UYU)$/.test(value)
                : /^(\d{8}|\d{12,14})$/.test(value),
        ).length / values.length;
      return ratio >= 0.9 ? [index] : [];
    });
    if (candidates.length === 1) {
      mapping[field] = candidates[0]!;
      confidence[field] = 'REVIEW';
      used.add(candidates[0]!);
    }
  }
  return { mapping, confidence };
}
export const suggestMapping = (headers: string[]) => detectMapping(headers).mapping;
export const formatFingerprint = (headers: string[]) =>
  createHash('sha256')
    .update(JSON.stringify({ version: 3, headers: headers.map(normalizeHeader) }))
    .digest('hex');
export function inspectSheet(
  table: IntermediateTable,
  headerRow?: number,
  profiles: CatalogImportProfile[] = [],
): CatalogSheetInspection {
  const width = Math.max(0, ...table.rows.map((row) => row.length));
  const candidate = (index: number) => {
    const headers = Array.from({ length: width }, (_, column) => table.rows[index]?.[column] ?? '');
    const sample = table.rows.slice(index + 1, index + 21);
    const detected = detectMapping(headers, sample);
    const required = ['supplierCode', 'description', 'reportedGtin'].some(
      (key) => detected.confidence[key as keyof CatalogColumnMapping] === 'HIGH',
    );
    const consistent = required
      ? sample.filter((row) =>
          ['supplierCode', 'description', 'reportedGtin'].some((key) => {
            const column = detected.mapping[key as keyof CatalogColumnMapping];
            return column !== null && row[column]?.trim();
          }),
        ).length
      : 0;
    const known = Object.values(detected.confidence).filter((value) => value === 'HIGH').length;
    return {
      index,
      headers,
      ...detected,
      consistent,
      score: (required ? 10 : 0) + known * 3 + consistent / 20,
    };
  };
  const candidates = table.rows
    .slice(0, 20)
    .map((_, index) => candidate(index))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected =
    headerRow === undefined ? (candidates[0] ?? candidate(0)) : candidate(headerRow - 1);
  const fingerprint = formatFingerprint(selected.headers);
  const competingTable =
    headerRow === undefined &&
    candidates.some(
      (candidate) =>
        candidate.index !== selected.index &&
        candidate.consistent > 0 &&
        candidate.score >= selected.score - 1 &&
        ['supplierCode', 'description', 'reportedGtin'].some(
          (key) => candidate.confidence[key as keyof CatalogColumnMapping] === 'HIGH',
        ) &&
        formatFingerprint(candidate.headers) !== fingerprint,
    );
  const profile = profiles.find(
    (item) =>
      item.fingerprint === fingerprint &&
      item.headers.length === width &&
      Object.entries(item.mapping).every(
        ([field, column]) =>
          column === selected.mapping[field as keyof CatalogColumnMapping] &&
          (column === null || column < width),
      ),
  );
  const mapping = { ...(profile?.mapping ?? selected.mapping) };
  const confidence = selected.confidence;
  // An uncertain optional column is omitted, never delegated to the employee.
  for (const key of Object.keys(mapping) as Array<keyof CatalogColumnMapping>)
    if (confidence[key] !== 'HIGH') mapping[key] = null;
  const high =
    !competingTable &&
    ['supplierCode', 'description', 'reportedGtin'].some(
      (key) =>
        mapping[key as keyof CatalogColumnMapping] !== null &&
        confidence[key as keyof CatalogColumnMapping] === 'HIGH',
    ) &&
    table.rows.slice(selected.index + 1, selected.index + 21).some((row) =>
      ['supplierCode', 'description', 'reportedGtin'].some((key) => {
        const column = mapping[key as keyof CatalogColumnMapping];
        return column !== null && row[column]?.trim();
      }),
    );
  const declarations = [...table.rows.slice(0, selected.index).flat(), ...selected.headers]
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const withoutVat = /\bsin\s+iva\b/.test(declarations),
    withVat = /\bcon\s+iva\b/.test(declarations);
  const includes = withoutVat && !withVat ? 'NO' : withVat && !withoutVat ? 'YES' : 'UNKNOWN';
  const currencies = (['ARS', 'USD', 'EUR', 'BRL', 'UYU'] as const).filter((code) =>
    new RegExp(`\\b${code}\\b`, 'i').test(declarations),
  );
  if (/\bdolares\b|us\$/.test(declarations) && !currencies.includes('USD')) currencies.push('USD');
  const declaredCurrency = currencies.length === 1 ? currencies[0] : null;
  return {
    name: table.name,
    rowCount: Math.max(0, table.rows.length - selected.index - 1),
    headerRow: selected.index + 1,
    headers: selected.headers,
    sample: table.rows.slice(0, 20),
    suggestedMapping: mapping,
    confidence,
    tableConfidence: high ? 'HIGH' : 'REVIEW',
    fingerprint,
    profileApplied: Boolean(profile),
    commercial: {
      ...(profile?.commercial ?? defaultCommercial),
      defaultCurrency: declaredCurrency ?? 'ARS',
      currencyConfirmed: true,
      priceIncludesVat: includes,
    },
    warnings: [
      ...(table.warnings ?? []),
      ...Object.entries(confidence)
        .filter(([, value]) => value === 'REVIEW')
        .map(
          ([field]) =>
            `No se pudo reconocer ${catalogMappingFields[field as keyof CatalogColumnMapping]} con seguridad; queda sin informar.`,
        ),
      ...(withVat && withoutVat
        ? ['Hay declaraciones contradictorias de IVA incluido; conservamos Desconocido.']
        : []),
      ...(competingTable
        ? [
            'Hay más de una tabla posible y no pudimos distinguir la lista con suficiente seguridad.',
          ]
        : []),
    ],
  };
}
export function suggestSheet(
  sheets: CatalogSheetInspection[],
  profiles: CatalogImportProfile[] = [],
): string | null {
  const candidates = sheets
    .filter((sheet) => sheet.tableConfidence === 'HIGH')
    .sort((a, b) => b.rowCount - a.rowCount);
  const remembered = candidates.filter((sheet) =>
    profiles.some(
      (profile) => profile.fingerprint === sheet.fingerprint && profile.sheetName === sheet.name,
    ),
  );
  if (remembered.length === 1) return remembered[0]!.name;
  if (
    !candidates.length ||
    (candidates[1] && candidates[1].rowCount >= candidates[0]!.rowCount * 0.8)
  )
    return null;
  return candidates[0]!.name;
}

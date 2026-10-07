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
  presentationText: ['presentacion', 'empaque', 'presentation', 'pack'],
  reportedGtin: ['gtin', 'ean', 'upc', 'codigodebarras', 'barcode'],
  price: ['precio', 'punitario', 'preciounitario', 'neto', 'valor', 'price', 'unitprice'],
  vatRate: ['iva', 'tiva', 'alicuota', 'vatrate', 'vat'],
  currency: ['moneda', 'currency', 'divisa'],
};
export function detectMapping(headers: string[], sample: string[][] = []) {
  const mapping = Object.fromEntries(
    Object.keys(catalogMappingFields).map((key) => [key, null]),
  ) as Record<keyof CatalogColumnMapping, number | null>;
  const confidence = Object.fromEntries(
    Object.keys(catalogMappingFields).map((key) => [key, 'MISSING']),
  ) as CatalogSheetInspection['confidence'];
  const used = new Set<number>();
  for (const field of Object.keys(aliases) as Array<keyof CatalogColumnMapping>) {
    const candidates = headers.flatMap((header, index) => {
      const normalized = normalizeHeader(header);
      return aliases[field].some(
        (alias) => normalized === alias || new RegExp(`^${alias}[0-9]+$`).test(normalized),
      )
        ? [index]
        : [];
    });
    if (candidates.length > 1) {
      confidence[field] = 'REVIEW';
      continue;
    }
    if (candidates.length === 1 && !used.has(candidates[0]!)) {
      const index = candidates[0]!;
      mapping[field] = index;
      used.add(index);
      const values = sample.map((row) => row[index]?.trim() ?? '').filter(Boolean);
      const consistent =
        !values.length ||
        values.filter((value) =>
          field === 'price' || field === 'vatRate'
            ? /^[\d.,\s$%]+$/.test(value)
            : field === 'currency'
              ? /^[A-Za-z]{3}$/.test(value)
              : field === 'supplierCode'
                ? value.length <= 128 && !/\s/.test(value)
                : true,
        ).length /
          values.length >=
          0.7;
      confidence[field] = consistent ? 'HIGH' : 'REVIEW';
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
    .update(JSON.stringify({ version: 2, headers: headers.map(normalizeHeader) }))
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
    const required =
      detected.mapping.supplierCode !== null && detected.mapping.description !== null;
    const consistent = required
      ? sample.filter(
          (row) =>
            row[detected.mapping.supplierCode!]?.trim() &&
            row[detected.mapping.description!]?.trim(),
        ).length
      : 0;
    const known = Object.values(detected.confidence).filter((value) => value === 'HIGH').length;
    return {
      index,
      headers,
      ...detected,
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
        candidate.score >= selected.score - 1 &&
        candidate.mapping.supplierCode !== null &&
        candidate.mapping.description !== null &&
        formatFingerprint(candidate.headers) !== fingerprint,
    );
  const profile = profiles.find(
    (item) =>
      item.fingerprint === fingerprint &&
      item.headers.length === width &&
      Object.values(item.mapping).every((column) => column === null || column < width),
  );
  const mapping = profile?.mapping ?? selected.mapping;
  const confidence = profile
    ? (Object.fromEntries(
        Object.entries(mapping).map(([key, index]) => [key, index === null ? 'MISSING' : 'HIGH']),
      ) as CatalogSheetInspection['confidence'])
    : selected.confidence;
  const high =
    !competingTable &&
    mapping.supplierCode !== null &&
    mapping.description !== null &&
    confidence.supplierCode === 'HIGH' &&
    confidence.description === 'HIGH' &&
    table.rows
      .slice(selected.index + 1, selected.index + 21)
      .some((row) => row[mapping.supplierCode!]?.trim() && row[mapping.description!]?.trim());
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
    commercial: profile?.commercial ?? { ...defaultCommercial },
    warnings: [
      ...(table.warnings ?? []),
      ...(competingTable
        ? ['Hay más de una tabla posible. Revisá el encabezado y las columnas antes de continuar.']
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

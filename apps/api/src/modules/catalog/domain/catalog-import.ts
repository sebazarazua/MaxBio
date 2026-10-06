import { createHash } from 'node:crypto';
import type {
  CatalogColumnMapping,
  CatalogImportSummary,
  SupplierCatalogData,
} from '@maxbio/contracts';
import { catalogMappingFields, supplierCatalogLimits } from '@maxbio/contracts';
import { normalizeIdentifier, CatalogRuleError } from './identifiers.js';

function canonical(input: unknown): unknown {
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map(canonical);
  if (input && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return input;
}
export const digest = (input: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
export interface CatalogSheet {
  name: string;
  rows: string[][];
}
export interface ReferenceRecord extends SupplierCatalogData {
  id: string;
  version: number;
  archivedAt: Date | null;
  missingFromLatestCompleteListAt: Date | null;
}
export interface PlannedRow {
  rowNumber: number;
  outcome: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'DUPLICATE' | 'EMPTY' | 'ERROR' | 'CONFLICT';
  itemId: string | null;
  supplierCode: string | null;
  data: SupplierCatalogData | null;
  messages: string[];
}
const maximum = {
  supplierCode: 128,
  description: 1000,
  brandText: 160,
  presentationText: 200,
  reportedGtin: 128,
};
export function validateReference(fields: Omit<SupplierCatalogData, 'normalizedReportedGtin'>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [field, label] of Object.entries(catalogMappingFields)) {
    const value = fields[field as keyof typeof fields];
    if ((field === 'supplierCode' || field === 'description') && !value)
      errors.push(`Falta ${label === 'descripción' ? 'la' : 'el'} ${label}.`);
    if (value && value.length > maximum[field as keyof typeof maximum])
      errors.push(
        `El campo ${label} admite hasta ${maximum[field as keyof typeof maximum]} caracteres.`,
      );
    if (
      value &&
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      errors.push(`El campo ${label} contiene caracteres de control. Corregilo en el archivo.`);
  }
  let normalizedReportedGtin: string | null = null;
  if (fields.reportedGtin && fields.reportedGtin.length <= 128) {
    try {
      normalizedReportedGtin = normalizeIdentifier({
        kind: 'GTIN',
        value: fields.reportedGtin,
      }).normalizedValue;
    } catch (error) {
      if (!(error instanceof CatalogRuleError)) throw error;
      warnings.push(
        'GTIN informado inválido: conservamos el texto como declaración del proveedor.',
      );
    }
  }
  return { data: { ...fields, normalizedReportedGtin }, errors, warnings };
}
export function referenceData(row: SupplierCatalogData): SupplierCatalogData {
  return {
    supplierCode: row.supplierCode,
    description: row.description,
    brandText: row.brandText,
    presentationText: row.presentationText,
    reportedGtin: row.reportedGtin,
    normalizedReportedGtin: row.normalizedReportedGtin,
  };
}
export function catalogFingerprint(records: ReferenceRecord[], supplierVersion: number) {
  return digest({
    supplierVersion,
    records: [...records]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        version: row.version,
        data: referenceData(row),
        archivedAt: row.archivedAt,
        missing: row.missingFromLatestCompleteListAt,
      })),
  });
}
export function planImport(
  sheet: CatalogSheet,
  headerRow: number,
  mapping: CatalogColumnMapping,
  existing: ReferenceRecord[],
  mode: 'PARTIAL' | 'COMPLETE',
) {
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  if (Object.values(mapping).some((index) => index !== null && index >= width))
    throw new CatalogRuleError('Elegí columnas que existan en la hoja seleccionada.');
  if (headerRow > sheet.rows.length)
    throw new CatalogRuleError('Elegí la fila que contiene los encabezados.');
  if (sheet.rows.length - headerRow > supplierCatalogLimits.rows)
    throw new CatalogRuleError('La lista admite hasta 10.000 filas de artículos.');
  const byCode = new Map(existing.map((row) => [row.supplierCode, row]));
  const groups = new Map<string, { row: PlannedRow; signature: string }[]>();
  const rows: PlannedRow[] = sheet.rows.slice(headerRow).map((cells, index) => {
    const row: PlannedRow = {
      rowNumber: headerRow + index + 1,
      outcome: 'EMPTY',
      itemId: null,
      supplierCode: null,
      data: null,
      messages: [],
    };
    if (cells.every((cell) => !cell.trim())) return row;
    const text = (column: number | null) =>
      column === null ? null : cells[column]?.trim() || null;
    const fields = {
      supplierCode: text(mapping.supplierCode) ?? '',
      description: text(mapping.description) ?? '',
      brandText: text(mapping.brandText),
      presentationText: text(mapping.presentationText),
      reportedGtin: text(mapping.reportedGtin),
    };
    const previous = byCode.get(fields.supplierCode);
    for (const field of ['brandText', 'presentationText', 'reportedGtin'] as const)
      if (mapping[field] === null && previous) fields[field] = previous[field];
    const validated = validateReference(fields);
    row.supplierCode = fields.supplierCode.length <= 128 ? fields.supplierCode || null : null;
    row.messages = [...validated.errors, ...validated.warnings];
    row.data = validated.errors.length ? null : validated.data;
    row.outcome = validated.errors.length ? 'ERROR' : 'CREATED';
    if (row.supplierCode) {
      const group = groups.get(row.supplierCode) ?? [];
      group.push({ row, signature: digest(fields) });
      groups.set(row.supplierCode, group);
    }
    return row;
  });
  for (const [code, group] of groups) {
    const previous = byCode.get(code);
    if (new Set(group.map((entry) => entry.signature)).size > 1 || previous?.archivedAt) {
      for (const { row } of group) {
        row.outcome = 'CONFLICT';
        row.itemId = previous?.id ?? null;
        row.messages.push(
          previous?.archivedAt
            ? `El código ${code} pertenece a una referencia archivada; no se reutiliza.`
            : `El código ${code} aparece más de una vez con información diferente.`,
        );
      }
      continue;
    }
    for (let index = 0; index < group.length; index++) {
      const row = group[index]!.row;
      if (!row.data) continue;
      row.itemId = previous?.id ?? null;
      row.outcome =
        index > 0
          ? 'DUPLICATE'
          : !previous
            ? 'CREATED'
            : digest(referenceData(previous)) === digest(row.data)
              ? 'UNCHANGED'
              : 'UPDATED';
    }
  }
  const count = (outcome: PlannedRow['outcome']) =>
    rows.filter((row) => row.outcome === outcome).length;
  const absencesSuppressed =
    mode === 'COMPLETE' &&
    rows.some((row) => row.outcome === 'ERROR' || row.outcome === 'CONFLICT');
  const included = new Set(
    rows
      .filter(
        (row) => row.data && ['CREATED', 'UPDATED', 'UNCHANGED', 'DUPLICATE'].includes(row.outcome),
      )
      .map((row) => row.supplierCode),
  );
  const summary: CatalogImportSummary = {
    total: rows.length,
    created: count('CREATED'),
    updated: count('UPDATED'),
    unchanged: count('UNCHANGED'),
    duplicates: count('DUPLICATE'),
    empty: count('EMPTY'),
    errors: count('ERROR'),
    conflicts: count('CONFLICT'),
    warnings: rows.filter((row) =>
      row.messages.some((message) => message.startsWith('GTIN informado inválido')),
    ).length,
    missing:
      mode === 'COMPLETE' && !absencesSuppressed
        ? existing.filter((row) => !row.archivedAt && !included.has(row.supplierCode)).length
        : 0,
    absencesSuppressed,
  };
  if (!rows.some((row) => row.data && ['CREATED', 'UPDATED', 'UNCHANGED'].includes(row.outcome))) {
    summary.absencesSuppressed = mode === 'COMPLETE';
    summary.missing = 0;
  }
  return { rows, summary };
}

const aliases: Record<keyof CatalogColumnMapping, string[]> = {
  supplierCode: ['codigo', 'codigoproveedor', 'cod', 'sku', 'referencia'],
  description: ['descripcion', 'producto', 'articulo', 'detalle'],
  brandText: ['marca', 'marcacomercial', 'brand'],
  presentationText: ['presentacion', 'empaque'],
  reportedGtin: ['gtin', 'ean', 'upc', 'codigodebarras'],
};
export function suggestMapping(headers: string[]) {
  const used = new Set<number>();
  return Object.fromEntries(
    Object.entries(aliases).map(([field, names]) => {
      const index = headers.findIndex(
        (header, index) =>
          !used.has(index) &&
          names.includes(
            header
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '')
              .toLowerCase()
              .replace(/[^a-z0-9]/g, ''),
          ),
      );
      if (index >= 0) used.add(index);
      return [field, index < 0 ? null : index];
    }),
  ) as Record<keyof CatalogColumnMapping, number | null>;
}
export function inspectSheet(sheet: CatalogSheet) {
  let index = sheet.rows.findIndex((row) => row.some((cell) => cell.trim()));
  if (index < 0) index = 0;
  // Preferir un encabezado reconocible entre las primeras veinte filas.
  const detected = sheet.rows.slice(0, 20).findIndex((row) => {
    const mapping = suggestMapping(row);
    return mapping.supplierCode !== null && mapping.description !== null;
  });
  if (detected >= 0) index = detected;
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const headers = Array.from({ length: width }, (_, column) => sheet.rows[index]?.[column] ?? '');
  return {
    name: sheet.name,
    rowCount: Math.max(0, sheet.rows.length - index - 1),
    headerRow: index + 1,
    headers,
    sample: sheet.rows.slice(0, 20),
    suggestedMapping: suggestMapping(headers),
  };
}

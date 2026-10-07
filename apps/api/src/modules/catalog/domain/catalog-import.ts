import { createHash } from 'node:crypto';
import type {
  CatalogColumnMapping,
  CatalogColumnMappingInput,
  CatalogImportSummary,
  SupplierCatalogData,
  CatalogCommercialOptions,
} from '@maxbio/contracts';
import {
  catalogMappingFields,
  supplierCatalogLimits,
  catalogColumnMappingSchema,
} from '@maxbio/contracts';
import { normalizeIdentifier, CatalogRuleError } from './identifiers.js';
import type { IntermediateTable } from './catalog-table.js';
import { cellKey } from './catalog-table.js';
import {
  commercialDecimal,
  ceilingPrice,
  commercialCurrency,
  defaultCommercial,
  embeddedCurrency,
} from './catalog-commercial.js';
export { inspectSheet, suggestMapping } from './catalog-detection.js';
import { normalizeHeader } from './catalog-detection.js';

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
export type CatalogSheet = IntermediateTable;
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
  manufacturerText: 200,
  modelText: 160,
  categoryText: 160,
  unitText: 80,
  presentationText: 200,
  reportedGtin: 128,
  alternateSupplierCode: 128,
};
export function validateReference(fields: Omit<SupplierCatalogData, 'normalizedReportedGtin'>) {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const field of Object.keys(maximum)) {
    const value = fields[field as keyof typeof maximum];
    const label = catalogMappingFields[field as keyof typeof maximum];
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
  if (!fields.supplierCode && !fields.description && !normalizedReportedGtin)
    errors.push('No hay datos suficientes para reconocer un artículo.');
  for (const [field, scale] of [
    ['price', 2],
    ['vatRate', 4],
  ] as const) {
    const value = fields[field];
    if (value !== null) {
      try {
        if (
          (field === 'price'
            ? ceilingPrice(value)
            : commercialDecimal(value, scale, 'DOT', true)) !== value
        )
          errors.push(`Revisá ${catalogMappingFields[field]}.`);
        if (
          field === 'vatRate' &&
          BigInt(value.split('.')[0]!) * 10000n +
            BigInt((value.split('.')[1] ?? '').padEnd(4, '0')) >
            1000000n
        )
          errors.push('El IVA declarado debe estar entre 0 y 100%.');
      } catch {
        errors.push(`Revisá ${catalogMappingFields[field]}.`);
      }
    }
  }
  if (fields.currency !== null && !/^[A-Z]{3}$/.test(fields.currency))
    errors.push('Revisá la moneda declarada.');
  if (fields.price !== null && !fields.currency)
    errors.push('No pudimos determinar la moneda del precio. Revisá las opciones de la lista.');
  return { data: { ...fields, normalizedReportedGtin }, errors, warnings };
}
export function referenceData(row: SupplierCatalogData): SupplierCatalogData {
  return {
    internalReferenceCode: row.internalReferenceCode,
    manufacturerText: row.manufacturerText,
    modelText: row.modelText,
    categoryText: row.categoryText,
    unitText: row.unitText,
    supplierCode: row.supplierCode,
    description: row.description,
    brandText: row.brandText,
    presentationText: row.presentationText,
    reportedGtin: row.reportedGtin,
    normalizedReportedGtin: row.normalizedReportedGtin,
    alternateSupplierCode: row.alternateSupplierCode,
    price: row.price,
    currency: row.currency,
    vatRate: row.vatRate,
    priceIncludesVat: row.priceIncludesVat,
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
  inputMapping: CatalogColumnMappingInput,
  existing: ReferenceRecord[],
  mode: 'PARTIAL' | 'COMPLETE',
  commercial: CatalogCommercialOptions = defaultCommercial,
  excludedRowNumbers: number[] = [],
) {
  const mapping = catalogColumnMappingSchema.parse(inputMapping);
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  if (Object.values(mapping).some((index) => index !== null && index >= width))
    throw new CatalogRuleError('Elegí columnas que existan en la hoja seleccionada.');
  if (headerRow > sheet.rows.length)
    throw new CatalogRuleError('Elegí la fila que contiene los encabezados.');
  if (sheet.rows.length - headerRow > supplierCatalogLimits.rows)
    throw new CatalogRuleError('La lista admite hasta 10.000 filas de artículos.');
  const indexBy = (key: keyof SupplierCatalogData) => {
    const index = new Map<string, ReferenceRecord[]>();
    for (const record of existing) {
      const value = record[key];
      if (value) index.set(value, [...(index.get(value) ?? []), record]);
    }
    return index;
  };
  const byCode = indexBy('supplierCode'),
    byGtin = indexBy('normalizedReportedGtin'),
    byAlternate = indexBy('alternateSupplierCode');
  const fingerprint = (data: SupplierCatalogData) =>
    digest([
      data.description,
      data.brandText,
      data.manufacturerText,
      data.modelText,
      data.categoryText,
      data.presentationText,
      data.unitText,
    ]);
  const byDescription = new Map<string, ReferenceRecord[]>();
  for (const record of existing)
    if (record.description && record.description.length >= 8) {
      const key = fingerprint(record);
      byDescription.set(key, [...(byDescription.get(key) ?? []), record]);
    }

  const excludedRows = new Set(excludedRowNumbers);
  const numericCells = new Set(sheet.numericCells ?? []);
  const percentageCells = new Set(sheet.percentageCells ?? []);
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
    const rowNumber = headerRow + index + 1;
    if (excludedRows.has(rowNumber)) {
      row.messages.push('Fila ignorada expresamente por el usuario.');
      return row;
    }
    const selected = Object.values(mapping).filter((column): column is number => column !== null);
    if (
      cells.every((cell) => !cell.trim()) &&
      !selected.some((column) => sheet.cellStates?.[cellKey(rowNumber, column)] === 'UNAVAILABLE')
    )
      return row;
    const headers = sheet.rows[headerRow - 1] ?? [];
    if (
      selected.every(
        (column) => normalizeHeader(cells[column] ?? '') === normalizeHeader(headers[column] ?? ''),
      ) &&
      cells.some((cell) => cell.trim())
    ) {
      row.messages.push('Encabezado repetido: fila ignorada.');
      return row;
    }
    const codeText = normalizeHeader(
      mapping.supplierCode === null ? '' : (cells[mapping.supplierCode] ?? ''),
    );
    const descriptionText = normalizeHeader(
      mapping.description === null ? '' : (cells[mapping.description] ?? ''),
    );
    if (
      !codeText &&
      !descriptionText &&
      cells.some((cell) => ['total', 'subtotal', 'totalgeneral'].includes(normalizeHeader(cell))) &&
      selected.every(
        (column) =>
          !cells[column]?.trim() &&
          sheet.cellStates?.[cellKey(rowNumber, column)] !== 'UNAVAILABLE',
      )
    ) {
      row.messages.push('Pie de total explícito sin datos de referencia: fila ignorada.');
      return row;
    }
    if (
      ['total', 'subtotal', 'totalgeneral'].includes(codeText) &&
      (!descriptionText || ['total', 'subtotal', 'totalgeneral'].includes(descriptionText))
    ) {
      row.messages.push('Total o subtotal explícito: fila ignorada.');
      return row;
    }
    const text = (column: number | null) =>
      column === null ? null : cells[column]?.trim() || null;
    if (
      !codeText &&
      /^(nota(?:s)?\b|observaciones?\b|condiciones?\b|vigencia\b|precios?\s+(?:con|sin)\s+iva\b)/i.test(
        text(mapping.description) ?? '',
      )
    ) {
      row.messages.push('Nota comercial explícita: fila ignorada.');
      return row;
    }
    const fields = {
      internalReferenceCode: null as string | null,
      supplierCode: text(mapping.supplierCode),
      description: text(mapping.description),
      manufacturerText: text(mapping.manufacturerText),
      modelText: text(mapping.modelText),
      categoryText: text(mapping.categoryText),
      unitText: text(mapping.unitText),
      brandText: text(mapping.brandText),
      presentationText: text(mapping.presentationText),
      reportedGtin: text(mapping.reportedGtin),
      alternateSupplierCode: text(mapping.alternateSupplierCode),
      price: null as string | null,
      vatRate: null as string | null,
      currency: null as string | null,
      priceIncludesVat: commercial.priceIncludesVat,
    };
    const cellErrors: string[] = [];
    const cellWarnings: string[] = [];
    for (const [field, column] of Object.entries(mapping)) {
      if (column === null) continue;
      const state = sheet.cellStates?.[cellKey(rowNumber, column)];
      if (state === 'UNAVAILABLE')
        cellErrors.push(
          `No hay un valor guardado utilizable para ${catalogMappingFields[field as keyof CatalogColumnMapping]}. Revisá esa celda en el archivo.`,
        );
      if (state === 'STORED_RESULT')
        cellWarnings.push(
          `Usamos el resultado guardado para ${catalogMappingFields[field as keyof CatalogColumnMapping]}; puede estar desactualizado.`,
        );
    }
    for (const [field, scale] of [
      ['price', 18],
      ['vatRate', 4],
    ] as const) {
      const value = text(mapping[field]);
      if (value !== null) {
        try {
          const key = cellKey(rowNumber, mapping[field]!);
          if (field === 'price' && (value.trim().endsWith('%') || percentageCells.has(key)))
            throw new CatalogRuleError(
              'Un porcentaje no es un precio. Revisá el valor en el archivo.',
            );
          if (field === 'vatRate' && !numericCells.has(key) && /[A-Za-z$]/.test(value))
            throw new CatalogRuleError('Revisá el IVA declarado; debe ser una tasa porcentual.');
          let parsed = commercialDecimal(
            value,
            scale + (field === 'vatRate' && percentageCells.has(key) ? 2 : 0),
            commercial.decimalSeparator,
            numericCells.has(key),
          );
          if (field === 'vatRate' && percentageCells.has(key)) {
            const [whole, fraction = ''] = parsed.split('.');
            const digits = whole + fraction.padEnd(2, '0');
            const point = whole!.length + 2;
            parsed = commercialDecimal(
              digits.slice(0, point) + (digits.length > point ? '.' + digits.slice(point) : ''),
              4,
              'DOT',
              true,
            );
          }
          fields[field] = field === 'price' ? ceilingPrice(parsed) : parsed;
        } catch (error) {
          cellErrors.push(`${catalogMappingFields[field]}: ${(error as Error).message}`);
        }
      }
    }
    try {
      const fromPrice = embeddedCurrency(text(mapping.price));
      const fromColumn = commercialCurrency(text(mapping.currency) ?? '');
      if (fromPrice && fromColumn && fromPrice !== fromColumn)
        cellErrors.push(
          'La moneda del precio y la columna de moneda no coinciden. Revisá la fila.',
        );
      fields.currency = commercialCurrency(
        fromColumn ?? fromPrice ?? commercial.defaultCurrency ?? 'ARS',
      );
    } catch (error) {
      cellErrors.push((error as Error).message);
    }
    const preliminary = validateReference(fields);
    const tiers = [
      fields.supplierCode ? (byCode.get(fields.supplierCode) ?? []) : [],
      preliminary.data.normalizedReportedGtin
        ? (byGtin.get(preliminary.data.normalizedReportedGtin) ?? [])
        : [],
      fields.alternateSupplierCode ? (byAlternate.get(fields.alternateSupplierCode) ?? []) : [],
      !fields.supplierCode && fields.description && fields.description.length >= 8
        ? (byDescription.get(fingerprint(preliminary.data)) ?? []).filter(
            (item) => !item.supplierCode,
          )
        : [],
    ];
    const candidates = tiers.find((tier) => tier.length) ?? [];
    const previous = candidates.length === 1 ? candidates[0] : undefined;
    const incompatible =
      candidates.length > 1 ||
      (previous?.normalizedReportedGtin &&
        preliminary.data.normalizedReportedGtin &&
        previous.normalizedReportedGtin !== preliminary.data.normalizedReportedGtin) ||
      (previous && tiers.slice(0, 3).some((tier) => tier.some((item) => item.id !== previous.id)));
    for (const field of [
      'brandText',
      'manufacturerText',
      'modelText',
      'categoryText',
      'unitText',
      'presentationText',
      'reportedGtin',
      'alternateSupplierCode',
      'price',
      'vatRate',
      'currency',
    ] as const)
      if (mapping[field] === null && previous && !(field === 'currency' && mapping.price !== null))
        fields[field] = previous[field];
    if (previous) fields.internalReferenceCode = previous.internalReferenceCode;
    if (previous && mapping.price === null) fields.priceIncludesVat = previous.priceIncludesVat;
    const validated = validateReference(fields);
    const errors = [...cellErrors, ...validated.errors];
    row.supplierCode =
      fields.supplierCode && fields.supplierCode.length <= 128 ? fields.supplierCode : null;
    row.itemId = previous?.id ?? null;
    row.data = errors.length ? null : validated.data;
    row.messages.push(...errors, ...validated.warnings, ...cellWarnings);
    row.outcome =
      incompatible || previous?.archivedAt
        ? 'CONFLICT'
        : errors.length
          ? 'ERROR'
          : !previous
            ? 'CREATED'
            : digest(referenceData(previous)) === digest(row.data)
              ? 'UNCHANGED'
              : 'UPDATED';
    if (row.outcome === 'CONFLICT')
      row.messages.push(
        'La identidad es ambigua o está reservada por una referencia archivada. Requiere revisión.',
      );
    if (row.data) {
      const key = previous
        ? 'id:' + previous.id
        : fields.supplierCode
          ? 'code:' + fields.supplierCode
          : validated.data.normalizedReportedGtin
            ? 'gtin:' + validated.data.normalizedReportedGtin
            : fields.alternateSupplierCode
              ? 'alt:' + fields.alternateSupplierCode
              : 'description:' + fingerprint(validated.data);
      const group = groups.get(key) ?? [];
      group.push({ row, signature: digest(row.data) });
      groups.set(key, group);
    }
    return row;
  });
  for (const group of groups.values()) {
    if (new Set(group.map((entry) => entry.signature)).size > 1) {
      for (const { row } of group) {
        row.outcome = 'CONFLICT';
        row.messages.push('La misma referencia aparece con información diferente.');
      }
    } else
      for (const { row } of group.slice(1))
        if (row.outcome !== 'CONFLICT') row.outcome = 'DUPLICATE';
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
      .map((row) => row.itemId),
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
    warnings: rows.filter(
      (row) => row.messages.length > 0 && row.outcome !== 'ERROR' && row.outcome !== 'CONFLICT',
    ).length,
    missing:
      mode === 'COMPLETE' && !absencesSuppressed
        ? existing.filter((row) => !row.archivedAt && !included.has(row.id)).length
        : 0,
    absencesSuppressed,
  };
  if (!rows.some((row) => row.data && ['CREATED', 'UPDATED', 'UNCHANGED'].includes(row.outcome))) {
    summary.absencesSuppressed = mode === 'COMPLETE';
    summary.missing = 0;
  }
  return { rows, summary };
}

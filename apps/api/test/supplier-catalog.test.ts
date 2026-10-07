import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  catalogColumnMappingSchema,
  catalogPreviewInputSchema,
  catalogCommitInputSchema,
  supplierCatalogQuerySchema,
  supplierCatalogRouteContract,
  supplierCatalogLimits,
} from '@maxbio/contracts';
import {
  parseCatalogFile,
  safeFileName,
  validateXlsxArchive,
} from '../src/modules/catalog/domain/catalog-file.js';
import {
  planImport,
  inspectSheet,
  catalogFingerprint,
  type ReferenceRecord,
} from '../src/modules/catalog/domain/catalog-import.js';
import { parseCatalogInput } from '../src/modules/catalog/api/supplier-catalog.controller.js';
import { xlsxFixture, zipFixture } from './supplier-catalog-fixtures.js';
const mapping = {
  supplierCode: 0,
  description: 1,
  brandText: 2,
  presentationText: 3,
  reportedGtin: 4,
};
const header = ['CODIGO', 'DESCRIPCION', 'MARCA', 'PRESENTACION', 'EAN'];
const row = ['00a/B-1', 'Bota Walker corta', 'Marca', 'Unidad', '4006381333931'];
const sheet = (rows: string[][]) => ({ name: 'Lista', rows: [header, ...rows] });
const plan = (
  rows: string[][],
  existing: ReferenceRecord[] = [],
  mode: 'PARTIAL' | 'COMPLETE' = 'PARTIAL',
) => planImport(sheet(rows), 1, mapping, existing, mode);
const previous = (): ReferenceRecord => ({
  ...plan([row]).rows[0]!.data!,
  id: randomUUID(),
  version: 1,
  archivedAt: null,
  missingFromLatestCompleteListAt: null,
});

test('CSV UTF-8/BOM, delimitadores, comillas, saltos y ceros/case/puntuación como texto', async () => {
  for (const delimiter of [',', ';', '\t']) {
    const parsed = await parseCatalogFile(
      Buffer.from(
        '\ufeffCODIGO' + delimiter + 'DESCRIPCION\r\n00a/B-1' + delimiter + '"Bota, corta"\r\n',
      ),
      'lista.csv',
      'text/csv',
    );
    assert.equal(parsed.sheets[0]!.rows[1]![0], '00a/B-1');
    assert.equal(parsed.sheets[0]!.rows[1]![1], 'Bota, corta');
    assert.equal(parsed.contentHash.length, 64);
  }
});
test('XLSX válido y múltiples hojas, encabezados detectados y elección independiente', async () => {
  const parsed = await parseCatalogFile(
    xlsxFixture([
      sheet([row]),
      {
        name: 'Otra',
        rows: [
          ['SKU', 'PRODUCTO', 'MARCA COMERCIAL', 'GTIN'],
          ['0001', 'Otro', 'M', '4006381333931'],
        ],
      },
    ]),
    'lista.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.equal(parsed.sheets.length, 2);
  assert.equal(parsed.sheets[0]!.rows[1]![0], '00a/B-1');
  assert.equal(parsed.sheets[1]!.rows[1]![0], '0001');
  assert.deepEqual(inspectSheet(parsed.sheets[1]!).suggestedMapping, {
    supplierCode: 0,
    description: 1,
    brandText: 2,
    presentationText: null,
    reportedGtin: 3,
    alternateSupplierCode: null,
    price: null,
    currency: null,
    vatRate: null,
  });
});
test('mapeo por índice, encabezados repetidos y título previo', () => {
  const value = {
    name: 'Lista',
    rows: [
      ['Lista de octubre'],
      ['DESCRIPCION', 'SKU', 'MARCA', 'MARCA'],
      ['Walker', '0002', 'Marca', 'Otra'],
    ],
  };
  assert.equal(inspectSheet(value).headerRow, 2);
  const result = planImport(
    value,
    2,
    { supplierCode: 1, description: 0, brandText: 3, presentationText: null, reportedGtin: null },
    [],
    'PARTIAL',
  );
  assert.equal(result.rows[0]!.data!.brandText, 'Otra');
  assert.equal(result.rows[0]!.data!.supplierCode, '0002');
});
test('XLSX conserva números de fila y contabiliza vacías finales', async () => {
  const parsed = await parseCatalogFile(
    xlsxFixture([{ name: 'Lista', rows: [[], header, row, [], []] }]),
    'lista.xlsx',
    'application/octet-stream',
  );
  const result = planImport(parsed.sheets[0]!, 2, mapping, [], 'PARTIAL');
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.empty, 2);
  assert.equal(result.rows[0]!.rowNumber, 3);
});
test('filas vacías, código/descripcion faltante, duplicados idénticos y contradictorios', () => {
  const result = plan([
    [],
    ['', 'Descripción'],
    ['ABC', ''],
    row,
    row,
    ['DL2115', 'Primero'],
    ['DL2115', 'Segundo'],
  ]);
  assert.equal(result.summary.empty, 1);
  assert.equal(result.summary.errors, 2);
  assert.equal(result.summary.created, 1);
  assert.equal(result.summary.duplicates, 1);
  assert.equal(result.summary.conflicts, 2);
  assert.match(result.rows[5]!.messages.join(' '), /DL2115.*información diferente/);
  const invalidTwin = plan([row, [row[0]!, '']]);
  assert.equal(invalidTwin.summary.created, 0);
  assert.equal(invalidTwin.summary.conflicts, 2);
});
test('GTIN válido canoniza a 14; inválido conserva declaración con advertencia', () => {
  assert.equal(plan([row]).rows[0]!.data!.normalizedReportedGtin, '04006381333931');
  const invalid = plan([['A', 'Descripción', '', '', '000invalid']]);
  assert.equal(invalid.summary.errors, 0);
  assert.equal(invalid.summary.warnings, 1);
  assert.equal(invalid.rows[0]!.data!.reportedGtin, '000invalid');
  assert.equal(invalid.rows[0]!.data!.normalizedReportedGtin, null);
});
test('strings largos/control: errores humanos sin truncar; códigos distintos por case', () => {
  const result = plan([
    ['X'.repeat(129), 'Descripción'],
    ['A', 'X'.repeat(1001)],
    ['B', 'Desc', 'M'.repeat(161)],
    ['C', 'Desc', '', 'P'.repeat(201)],
    ['D', 'Desc', '', '', 'G'.repeat(129)],
    ['E', 'Desc\u0000'],
    ['abc', 'Uno'],
    ['ABC', 'Dos'],
  ]);
  assert.equal(result.summary.errors, 6);
  assert.equal(result.summary.created, 2);
  assert.match(result.rows[0]!.messages[0]!, /128 caracteres/);
  assert.equal(result.rows[0]!.supplierCode, null);
});
test('reimportación, actualización, parciales y completos seguros con errores', () => {
  const existing = previous();
  assert.equal(plan([row], [existing]).summary.unchanged, 1);
  assert.equal(
    plan([[row[0]!, 'Otra descripción', 'Otra marca', 'Otra presentación', 'inválido']], [existing])
      .summary.updated,
    1,
  );
  assert.equal(plan([['Otra', 'Descripción']], [existing], 'PARTIAL').summary.missing, 0);
  assert.equal(plan([['Otra', 'Descripción']], [existing], 'COMPLETE').summary.missing, 1);
  const incomplete = plan(
    [
      ['Otra', 'Descripción'],
      ['', 'Error'],
    ],
    [existing],
    'COMPLETE',
  );
  assert.equal(incomplete.summary.missing, 0);
  assert.equal(incomplete.summary.absencesSuppressed, true);
  const archived = { ...existing, archivedAt: new Date() };
  assert.equal(plan([row], [archived]).summary.conflicts, 1);
  const optional = planImport(
    sheet([[row[0]!, 'Otra']]),
    1,
    { ...mapping, brandText: null, presentationText: null, reportedGtin: null },
    [existing],
    'PARTIAL',
  );
  assert.equal(optional.rows[0]!.data!.brandText, existing.brandText);
});
test('5.000 filas producen un plan de referencias puro sin conceptos de Product', () => {
  const result = plan(Array.from({ length: 5000 }, (_, index) => [`00${index}`, 'Walker']));
  assert.equal(result.summary.created, 5000);
  assert.equal(result.rows.length, 5000);
  assert.ok(result.rows.every((row) => row.data && !('productId' in row.data)));
});
test('límites de archivo, filas, columnas y celdas, formato/MIME/contenido inválido', async () => {
  await assert.rejects(
    parseCatalogFile(Buffer.alloc(supplierCatalogLimits.fileBytes + 1), 'lista.csv', 'text/csv'),
    /10 MiB/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from('a'), 'lista.xls', 'application/vnd.ms-excel'),
    /\.xls/,
  );
  await assert.rejects(
    parseCatalogFile(
      Buffer.from('a'),
      'lista.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ),
    /Excel/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from('a'), 'lista.csv', 'image/png'),
    /tipo de archivo/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from('"inconcluso'), 'lista.csv', 'text/csv'),
    /comillas/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from([0xff, 0xfe, 0x00]), 'lista.csv', 'text/csv'),
    /UTF-8/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from(Array(101).fill('x').join(',')), 'lista.csv', 'text/csv'),
    /100 columnas/,
  );
  await assert.rejects(
    parseCatalogFile(Buffer.from('X'.repeat(4001)), 'lista.csv', 'text/csv'),
    /4.000 caracteres/,
  );
  assert.throws(() => plan(Array.from({ length: 10001 }, () => ['A', 'Desc'])), /10.000/);
  await assert.rejects(
    parseCatalogFile(Buffer.from('A,B\n'.repeat(10022)), 'lista.csv', 'text/csv'),
    /10.000/,
  );
  assert.equal(
    plan(Array.from({ length: 10000 }, (_, i) => [String(i), 'Desc'])).summary.created,
    10000,
  );
});
test('XLSX rechaza macros, entidades XML, expansi\u00f3n y celdas dispersas', async () => {
  for (const extra of [
    { 'xl/vbaProject.bin': 'macro' },
    { 'xl/sharedStrings.xml': '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]>' },
    { 'xl/worksheets/sheet1.xml': '<worksheet><row r="1"><c r="A10000000"/></row></worksheet>' },
    { 'xl/worksheets/sheet1.xml': '<worksheet><dimension ref="A1:XFD1048576"/></worksheet>' },
    { 'xl/worksheets/sheet1.xml': '<worksheet><row r="1000000"/></worksheet>' },
    { 'xl/worksheets/sheet1.xml': '<worksheet><row r="1"><c r="A&#49;000000"/></row></worksheet>' },
  ] as Record<string, string>[])
    await assert.rejects(
      parseCatalogFile(
        xlsxFixture([sheet([row])], extra),
        'lista.xlsx',
        'application/octet-stream',
      ),
    );
  await assert.rejects(
    validateXlsxArchive(
      zipFixture({
        '[Content_Types].xml': '<x/>',
        'xl/workbook.xml': '<x/>',
        'bomb.xml': 'x'.repeat(41 * 1024 * 1024),
      }),
    ),
    /excesivo|expansión/,
  );
  await assert.rejects(
    parseCatalogFile(
      xlsxFixture([{ name: 'X'.repeat(32), rows: [header, row] }]),
      'lista.xlsx',
      'application/octet-stream',
    ),
    /nombres/,
  );
});
test('contratos estrictos, paginación máxima, sin organizationId, rutas explícitas y errores humanos', () => {
  assert.equal(
    supplierCatalogQuerySchema.safeParse({ organizationId: randomUUID() }).success,
    false,
  );
  assert.equal(supplierCatalogQuerySchema.safeParse({ limit: '101' }).success, false);
  assert.equal(supplierCatalogQuerySchema.parse({}).limit, 20);
  assert.equal(catalogColumnMappingSchema.safeParse({ ...mapping, description: 0 }).success, false);
  assert.throws(
    () =>
      parseCatalogInput(catalogPreviewInputSchema, {
        uploadId: randomUUID(),
        sheet: 'Lista',
        headerRow: 1,
        mode: 'PARTIAL',
        mapping: { ...mapping, supplierCode: null },
      }),
    /columna.*código/,
  );
  assert.equal(
    catalogCommitInputSchema.safeParse({
      previewHash: 'a'.repeat(64),
      organizationId: randomUUID(),
    }).success,
    false,
  );
  assert.equal(supplierCatalogRouteContract('catalog-scans/resolve', 'POST'), undefined);
  assert.ok(
    supplierCatalogRouteContract(`suppliers/${randomUUID()}/catalog-imports/preview`, 'POST'),
  );
  assert.equal(safeFileName('../../private\\lista\u0000.csv'), 'lista.csv');
  const existing = previous();
  assert.notEqual(
    catalogFingerprint([existing], 1),
    catalogFingerprint([{ ...existing, version: 2 }], 1),
  );
});

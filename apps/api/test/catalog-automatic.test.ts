import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  catalogColumnMappingSchema,
  catalogMappingFields,
  catalogPreviewInputSchema,
  supplierCatalogDataSchema,
} from '@maxbio/contracts';
import { ceilingPrice } from '../src/modules/catalog/domain/catalog-commercial.js';
import {
  catalogPrefix,
  referenceCode,
} from '../src/modules/catalog/domain/catalog-reference-code.js';
import { inspectSheet, suggestSheet } from '../src/modules/catalog/domain/catalog-detection.js';
import { planImport, type ReferenceRecord } from '../src/modules/catalog/domain/catalog-import.js';
import { searchTokens, textContains } from '../src/modules/catalog/domain/catalog-search.js';

const mapping = (fields: Record<string, number>) =>
  catalogColumnMappingSchema.parse({
    ...Object.fromEntries(Object.keys(catalogMappingFields).map((field) => [field, null])),
    ...fields,
  });
const record = (
  data: NonNullable<ReturnType<typeof planImport>['rows'][number]['data']>,
  sequence = 1,
): ReferenceRecord => ({
  ...data,
  internalReferenceCode: referenceCode('A', sequence),
  id: randomUUID(),
  version: 1,
  archivedAt: null,
  missingFromLatestCompleteListAt: null,
});

test('precio canónico: techo exacto a centavos sin Float, negativos y límites', () => {
  for (const [input, expected] of [
    ['100', '100.00'],
    ['100.1', '100.10'],
    ['100.101', '100.11'],
    ['100.119', '100.12'],
    ['218505.11669999998', '218505.12'],
    ['0.000000000000000001', '0.01'],
    ['999.999', '1000.00'],
    ['100.10000000', '100.10'],
  ])
    assert.equal(ceilingPrice(input!), expected);
  assert.throws(() => ceilingPrice('-1'));
  assert.throws(() => ceilingPrice('999999999999999.999'));
});
test('prefijos extensibles y código de referencia independiente de UUID/MB-/código externo', () => {
  assert.deepEqual([1, 26, 27, 52, 53, 702, 703].map(catalogPrefix), [
    'A',
    'Z',
    'AA',
    'AZ',
    'BA',
    'ZZ',
    'AAA',
  ]);
  assert.equal(referenceCode('M', 143), 'M000143');
  assert.throws(() => referenceCode('A', 1000000));
  assert.throws(() => catalogPrefix(0));
});
test('modelo fijo automático: encabezado 1/16, código solo, descripción sola y campos opcionales', () => {
  for (const headerRow of [1, 16])
    for (const headers of [
      ['SKU'],
      ['DESCRIPCION'],
      ['REF', 'NOMBRE', 'FABRICANTE', 'MODELO', 'FAMILIA', 'U.M.', 'PRESENTACION', 'MARCA'],
    ]) {
      const values =
        headers.length === 1
          ? [headers[0] === 'SKU' ? '000-Ab/1' : 'Walker corta']
          : ['000-Ab/1', 'Walker corta', 'Laboratorio', 'W', 'Ortopedia', 'Par', 'Caja', 'Marca'];
      const table = {
        name: 'Comercial',
        rows: [
          ...Array.from({ length: headerRow - 1 }, () => ['Lista comercial']),
          headers,
          values,
        ],
      };
      const inspection = inspectSheet(table);
      assert.equal(inspection.headerRow, headerRow);
      assert.equal(suggestSheet([inspection]), 'Comercial');
      const plan = planImport(table, headerRow, inspection.suggestedMapping, [], 'PARTIAL');
      assert.equal(plan.summary.created, 1);
      assert.equal(plan.rows[0]!.data!.internalReferenceCode, null);
      assert.equal(plan.rows[0]!.data!.currency, 'ARS');
      assert.equal(plan.rows[0]!.data!.vatRate, null);
      assert.equal(plan.rows[0]!.data!.priceIncludesVat, 'UNKNOWN');
      if (headers[0] === 'SKU') assert.equal(plan.rows[0]!.data!.description, null);
      if (headers[0] === 'DESCRIPCION') assert.equal(plan.rows[0]!.data!.supplierCode, null);
      if (headers.length > 1) assert.equal(plan.rows[0]!.data!.manufacturerText, 'Laboratorio');
    }
});
test('precio solo no es artículo; notas explícitas se ignoran; hoja ambigua no se elige', () => {
  const priceOnly = { name: 'Precios', rows: [['PRECIO'], ['100']] };
  assert.equal(suggestSheet([inspectSheet(priceOnly)]), null);
  assert.equal(planImport(priceOnly, 1, mapping({ price: 0 }), [], 'PARTIAL').summary.errors, 1);
  const table = {
    name: 'Lista',
    rows: [['DESCRIPCION'], ['Nota del proveedor'], ['Walker corta']],
  };
  const plan = planImport(table, 1, mapping({ description: 0 }), [], 'PARTIAL');
  assert.equal(plan.summary.empty, 1);
  assert.equal(plan.summary.created, 1);
  const first = inspectSheet(table);
  assert.equal(suggestSheet([first, { ...first, name: 'Otra' }]), null);
});
test('campos inciertos quedan null; declaraciones de IVA y USD son automáticas', () => {
  const table = {
    name: 'Lista',
    rows: [
      ['Precios sin IVA'],
      ['SKU', 'DESCRIPCION', 'MARCA', 'MARCA 2', 'MONEDA', 'PRECIO'],
      ['001', 'Walker', 'Una', 'Otra', 'USD', '100.10'],
    ],
  };
  const inspection = inspectSheet(table);
  assert.equal(inspection.suggestedMapping.brandText, null);
  const plan = planImport(
    table,
    inspection.headerRow,
    inspection.suggestedMapping,
    [],
    'PARTIAL',
    inspection.commercial,
  );
  assert.equal(plan.rows[0]!.data!.brandText, null);
  assert.equal(plan.rows[0]!.data!.currency, 'USD');
  assert.equal(plan.rows[0]!.data!.priceIncludesVat, 'NO');
  assert.equal(plan.rows[0]!.data!.price, '100.10');
});
test('reimportación exacta por GTIN/alternativo/huella conserva código; ambigüedad y archivados bloquean', () => {
  const table = {
    name: 'Lista',
    rows: [
      ['SKU', 'DESCRIPCION', 'GTIN', 'COD_EXT'],
      ['old', 'Walker corta', '4006381333931', 'alt'],
    ],
  };
  const columns = mapping({
    supplierCode: 0,
    description: 1,
    reportedGtin: 2,
    alternateSupplierCode: 3,
  });
  const old = record(planImport(table, 1, columns, [], 'PARTIAL').rows[0]!.data!);
  const next = {
    ...table,
    rows: [table.rows[0]!, ['new', 'Walker corta', '4006381333931', 'alt']],
  };
  const matched = planImport(next, 1, columns, [old], 'PARTIAL');
  assert.equal(matched.summary.updated, 1);
  assert.equal(matched.rows[0]!.itemId, old.id);
  assert.equal(matched.rows[0]!.data!.internalReferenceCode, 'A000001');
  assert.equal(
    planImport(
      { ...table, rows: [table.rows[0]!, ['old', 'Otro artículo', '5901234123457', 'alt']] },
      1,
      columns,
      [old],
      'PARTIAL',
    ).summary.conflicts,
    1,
  );
  const second = { ...old, id: randomUUID(), internalReferenceCode: 'A000002' };
  assert.equal(planImport(next, 1, columns, [old, second], 'PARTIAL').summary.conflicts, 1);
  assert.equal(
    planImport(next, 1, columns, [{ ...old, archivedAt: new Date() }], 'PARTIAL').summary.conflicts,
    1,
  );
  const alternate = { ...next, rows: [table.rows[0]!, ['new', 'Walker corta', '', 'alt']] };
  assert.equal(planImport(alternate, 1, columns, [old], 'PARTIAL').rows[0]!.itemId, old.id);
  const descriptions = { name: 'Lista', rows: [['DESCRIPCION'], ['Walker corta']] };
  const descriptive = record(
    planImport(descriptions, 1, mapping({ description: 0 }), [], 'PARTIAL').rows[0]!.data!,
  );
  assert.equal(
    planImport(descriptions, 1, mapping({ description: 0 }), [descriptive], 'PARTIAL').summary
      .unchanged,
    1,
  );
  assert.equal(
    planImport(
      { ...descriptions, rows: [['DESCRIPCION'], ['Walker corto']] },
      1,
      mapping({ description: 0 }),
      [descriptive],
      'PARTIAL',
    ).summary.created,
    1,
  );
});
test('contrato automático y búsqueda tokenizada con literales LIKE escapados', () => {
  assert.equal(catalogPreviewInputSchema.parse({ uploadId: randomUUID() }).mode, 'PARTIAL');
  for (const manual of [{ headerRow: 1 }, { sheetName: 'CSV' }, { mapping: { supplierCode: 0 } }])
    assert.equal(
      catalogPreviewInputSchema.safeParse({ uploadId: randomUUID(), ...manual }).success,
      false,
    );
  const data = planImport(
    {
      name: 'Lista',
      rows: [
        ['SKU', 'PRECIO'],
        ['001', '100.10'],
      ],
    },
    1,
    mapping({ supplierCode: 0, price: 1 }),
    [],
    'PARTIAL',
  ).rows[0]!.data!;
  assert.equal(supplierCatalogDataSchema.safeParse(data).success, true);
  for (const price of ['100', '100.1', '100.101', '-1.00'])
    assert.equal(supplierCatalogDataSchema.safeParse({ ...data, price }).success, false);
  assert.deepEqual(searchTokens('  Prótesis CORTA corta '), ['protesis', 'corta']);
  assert.deepEqual(searchTokens('corta walker'), ['corta', 'walker']);
  assert.equal(textContains('00_%').contains, '00\\_\\%');
});

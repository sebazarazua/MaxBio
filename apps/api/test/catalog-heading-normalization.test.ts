import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  detectMapping,
  inspectSheet,
  normalizeHeadingWords,
  suggestSheet,
} from '../src/modules/catalog/domain/catalog-detection.js';
import { planImport } from '../src/modules/catalog/domain/catalog-import.js';

test('encabezados equivalentes: palabras completas, puntuación, tildes y abreviaturas controladas', () => {
  const variants = {
    supplierCode: [
      'CODIGO ARTICULO',
      'COD. ARTICULO',
      'COD ART',
      'CODIGO DEL ARTICULO',
      'CODIGO INTERNO',
      'CODIGO INTERNO PROVEEDOR',
      'CODIGO PRODUCTO',
      'CODIGO DEL PRODUCTO',
      'REF. ARTICULO',
      'NRO ARTICULO',
      'NUMERO ARTICULO',
      'SKU',
    ],
    description: [
      'DESCRIPCION',
      'DESCRIPCIÓN DEL PRODUCTO',
      'DESCRIPCION ARTICULO',
      'DESCRIPCION DEL ARTICULO',
      'DETALLE PRODUCTO',
      'NOMBRE PRODUCTO',
    ],
    price: [
      'PRECIO',
      'PRECIO DE LISTA',
      'PRECIO LISTA',
      'PRECIO UNITARIO',
      'P. UNITARIO',
      'P UNITARIO',
      'VALOR UNITARIO',
      'IMPORTE UNITARIO',
    ],
    vatRate: ['ALICUOTA IVA', 'ALÍCUOTA IVA', 'IVA %', '% IVA', 'TASA IVA', 'T.IVA'],
    reportedGtin: ['GTIN', 'EAN', 'EAN13', 'EAN-13', 'UPC', 'GTIN/EAN', 'CODIGO DE BARRAS'],
    unitText: ['UNIDAD', 'UNIDAD DE MEDIDA', 'U.M.', 'UM'],
    brandText: ['MARCA PRODUCTO', 'MARCA DEL PRODUCTO'],
    manufacturerText: ['FABRICANTE', 'LABORATORIO', 'FABRICANTE / LABORATORIO'],
  } as const;
  for (const [field, headings] of Object.entries(variants))
    for (const heading of headings)
      for (const value of [
        heading,
        '  ' + heading.toLowerCase().replaceAll(' ', '   ') + '  ',
        heading.replaceAll(' ', '-'),
      ]) {
        const result = detectMapping([value]);
        assert.equal(result.mapping[field as keyof typeof result.mapping], 0, value);
        assert.equal(result.confidence[field as keyof typeof result.confidence], 'HIGH', value);
      }
  assert.deepEqual(normalizeHeadingWords(' Cód. del  artículo '), ['codigo', 'producto']);
});

test('fixtures comerciales variados se interpretan con columnas reordenadas y encabezados 1/16', () => {
  const columns = [
    ['COD. ARTICULO', '000-a/B', 'supplierCode'],
    ['DESCRIPCIÓN DEL PRODUCTO', 'Prótesis Walker corta', 'description'],
    ['PRECIO DE LISTA', '100.1199', 'price'],
    ['ALÍCUOTA IVA', '10.5', 'vatRate'],
    ['EAN-13', '4006381333931', 'reportedGtin'],
    ['UNIDAD DE MEDIDA', 'Par', 'unitText'],
    ['MARCA DEL PRODUCTO', 'Marca', 'brandText'],
    ['FABRICANTE / LABORATORIO', 'Fabricante', 'manufacturerText'],
    ['MODELO DEL ARTICULO', 'W1', 'modelText'],
    ['CATEGORIA PRODUCTO', 'Ortopedia', 'categoryText'],
  ];
  for (const ordered of [
    columns,
    [...columns].reverse(),
    [...columns.slice(4), ...columns.slice(0, 4)],
  ])
    for (const headerRow of [1, 16]) {
      const table = {
        name: 'Lista genérica',
        rows: [
          ...Array.from({ length: headerRow - 1 }, () => ['Lista comercial']),
          ordered.map((column) => column[0]!),
          ordered.map((column) => column[1]!),
        ],
      };
      const detected = inspectSheet(table);
      assert.equal(detected.headerRow, headerRow);
      assert.equal(suggestSheet([detected]), table.name);
      ordered.forEach((column, index) =>
        assert.equal(
          detected.suggestedMapping[column[2] as keyof typeof detected.suggestedMapping],
          index,
        ),
      );
      const result = planImport(
        table,
        headerRow,
        detected.suggestedMapping,
        [],
        'PARTIAL',
        detected.commercial,
      );
      assert.equal(result.summary.created, 1);
      assert.equal(result.summary.errors, 0);
      assert.equal(result.rows[0]!.data!.price, '100.12');
      assert.equal(result.rows[0]!.data!.supplierCode, '000-a/B');
      assert.equal(result.rows[0]!.data!.unitText, 'Par');
      assert.equal(result.rows[0]!.data!.normalizedReportedGtin, '04006381333931');
    }
});

test('encabezados largos no inventan opcionales ausentes y conservan ARS/IVA desconocido', () => {
  const table = {
    name: 'Lista',
    rows: [
      ['CODIGO INTERNO PROVEEDOR', 'DETALLE PRODUCTO'],
      ['00-1', 'Artículo declarado'],
    ],
  };
  const detected = inspectSheet(table);
  const data = planImport(table, detected.headerRow, detected.suggestedMapping, [], 'PARTIAL')
    .rows[0]!.data!;
  for (const field of [
    'brandText',
    'manufacturerText',
    'modelText',
    'categoryText',
    'unitText',
    'price',
    'vatRate',
    'reportedGtin',
  ] as const)
    assert.equal(data[field], null);
  assert.equal(data.currency, 'ARS');
  assert.equal(data.priceIncludesVat, 'UNKNOWN');
});

test('columnas igualmente plausibles quedan REVIEW, incluidos nombres largos y numerados', () => {
  for (const [field, headers] of [
    ['brandText', ['MARCA', 'MARCA 2']],
    ['brandText', ['MARCA DEL PRODUCTO', 'MARCA PRODUCTO 2']],
    ['price', ['PRECIO DE LISTA', 'PRECIO UNITARIO']],
    ['price', ['PRECIO DE LISTA', 'PRECIO DE LISTA 2']],
    ['supplierCode', ['COD. ARTICULO', 'CODIGO DEL PRODUCTO']],
    ['reportedGtin', ['EAN-13', 'GTIN/EAN']],
  ] as const) {
    const result = detectMapping([...headers]);
    assert.equal(result.mapping[field], null);
    assert.equal(result.confidence[field], 'REVIEW');
  }
  const table = {
    name: 'Ambigua',
    rows: [
      ['CODIGO ARTICULO', 'CODIGO PRODUCTO'],
      ['001', '002'],
    ],
  };
  assert.equal(suggestSheet([inspectSheet(table)]), null);
});

test('palabras parecidas y calificadores desconocidos no se reconocen por coincidencia parcial', () => {
  for (const heading of [
    'PRECIOSO',
    'PRECIOSIDAD UNITARIA',
    'CODIGO POSTAL',
    'NOMBRE DEL PROVEEDOR',
    'MARCA REGISTRADA',
    'IMPUESTO INTERNO',
    'PRECIO ESTIMADO',
    'CON IVA SIN IVA PRECIO',
  ]) {
    const result = detectMapping([heading]);
    assert.ok(
      Object.values(result.mapping).every((column) => column === null),
      heading,
    );
    assert.ok(
      Object.values(result.confidence).every((confidence) => confidence === 'MISSING'),
      heading,
    );
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  catalogColumnMappingSchema,
  catalogCommercialOptionsSchema,
  catalogPreviewInputSchema,
} from '@maxbio/contracts';
import {
  inspectSheet,
  suggestMapping,
  suggestSheet,
  formatFingerprint,
} from '../src/modules/catalog/domain/catalog-detection.js';
import { planImport } from '../src/modules/catalog/domain/catalog-import.js';
import { commercialDecimal } from '../src/modules/catalog/domain/catalog-commercial.js';
import { parseCatalogFile } from '../src/modules/catalog/domain/catalog-file.js';
import { xlsxFixture, zipFixture } from './supplier-catalog-fixtures.js';

const commercial = catalogCommercialOptionsSchema.parse({
  defaultCurrency: 'ARS',
  currencyConfirmed: true,
});
const mapping = catalogColumnMappingSchema.parse({
  supplierCode: 0,
  description: 1,
  price: 2,
  vatRate: 3,
  alternateSupplierCode: 4,
  brandText: null,
  presentationText: null,
  reportedGtin: null,
});
const headers = ['CODIGO', 'DESCRIPCION', 'PRECIO', 'T.IVA', 'COD_EXT'];
const table = (rows: string[][]) => ({ name: 'Precios', rows: [headers, ...rows] });

test('sinónimos, columnas reordenadas y extra, encabezado fila 5, selección de hoja con confianza', () => {
  for (const code of ['CODIGO', 'CÓDIGO', 'SKU', 'ART', 'REF'])
    for (const description of ['DESCRIPCION', 'PRODUCTO', 'DETALLE', 'NOMBRE'])
      for (const price of ['PRECIO', 'P. UNITARIO', 'P UNITARIO', 'NETO']) {
        const value = inspectSheet({
          name: 'Comercial',
          rows: [
            ['Lista'],
            ['Vigencia'],
            [],
            [],
            ['TOTAL', price, description, code, 'IVA', 'COD_EXT', 'EAN', 'MONEDA'],
            ['999', '100.25', 'Referencia comercial', '01', '21', 'EXT', '4006381333931', 'USD'],
          ],
        });
        assert.equal(value.headerRow, 5);
        assert.equal(value.suggestedMapping.supplierCode, 3);
        assert.equal(value.suggestedMapping.description, 2);
        assert.equal(value.suggestedMapping.price, 1);
        assert.equal(value.suggestedMapping.vatRate, 4);
        assert.equal(value.suggestedMapping.alternateSupplierCode, 5);
        assert.equal(value.suggestedMapping.reportedGtin, 6);
        assert.equal(value.suggestedMapping.currency, 7);
        assert.equal(
          suggestSheet([inspectSheet({ name: 'Portada', rows: [['Lista'], ['Teléfono']] }), value]),
          'Comercial',
        );
        assert.equal(suggestSheet([value, { ...value, name: 'Otra lista' }]), null);
      }
  assert.equal(suggestMapping(['CODIGO', 'CODIGO 2', 'DESCRIPCION']).supplierCode, null);
  const ambiguous = inspectSheet({
    name: 'Ambigua',
    rows: [
      ['CODIGO', 'CODIGO 2', 'DESCRIPCION'],
      ['1', '2', 'Producto'],
    ],
  });
  assert.equal(ambiguous.confidence.supplierCode, 'REVIEW');
  assert.equal(ambiguous.tableConfidence, 'REVIEW');
});

test('contenido propone columnas desconocidas para revisión humana, nunca confirma', () => {
  const value = inspectSheet({
    name: 'Lista',
    rows: [
      ['Campo A', 'Campo B'],
      ['A-01', 'Bota walker corta'],
      ['B-02', 'Bota walker larga'],
    ],
  });
  assert.equal(value.suggestedMapping.supplierCode, 0);
  assert.equal(value.suggestedMapping.description, 1);
  assert.equal(value.confidence.supplierCode, 'REVIEW');
  assert.equal(suggestSheet([value]), null);
});

test('fingerprint estable ante precios/filas/nombre de archivo; perfil confirmado no se aplica a estructura nueva', () => {
  const first = inspectSheet(table([['A', 'Producto', '100', '21', 'X']]));
  const profile = {
    fingerprint: first.fingerprint,
    headers: first.headers,
    mapping,
    sheetName: first.name,
    headerRow: first.headerRow,
    commercial,
  };
  const next = inspectSheet(table([['B', 'Otro producto', '120', '10.5', 'Y']]), undefined, [
    profile,
  ]);
  assert.equal(next.profileApplied, true);
  assert.deepEqual(next.commercial, commercial);
  assert.equal(next.fingerprint, first.fingerprint);
  const changed = inspectSheet(
    {
      name: 'Nuevo',
      rows: [
        ['ARTICULO', 'DETALLE', 'VALOR'],
        ['B', 'Otro producto', '120'],
      ],
    },
    undefined,
    [profile],
  );
  assert.equal(changed.profileApplied, false);
  assert.equal(changed.commercial.currencyConfirmed, false);
  assert.equal(changed.suggestedMapping.supplierCode, 0);
  assert.notEqual(formatFingerprint([...headers].reverse()), first.fingerprint);
});

test('Decimal exacto, moneda explícita, IVA 0/10.5/21/null, alternativo y semántica desconocida', () => {
  const result = planImport(
    table([
      ['01', 'Producto A', '218505.11669999998', '0', 'EXT'],
      ['02', 'Producto B', '1.234,56789', '10,5', ''],
      ['03', 'Producto C', '', '21', ''],
      ['04', 'Producto D', '', '', ''],
    ]),
    1,
    mapping,
    [],
    'PARTIAL',
    commercial,
  );
  assert.equal(result.summary.errors, 0);
  assert.equal(result.rows[0]!.data!.price, '218505.11669999998');
  assert.equal(result.rows[1]!.data!.price, '1234.56789');
  assert.equal(result.rows[0]!.data!.currency, 'ARS');
  assert.equal(result.rows[0]!.data!.alternateSupplierCode, 'EXT');
  assert.deepEqual(
    result.rows.map((row) => row.data!.vatRate),
    ['0', '10.5', '21', null],
  );
  assert.equal(result.rows[3]!.data!.price, null);
  assert.equal(result.rows[0]!.data!.priceIncludesVat, 'UNKNOWN');
  const unknown = planImport(table([['A', 'Producto', '100', '', '']]), 1, mapping, [], 'PARTIAL');
  assert.equal(unknown.summary.errors, 1);
  assert.match(unknown.rows[0]!.messages.join(' '), /moneda/);
  assert.throws(() => commercialDecimal('1.234', 18), /ambiguo/);
  assert.equal(commercialDecimal('1.234', 18, 'COMMA'), '1234');
  assert.equal(commercialDecimal('1.234', 18, 'DOT'), '1.234');
  assert.throws(() => commercialDecimal('-100', 18), /no negativo/);
  assert.throws(() => commercialDecimal('123456789012345', 18), /precisión/);
  assert.throws(() => commercialDecimal('1 2', 18), /agrupación/);
  assert.equal(commercialDecimal('1 234,50', 18), '1234.5');
  assert.equal(commercialDecimal('1.23e-8', 18, 'DOT', true), '0.0000000123');
  assert.equal(
    planImport(table([['A', 'Producto', '21%', '21', '']]), 1, mapping, [], 'PARTIAL', commercial)
      .summary.errors,
    1,
  );
  assert.equal(
    planImport(
      table([['A', 'Producto', '100', 'USD 21', '']]),
      1,
      mapping,
      [],
      'PARTIAL',
      commercial,
    ).summary.errors,
    1,
  );
});

test('moneda en columna, precio null y vaciado explícito; reimport conserva opcionales ignorados y snapshots previos', () => {
  const old = planImport(
    table([['A', 'Producto', '100', '21', 'X']]),
    1,
    mapping,
    [],
    'PARTIAL',
    commercial,
  ).rows[0]!.data!;
  const previous = {
    ...old,
    id: randomUUID(),
    version: 1,
    archivedAt: null,
    missingFromLatestCompleteListAt: null,
  };
  const next = planImport(
    table([['A', 'Producto', '120', '10.5', 'Y']]),
    1,
    mapping,
    [previous],
    'PARTIAL',
    commercial,
  );
  assert.equal(next.summary.updated, 1);
  assert.equal(next.rows[0]!.data!.price, '120');
  assert.equal(old.price, '100');
  const untouched = planImport(
    table([['A', 'Producto']]),
    1,
    { ...mapping, price: null, vatRate: null, alternateSupplierCode: null },
    [previous],
    'PARTIAL',
  );
  assert.equal(untouched.rows[0]!.data!.price, '100');
  const blank = planImport(
    table([['A', 'Producto', '', '', '']]),
    1,
    mapping,
    [previous],
    'PARTIAL',
    commercial,
  );
  assert.equal(blank.rows[0]!.data!.price, null);
  assert.equal(blank.rows[0]!.data!.vatRate, null);
  const usd = planImport(
    {
      name: 'Lista',
      rows: [
        ['SKU', 'PRODUCTO', 'PRECIO', 'MONEDA'],
        ['B', 'Producto', '0', 'USD'],
      ],
    },
    1,
    { ...mapping, vatRate: null, alternateSupplierCode: null, currency: 3 },
    [],
    'PARTIAL',
  );
  assert.equal(usd.rows[0]!.data!.currency, 'USD');
  assert.equal(usd.rows[0]!.data!.price, '0');
  const embedded = planImport(
    table([['B', 'Producto', 'USD 100', '21', '']]),
    1,
    mapping,
    [],
    'PARTIAL',
    commercial,
  );
  assert.equal(embedded.rows[0]!.data!.currency, 'USD');
});

test('repetidos/vacíos/totales explícitos ignorados con evidencia; notas dudosas requieren excluir expresamente', () => {
  const result = planImport(
    table([
      ['A', 'Producto', '100', '21', ''],
      [],
      headers,
      ['TOTAL', '', '100', '', ''],
      ['', 'Nota del proveedor'],
      ['TOTAL', 'Totalizador médico', '10', '', ''],
    ]),
    1,
    mapping,
    [],
    'COMPLETE',
    commercial,
  );
  assert.equal(result.summary.created, 2);
  assert.equal(result.summary.empty, 3);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.absencesSuppressed, true);
  assert.match(result.rows[2]!.messages.join(' '), /Encabezado repetido/);
  assert.match(result.rows[3]!.messages.join(' '), /subtotal/);
  const manual = planImport(
    table([
      ['A', 'Producto', '100'],
      ['CATEGORY', 'Sección de la lista'],
    ]),
    1,
    mapping,
    [],
    'PARTIAL',
    commercial,
    [3],
  );
  assert.equal(manual.rows[1]!.outcome, 'EMPTY');
  assert.match(manual.rows[1]!.messages.join(' '), /expresamente/);
  const footer = planImport(
    {
      name: 'Lista',
      rows: [
        ['CODIGO', 'DESCRIPCION', 'PRECIO', 'OBS'],
        ['A', 'Producto', '100'],
        ['', '', '', 'Total'],
      ],
    },
    1,
    { ...mapping, vatRate: null, alternateSupplierCode: null },
    [],
    'COMPLETE',
    commercial,
  );
  assert.equal(footer.summary.errors, 0);
  assert.equal(footer.summary.empty, 1);
});

const formulaWorkbook = (cached = '<v>100.12345678901234</v>', type = 'n') =>
  xlsxFixture([{ name: 'Lista', rows: [] }], {
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>CODIGO</t></is></c><c r="B1" t="inlineStr"><is><t>DESCRIPCION</t></is></c><c r="C1" t="inlineStr"><is><t>PRECIO</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2" t="inlineStr"><is><t>Producto</t></is></c><c r="C2" t="${type}"><f>WEBSERVICE("http://127.0.0.1:1/never")</f>${cached}</c></row></sheetData></worksheet>`,
  });
test('fórmulas nunca ejecutadas: ignoradas, resultado guardado advertido, ausente/error bloquea solo campo usado', async () => {
  for (const [cache, type, errors] of [
    ['<v>100.12345678901234</v>', 'n', 0],
    ['', 'n', 1],
    ['', 'str', 1],
    ['<v>#DIV/0!</v>', 'e', 1],
  ] as const) {
    const parsed = await parseCatalogFile(
      formulaWorkbook(cache, type),
      'lista.xlsx',
      'application/octet-stream',
    );
    const selected = { ...mapping, vatRate: null, alternateSupplierCode: null };
    const imported = planImport(parsed.sheets[0]!, 1, selected, [], 'PARTIAL', commercial);
    assert.equal(imported.summary.errors, errors);
    if (!errors) {
      assert.equal(imported.rows[0]!.data!.price, '100.12345678901234');
      assert.equal(imported.summary.warnings, 1);
    }
    const ignored = planImport(parsed.sheets[0]!, 1, { ...selected, price: null }, [], 'PARTIAL');
    assert.equal(ignored.summary.created, 1);
    assert.equal(ignored.summary.warnings, 0);
  }
});

test('enlaces externos nunca solicitados, aunque exista relación de red y fórmula: solo advertencia', async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end('never');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const parsed = await parseCatalogFile(
      xlsxFixture([table([['A', 'Producto', '100', '21', 'X']])], {
        'xl/externalLinks/externalLink1.xml': '<externalLink/>',
        'xl/externalLinks/_rels/externalLink1.xml.rels': `<Relationships><Relationship Id="external" Type="externalLinkPath" TargetMode="Exter&#110;al" Target="http://127.0.0.1:${address.port}/never"/></Relationships>`,
      }),
      'lista.xlsx',
      'application/octet-stream',
    );
    assert.match(parsed.warnings.join(' '), /vínculos externos/);
    assert.equal(requests, 0);
    assert.equal(
      planImport(parsed.sheets[0]!, 1, mapping, [], 'PARTIAL', commercial).summary.created,
      1,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('porcentajes de Excel se convierten exactamente a IVA declarado, sin calcular impuestos', async () => {
  const parsed = await parseCatalogFile(
    xlsxFixture([{ name: 'Lista', rows: [] }], {
      'xl/styles.xml':
        '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>CODIGO</t></is></c><c r="B1" t="inlineStr"><is><t>DESCRIPCION</t></is></c><c r="D1" t="inlineStr"><is><t>IVA</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>A</t></is></c><c r="B2" t="inlineStr"><is><t>Producto</t></is></c><c r="D2" s="1"><v>0.105</v></c></row></sheetData></worksheet>',
    }),
    'lista.xlsx',
    'application/octet-stream',
  );
  const result = planImport(
    parsed.sheets[0]!,
    1,
    { ...mapping, price: null, alternateSupplierCode: null },
    [],
    'PARTIAL',
  );
  assert.equal(result.rows[0]!.data!.vatRate, '10.5');
});

test('CSV detecta delimitador después de títulos y conserva fila de encabezado', async () => {
  for (const delimiter of [',', ';', '\t']) {
    const parsed = await parseCatalogFile(
      Buffer.from(
        [
          'LISTA DE PRECIOS',
          'Vigencia',
          '',
          '',
          ['SKU', 'DETALLE', 'PRECIO'].join(delimiter),
          ['001', 'Bota walker', '100'].join(delimiter),
        ].join('\n'),
      ),
      'lista.csv',
      'text/csv',
    );
    const value = inspectSheet(parsed.sheets[0]!);
    assert.equal(value.headerRow, 5);
    assert.equal(value.suggestedMapping.price, 2);
    assert.equal(parsed.sheets[0]!.rows[5]![0], '001');
  }
});

test('seguridad preservada: XML malformado, DTD/entidades, path traversal y rangos de fórmula fuera de límites', async () => {
  for (const content of [
    '<worksheet><row></worksheet>',
    '<!DOCTYPE worksheet SYSTEM "http://127.0.0.1:1/never"><worksheet/>',
    '<worksheet><row r="1"><c r="A1"><f ref="A1:XFD1048576">1</f><v>1</v></c></row></worksheet>',
  ])
    await assert.rejects(
      parseCatalogFile(
        xlsxFixture([{ name: 'Lista', rows: [] }], { 'xl/worksheets/sheet1.xml': content }),
        'lista.xlsx',
        'application/octet-stream',
      ),
    );
  await assert.rejects(
    parseCatalogFile(
      zipFixture({
        '[Content_Types].xml': '<x/>',
        'xl/workbook.xml': '<x/>',
        '../danger.xml': '<x/>',
      }),
      'lista.xlsx',
      'application/octet-stream',
    ),
  );
  assert.equal(
    catalogPreviewInputSchema.safeParse({
      uploadId: randomUUID(),
      sheet: 'Lista',
      headerRow: 1,
      mapping,
      mode: 'PARTIAL',
      organizationId: randomUUID(),
    }).success,
    false,
  );
});

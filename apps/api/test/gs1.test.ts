import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { scanInputSchema, scanReasonCodeSchema, scanResultSchema } from '@maxbio/contracts';
import { expirationFromYymmdd, parseGs1 } from '../src/common/domain/scanning/gs1.js';
import {
  GS1_REASON_CODES,
  MAX_GS1_ELEMENTS,
  MAX_GS1_ISSUES,
  type Gs1Parsed,
  type Gs1ParseResult,
} from '../src/common/domain/scanning/gs1-types.js';
import { canonicalGtin, hasValidGtinCheckDigit } from '../src/common/domain/scanning/gtin.js';
import { classifyScan } from '../src/modules/catalog/domain/catalog-scan.js';

// Synthetic fixtures (gs1-design.md §17). GS is a real U+001D, never the visible "<GS>".
const G = '04006381333931',
  ES = '01' + G,
  GS = '\x1d';
const parse = (raw: string, referenceYear = 2026) => parseGs1(raw, { referenceYear });
function gs1(raw: string, referenceYear = 2026): Gs1Parsed {
  const result = parse(raw, referenceYear);
  assert.equal(result.kind, 'GS1', JSON.stringify({ raw, result }));
  return result as Gs1Parsed;
}
const codes = (result: Gs1Parsed) => result.issues.map((issue) => issue.code);
function rejected(raw: string, reasonCode: string, status = 'INVALID') {
  assert.deepEqual(parse(raw), { kind: 'REJECTED', status, reasonCode }, JSON.stringify(raw));
}
const classify = (value: string, extra: object = {}) =>
  classifyScan(scanInputSchema.parse({ value, ...extra }), { referenceYear: 2026 });
const FOUR = { gtin14: G, lotNumber: 'ABC', serialNumber: 'S9982' };
const EXP = { expirationDate: '2028-12-31', expiration: { encoded: '281231', precision: 'DAY' } };

test('GTIN compartido: checksum y canonical14 idénticos al flujo legacy', () => {
  assert.equal(hasValidGtinCheckDigit(G), true);
  assert.equal(hasValidGtinCheckDigit('4006381333931'), true);
  assert.equal(hasValidGtinCheckDigit('07791234567890'), false);
  assert.equal(canonicalGtin('96385074'), '00000096385074');
  assert.deepEqual([...GS1_REASON_CODES], scanReasonCodeSchema.options);
});

test('#1-#6 campos individuales y combinados en element string', () => {
  const only = gs1(ES);
  assert.equal(only.status, 'VALID');
  assert.deepEqual(only.fields, { gtin14: G });
  assert.equal(only.syntax, 'ELEMENT_STRING');
  assert.equal(only.symbology, null);
  assert.equal(only.canResolveIdentity, true);
  assert.equal(only.canApplyPhysicalData, true);
  assert.deepEqual(gs1(ES + '10ABC').fields, { gtin14: G, lotNumber: 'ABC' });
  assert.deepEqual(gs1(ES + '17281231').fields, { gtin14: G, ...EXP });
  assert.deepEqual(gs1(ES + '21S9982').fields, { gtin14: G, serialNumber: 'S9982' });
  assert.deepEqual(gs1(ES + '1728123110ABC').fields, { gtin14: G, lotNumber: 'ABC', ...EXP });
  const four = gs1(ES + '1728123110ABC' + GS + '21S9982');
  assert.equal(four.status, 'VALID');
  assert.deepEqual(four.fields, { ...FOUR, ...EXP });
  assert.deepEqual(
    four.elements.map((e) => [e.ai, e.start, e.end]),
    [
      ['01', 2, 16],
      ['17', 18, 24],
      ['10', 26, 29],
      ['21', 32, 37],
    ],
  );
});

test('#7-#8 orden alternativo, variable inicial delimitada y AIM DataMatrix', () => {
  const alt = gs1(']d221S9982' + GS + '10ABC' + GS + '17281231' + ES);
  assert.equal(alt.status, 'VALID');
  assert.equal(alt.symbology, 'GS1_DATAMATRIX');
  assert.equal(alt.aimPrefix, ']d2');
  assert.deepEqual(alt.fields, { ...FOUR, ...EXP });
  const first = gs1('10ABC' + GS + ES + '17281231');
  assert.equal(first.status, 'VALID');
  assert.deepEqual(first.fields, { gtin14: G, lotNumber: 'ABC', ...EXP });
});

test('#9-#11 variables no se cortan por dígitos internos y conservan case/puntuación', () => {
  assert.deepEqual(gs1(ES + '10ABC1017XYZ').fields, { gtin14: G, lotNumber: 'ABC1017XYZ' });
  // A lost GS cannot be detected while the remainder is still a valid lot.
  const lost = gs1(ES + '10ABC17281231');
  assert.equal(lost.status, 'VALID');
  assert.deepEqual(lost.fields, { gtin14: G, lotNumber: 'ABC17281231' });
  assert.deepEqual(gs1(ES + '21aB09-_/Z').fields, { gtin14: G, serialNumber: 'aB09-_/Z' });
  assert.deepEqual(gs1(ES + '10ABC21S1').fields, { gtin14: G, lotNumber: 'ABC21S1' });
});

test('#12 AIM soportados: misma identidad, symbology distinta, prefijo fuera de los datos', () => {
  for (const [aim, symbology] of [
    [']d2', 'GS1_DATAMATRIX'],
    [']C1', 'GS1_128'],
    [']Q3', 'GS1_QR'],
  ] as const) {
    const result = gs1(aim + ES + '10LOT');
    assert.equal(result.symbology, symbology);
    assert.equal(result.aimPrefix, aim);
    assert.deepEqual(result.fields, { gtin14: G, lotNumber: 'LOT' });
  }
  assert.deepEqual(gs1(']C1' + ES + '1728123110LOTE123').fields, {
    gtin14: G,
    lotNumber: 'LOTE123',
    ...EXP,
  });
});

test('#13-#14 HRI equivalente e independiente del orden', () => {
  const hri = gs1('(01)' + G + '(17)281231(10)ABC(21)S9982');
  assert.equal(hri.syntax, 'HRI');
  assert.equal(hri.status, 'VALID');
  assert.deepEqual(hri.fields, { ...FOUR, ...EXP });
  assert.deepEqual(gs1('(21)S9982(10)ABC(01)' + G + '(17)281231').fields, { ...FOUR, ...EXP });
});

test('#15-#17 GTIN inválido nunca se rescata; AI01 exige 14 dígitos', () => {
  for (const raw of ['(01)04006381333932', '(01)07791234567890', '(01)4006381333931']) {
    const result = gs1(raw);
    assert.equal(result.status, 'INVALID');
    assert.equal(result.canResolveIdentity, false);
    assert.deepEqual(codes(result), ['INVALID_GTIN']);
    const catalog = classify(raw, { supplierId: randomUUID() });
    assert.ok('status' in catalog && catalog.status === 'INVALID');
    assert.equal('identity' in catalog, false);
  }
  assert.deepEqual(parse('4006381333931'), { kind: 'NOT_GS1' });
  const bad = classify('01' + '04006381333932' + '10ABC');
  assert.ok('status' in bad && bad.reasonCode === 'INVALID_GTIN');
});

test('#18-#22 fechas: inválida PARTIAL, bisiestos, día 00 en revisión, sin rollover', () => {
  const partial = gs1('(01)' + G + '(10)ABC(17)280231');
  assert.equal(partial.status, 'PARTIAL');
  assert.deepEqual(partial.fields, { gtin14: G, lotNumber: 'ABC' });
  assert.deepEqual(codes(partial), ['INVALID_EXPIRATION']);
  assert.equal(partial.canResolveIdentity, true);
  assert.equal(partial.canApplyPhysicalData, false);
  assert.equal(gs1('(01)' + G + '(17)280229').fields.expirationDate, '2028-02-29');
  assert.deepEqual(codes(gs1('(01)' + G + '(17)270229')), ['INVALID_EXPIRATION']);
  const month = gs1('(01)' + G + '(17)280200');
  assert.equal(month.status, 'PARTIAL');
  assert.equal(month.fields.expirationDate, '2028-02-29');
  assert.deepEqual(month.fields.expiration, { encoded: '280200', precision: 'MONTH' });
  assert.deepEqual(month.issues, [
    { code: 'EXPIRATION_DAY_UNSPECIFIED', severity: 'REVIEW', ai: '17', offset: 22 },
  ]);
  assert.equal(month.canApplyPhysicalData, false);
  assert.equal(gs1('(01)' + G + '(17)270200').fields.expirationDate, '2027-02-28');
  for (const value of ['281300', '280000', '281232', '28AA31', '28123', '2812311']) {
    const result = gs1('(01)' + G + '(17)' + value);
    assert.deepEqual(codes(result), ['INVALID_EXPIRATION'], value);
    assert.equal(result.fields.expirationDate, undefined);
  }
  assert.deepEqual(codes(gs1(ES + '17281300')), ['INVALID_EXPIRATION']);
});

test('#23-#25 ventana de siglo Y-49..Y+50 con referenceYear inyectado', () => {
  assert.equal(expirationFromYymmdd('770101', 2026)?.date, '1977-01-01');
  assert.equal(expirationFromYymmdd('761231', 2026)?.date, '2076-12-31');
  assert.equal(expirationFromYymmdd('280101', 2026)?.date, '2028-01-01');
  assert.equal(expirationFromYymmdd('770101', 2027)?.date, '2077-01-01');
  assert.equal(expirationFromYymmdd('000229', 2050), null);
  assert.equal(expirationFromYymmdd('000229', 1999)?.date, '2000-02-29');
  assert.equal(gs1(ES + '17770101', 2027).fields.expirationDate, '2077-01-01');
  assert.equal(gs1(ES + '17770101', 2026).fields.expirationDate, '1977-01-01');
  assert.throws(() => parseGs1(ES, { referenceYear: 26 }), RangeError);
  assert.throws(() => parseGs1(ES, { referenceYear: Number.NaN }), RangeError);
});

test('#26-#28 duplicados: nunca first/last-wins; AI01 duplicado bloquea identidad', () => {
  for (const raw of ['(01)' + G + '(10)A(10)B', '(01)' + G + '(10)A(10)A']) {
    const result = gs1(raw);
    assert.equal(result.status, 'PARTIAL');
    assert.equal(result.fields.lotNumber, undefined);
    assert.deepEqual(codes(result), ['DUPLICATE_AI']);
    assert.equal(result.canResolveIdentity, true);
    assert.equal(result.canApplyPhysicalData, false);
    assert.equal(result.elements.filter((e) => e.ai === '10').length, 2);
  }
  const serial = gs1('(01)' + G + '(21)A(21)B');
  assert.equal(serial.fields.serialNumber, undefined);
  assert.deepEqual(codes(serial), ['DUPLICATE_AI']);
  const date = gs1(ES + '17281231' + '17281231');
  assert.equal(date.fields.expirationDate, undefined);
  assert.equal(date.fields.expiration, undefined);
  const gtin = gs1('(01)' + G + '(01)' + G);
  assert.equal(gtin.status, 'INVALID');
  assert.equal(gtin.canResolveIdentity, false);
  assert.equal(gtin.fields.gtin14, undefined);
});

test('#29-#32 AI no soportados: HRI y AI11 delimitados PARTIAL; cola raw desconocida se detiene', () => {
  for (const raw of ['(01)' + G + '(11)260101(17)281231', ES + '1126010117281231']) {
    const result = gs1(raw);
    assert.equal(result.status, 'PARTIAL');
    assert.deepEqual(result.fields, { gtin14: G, ...EXP });
    assert.deepEqual(
      result.issues.map(({ code, severity, ai }) => ({ code, severity, ai })),
      [{ code: 'UNSUPPORTED_AI', severity: 'REVIEW', ai: '11' }],
    );
    assert.equal(Object.hasOwn(result.fields, 'productionDate'), false);
  }
  const hri = gs1('(01)' + G + '(91)OTRO(17)281231');
  assert.equal(hri.status, 'PARTIAL');
  assert.deepEqual(hri.fields, { gtin14: G, ...EXP });
  assert.deepEqual(codes(hri), ['UNSUPPORTED_AI']);
  const raw = gs1(ES + '91OTRO' + GS + '17281231');
  assert.equal(raw.complete, false);
  assert.equal(raw.status, 'INVALID');
  assert.equal(raw.canResolveIdentity, false);
  assert.equal(raw.fields.expirationDate, undefined);
  assert.deepEqual(codes(raw), ['UNSUPPORTED_AI']);
  const catalog = classify(ES + '91OTRO' + GS + '17281231');
  assert.ok('status' in catalog && catalog.status === 'UNSUPPORTED');
  assert.equal('identity' in catalog, false);
  assert.deepEqual(codes(gs1('(01)' + G + '(11)26AB01')), ['INVALID_FIELD_LENGTH']);
});

test('#33-#36 truncados, variables vacías y longitudes 20/21 sin recorte', () => {
  for (const raw of [']d20104006', ES + '1728', ']C1', ES + '10', ES + '1']) {
    const result = gs1(raw);
    assert.equal(result.status, 'INVALID', raw);
    assert.equal(result.complete, false);
    assert.deepEqual(codes(result), ['TRUNCATED_ELEMENT'], raw);
    const catalog = classify(raw);
    assert.ok('status' in catalog && catalog.status === 'INVALID', raw);
  }
  assert.deepEqual(codes(gs1('(01)')), ['INVALID_GTIN']);
  const emptyHri = gs1('(01)' + G + '(21)');
  assert.equal(emptyHri.fields.serialNumber, undefined);
  assert.deepEqual(codes(emptyHri), ['INVALID_FIELD_LENGTH']);
  assert.deepEqual(codes(gs1(ES + '10' + GS + '21S1')), ['INVALID_FIELD_LENGTH']);
  const twenty = 'A'.repeat(20),
    long = 'A'.repeat(21);
  assert.equal(gs1(ES + '10' + twenty).fields.lotNumber, twenty);
  assert.equal(gs1('(01)' + G + '(21)' + twenty).fields.serialNumber, twenty);
  const missing = gs1(ES + '10' + long);
  assert.deepEqual(codes(missing), ['MISSING_SEPARATOR']);
  assert.equal(missing.status, 'INVALID');
  assert.equal(missing.fields.lotNumber, undefined);
  const hriLong = gs1('(01)' + G + '(10)' + long);
  assert.deepEqual(codes(hriLong), ['INVALID_FIELD_LENGTH']);
  assert.equal(hriLong.fields.lotNumber, undefined);
  const lost = gs1(ES + '10' + twenty + '17281231');
  assert.deepEqual(codes(lost), ['MISSING_SEPARATOR']);
  assert.equal(lost.fields.expirationDate, undefined);
});

test('#37-#38 paréntesis: dato literal en element string, delimitador en HRI', () => {
  const literal = gs1(ES + '10ABC(17)XYZ');
  assert.equal(literal.status, 'VALID');
  assert.deepEqual(literal.fields, { gtin14: G, lotNumber: 'ABC(17)XYZ' });
  const hri = gs1('(01)' + G + '(10)ABC(17)XYZ');
  assert.equal(hri.fields.lotNumber, 'ABC');
  assert.deepEqual(codes(hri), ['INVALID_EXPIRATION']);
  assert.equal(gs1('(01)' + G + '(10)AB(C)').fields.lotNumber, 'AB(C)');
});

test('#39-#40 separadores y formatos mixtos', () => {
  for (const raw of [GS + ES, ES + '10A' + GS + GS + '21B', ES + '10A' + GS, ES + GS])
    assert.deepEqual(codes(gs1(raw)), ['UNEXPECTED_SEPARATOR'], JSON.stringify(raw));
  // GS after a predefined-length element is tolerated when another AI follows.
  assert.deepEqual(gs1(ES + GS + '10ABC').fields, { gtin14: G, lotNumber: 'ABC' });
  rejected(']d2]C1' + ES, 'MIXED_FORMAT');
  rejected(']d2(01)' + G, 'MIXED_FORMAT');
  rejected('(01)' + G + GS + '10A', 'MIXED_FORMAT');
  rejected('ABC(10)LOT', 'MIXED_FORMAT');
  const embedded = classify('XX(01)' + G);
  assert.ok('status' in embedded && embedded.reasonCode === 'MIXED_FORMAT');
});

test('#41-#44 Unicode/controles rechazados, caracteres fuera del set 82, transporte y GS visible', () => {
  rejected(ES + '10Aé', 'INVALID_CHARACTER');
  rejected(ES + '10A😀', 'INVALID_CHARACTER');
  rejected(ES + '10A\ud800', 'INVALID_CHARACTER');
  rejected('(01)' + G + '(10)Aé', 'INVALID_CHARACTER');
  for (const control of ['\x00', '\x7f', '\t', '\x85', '\n', '\r'])
    rejected(ES + '10A' + control + 'B', 'INVALID_CONTROL');
  for (const raw of [
    ES + '10A B',
    ES + '10ABC ',
    ES + '10A#',
    ES + '10A$',
    ES + '10A@',
    ES + '10A\\',
  ]) {
    const result = gs1(raw);
    assert.deepEqual(codes(result), ['INVALID_CHARACTER'], raw);
    assert.equal(result.fields.lotNumber, undefined);
  }
  for (const raw of ['  ' + ES, ES + '\r\n', ES + '\n', ES + '\r', ES + '\t', ' (01)' + G])
    assert.deepEqual(gs1(raw).fields, { gtin14: G }, JSON.stringify(raw));
  const visible = gs1(ES + '10A<GS>21B');
  assert.deepEqual(visible.fields, { gtin14: G, lotNumber: 'A<GS>21B' });
  for (const alias of ['{GS}', '^', '~', '|', '␝', '\\x1D']) {
    const result = parse(ES + '10A' + alias + '21B');
    assert.ok(result.kind !== 'GS1' || result.fields.serialNumber === undefined, alias);
  }
});

test('#45-#47 límites de longitud, elementos e issues; GTIN ausente', () => {
  const max = ES + '10' + 'A'.repeat(512 - ES.length - 2);
  assert.equal(max.length, 512);
  const atLimit = parse(max);
  assert.notEqual(atLimit.kind === 'REJECTED' && atLimit.reasonCode, 'SCAN_TOO_LONG');
  rejected(max + 'A', 'SCAN_TOO_LONG');
  rejected('x'.repeat(10000), 'SCAN_TOO_LONG');
  rejected('', 'EMPTY_SCAN');
  const elements = gs1('(01)' + G + '(10)A'.repeat(40));
  assert.equal(elements.complete, false);
  assert.equal(elements.status, 'INVALID');
  assert.ok(elements.elements.length <= MAX_GS1_ELEMENTS);
  assert.ok(codes(elements).includes('TOO_MANY_ELEMENTS'));
  const issues = gs1('(01)' + G + '(91)X'.repeat(20));
  assert.equal(issues.issues.length, MAX_GS1_ISSUES);
  assert.equal(issues.issues.at(-1)?.code, 'TOO_MANY_ISSUES');
  assert.equal(issues.status, 'INVALID');
  const missing = gs1('(10)ABC(17)281231');
  assert.equal(missing.status, 'INVALID');
  assert.deepEqual(codes(missing), ['MISSING_GTIN']);
  assert.equal(missing.canResolveIdentity, false);
});

test('#48-#49 Digital Link no soportado; AIM genéricos o desconocidos conservan legacy', () => {
  rejected(
    'https://id.gs1.org/01/' + G + '/10/ABC/21/S9982?17=281231',
    'UNSUPPORTED_FORMAT',
    'UNSUPPORTED',
  );
  rejected('HTTPS://example.com/01/' + G, 'UNSUPPORTED_FORMAT', 'UNSUPPORTED');
  const dl = classify('https://id.gs1.org/01/' + G, { supplierId: randomUUID() });
  assert.ok('status' in dl && dl.status === 'UNSUPPORTED');
  assert.deepEqual(parse('https://example.com/producto'), { kind: 'NOT_GS1' });
  for (const raw of [']d1HELLO', ']Q1HELLO', ']C0ABC123', ']e0HELLO', 'HELLO WORLD', 'DL2115']) {
    assert.deepEqual(parse(raw), { kind: 'NOT_GS1' }, raw);
    const supplierId = randomUUID();
    assert.deepEqual(classify(raw, { supplierId }), {
      identity: { kind: 'SUPPLIER_BARCODE', value: raw, normalizedValue: raw, supplierId },
    });
  }
  rejected(']d1' + ES + '10A', 'FORMAT_CONFLICT', 'UNSUPPORTED');
  rejected(']Q1(01)' + G, 'FORMAT_CONFLICT', 'UNSUPPORTED');
  rejected(']e0' + ES, 'UNSUPPORTED_SYMBOLOGY', 'UNSUPPORTED');
});

test('#50-#51 regresiones legacy: GTIN, MB-, INTERNAL_CODE y externos', () => {
  for (const [value, normalizedValue] of [
    ['4006381333931', G],
    ['96385074', '00000096385074'],
    ['036000291452', '00036000291452'],
    [G, G],
  ] as const)
    assert.deepEqual(classify(value), {
      identity: { kind: 'GTIN', value, normalizedValue, supplierId: null },
    });
  assert.deepEqual(classify(' MB-WALKER '), {
    identity: {
      kind: 'INTERNAL_BARCODE',
      value: 'MB-WALKER',
      normalizedValue: 'MB-WALKER',
      supplierId: null,
    },
  });
  assert.ok('status' in classify('MB-lower'));
  assert.deepEqual(classify('DL2115', { namespace: 'INTERNAL_CODE' }), {
    identity: {
      kind: 'INTERNAL_CODE',
      value: 'DL2115',
      normalizedValue: 'DL2115',
      supplierId: null,
    },
  });
  assert.deepEqual(classify('EXT-1'), {
    identity: {
      kind: 'SUPPLIER_BARCODE',
      value: 'EXT-1',
      normalizedValue: 'EXT-1',
      supplierId: null,
    },
  });
  for (const value of ['4006381333932', '04006381333932', 'a\tbc', 'a'.repeat(129), '   '])
    assert.equal(
      (classify(value, { supplierId: randomUUID() }) as { status: string }).status,
      'INVALID',
    );
  // GS1 never becomes an internal code, and invalid GS1 never becomes SUPPLIER_BARCODE.
  const internal = classify('(01)' + G, { namespace: 'INTERNAL_CODE' });
  assert.ok('status' in internal && internal.reasonCode === 'FORMAT_CONFLICT');
  for (const raw of [
    '(01)' + G + '(01)' + G,
    '01ABCDEFGHIJKLMNOP',
    ']d2' + ES.slice(0, 10),
    ES + GS,
  ]) {
    const result = classify(raw, { supplierId: randomUUID() });
    assert.ok('status' in result, raw);
    assert.equal('identity' in result, false);
  }
});

test('catálogo: identidad GTIN canónica + interpretación sin raw, offsets ni valores desconocidos', () => {
  const result = classify(']d2' + ES + '17280200' + '10ABC' + GS + '91SECRETO');
  assert.ok('status' in result && result.status === 'UNSUPPORTED');
  assert.doesNotMatch(JSON.stringify(result), /SECRETO|offset|elements/);
  const known = classify(']d2' + ES + '1728020010ABC' + GS + '21S9982');
  assert.ok(!('status' in known));
  assert.deepEqual(known.identity, {
    kind: 'GTIN',
    value: G,
    normalizedValue: G,
    supplierId: null,
  });
  assert.deepEqual(known.scan, {
    format: 'GS1',
    status: 'PARTIAL',
    syntax: 'ELEMENT_STRING',
    symbology: 'GS1_DATAMATRIX',
    referenceYear: 2026,
    fields: {
      gtin14: G,
      expirationDate: '2028-02-29',
      expiration: { encoded: '280200', precision: 'MONTH' },
      lotNumber: 'ABC',
      serialNumber: 'S9982',
    },
    issues: [{ code: 'EXPIRATION_DAY_UNSPECIFIED', severity: 'REVIEW', ai: '17' }],
    canApplyPhysicalData: false,
  });
  const hri = classify('(01)' + G + '(91)SECRETO');
  assert.ok(!('status' in hri));
  assert.doesNotMatch(JSON.stringify(hri), /SECRETO|offset|elements|\]d2/);
  assert.ok(
    scanResultSchema.safeParse({
      status: 'UNKNOWN',
      identity: hri.identity,
      message: 'x',
      scan: { ...hri.scan, raw: 'x' },
    }).success === false,
  );
});

test('transporte: U+001D sobrevive JSON.stringify → JSON.parse → contrato estricto → parser', () => {
  const body = JSON.stringify({ value: ']d2' + ES + '10LOT' + GS + '21SER' });
  assert.match(body, /\\u001d/);
  assert.equal(body.includes(GS), false);
  const input = scanInputSchema.parse(JSON.parse(body));
  assert.equal(input.value.charCodeAt(input.value.indexOf('LOT') + 3), 29);
  const result = classifyScan(input, { referenceYear: 2026 });
  assert.ok(!('status' in result));
  assert.deepEqual(result.scan?.fields, { gtin14: G, lotNumber: 'LOT', serialNumber: 'SER' });
});

test('permutaciones de los cuatro AIs, delimitadas en element string y HRI', () => {
  const parts = [
    ['01', G, true],
    ['10', 'aBc-1', false],
    ['17', '281231', true],
    ['21', 'Ser/9', false],
  ] as const;
  const expected = { gtin14: G, lotNumber: 'aBc-1', serialNumber: 'Ser/9', ...EXP };
  const permutations = (items: readonly (typeof parts)[number][]): (typeof parts)[number][][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
        );
  const all = permutations(parts);
  assert.equal(all.length, 24);
  for (const order of all) {
    const raw = order
      .map(
        ([ai, value, fixed], index) => ai + value + (!fixed && index < order.length - 1 ? GS : ''),
      )
      .join('');
    for (const candidate of [raw, ']d2' + raw, ']C1' + raw, ']Q3' + raw]) {
      const result = gs1(candidate);
      assert.equal(result.status, 'VALID', JSON.stringify(candidate));
      assert.deepEqual(result.fields, expected);
    }
    const hri = gs1(order.map(([ai, value]) => `(${ai})${value}`).join(''));
    assert.equal(hri.status, 'VALID');
    assert.deepEqual(hri.fields, expected);
  }
});

test('corpus adversarial determinista: termina, acota salida, no lanza y conserva case', () => {
  let seed = 0x2026;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const alphabet = [
    '0',
    '1',
    '7',
    '2',
    '(',
    ')',
    GS,
    ']',
    'd',
    'C',
    'Q',
    '3',
    'a',
    'Z',
    ' ',
    '\r',
    '\n',
    'é',
    '\x00',
    '-',
    '%',
  ];
  const seeds = [ES, '(01)' + G, ']d2' + ES, '10', '17', '21', '(10)', '(21)', '(91)'];
  for (let n = 0; n < 5000; n++) {
    let raw = n % 3 ? seeds[next() % seeds.length]! : '';
    const length = next() % (n % 50 === 0 ? 700 : 80);
    for (let i = 0; i < length; i++) raw += alphabet[next() % alphabet.length];
    let first: Gs1ParseResult | undefined;
    for (const run of [0, 1]) {
      const result = parse(raw);
      if (run === 0) first = result;
      else assert.deepEqual(result, first);
      if (raw.length > 512)
        assert.equal(result.kind === 'REJECTED' && result.reasonCode, 'SCAN_TOO_LONG');
      if (result.kind !== 'GS1') continue;
      assert.ok(result.issues.length <= MAX_GS1_ISSUES);
      assert.ok(result.elements.length <= MAX_GS1_ELEMENTS);
      for (const value of [result.fields.lotNumber, result.fields.serialNumber])
        if (value !== undefined) assert.ok(raw.includes(value), JSON.stringify(raw));
      if (result.canApplyPhysicalData) assert.equal(result.issues.length, 0);
      if (result.canResolveIdentity) assert.equal(result.fields.gtin14?.length, 14);
    }
    assert.doesNotThrow(() =>
      classifyScan({ value: raw.slice(0, 512) || 'x', namespace: 'AUTO' }, { referenceYear: 2026 }),
    );
  }
});

test('rendimiento lineal y acotado: 10000 lecturas de 512 caracteres', () => {
  const inputs = [
    ES + '10' + 'A'.repeat(20) + GS + '21' + 'B'.repeat(20) + GS + '17281231',
    '(01)' + G + '(91)X'.repeat(98),
    ES + '10' + 'A'.repeat(512 - 18),
    ('(10)' + 'A'.repeat(20)).repeat(21).slice(0, 512),
  ];
  for (const raw of inputs) assert.ok(raw.length <= 512);
  for (let i = 0; i < 500; i++) for (const raw of inputs) parse(raw);
  const durations: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const start = performance.now();
    parse(inputs[i % inputs.length]!);
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  // Generous bound to avoid CI flakiness; the design target (p95 < 5 ms) is orders of magnitude above.
  assert.ok(durations[Math.floor(durations.length * 0.95)]! < 50);
});

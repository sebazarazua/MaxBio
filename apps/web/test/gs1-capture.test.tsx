import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import {
  scanInputSchema,
  scanInterpretationSchema,
  type ScanInterpretation,
} from '@maxbio/contracts';
import {
  capturePlan,
  displayDate,
  pastedReadingProblem,
  physicalSummary,
  sameCaptureGroup,
  serialInOperation,
} from '../src/lib/gs1-capture.js';

mock.module('server-only', { namedExports: {} });
const { POST } = await import('../src/app/api/catalog/[...path]/route.js');

const GS = '\x1d',
  G = '04006381333931';
const none = { lotRequired: false, expirationRequired: false, serialRequired: false };
const all = { lotRequired: true, expirationRequired: true, serialRequired: true };
function scan(
  fields: ScanInterpretation['fields'],
  issues: ScanInterpretation['issues'] = [],
): ScanInterpretation {
  return scanInterpretationSchema.parse({
    format: 'GS1',
    status: issues.length ? 'PARTIAL' : 'VALID',
    syntax: 'ELEMENT_STRING',
    symbology: 'GS1_DATAMATRIX',
    referenceYear: 2026,
    fields: { gtin14: G, ...fields },
    issues,
    canApplyPhysicalData: issues.length === 0,
  });
}
const day = {
  expirationDate: '2028-12-31',
  expiration: { encoded: '281231', precision: 'DAY' },
} as const;

test('precarga de cuatro campos según policy; solo GTIN equivale al flujo legacy', () => {
  const four = scan({ lotNumber: 'ABC123', serialNumber: 'S9982', ...day });
  assert.deepEqual(capturePlan(four, all), {
    lot: 'ABC123',
    expiration: '2028-12-31',
    serial: 'S9982',
    review: [],
    notes: [],
  });
  assert.deepEqual(capturePlan(scan({}), none), {
    lot: '',
    expiration: '',
    serial: null,
    review: [],
    notes: [],
  });
  assert.deepEqual(capturePlan(undefined, all).notes, []);
  assert.deepEqual(physicalSummary(four), ['Lote: ABC123', 'Vence: 31/12/2028', 'Serie: S9982']);
  assert.equal(displayDate('2028-02-29'), '29/02/2028');
});

test('obligatorios ausentes piden el dato; datos opcionales del scan se conservan', () => {
  assert.deepEqual(capturePlan(scan({}), all).notes, [
    'Este producto requiere lote. Ingresalo desde la etiqueta.',
    'Este producto requiere vencimiento. Ingresalo desde la etiqueta.',
    'Este producto requiere una serie por unidad. Ingresala desde la etiqueta.',
  ]);
  const optional = capturePlan(scan({ lotNumber: 'L1', ...day }), none);
  assert.equal(optional.lot, 'L1');
  assert.equal(optional.expiration, '2028-12-31');
  assert.deepEqual(optional.review, []);
  const anonymous = capturePlan(scan({ ...day }), none);
  assert.equal(anonymous.lot, '');
  assert.equal(anonymous.expiration, '2028-12-31');
});

test('serie con policy false: revisión explícita, nunca se envía ni se pierde en silencio', () => {
  const plan = capturePlan(scan({ serialNumber: 'S1' }), none);
  assert.equal(plan.serial, null);
  assert.equal(plan.review.length, 1);
  assert.equal(plan.review[0]!.key, 'serial');
  assert.equal(plan.review[0]!.canDiscard, true);
  assert.match(plan.review[0]!.message, /S1.*no se maneja por serie/);
});

test('día 00 y fecha inválida: candidato separado, nunca precargado; descarte solo si no es obligatorio', () => {
  const month = scan(
    { expirationDate: '2028-02-29', expiration: { encoded: '280200', precision: 'MONTH' } },
    [{ code: 'EXPIRATION_DAY_UNSPECIFIED', severity: 'REVIEW', ai: '17' }],
  );
  const required = capturePlan(month, all);
  assert.equal(required.expiration, '');
  assert.deepEqual(
    required.review.map(({ key, canDiscard }) => ({ key, canDiscard })),
    [{ key: 'expiration', canDiscard: false }],
  );
  assert.match(required.review[0]!.message, /02\/2028/);
  assert.equal(capturePlan(month, none).review[0]!.canDiscard, true);
  const invalid = capturePlan(
    scan({ lotNumber: 'ABC' }, [{ code: 'INVALID_EXPIRATION', severity: 'ERROR', ai: '17' }]),
    none,
  );
  assert.equal(invalid.lot, 'ABC');
  assert.deepEqual(invalid.review, [
    {
      key: 'expiration',
      message: 'La fecha de vencimiento del código no es válida.',
      canDiscard: true,
    },
  ]);
  const duplicate = capturePlan(
    scan({}, [{ code: 'DUPLICATE_AI', severity: 'ERROR', ai: '10' }]),
    all,
  );
  assert.deepEqual(
    duplicate.review.map((r) => r.key),
    ['lot'],
  );
  const unsupported = capturePlan(
    scan({ ...day }, [{ code: 'UNSUPPORTED_AI', severity: 'REVIEW', ai: '91' }]),
    none,
  );
  assert.deepEqual(
    unsupported.review.map((r) => r.key),
    ['data'],
  );
});

test('grupo de series: misma captura acumula; otro lote/fecha o revisión exige decisión', () => {
  const current = { productId: 'p', lot: 'L1', expiration: '2028-12-31' };
  const next = (fields: ScanInterpretation['fields']) => ({
    productId: 'p',
    plan: capturePlan(scan(fields), all),
  });
  assert.equal(
    sameCaptureGroup(current, next({ lotNumber: 'L1', serialNumber: 'B', ...day })),
    true,
  );
  assert.equal(sameCaptureGroup(current, next({ serialNumber: 'B' })), true);
  assert.equal(sameCaptureGroup(current, next({ lotNumber: 'L2', serialNumber: 'B' })), false);
  assert.equal(
    sameCaptureGroup(
      current,
      next({
        serialNumber: 'B',
        expirationDate: '2029-01-01',
        expiration: { encoded: '290101', precision: 'DAY' },
      }),
    ),
    false,
  );
  assert.equal(
    sameCaptureGroup(current, { ...next({ serialNumber: 'B' }), productId: 'other' }),
    false,
  );
});

test('serie repetida en captura o borrador, exacta y sensible a mayúsculas', () => {
  const lines = [
    { id: 'l1', product: { id: 'p' }, serialNumbers: ['S1'] },
    { id: 'l2', product: { id: 'q' }, serialNumbers: ['S2'] },
  ];
  assert.equal(serialInOperation('S1', '', lines, 'p', null), true);
  assert.equal(serialInOperation('s1', '', lines, 'p', null), false);
  assert.equal(serialInOperation('S2', '', lines, 'p', null), false);
  assert.equal(serialInOperation('S3', 'S4\nS3', lines, 'p', null), true);
  assert.equal(serialInOperation('S1', '', lines, 'p', 'l1'), false);
});

test('pegado: una lectura con terminador final; varias líneas se rechazan', () => {
  assert.equal(pastedReadingProblem('(01)' + G + '\r\n'), null);
  assert.equal(pastedReadingProblem('(01)' + G), null);
  assert.ok(pastedReadingProblem('ABC\nDEF'));
  assert.ok(pastedReadingProblem('ABC\r\nDEF\n'));
});

test('transporte: input DOM conserva U+001D y JSON lo serializa escapado', () => {
  const dom = new JSDOM('<!doctype html><input type="text" maxlength="512">');
  const input = dom.window.document.querySelector('input')!;
  const value = ']d201' + G + '10LOT' + GS + '21SER';
  input.value = value;
  assert.equal(input.value, value);
  input.value = 'AB\r\nCD';
  assert.equal(input.value, 'ABCD');
  const body = JSON.stringify({ value });
  assert.match(body, /\\u001d/);
  assert.equal(scanInputSchema.parse(JSON.parse(body)).value, value);
});

const previousBase = process.env.API_BASE_URL,
  previousOrigin = process.env.WEB_ORIGIN,
  originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  if (previousBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = previousBase;
  if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = previousOrigin;
});
test('BFF catalog: reenvía el cuerpo con GS intacto y valida la respuesta GS1 estricta', async () => {
  process.env.API_BASE_URL = 'http://internal.invalid:3001';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  const value = '01' + G + '10LOT' + GS + '21SER';
  let forwarded = '';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'http://internal.invalid:3001/api/v1/catalog-scans/resolve');
    forwarded = String(init?.body);
    return Response.json({
      status: 'UNKNOWN',
      identity: { kind: 'GTIN', value: G, normalizedValue: G, supplierId: null },
      message: 'Código desconocido.',
      scan: scan({ lotNumber: 'LOT', serialNumber: 'SER' }),
    });
  }) as typeof fetch;
  const call = (body: unknown) =>
    POST(
      new Request('http://localhost:3000/api/catalog/catalog-scans/resolve', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'X-Maxbio-Csrf': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path: ['catalog-scans', 'resolve'] }) },
    );
  const response = await call({ value });
  assert.equal(response.status, 200);
  assert.equal((JSON.parse(forwarded) as { value: string }).value, value);
  assert.equal(
    (JSON.parse(forwarded) as { value: string }).value.charCodeAt(value.indexOf(GS)),
    29,
  );
  const data = (await response.json()) as { scan: ScanInterpretation };
  assert.equal(data.scan.fields.serialNumber, 'SER');
  // Strict contract: no physical "trusted" data or tenant from the browser.
  assert.equal((await call({ value, lotNumber: 'X' })).status, 400);
  assert.equal((await call({ value, organizationId: crypto.randomUUID() })).status, 400);
  globalThis.fetch = (async () =>
    Response.json({
      status: 'UNKNOWN',
      identity: { kind: 'GTIN', value: G, normalizedValue: G, supplierId: null },
      message: 'x',
      scan: { ...scan({}), raw: value },
    })) as typeof fetch;
  assert.equal((await call({ value })).status, 503);
});

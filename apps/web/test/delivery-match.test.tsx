import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import {
  inventoryPhysicalMatchSchema,
  scanInterpretationSchema,
  type InventoryPhysicalMatch,
  type ScanInterpretation,
} from '@maxbio/contracts';
import {
  allocatedByPosition,
  decimal,
  hasPhysicalData,
  matchCriteria,
  remaining,
  scaled,
  selectionAllocations,
} from '../src/lib/delivery-match.js';

mock.module('server-only', { namedExports: {} });
const { POST } = await import('../src/app/api/inventory/[...path]/route.js');

const G = '04006381333931';
function scan(fields: ScanInterpretation['fields']): ScanInterpretation {
  return scanInterpretationSchema.parse({
    format: 'GS1',
    status: 'VALID',
    syntax: 'ELEMENT_STRING',
    symbology: null,
    referenceYear: 2026,
    fields: { gtin14: G, ...fields },
    issues: [],
    canApplyPhysicalData: true,
  });
}
const position = (
  id: string,
  extra: Partial<InventoryPhysicalMatch['positions'][number]> = {},
): InventoryPhysicalMatch['positions'][number] => ({
  positionId: id,
  quantity: '5',
  location: { id: '00000000-0000-4000-8000-0000000000aa', name: 'Depósito principal' },
  lotId: null,
  lotNumber: 'L1',
  expirationDate: null,
  serialId: null,
  serialNumber: null,
  condition: 'USABLE',
  eligible: true,
  unavailableReason: null,
  ...extra,
});
const A = '00000000-0000-4000-8000-000000000001',
  B = '00000000-0000-4000-8000-000000000002',
  S = '00000000-0000-4000-8000-000000000003';

test('criterios: solo datos físicos exactos; GTIN solo y día 00 no consultan Stock', () => {
  assert.equal(matchCriteria(undefined), null);
  assert.equal(matchCriteria(scan({})), null);
  assert.deepEqual(
    matchCriteria(
      scan({
        lotNumber: 'L1',
        serialNumber: 'S1',
        expirationDate: '2028-12-31',
        expiration: { encoded: '281231', precision: 'DAY' },
      }),
    ),
    { serialNumber: 'S1', lotNumber: 'L1', expirationDate: '2028-12-31' },
  );
  const month = scan({
    expirationDate: '2028-02-29',
    expiration: { encoded: '280200', precision: 'MONTH' },
  });
  assert.equal(matchCriteria(month), null);
  assert.equal(hasPhysicalData(month), true);
  assert.equal(hasPhysicalData(scan({})), false);
});

test('aritmética exacta y disponible descontando lo ya vinculado en el borrador', () => {
  assert.equal(scaled('3,25'), 3250000n);
  assert.equal(scaled('1e3'), null);
  assert.equal(decimal(3250000n), '3.25');
  const allocated = allocatedByPosition([
    { allocations: [{ positionId: A, quantity: '2' }] },
    { allocations: [{ positionId: A, quantity: '1.5' }] },
  ]);
  assert.equal(remaining(position(A), allocated), 1500000n);
  assert.equal(remaining(position(B), allocated), 5000000n);
  assert.equal(remaining(position(B, { eligible: false }), allocated), 0n);
});

test('selección: parcial válida, excedente rechazado, serie única e indivisible', () => {
  const positions = [position(A), position(B, { quantity: '3' })];
  const none = new Map<string, bigint>();
  const partial = selectionAllocations(positions, { [A]: '2', [B]: '' }, none, 'UNIT');
  assert.ok(!('error' in partial));
  assert.equal(partial.quantity, '2');
  assert.deepEqual(partial.allocations, [{ positionId: A, quantity: '2' }]);
  assert.equal(partial.physical[0]?.lotNumber, 'L1');
  const both = selectionAllocations(positions, { [A]: '5', [B]: '3' }, none, 'UNIT');
  assert.ok(!('error' in both) && both.quantity === '8');
  assert.ok('error' in selectionAllocations(positions, { [B]: '4' }, none, 'UNIT'));
  assert.ok('error' in selectionAllocations(positions, { [A]: '1.5' }, none, 'UNIT'));
  assert.ok('error' in selectionAllocations(positions, {}, none, 'UNIT'));
  const meter = selectionAllocations(positions, { [A]: '1.5' }, none, 'METER');
  assert.ok(!('error' in meter) && meter.quantity === '1.5');
  const serial = [position(S, { quantity: '1', serialId: S, serialNumber: 'S1' })];
  assert.ok(!('error' in selectionAllocations(serial, { [S]: '1' }, none, 'UNIT')));
  // The same serialized position cannot be proposed twice inside one draft.
  const linked = allocatedByPosition([{ allocations: [{ positionId: S, quantity: '1' }] }]);
  assert.equal(remaining(serial[0]!, linked), 0n);
  assert.ok('error' in selectionAllocations(serial, { [S]: '1' }, linked, 'UNIT'));
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
test('BFF inventory: physical-match permitido, cuerpo estricto, CSRF y respuesta validada', async () => {
  process.env.API_BASE_URL = 'http://internal.invalid:3001';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  const productId = '00000000-0000-4000-8000-0000000000bb';
  const reply = inventoryPhysicalMatchSchema.parse({
    status: 'EXACT',
    reasonCodes: [],
    businessDate: '2026-10-26',
    policy: null,
    availableQuantity: '1',
    positions: [position(S, { quantity: '1', serialId: S, serialNumber: 'S1' })],
    total: 1,
    page: 1,
    limit: 20,
  });
  let forwarded: unknown;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(url),
      `http://internal.invalid:3001/api/v1/inventory/products/${productId}/physical-match`,
    );
    forwarded = JSON.parse(String(init?.body));
    return Response.json(reply);
  }) as typeof fetch;
  const call = (body: unknown, csrf = '1', path = ['products', productId, 'physical-match']) =>
    POST(
      new Request('http://localhost:3000/api/inventory/' + path.join('/'), {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:3000',
          'X-Maxbio-Csrf': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ path }) },
    );
  const ok = await call({ serialNumber: 'S1', lotNumber: 'L1' });
  assert.equal(ok.status, 200);
  assert.deepEqual(forwarded, { serialNumber: 'S1', lotNumber: 'L1' });
  assert.equal(((await ok.json()) as InventoryPhysicalMatch).status, 'EXACT');
  for (const body of [{}, { lotNumber: 'L1', organizationId: productId }, { gtin: G }])
    assert.equal((await call(body)).status, 400);
  assert.equal((await call({ lotNumber: 'L1' }, '0')).status, 403);
  assert.equal(
    (await call({ lotNumber: 'L1' }, '1', ['products', 'not-a-uuid', 'physical-match'])).status,
    404,
  );
  globalThis.fetch = (async () => Response.json({ ...reply, raw: 'x' })) as typeof fetch;
  assert.equal((await call({ lotNumber: 'L1' })).status, 503);
});

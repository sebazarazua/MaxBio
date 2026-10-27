import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  traceabilityDetailSchema,
  traceabilityQuerySchema,
  traceabilityRouteContract,
  traceabilitySourceLabels,
} from '@maxbio/contracts';
import {
  deliveryNoteNumberSearch,
  gtinSearch,
  numberPartCandidates,
} from '../src/modules/traceability/domain/traceability-search.js';

test('número de Remito: candidatos acotados con y sin ceros a la izquierda', () => {
  const candidates = numberPartCandidates('4122');
  assert.equal(candidates.length, 9);
  assert.ok(candidates.includes('4122') && candidates.includes('00004122'));
  assert.ok(candidates.includes('000000004122') && candidates.every((c) => c.length <= 12));
  assert.deepEqual(numberPartCandidates('00004122'), candidates);
  assert.equal(numberPartCandidates('0').length, 12);
  assert.deepEqual(numberPartCandidates('1234567890123'), []);
  assert.deepEqual(deliveryNoteNumberSearch('00001-00004122'), {
    prefixes: numberPartCandidates('1'),
    numbers: candidates,
  });
  assert.equal(deliveryNoteNumberSearch('4122')?.prefixes, null);
  for (const term of ['ABC123', 'S9982', '1-2-3', '-4122', 'Rodillera'])
    assert.equal(deliveryNoteNumberSearch(term), null, term);
});

test('GTIN: solo exacto con dígito verificador válido, canónico a 14', () => {
  assert.equal(gtinSearch('4006381333931'), '04006381333931');
  assert.equal(gtinSearch('04006381333931'), '04006381333931');
  for (const term of ['4006381333932', '400638133393', '40063813339311', 'ABC'])
    assert.equal(gtinSearch(term), null, term);
});

test('contrato estricto: sin tenant ni raw, paginación acotada, ruta solo GET', () => {
  assert.deepEqual(traceabilityQuerySchema.parse({}), { search: '', page: 1, limit: 25 });
  assert.equal(traceabilityQuerySchema.parse({ search: '  S9982 ' }).search, 'S9982');
  for (const bad of [
    { organizationId: randomUUID() },
    { raw: 'x' },
    { limit: '101' },
    { search: 'a\u0000b' },
    { source: 'DECLARED' },
    { dateFrom: '2026-10-02', dateTo: '2026-10-01' },
  ])
    assert.equal(traceabilityQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
  const id = randomUUID();
  assert.ok(traceabilityRouteContract('traceability', 'GET'));
  assert.ok(traceabilityRouteContract('traceability/' + id, 'GET'));
  for (const [path, method] of [
    ['traceability', 'POST'],
    ['traceability/' + id, 'PATCH'],
    ['traceability/x', 'GET'],
    ['traceability/' + id + '/extra', 'GET'],
  ])
    assert.equal(traceabilityRouteContract(path!, method!), null);
  assert.deepEqual(traceabilitySourceLabels, {
    STOCK: 'Vinculado a Stock',
    DOCUMENTARY: 'Solo documental',
  });
  // Internal fields are not part of the public detail.
  for (const field of ['organizationId', 'reviewedPriorTraceIds', 'preserveOnUnlink'])
    assert.equal(field in traceabilityDetailSchema.shape, false);
});

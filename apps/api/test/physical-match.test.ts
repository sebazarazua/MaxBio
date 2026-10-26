import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  inventoryPhysicalMatchInputSchema,
  inventoryRouteContract,
  physicalMatchReasonMessages,
  physicalMatchReasonSchema,
} from '@maxbio/contracts';
import { positionOutboundBlock } from '../src/modules/inventory/domain/outbound.js';

const policy = { lotRequired: true, expirationRequired: false, serialRequired: false };
const usable = {
  locationArchived: false,
  condition: 'USABLE' as const,
  lotNumber: 'L1',
  expirationDate: '2028-01-01',
  hasSerial: false,
};

test('regla única de salida: mismo orden que la confirmación del Remito', () => {
  assert.equal(positionOutboundBlock(policy, usable, '2026-10-26'), null);
  assert.equal(
    positionOutboundBlock(
      policy,
      { ...usable, locationArchived: true, condition: 'DAMAGED' },
      '2026-10-26',
    ),
    'LOCATION_ARCHIVED',
  );
  assert.equal(
    positionOutboundBlock(policy, { ...usable, condition: 'DAMAGED' }, '2026-10-26'),
    'DAMAGED',
  );
  assert.equal(
    positionOutboundBlock(policy, { ...usable, condition: 'QUARANTINE' }, '2026-10-26'),
    'QUARANTINED',
  );
  // The expiration day itself is still available; the day after is not.
  assert.equal(positionOutboundBlock(policy, usable, '2028-01-01'), null);
  assert.equal(positionOutboundBlock(policy, usable, '2028-01-02'), 'EXPIRED');
  assert.equal(
    positionOutboundBlock(policy, { ...usable, lotNumber: null }, '2026-10-26'),
    'POLICY_MISMATCH',
  );
  assert.equal(
    positionOutboundBlock({ ...policy, serialRequired: true }, usable, '2026-10-26'),
    'POLICY_MISMATCH',
  );
});

test('contrato estricto del match: criterios físicos, sin tenant/GTIN/raw, ruta explícita', () => {
  assert.equal(inventoryPhysicalMatchInputSchema.safeParse({}).success, false);
  assert.deepEqual(inventoryPhysicalMatchInputSchema.parse({ lotNumber: ' L1 ' }), {
    lotNumber: 'L1',
    page: 1,
    limit: 20,
  });
  for (const extra of [{ organizationId: randomUUID() }, { gtin: '04006381333931' }, { raw: 'x' }])
    assert.equal(
      inventoryPhysicalMatchInputSchema.safeParse({ lotNumber: 'L', ...extra }).success,
      false,
    );
  const id = randomUUID();
  assert.ok(inventoryRouteContract(`products/${id}/physical-match`, 'POST'));
  assert.equal(inventoryRouteContract(`products/${id}/physical-match`, 'GET'), null);
  assert.equal(inventoryRouteContract('products/x/physical-match', 'POST'), null);
  for (const code of physicalMatchReasonSchema.options)
    assert.ok(physicalMatchReasonMessages[code]);
});

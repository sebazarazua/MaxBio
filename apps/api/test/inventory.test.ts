import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inventoryLineInputSchema,
  inventoryConfirmSchema,
  inventoryRouteContract,
} from '@maxbio/contracts';
import {
  amount,
  quantity,
  validQuantity,
  businessDate,
} from '../src/modules/inventory/domain/quantity.js';
const id = '9fc8a811-b273-4a90-9c54-6c3939fcb397';
test('cantidades NUMERIC(20,6) exactas; metros, masa y volumen sin IEEE-754', () => {
  assert.equal(quantity(amount('0.1') + amount('0.2')), '0.3');
  assert.equal(quantity(amount('3') - amount('0.5')), '2.5');
  assert.equal(quantity(amount('0.000001')), '0.000001');
  assert.equal(quantity(amount('99999999999999.999999')), '99999999999999.999999');
  for (const value of ['1.0000001', '1e3', 'NaN', 'Infinity', '01', '-0.1x'])
    assert.throws(() => amount(value));
  for (const unit of ['METER', 'CENTIMETER', 'LITER', 'MILLILITER', 'KILOGRAM', 'GRAM'])
    assert.equal(validQuantity('1.000001', unit), 1000001n);
  for (const unit of ['UNIT', 'PAIR']) assert.throws(() => validQuantity('1.1', unit));
  assert.throws(() => validQuantity('0', 'UNIT'));
  assert.equal(validQuantity('0', 'UNIT', true), 0n);
  assert.throws(() => validQuantity('-1', 'METER', true));
});
test('contratos estrictos, precisión, seriales duplicados y unidad de captura', () => {
  const line = { expectedVersion: 1, productId: id, unitOfMeasure: 'UNIT', quantity: '1' };
  assert.equal(inventoryLineInputSchema.safeParse(line).success, true);
  for (const extra of [
    { quantity: '1.5' },
    { quantity: '-1' },
    { quantity: '1.0000001' },
    { quantity: 'NaN' },
    { quantity: '1e3' },
    { quantity: 'junk' },
    { organizationId: id },
    { serialNumbers: ['001', '001'] },
    { lotNumber: 'a\nb' },
  ])
    assert.equal(inventoryLineInputSchema.safeParse({ ...line, ...extra }).success, false);
  assert.equal(inventoryLineInputSchema.parse({ ...line, quantity: '1.000000' }).quantity, '1');
  assert.equal(
    inventoryConfirmSchema.safeParse({ operationId: id, expectedVersion: 1, physical: '100' })
      .success,
    false,
  );
  assert.ok(inventoryRouteContract(`receipts/${id}/lines/${id}`, 'PUT'));
  for (const [p, m] of [
    ['movement', 'POST'],
    ['balances', 'PATCH'],
    [`receipts/${id}`, 'DELETE'],
    ['../auth/me', 'GET'],
  ])
    assert.equal(inventoryRouteContract(p!, m!), null);
});
test('fecha de negocio argentina conserva vigencia inclusive del día de vencimiento', () => {
  assert.equal(businessDate(new Date('2026-10-07T02:59:59Z')), '2026-10-06');
  assert.equal(businessDate(new Date('2026-10-07T03:00:00Z')), '2026-10-07');
});

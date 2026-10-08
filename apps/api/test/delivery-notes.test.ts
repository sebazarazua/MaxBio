import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  deliveryNoteCreateSchema,
  deliveryNoteUpdateSchema,
  deliveryNoteConfirmSchema,
  deliveryNoteRouteContract,
} from '@maxbio/contracts';
const minimal = () => ({ id: randomUUID(), customerId: randomUUID(), documentDate: '2026-10-08' });
test('Remitos: strict contracts, internal fields, dates, document number and quantities', () => {
  const v = minimal();
  assert.equal(deliveryNoteCreateSchema.parse(v).lines.length, 0);
  for (const field of [
    'organizationId',
    'tenant',
    'status',
    'confirmedAt',
    'inventoryMovementId',
    'customerSnapshot',
    'actor',
    'audit',
    'version',
    'createdAt',
  ])
    assert.equal(
      deliveryNoteCreateSchema.safeParse({ ...v, [field]: randomUUID() }).success,
      false,
      field,
    );
  assert.equal(
    deliveryNoteCreateSchema.safeParse({ ...v, documentDate: '2026-02-30' }).success,
    false,
  );
  for (const fields of [
    { documentPrefix: '00001' },
    { documentNumber: '00003897' },
    { documentPrefix: '-1', documentNumber: '12' },
    { documentPrefix: 1, documentNumber: 3897 },
  ])
    assert.equal(deliveryNoteCreateSchema.safeParse({ ...v, ...fields }).success, false);
  const parsed = deliveryNoteCreateSchema.parse({
    ...v,
    documentPrefix: '00001',
    documentNumber: '00003897',
  });
  assert.equal(parsed.documentPrefix + '-' + parsed.documentNumber, '00001-00003897');
  for (const quantity of ['0', '-1', '1e2', 'NaN', '1.0000001', '1000000001'])
    assert.equal(
      deliveryNoteCreateSchema.safeParse({
        ...v,
        lines: [{ id: randomUUID(), productId: randomUUID(), quantity }],
      }).success,
      false,
    );
  assert.equal(
    deliveryNoteCreateSchema.parse({
      ...v,
      lines: [{ id: randomUUID(), productId: randomUUID(), quantity: '1.125000' }],
    }).lines[0]?.quantity,
    '1.125',
  );
  const l = { id: randomUUID(), productId: randomUUID(), quantity: '1' };
  assert.equal(deliveryNoteCreateSchema.safeParse({ ...v, lines: [l, l] }).success, false);
  assert.equal(
    deliveryNoteCreateSchema.safeParse({ ...v, lines: [l, { ...l, id: randomUUID() }] }).success,
    true,
  );
  assert.equal(deliveryNoteUpdateSchema.safeParse(v).success, false);
  assert.equal(
    deliveryNoteConfirmSchema.safeParse({
      operationId: randomUUID(),
      expectedVersion: 1,
      status: 'CONFIRMED',
    }).success,
    false,
  );
});
test('Remitos: BFF explicit routes, no generic status/stock/renderer/DELETE API', () => {
  const id = randomUUID();
  for (const [path, method] of [
    ['delivery-notes', 'GET'],
    ['delivery-notes', 'POST'],
    [`delivery-notes/${id}`, 'GET'],
    [`delivery-notes/${id}`, 'PATCH'],
    [`delivery-notes/${id}/confirm`, 'POST'],
    [`delivery-notes/${id}/cancel`, 'POST'],
  ])
    assert.ok(deliveryNoteRouteContract(path!, method!));
  for (const [path, method] of [
    [`delivery-notes/${id}`, 'DELETE'],
    [`delivery-notes/${id}/status`, 'POST'],
    [`delivery-notes/${id}/print`, 'POST'],
    ['delivery-notes/../../stock', 'GET'],
    [`delivery-notes/${id}/confirm`, 'GET'],
  ])
    assert.equal(deliveryNoteRouteContract(path!, method!), null);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  scanInterpretationSchema,
  deliveryNoteCreateSchema,
  deliveryNoteRouteContract,
} from '@maxbio/contracts';
import { scannedDeclaration, splitDeclaration } from '../src/lib/delivery-traces.js';

test('Stage 5 captura sin stock: solo GS1 físico válido, sin trace vacía por GTIN y sin raw al editar contrato de respuesta', () => {
  const scan = scanInterpretationSchema.parse({
    format: 'GS1',
    status: 'VALID',
    syntax: 'HRI',
    symbology: null,
    referenceYear: 2026,
    fields: {
      gtin14: '04006381333931',
      lotNumber: 'ABC',
      expirationDate: '2028-12-31',
      serialNumber: 'S1',
    },
    issues: [],
    canApplyPhysicalData: true,
  });
  const reading = '(01)04006381333931(17)281231(10)ABC(21)S1';
  const t = scannedDeclaration(scan, reading)[0]!;
  assert.equal(t.quantity, '1');
  assert.equal(t.serialNumber, 'S1');
  assert.equal(t.scanValue, reading);
  assert.deepEqual(scannedDeclaration({ ...scan, canApplyPhysicalData: false }, reading), []);
  assert.deepEqual(
    scannedDeclaration({ ...scan, fields: { gtin14: scan.fields.gtin14 } }, reading),
    [],
  );
  const line = { id: randomUUID(), productId: randomUUID(), quantity: '1', physicalTraces: [t] };
  assert.equal(
    deliveryNoteCreateSchema.safeParse({
      id: randomUUID(),
      customerId: randomUUID(),
      documentDate: '2026-10-26',
      lines: [line],
    }).success,
    true,
  );
  assert.equal(
    deliveryNoteCreateSchema.safeParse({
      id: randomUUID(),
      customerId: randomUUID(),
      documentDate: '2026-10-26',
      lines: [{ ...line, physicalTraces: [{ ...t, origin: 'INVENTORY' }] }],
    }).success,
    false,
  );
  assert.ok(deliveryNoteRouteContract('delivery-notes/trace-history', 'POST'));
});

test('Stage 5 split decimal exacto, vínculo total y validaciones de cantidades', () => {
  const source = {
    id: randomUUID(),
    quantity: '5',
    lotNumber: 'ABC',
    expirationDate: null,
    serialNumber: null,
  };
  const partial = splitDeclaration([source], source.id, '2');
  assert.equal(partial.source.quantity, '5');
  assert.equal(partial.traces[0]!.quantity, '3');
  assert.equal(source.quantity, '5');
  assert.deepEqual(splitDeclaration([source], source.id, '5').traces, []);
  assert.equal(
    splitDeclaration([{ ...source, quantity: '0.000003' }], source.id, '0.000001').traces[0]!
      .quantity,
    '0.000002',
  );
  for (const q of ['6', '0', '-1', 'NaN', '0.0000001'])
    assert.throws(() => splitDeclaration([source], source.id, q));
});

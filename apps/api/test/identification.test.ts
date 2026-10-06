import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  scanInputSchema,
  identificationConfirmSchema,
  identificationRouteContract,
} from '@maxbio/contracts';
import { parseScan } from '../src/modules/catalog/domain/catalog-scan.js';

test('GTIN conserva checksum y canonical14; inválido nunca cae al namespace externo', () => {
  const valid = parseScan({ value: '4006381333931', namespace: 'AUTO' });
  assert.deepEqual(valid, {
    kind: 'GTIN',
    value: '4006381333931',
    normalizedValue: '04006381333931',
    supplierId: null,
  });
  for (const value of ['4006381333932', '04006381333932'])
    assert.equal(
      (parseScan({ value, namespace: 'AUTO', supplierId: randomUUID() }) as { status: string })
        .status,
      'INVALID',
    );
});
test('internos y externos tienen namespaces diferentes; controles y límites se rechazan', () => {
  assert.equal(
    (parseScan({ value: 'MB-WALKER', namespace: 'AUTO' }) as { kind: string }).kind,
    'INTERNAL_BARCODE',
  );
  assert.equal(
    (parseScan({ value: 'DL2115', namespace: 'INTERNAL_CODE' }) as { kind: string }).kind,
    'INTERNAL_CODE',
  );
  const supplierId = randomUUID();
  assert.deepEqual(parseScan({ value: 'DL2115', namespace: 'AUTO', supplierId }), {
    kind: 'SUPPLIER_BARCODE',
    value: 'DL2115',
    normalizedValue: 'DL2115',
    supplierId,
  });
  for (const value of ['MB-lower', 'a\tbc', 'a'.repeat(129), '   '])
    assert.equal((parseScan({ value, namespace: 'AUTO' }) as { status: string }).status, 'INVALID');
});
test('compuestos GS1 detectables nunca se persisten como identidad', () => {
  for (const value of [
    '(01)04006381333931(10)LOT',
    ']C1010400638133393110LOT',
    '010400638133393117261231',
    '01abc\x1d10LOT',
  ])
    assert.equal(
      (parseScan({ value, namespace: 'AUTO' }) as { status: string }).status,
      'UNSUPPORTED',
    );
});
test('contratos estrictos limitan workflow; no admite stock, múltiples identificadores ni edición estructural', () => {
  assert.equal(
    scanInputSchema.safeParse({ value: 'test', organizationId: randomUUID() }).success,
    false,
  );
  const command = {
    operationId: randomUUID(),
    scan: { value: '4006381333931' },
    referenceId: randomUUID(),
    expectedReferenceVersion: 1,
    target: { mode: 'NEW', product: { name: 'Walker', unitOfMeasure: 'UNIT' } },
  };
  assert.equal(identificationConfirmSchema.safeParse(command).success, true);
  assert.equal(identificationConfirmSchema.safeParse({ ...command, quantity: 1 }).success, false);
  assert.equal(
    identificationConfirmSchema.safeParse({
      ...command,
      target: {
        mode: 'NEW',
        product: { ...command.target.product, identifiers: [], archivedAt: null },
      },
    }).success,
    false,
  );
  assert.ok(identificationRouteContract('catalog-scans/resolve', 'POST'));
  assert.equal(identificationRouteContract('products', 'POST'), null);
});

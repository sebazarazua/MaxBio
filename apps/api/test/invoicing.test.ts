import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  formatCents,
  invoiceCreateSchema,
  invoiceLineAmounts,
  invoiceRouteContract,
  invoiceStatusLabels,
  invoiceTotals,
  invoiceUpdateSchema,
  moneyCents,
} from '@maxbio/contracts';

test('línea: cantidad × precio unitario y alícuotas 0, 10,5, 21 y 27 %', () => {
  assert.deepEqual(invoiceLineAmounts('2', '1000.00', 'VAT_21'), {
    netAmount: '2000.00',
    vatAmount: '420.00',
    totalAmount: '2420.00',
  });
  assert.deepEqual(invoiceLineAmounts('3', '100', 'VAT_10_5'), {
    netAmount: '300.00',
    vatAmount: '31.50',
    totalAmount: '331.50',
  });
  assert.equal(invoiceLineAmounts('1', '100', 'VAT_27').vatAmount, '27.00');
  for (const rate of ['VAT_0', 'EXEMPT', 'NOT_TAXED'] as const)
    assert.deepEqual(invoiceLineAmounts('4', '25.50', rate), {
      netAmount: '102.00',
      vatAmount: '0.00',
      totalAmount: '102.00',
    });
});

test('redondeo único: mitad hacia arriba a centavos, primero neto y después IVA', () => {
  // 1.5 × 333.33 = 499.995 → 500.00; 500 × 10,5 % = 52.50
  assert.deepEqual(invoiceLineAmounts('1.5', '333.33', 'VAT_10_5'), {
    netAmount: '500.00',
    vatAmount: '52.50',
    totalAmount: '552.50',
  });
  // 0.30 × 27 % = 0.081 → 0.08; 0.05 × 21 % = 0.0105 → 0.01; 0.02 × 21 % = 0.0042 → 0.00
  assert.equal(invoiceLineAmounts('3', '0.1', 'VAT_27').vatAmount, '0.08');
  assert.equal(invoiceLineAmounts('1', '0.05', 'VAT_21').vatAmount, '0.01');
  assert.equal(invoiceLineAmounts('1', '0.02', 'VAT_21').vatAmount, '0.00');
  // 0.000001 × 0.01 rounds to zero; 0.5 cents rounds up.
  assert.equal(invoiceLineAmounts('0.000001', '0.01', 'VAT_21').netAmount, '0.00');
  assert.equal(invoiceLineAmounts('0.5', '0.01', 'VAT_0').netAmount, '0.01');
});

test('totales: suma exacta de líneas, cero y completitud', () => {
  const lines = [
    invoiceLineAmounts('1', '0.10', 'VAT_21'),
    invoiceLineAmounts('1', '0.20', 'VAT_21'),
    { netAmount: null, vatAmount: null },
  ];
  // Never 0.30000000000000004: integer cents.
  assert.deepEqual(invoiceTotals(lines), {
    netAmount: '0.30',
    vatAmount: '0.06',
    totalAmount: '0.36',
    complete: false,
  });
  assert.deepEqual(invoiceTotals([]), {
    netAmount: '0.00',
    vatAmount: '0.00',
    totalAmount: '0.00',
    complete: true,
  });
  assert.equal(invoiceLineAmounts('7', '0', 'VAT_21').totalAmount, '0.00');
  const big = invoiceLineAmounts('1000000000', '9999999.99', 'VAT_0');
  assert.equal(big.netAmount, '9999999990000000.00');
  assert.equal(moneyCents(big.netAmount), 999999999000000000n);
});

test('valores inválidos y límites de NUMERIC(18,2)', () => {
  for (const value of ['-1', '1,5', '1.234', '1e3', '01', '', ' 1', 'NaN'])
    assert.throws(() => moneyCents(value), /Importe inválido/, value);
  assert.throws(() => invoiceLineAmounts('-1', '1', 'VAT_21'));
  assert.throws(() => invoiceLineAmounts('1.0000001', '1', 'VAT_21'));
  assert.throws(
    () => invoiceLineAmounts('1000000000', '9999999999999999.99', 'VAT_21'),
    /demasiado grande/,
  );
  assert.throws(() => formatCents(-1n));
  assert.equal(formatCents(5n), '0.05');
});

test('contratos: sin tenant, totales ni snapshots del browser; rutas explícitas', () => {
  const base = {
    expectedVersion: 1,
    invoiceType: 'INVOICE_B',
    issueDate: '2026-10-27',
    notes: null,
    lines: [{ id: randomUUID(), description: 'Rodillera', unitPrice: '10.00', vatRate: 'VAT_21' }],
  };
  assert.equal(invoiceUpdateSchema.safeParse(base).success, true);
  for (const extra of [
    { netAmount: '1.00' },
    { totalAmount: '1.00' },
    { organizationId: randomUUID() },
    { customerSnapshot: {} },
    { customerId: randomUUID() },
  ])
    assert.equal(invoiceUpdateSchema.safeParse({ ...base, ...extra }).success, false);
  assert.equal(
    invoiceUpdateSchema.safeParse({ ...base, lines: [{ ...base.lines[0], quantity: '9' }] })
      .success,
    false,
  );
  assert.equal(
    invoiceUpdateSchema.safeParse({ ...base, lines: [{ ...base.lines[0], vatRate: 'VAT_15' }] })
      .success,
    false,
  );
  const id = randomUUID();
  assert.equal(invoiceCreateSchema.safeParse({ id, deliveryNoteIds: [] }).success, false);
  assert.equal(invoiceCreateSchema.safeParse({ id, deliveryNoteIds: [id, id] }).success, false);
  assert.ok(invoiceRouteContract('invoices/pending-delivery-notes', 'GET'));
  assert.ok(invoiceRouteContract(`invoices/${id}/ready`, 'POST'));
  assert.equal(invoiceRouteContract(`invoices/${id}`, 'DELETE'), null);
  assert.equal(invoiceRouteContract(`invoices/${id}/authorize`, 'POST'), null);
  assert.equal(invoiceStatusLabels.READY, 'Lista para autorizar');
});

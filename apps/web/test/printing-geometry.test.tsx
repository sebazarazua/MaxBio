import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { bourbonProvisionalTemplate, printTemplateCreateSchema } from '@maxbio/contracts';
import { moveGeometry, screenDeltaMm } from '../src/components/printing/geometry-controls.js';

test('Editor: el zoom no cambia mm; movimiento nominal exacto, fila compartida y definición persistible', () => {
  const template = bourbonProvisionalTemplate(randomUUID(), randomUUID());
  for (const zoom of [0.5, 1, 2]) {
    const pixelsPerMm = (96 / 25.4) * zoom;
    assert.ok(Math.abs(screenDeltaMm(5 * pixelsPerMm, 203 * pixelsPerMm, 203) - 5) < 1e-9);
    const moved = moveGeometry(
      template.definition,
      'customer',
      screenDeltaMm(5 * pixelsPerMm, 203 * pixelsPerMm, 203),
      screenDeltaMm(0.1 * pixelsPerMm, 271 * pixelsPerMm, 271),
      203,
      271,
    );
    const f = moved.fields.find((f) => f.id === 'customer')!;
    assert.equal(f.xMm, 34);
    assert.equal(f.yMm, 56.6);
    assert.equal(template.definition.fields.find((f) => f.id === 'customer')!.xMm, 29);
    assert.deepEqual(
      printTemplateCreateSchema.parse({ ...template, definition: moved }).definition,
      moved,
    );
  }
  const moved = moveGeometry(template.definition, 'row-2-productName', 0.5, -0.1, 203, 271);
  assert.equal(moved.productRegion.xMm, 8.5);
  assert.equal(moved.productRegion.yMm, 106.7);
  assert.deepEqual(moved.productRegion.columns, template.definition.productRegion.columns);
  assert.deepEqual(moved.fields, template.definition.fields);
  assert.equal(
    moveGeometry(template.definition, 'customer', -100, 0, 203, 271).fields.find(
      (f) => f.id === 'customer',
    )!.xMm,
    0,
  );
  const fractional = structuredClone(template.definition);
  fractional.fields.find((f) => f.id === 'customer')!.widthMm = 183.05;
  const edge = moveGeometry(fractional, 'customer', 1000, 0, 203, 271).fields.find(
    (f) => f.id === 'customer',
  )!;
  assert.ok(edge.xMm + edge.widthMm <= 203);
});

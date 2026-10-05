import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  catalogListQuerySchema,
  productCreateSchema,
  productUpdateSchema,
  catalogRouteContract,
} from '@maxbio/contracts';
import { normalizeIdentifier, normalizeName } from '../src/modules/catalog/domain/identifiers.js';

test('GTIN valida todas las longitudes y conserva ceros mediante una clave de 14 dígitos', () => {
  for (const value of ['96385074', '036000291452', '4006381333931', '10012345000017']) {
    const normalized = normalizeIdentifier({ kind: 'GTIN', value });
    assert.equal(normalized.value, value);
    assert.equal(normalized.normalizedValue, value.padStart(14, '0'));
  }
  assert.equal(
    normalizeIdentifier({ kind: 'GTIN', value: '036000291452' }).normalizedValue,
    normalizeIdentifier({ kind: 'GTIN', value: '00036000291452' }).normalizedValue,
  );
});
test('GTIN rechaza checksum, longitud, letras y separadores inválidos', () => {
  for (const value of ['4006381333932', '123', '4006-381333931', '400638133393A', '123456789', ''])
    assert.throws(() => normalizeIdentifier({ kind: 'GTIN', value }));
});
test('los códigos internos conservan case, puntuación y ceros; el barcode tiene namespace explícito', () => {
  assert.equal(
    normalizeIdentifier({ kind: 'INTERNAL_CODE', value: '  00a/B-1  ' }).normalizedValue,
    '00a/B-1',
  );
  assert.notEqual(
    normalizeIdentifier({ kind: 'INTERNAL_CODE', value: 'Ab' }).normalizedValue,
    normalizeIdentifier({ kind: 'INTERNAL_CODE', value: 'AB' }).normalizedValue,
  );
  assert.equal(
    normalizeIdentifier({ kind: 'INTERNAL_BARCODE', value: ' MB-001_A ' }).normalizedValue,
    'MB-001_A',
  );
  for (const value of ['12345', 'mb-ABC', 'MB-', 'MB-A B', 'MB-Ñ'])
    assert.throws(() => normalizeIdentifier({ kind: 'INTERNAL_BARCODE', value }));
  assert.throws(() => normalizeIdentifier({ kind: 'INTERNAL_CODE', value: 'A\nB' }));
});
test('marcas/categorías colapsan espacios, conservan tildes y comparan sin case', () => {
  assert.deepEqual(normalizeName('  Marca   Médica  '), {
    name: 'Marca Médica',
    normalizedName: 'marca médica',
  });
  assert.notEqual(normalizeName('Medica').normalizedName, normalizeName('Médica').normalizedName);
});
test('contratos estrictos, paginación acotada, unidad separada y versión obligatoria', () => {
  assert.equal(
    productCreateSchema.parse({
      name: 'Producto',
      unitOfMeasure: 'UNIT',
      presentation: 'Caja x 100',
    }).unitOfMeasure,
    'UNIT',
  );
  assert.equal(
    productCreateSchema.safeParse({ name: 'Producto', unitOfMeasure: 'BOX' }).success,
    false,
  );
  assert.equal(
    productCreateSchema.safeParse({
      name: 'Producto',
      unitOfMeasure: 'UNIT',
      organizationId: 'ajena',
    }).success,
    false,
  );
  assert.equal(productUpdateSchema.safeParse({ name: 'Otro' }).success, false);
  assert.equal(productUpdateSchema.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(productUpdateSchema.parse({ name: 'Otro', expectedVersion: 1 }).expectedVersion, 1);
  assert.deepEqual(catalogListQuerySchema.parse({}), {
    q: '',
    page: 1,
    limit: 20,
    includeArchived: false,
  });
  for (const query of [
    { limit: '1000000' },
    { page: '0' },
    { page: '-1' },
    { limit: '1.5' },
    { includeArchived: 'yes' },
    { organizationId: 'ajena' },
  ])
    assert.equal(catalogListQuerySchema.safeParse(query).success, false);
});

test('proxy limita rutas, métodos y contratos a capacidades concretas del catálogo', () => {
  const id = '9fc8a811-b273-4a90-9c54-6c3939fcb397';
  assert.ok(catalogRouteContract('products', 'GET')?.query);
  assert.ok(catalogRouteContract('products/' + id, 'PATCH')?.body);
  assert.ok(catalogRouteContract('products/' + id + '/identifiers', 'POST')?.body);
  assert.ok(catalogRouteContract('supplier-products/' + id + '/restore', 'POST'));
  for (const [path, method] of [
    ['products', 'DELETE'],
    ['auth/me', 'GET'],
    ['../auth/me', 'GET'],
    ['products/not-a-uuid', 'PATCH'],
    ['products/' + id + '/identifiers', 'PATCH'],
    ['brands/' + id, 'GET'],
  ])
    assert.equal(catalogRouteContract(path!, method!), undefined);
});

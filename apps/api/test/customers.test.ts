import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  customerCreateSchema,
  customerUpdateSchema,
  customerKindSchema,
  customerListQuerySchema,
  customerRouteContract,
  cuitSchema,
  validCuit,
} from '@maxbio/contracts';
import { customerSearchTokens } from '../src/modules/customers/domain/customer-search.js';

test('Customer mínimo, cuatro tipos y opcionales canónicos sin campos internos', () => {
  for (const kind of ['HEALTH_INSURER', 'INSTITUTION', 'COMPANY', 'OTHER']) {
    const result = customerCreateSchema.parse({ id: randomUUID(), name: ' Clínica X ', kind });
    assert.equal(result.name, 'Clínica X');
  }
  assert.equal(customerKindSchema.safeParse('PATIENT').success, false);
  const base = { id: randomUUID(), name: 'Cliente', kind: 'OTHER' };
  for (const field of [
    'organizationId',
    'version',
    'archivedAt',
    'searchText',
    'actor',
    'createdAt',
    'updatedAt',
  ])
    assert.equal(customerCreateSchema.safeParse({ ...base, [field]: 'extra' }).success, false);
  assert.equal(
    customerCreateSchema.parse({ ...base, cuit: ' ', email: ' ', notes: '', phone: null }).cuit,
    null,
  );
  assert.equal(
    customerCreateSchema.safeParse({ ...base, id: '00000000-0000-1000-8000-000000000001' }).success,
    false,
  );
});
test('CUIT local: formato humano, canonización y checksum; no verifica registro', () => {
  assert.equal(cuitSchema.parse(' 20-12345678-6 '), '20123456786');
  assert.equal(cuitSchema.parse('20 - 12345678 - 6'), '20123456786');
  assert.equal(cuitSchema.parse('20123456786'), '20123456786');
  for (const value of [
    '20123456785',
    '00000000000',
    '2012345678',
    '20.12345678.6',
    '20123456786x',
    '+20123456786',
    '30123456789',
  ])
    assert.equal(cuitSchema.safeParse(value).success, false, value);
  assert.equal(validCuit('20123456786'), true);
});
test('Customer límites, email, notas multilínea y edición con versión obligatoria', () => {
  const base = { id: randomUUID(), name: 'Cliente', kind: 'OTHER' };
  const limits = {
    name: 200,
    legalName: 200,
    taxConditionText: 80,
    addressLine: 250,
    locality: 120,
    province: 100,
    postalCode: 20,
    contactName: 160,
    phone: 50,
    notes: 1000,
  };
  for (const [field, max] of Object.entries(limits)) {
    assert.equal(
      customerCreateSchema.safeParse({ ...base, [field]: 'a'.repeat(max) }).success,
      true,
    );
    assert.equal(
      customerCreateSchema.safeParse({ ...base, [field]: 'a'.repeat(max + 1) }).success,
      false,
    );
  }
  assert.equal(
    customerCreateSchema.parse({
      ...base,
      email: ' contacto@example.invalid ',
      notes: 'Primera\r\nSegunda',
    }).notes,
    'Primera\nSegunda',
  );
  for (const email of ['invalido', 'a@@example.invalid', 'a b@example.invalid'])
    assert.equal(customerCreateSchema.safeParse({ ...base, email }).success, false);
  assert.equal(customerCreateSchema.safeParse({ ...base, name: 'a\nb' }).success, false);
  assert.equal(customerUpdateSchema.safeParse({ name: 'Nuevo' }).success, false);
  assert.equal(customerUpdateSchema.safeParse({ expectedVersion: 1 }).success, false);
  assert.equal(customerUpdateSchema.parse({ expectedVersion: 1, cuit: null }).cuit, null);
});
test('Búsqueda mult-token/tildes y CUIT: no altera texto ni teléfonos', () => {
  assert.deepEqual(customerSearchTokens(' Italiano HÓSPITAL italiano '), ['italiano', 'hospital']);
  assert.deepEqual(customerSearchTokens('hospital 20-12345678-6'), ['hospital', '20123456786']);
  assert.deepEqual(customerSearchTokens('20 - 12345678 - 6'), ['20123456786']);
  assert.deepEqual(customerSearchTokens('contacto 011-4567'), ['contacto', '011-4567']);
  assert.deepEqual(customerSearchTokens('modelo20-12345678-6x'), ['modelo20-12345678-6x']);
});
test('Rutas y query Customer: allowlist, UUID v4, paginación limitada y sin DELETE', () => {
  const id = randomUUID();
  assert.ok(customerRouteContract('customers', 'GET'));
  assert.ok(customerRouteContract(`customers/${id}/restore`, 'POST'));
  assert.equal(customerRouteContract(`customers/${id}`, 'DELETE'), null);
  assert.equal(customerRouteContract(`customers/${id}/stock`, 'POST'), null);
  assert.equal(customerRouteContract('customers/not-a-uuid', 'PATCH'), null);
  assert.equal(customerListQuerySchema.safeParse({ limit: '101' }).success, false);
  assert.equal(customerListQuerySchema.safeParse({ organizationId: id }).success, false);
});

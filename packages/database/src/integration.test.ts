import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDatabaseClient, MembershipRole } from './index.js';

test('pertenencias por organización, unicidad y conservación de relaciones', async () => {
  const url = process.env.DATABASE_URL;
  assert.ok(url, 'Falta DATABASE_URL');
  const client = createDatabaseClient(url);
  const suffix = randomUUID();
  const organizations: string[] = [];
  let userId: string | undefined;
  try {
    const a = await client.organization.create({
      data: { name: 'Fixture A', slug: `test-a-${suffix}` },
    });
    organizations.push(a.id);
    const b = await client.organization.create({
      data: { name: 'Fixture B', slug: `test-b-${suffix}` },
    });
    organizations.push(b.id);
    const user = await client.user.create({
      data: { email: `${suffix}@example.invalid`, displayName: 'Fixture' },
    });
    userId = user.id;
    await client.membership.create({
      data: { organizationId: a.id, userId, role: MembershipRole.ADMIN },
    });
    await client.membership.create({
      data: { organizationId: b.id, userId, role: MembershipRole.OPERATOR },
    });
    const memberships = await client.membership.findMany({
      where: { organizationId: a.id, userId },
    });
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.role, MembershipRole.ADMIN);
    await assert.rejects(
      client.membership.create({ data: { organizationId: a.id, userId } }),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002',
    );
    await assert.rejects(
      client.organization.delete({ where: { id: a.id } }),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003',
    );
    await client.organization.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    assert.equal(await client.membership.count({ where: { organizationId: a.id } }), 1);
  } finally {
    // Borrado explícito solo de fixtures creados por este test; nunca datos de negocio.
    await client.membership.deleteMany({ where: { organizationId: { in: organizations } } });
    if (userId) await client.user.delete({ where: { id: userId } });
    await client.organization.deleteMany({ where: { id: { in: organizations } } });
    await client.$disconnect();
  }
});

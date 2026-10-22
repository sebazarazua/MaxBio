import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, cp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';

test(
  'Numeración migration: HEAD upgrade con históricos, from-zero, status, drift y constraints',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma', 'migrations'),
      cache = join(root, 'node_modules', '.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'numbering-migration-')),
      migrations = join(temp, 'migrations');
    await mkdir(migrations);
    const config = join(temp, 'prisma.config.ts'),
      schema = join(temp, 'schema.prisma');
    await cp(join(root, 'prisma', 'schema.prisma'), schema);
    await writeFile(
      config,
      "import {defineConfig} from 'prisma/config';export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    const names = (await readdir(source)).filter((n) => /^\d+_/.test(n)).sort(),
      parent = createDatabaseClient(process.env.DATABASE_URL!),
      created: string[] = [];
    function cli(url: string, args: string[]) {
      return execFileSync(
        process.execPath,
        [join(root, 'node_modules', 'prisma', 'build', 'index.js'), ...args, '--config', config],
        { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000 },
      ).toString();
    }
    try {
      await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
      for (const n of names.filter((n) => n < '20261022120000'))
        await cp(join(source, n), join(migrations, n), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const name = 'maxbio_numbering_migration_' + randomUUID().replaceAll('-', '');
        assert.match(name, /^maxbio_numbering_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
        created.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + name;
        const client = createDatabaseClient(url.toString());
        try {
          if (mode === 'upgrade') {
            cli(url.toString(), ['migrate', 'deploy']);
            const absent = await client.$queryRaw<
              Array<{ table: string | null }>
            >`SELECT to_regclass('public."DeliveryNoteNumbering"')::text AS table`;
            assert.equal(absent[0]!.table, null);
            const org = await client.organization.create({
              data: { name: 'HEAD customer', slug: randomUUID() },
            });
            const customer = await client.customer.create({
              data: { organizationId: org.id, name: 'Cliente previo', kind: 'HEALTH_INSURER' },
            });
            for (const [prefix, number, date] of [
              ['0001', '999999', '2026-10-19'],
              ['0002', '99', '2026-10-20'],
              ['0002', '00000400', '2026-10-21'],
              ['0002', '9', '2026-10-22'],
            ] as const) {
              await client.deliveryNote.create({
                data: {
                  organizationId: org.id,
                  customerId: customer.id,
                  documentPrefix: prefix,
                  documentNumber: number,
                  documentDate: new Date(date),
                  createdAt: new Date(date),
                  creationHash: '0'.repeat(64),
                },
              });
            }
            for (const n of names.filter((n) => n >= '20261022120000'))
              await cp(join(source, n), join(migrations, n), { recursive: true });
          }
          cli(url.toString(), ['migrate', 'deploy']);
          assert.equal(await client.customer.count(), mode === 'upgrade' ? 1 : 0);
          assert.equal(await client.deliveryNote.count(), mode === 'upgrade' ? 4 : 0);
          assert.equal(await client.inventoryMovement.count(), 0);
          assert.equal(await client.inventoryBalance.count(), 0);
          const states = await client.deliveryNoteNumbering.findMany();
          if (mode === 'upgrade') {
            assert.equal(states.length, 1);
            assert.equal(states[0]!.prefix, '0002');
            assert.equal(states[0]!.nextNumber, 401n);
            assert.equal(states[0]!.numberWidth, 8);
            const historical = await client.deliveryNote.findMany({
              orderBy: { createdAt: 'asc' },
            });
            assert.deepEqual(
              historical.map((d) => d.documentNumber),
              ['999999', '99', '00000400', '9'],
            );
            for (const data of [{ nextNumber: -1n }, { numberWidth: 13 }, { prefix: 'invalid' }])
              await assert.rejects(
                client.deliveryNoteNumbering.update({
                  where: { organizationId: states[0]!.organizationId },
                  data,
                }),
              );
          } else assert.equal(states.length, 0);
          assert.match(cli(url.toString(), ['migrate', 'status']), /up to date/);
          cli(url.toString(), [
            'migrate',
            'diff',
            '--from-config-datasource',
            '--to-schema',
            schema,
            '--exit-code',
          ]);
          const constraints = await client.$queryRaw<
            Array<{ conname: string }>
          >`SELECT conname FROM pg_constraint WHERE conrelid='"DeliveryNoteNumbering"'::regclass`;
          for (const name of [
            'delivery_numbering_values',
            'DeliveryNoteNumbering_pkey',
            'DeliveryNoteNumbering_organizationId_fkey',
          ])
            assert.ok(constraints.some((c) => c.conname === name));
          const indexes = await client.$queryRaw<
            Array<{ indexname: string }>
          >`SELECT indexname FROM pg_indexes WHERE tablename='DeliveryNote'`;
          assert.ok(
            indexes.some(
              (i) =>
                i.indexname === 'DeliveryNote_organizationId_documentPrefix_documentNumber_key',
            ),
          );
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_numbering_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.$disconnect();
      assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

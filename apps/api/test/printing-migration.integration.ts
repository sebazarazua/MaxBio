import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, cp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';
import { connectedTestDatabaseManagement } from './test-database-management.js';

test(
  'Printing migration: upgrade desde HEAD, from zero, status, drift y guards SQL',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma', 'migrations'),
      cache = join(root, 'node_modules', '.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'printing-migration-')),
      migrations = join(temp, 'migrations');
    await mkdir(migrations);
    const config = join(temp, 'prisma.config.ts'),
      schema = join(temp, 'schema.prisma');
    await cp(join(root, 'prisma', 'schema.prisma'), schema);
    await writeFile(
      config,
      "import {defineConfig} from 'prisma/config';export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    const names = (await readdir(source)).filter((n) => /^\d+_/.test(n)).sort();
    const parent = await connectedTestDatabaseManagement(process.env.DATABASE_URL!),
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
      for (const n of names.filter((n) => n < '20261019190000'))
        await cp(join(source, n), join(migrations, n), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const name = 'maxbio_print_migration_' + randomUUID().replaceAll('-', '');
        assert.match(name, /^maxbio_print_migration_[a-f0-9]{32}$/);
        await parent.query('CREATE DATABASE "' + name + '"');
        created.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + name;
        const client = createDatabaseClient(url.toString());
        try {
          if (mode === 'upgrade') {
            cli(url.toString(), ['migrate', 'deploy']);
            const absent = await client.$queryRaw<
              Array<{ table: string | null }>
            >`SELECT to_regclass('public."PrintTemplate"')::text AS table`;
            assert.equal(absent[0]!.table, null);
            const org = await client.organization.create({
              data: { name: 'HEAD printing upgrade', slug: randomUUID() },
            });
            await client.customer.create({
              select: { id: true },
              data: { organizationId: org.id, name: 'Cliente anterior', kind: 'COMPANY' },
            });
            await client.product.create({
              data: { organizationId: org.id, name: 'Producto anterior', unitOfMeasure: 'UNIT' },
            });
            for (const n of names.filter((n) => n >= '20261019190000'))
              await cp(join(source, n), join(migrations, n), { recursive: true });
          }
          cli(url.toString(), ['migrate', 'deploy']);
          assert.match(cli(url.toString(), ['migrate', 'status']), /up to date/);
          cli(url.toString(), [
            'migrate',
            'diff',
            '--from-config-datasource',
            '--to-schema',
            schema,
            '--exit-code',
          ]);
          assert.equal(await client.customer.count(), mode === 'upgrade' ? 1 : 0);
          assert.equal(await client.product.count(), mode === 'upgrade' ? 1 : 0);
          assert.equal(await client.deliveryNote.count(), 0);
          assert.equal(await client.inventoryMovement.count(), 0);
          assert.equal(await client.inventoryBalance.count(), 0);
          assert.equal(await client.printTemplate.count(), 0);
          const triggers = await client.$queryRaw<
            Array<{ tgname: string }>
          >`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`;
          for (const n of [
            'print_template_guard',
            'print_calibration_immutable',
            'print_asset_immutable',
            'print_artifact_immutable',
            'print_artifact_guard',
            'print_configuration_guard',
            'delivery_complete',
            'inventory_line_immutable',
          ])
            assert.ok(
              triggers.some((t) => t.tgname === n),
              n,
            );
          const org = await client.organization.create({
            data: { name: 'Guard fixture', slug: randomUUID() },
          });
          const assetId = randomUUID();
          await assert.rejects(
            client.printAsset.create({
              data: {
                organizationId: org.id,
                kind: 'BACKGROUND',
                storageKey: org.id + '/' + randomUUID(),
                contentHash: 'a'.repeat(64),
                byteSize: 1,
              },
            }),
          );
          await client.printAsset.create({
            data: {
              id: assetId,
              organizationId: org.id,
              kind: 'BACKGROUND',
              storageKey: org.id + '/' + randomUUID(),
              contentHash: 'a'.repeat(64),
              byteSize: 1,
              widthPx: 180,
              heightPx: 240,
            },
          });
          const id = randomUUID();
          for (const definition of [{}, { schemaVersion: null }])
            await assert.rejects(
              client.printTemplate.create({
                data: {
                  id: randomUUID(),
                  organizationId: org.id,
                  familyId: id,
                  revision: 1,
                  name: 'Invalid schema fixture',
                  pageWidthMm: 180,
                  pageHeightMm: 240,
                  safeToleranceXmm: 2,
                  safeToleranceYmm: 1,
                  backgroundAssetId: assetId,
                  definition,
                },
              }),
            );
          await client.printTemplate.create({
            data: {
              id,
              organizationId: org.id,
              familyId: id,
              revision: 1,
              name: 'Fixture',
              pageWidthMm: 180,
              pageHeightMm: 240,
              safeToleranceXmm: 2,
              safeToleranceYmm: 1,
              backgroundAssetId: assetId,
              definition: { schemaVersion: 1 },
            },
          });
          await assert.rejects(
            client.printConfiguration.create({
              data: { organizationId: org.id, templateRevisionId: id },
            }),
          );
          await client.printTemplate.update({
            where: { id },
            data: { status: 'PUBLISHED', publishedAt: new Date() },
          });
          await assert.rejects(
            client.printTemplate.update({ where: { id }, data: { name: 'No' } }),
          );
          await assert.rejects(client.printTemplate.delete({ where: { id } }));
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_print_migration_[a-f0-9]{32}$/);
        await parent.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.end();
      assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, cp, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';

test(
  'Remitos migration: HEAD upgrade, from zero, status, schema drift, constraints and indexes',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma', 'migrations'),
      cache = join(root, 'node_modules', '.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'delivery-migration-')),
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
      for (const n of names.filter((n) => n < '20261008170000'))
        await cp(join(source, n), join(migrations, n), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const name = 'maxbio_delivery_migration_' + randomUUID().replaceAll('-', '');
        assert.match(name, /^maxbio_delivery_migration_[a-f0-9]{32}$/);
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
            >`SELECT to_regclass('public."DeliveryNote"')::text AS table`;
            assert.equal(absent[0]!.table, null);
            const org = await client.organization.create({
              data: { name: 'HEAD customer', slug: randomUUID() },
            });
            await client.customer.create({
              data: { organizationId: org.id, name: 'Cliente previo', kind: 'HEALTH_INSURER' },
            });
            await client.product.create({
              data: { organizationId: org.id, name: 'Producto previo', unitOfMeasure: 'UNIT' },
            });
            for (const n of names.filter((n) => n >= '20261008170000'))
              await cp(join(source, n), join(migrations, n), { recursive: true });
          }
          cli(url.toString(), ['migrate', 'deploy']);
          assert.equal(await client.customer.count(), mode === 'upgrade' ? 1 : 0);
          assert.equal(await client.product.count(), mode === 'upgrade' ? 1 : 0);
          assert.equal(await client.deliveryNote.count(), 0);
          assert.equal(await client.inventoryMovement.count(), 0);
          assert.equal(await client.inventoryBalance.count(), 0);
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
          >`SELECT conname FROM pg_constraint WHERE conrelid IN ('"DeliveryNote"'::regclass,'"DeliveryNoteLine"'::regclass,'"DeliveryNoteAllocation"'::regclass,'"InventoryMovement"'::regclass,'"InventoryMovementLine"'::regclass)`;
          for (const n of [
            'delivery_state',
            'delivery_number',
            'delivery_line_quantity',
            'delivery_allocation_quantity',
            'inventory_movement_source',
            'InventoryMovementLine_delivery_source_fkey',
          ])
            assert.ok(
              constraints.some((c) => c.conname === n),
              n,
            );
          const triggers = await client.$queryRaw<
            Array<{ tgname: string }>
          >`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`;
          for (const n of [
            'delivery_complete',
            'delivery_movement_complete',
            'delivery_document_guard',
            'delivery_line_guard',
            'delivery_allocation_guard',
            'delivery_position_guard',
            'inventory_line_immutable',
          ])
            assert.ok(
              triggers.some((t) => t.tgname === n),
              n,
            );
          const indexes = await client.$queryRaw<
            Array<{ indexname: string }>
          >`SELECT indexname FROM pg_indexes WHERE tablename IN ('DeliveryNote','InventoryMovement')`;
          for (const n of [
            'DeliveryNote_organizationId_documentPrefix_documentNumber_key',
            'InventoryMovement_organizationId_deliveryNoteId_key',
            'DeliveryNote_organizationId_confirmationOperationId_key',
          ])
            assert.ok(
              indexes.some((i) => i.indexname === n),
              n,
            );
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_delivery_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.$disconnect();
      assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

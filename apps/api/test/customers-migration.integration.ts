import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient, PrismaClient, type Prisma } from '@maxbio/database';

test(
  'Customers: migración desde HEAD y desde cero, constraints/índices reales y sin drift',
  { timeout: 180000 },
  async () => {
    const databaseRoot = resolve('../../packages/database');
    const source = join(databaseRoot, 'prisma', 'migrations');
    const cacheRoot = join(databaseRoot, 'node_modules', '.cache');
    const { PrismaPg } = createRequire(join(databaseRoot, 'package.json'))(
      '@prisma/adapter-pg',
    ) as {
      PrismaPg: new (options: {
        connectionString: string;
        max: number;
        statement_timeout: number;
        query_timeout: number;
      }) => NonNullable<Prisma.PrismaClientOptions['adapter']>;
    };
    const parent = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL!,
        max: 1,
        statement_timeout: 30000,
        query_timeout: 35000,
      }),
    });
    await mkdir(cacheRoot, { recursive: true });
    const temporary = await mkdtemp(join(cacheRoot, 'customers-migration-'));
    const migrations = join(temporary, 'migrations');
    await mkdir(migrations);
    const schemaPath = join(temporary, 'schema.prisma'),
      configPath = join(temporary, 'prisma.config.ts');
    await cp(join(databaseRoot, 'prisma', 'schema.prisma'), schemaPath);
    await writeFile(
      configPath,
      "import {defineConfig} from 'prisma/config'; export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    const names = (await readdir(source)).filter((name) => /^\d+_/.test(name)).sort();
    const customerMigration = '20261008120000_customers';
    assert.ok(names.includes(customerMigration));
    const created: string[] = [];
    function cli(url: string, args: string[]) {
      return execFileSync(
        process.execPath,
        [
          join(databaseRoot, 'node_modules', 'prisma', 'build', 'index.js'),
          ...args,
          '--config',
          configPath,
        ],
        {
          cwd: databaseRoot,
          env: { ...process.env, DATABASE_URL: url },
          stdio: 'pipe',
          timeout: 60000,
        },
      ).toString();
    }
    try {
      await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
      for (const name of names.filter((name) => name < customerMigration))
        await cp(join(source, name), join(migrations, name), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const dbName = 'maxbio_customers_migration_' + randomUUID().replaceAll('-', '');
        assert.match(dbName, /^maxbio_customers_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('CREATE DATABASE "' + dbName + '"');
        created.push(dbName);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + dbName;
        const connection = url.toString(),
          client = createDatabaseClient(connection);
        try {
          let organizationId: string;
          if (mode === 'upgrade') {
            cli(connection, ['migrate', 'deploy']);
            const missing = await client.$queryRaw<
              Array<{ table: string | null }>
            >`SELECT to_regclass('public."Customer"')::text AS table`;
            assert.equal(missing[0]!.table, null);
            organizationId = (
              await client.organization.create({
                data: { name: 'HEAD fixture', slug: randomUUID() },
              })
            ).id;
            await client.product.create({
              data: { organizationId, name: 'Product previo', unitOfMeasure: 'UNIT' },
            });
            await client.supplier.create({ data: { organizationId, name: 'Supplier previo' } });
            await cp(join(source, customerMigration), join(migrations, customerMigration), {
              recursive: true,
            });
            for (const name of names.filter((name) => name > customerMigration))
              await cp(join(source, name), join(migrations, name), { recursive: true });
            cli(connection, ['migrate', 'deploy']);
            assert.equal(await client.product.count(), 1);
            assert.equal(await client.supplier.count(), 1);
          } else {
            cli(connection, ['migrate', 'deploy']);
            organizationId = (
              await client.organization.create({
                data: { name: 'Base vacía fixture', slug: randomUUID() },
              })
            ).id;
            assert.equal(await client.product.count(), 0);
          }
          const row = await client.customer.create({
            data: {
              organizationId,
              name: 'Clínica después de migrar',
              kind: 'INSTITUTION',
              cuit: '20123456786',
            },
          });
          assert.equal(row.searchText, 'clinica despues de migrar 20123456786');
          await assert.rejects(
            client.customer.create({
              data: { organizationId, name: 'Duplicado', kind: 'OTHER', cuit: row.cuit },
            }),
          );
          await assert.rejects(
            client.customer.create({
              data: { organizationId, name: 'CUIT inválido', kind: 'OTHER', cuit: '20123456785' },
            }),
          );
          const checks = await client.$queryRaw<
            Array<{ conname: string }>
          >`SELECT conname FROM pg_constraint WHERE conrelid='"Customer"'::regclass`;
          for (const name of [
            'Customer_pkey',
            'Customer_organizationId_fkey',
            'Customer_name_check',
            'Customer_version_check',
            'Customer_cuit_check',
            'Customer_lifecycle_check',
          ])
            assert.ok(
              checks.some((check) => check.conname === name),
              name,
            );
          const indexes = await client.$queryRaw<
            Array<{ indexname: string; indexdef: string }>
          >`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='Customer'`;
          for (const name of [
            'Customer_pkey',
            'Customer_organizationId_id_key',
            'Customer_organizationId_cuit_key',
            'Customer_organizationId_archivedAt_name_id_idx',
            'Customer_searchText_idx',
          ])
            assert.ok(
              indexes.some((index) => index.indexname === name),
              name,
            );
          assert.match(
            indexes.find((index) => index.indexname === 'Customer_searchText_idx')!.indexdef,
            /gin.*gin_trgm_ops/,
          );
          assert.match(cli(connection, ['migrate', 'status']), /up to date/);
          cli(connection, [
            'migrate',
            'diff',
            '--from-config-datasource',
            '--to-schema',
            schemaPath,
            '--exit-code',
          ]);
          assert.equal(await client.inventoryMovement.count(), 0);
          assert.equal(await client.inventoryBalance.count(), 0);
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const dbName of created) {
        assert.match(dbName, /^maxbio_customers_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + dbName + '" WITH (FORCE)');
      }
      await parent.$disconnect();
      assert.ok(resolve(temporary).startsWith(resolve(cacheRoot) + sep));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

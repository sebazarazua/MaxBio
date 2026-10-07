import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readdir, cp, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createDatabaseClient, PrismaClient, type Prisma } from '@maxbio/database';

test(
  'Prisma Migrate: backfill V2 determinista, historia redondeada, vínculo intacto y previews vencidos',
  { timeout: 120000 },
  async () => {
    const databaseName = 'maxbio_catalog_migration_' + randomUUID().replaceAll('-', '');
    assert.match(databaseName, /^maxbio_catalog_migration_[a-f0-9]{32}$/);
    // Database creation copies template1 and is maintenance, not an API query.
    // Keep the application client's two-second statement limit unchanged.
    const { PrismaPg } = createRequire(resolve('../../packages/database/package.json'))(
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
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/' + databaseName;
    const client = createDatabaseClient(url.toString());
    const databaseRoot = resolve('../../packages/database');
    const cacheRoot = join(databaseRoot, 'node_modules', '.cache');
    await mkdir(cacheRoot, { recursive: true });
    const temporary = await mkdtemp(join(cacheRoot, 'catalog-migration-'));
    const migrations = join(temporary, 'migrations');
    await mkdir(migrations);
    const configPath = join(temporary, 'prisma.config.ts');
    await writeFile(
      configPath,
      `import {defineConfig} from 'prisma/config'; export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});`,
    );
    await cp(join(databaseRoot, 'prisma', 'schema.prisma'), join(temporary, 'schema.prisma'));
    const source = join(databaseRoot, 'prisma', 'migrations');
    const names = (await readdir(source)).filter((name) => /^\d+_/.test(name)).sort();
    const added = names.filter((name) => name >= '20261007170000');
    const migrate = () =>
      execFileSync(
        process.execPath,
        [
          join(databaseRoot, 'node_modules', 'prisma', 'build', 'index.js'),
          'migrate',
          'deploy',
          '--config',
          configPath,
        ],
        {
          cwd: databaseRoot,
          env: { ...process.env, DATABASE_URL: url.toString() },
          stdio: 'pipe',
          timeout: 60000,
        },
      );
    try {
      await parent.$executeRawUnsafe('CREATE DATABASE "' + databaseName + '"');
      await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
      for (const name of names.filter((name) => !added.includes(name)))
        await cp(join(source, name), join(migrations, name), { recursive: true });
      migrate();
      const organization = await client.organization.create({
        data: { name: 'Backfill', slug: randomUUID() },
      });
      const other = await client.organization.create({
        data: { name: 'Otro tenant', slug: randomUUID() },
      });
      const supplierA = randomUUID(),
        supplierB = randomUUID(),
        supplierOther = randomUUID();
      await client.$executeRaw`INSERT INTO "Supplier" (id,"organizationId",name,"createdAt","updatedAt","archivedAt") VALUES (${supplierA}::uuid,${organization.id}::uuid,'Anterior','2026-01-01',NOW(),NOW()),(${supplierB}::uuid,${organization.id}::uuid,'Posterior','2026-02-01',NOW(),NULL),(${supplierOther}::uuid,${other.id}::uuid,'Privado','2026-01-01',NOW(),NULL)`;
      const productId = randomUUID();
      await client.$executeRaw`INSERT INTO "Product" (id,"organizationId",name,"unitOfMeasure","updatedAt") VALUES (${productId}::uuid,${organization.id}::uuid,'Producto físico','UNIT',NOW())`;
      const link = await client.supplierProduct.create({
        data: {
          organizationId: organization.id,
          supplierId: supplierA,
          productId,
          supplierCode: 'external',
        },
      });
      const first = '00000000-0000-4000-8000-000000000001',
        second = '00000000-0000-4000-8000-000000000002',
        third = randomUUID(),
        foreign = randomUUID();
      await client.$executeRaw`INSERT INTO "SupplierCatalogItem" (id,"organizationId","supplierId","supplierCode",description,price,currency,"supplierProductId","createdAt","updatedAt","archivedAt") VALUES
      (${second}::uuid,${organization.id}::uuid,${supplierA}::uuid,'B','Segundo',100.101,'ARS',NULL,'2026-01-01',NOW(),NOW()),
      (${first}::uuid,${organization.id}::uuid,${supplierA}::uuid,'00-a/B','Primero',218505.11669999998,'ARS',${link.id}::uuid,'2026-01-01',NOW(),NULL),
      (${third}::uuid,${organization.id}::uuid,${supplierB}::uuid,'C','Tercero',NULL,NULL,NULL,'2026-01-01',NOW(),NULL),
      (${foreign}::uuid,${other.id}::uuid,${supplierOther}::uuid,'C','Privado',NULL,NULL,NULL,'2026-01-01',NOW(),NULL)`;
      const user = await client.user.create({
        data: { email: randomUUID() + '@example.invalid', displayName: 'Migración' },
      });
      const membership = await client.membership.create({
        data: { organizationId: organization.id, userId: user.id, role: 'ADMIN' },
      });
      const session = await client.session.create({
        data: {
          userId: user.id,
          activeMembershipId: membership.id,
          tokenHash: 'a'.repeat(64),
          expiresAt: new Date(Date.now() + 86400000),
          absoluteExpiresAt: new Date(Date.now() + 86400000),
        },
      });
      const base = {
        organizationId: organization.id,
        supplierId: supplierA,
        actorUserId: user.id,
        membershipId: membership.id,
        sessionId: session.id,
        fileName: 'backfill.csv',
        contentHash: 'b'.repeat(64),
        format: 'CSV',
        sheetName: 'CSV',
        headerRow: 1,
        mapping: { supplierCode: 0, description: 1 },
        mode: 'PARTIAL' as const,
        previewHash: 'c'.repeat(64),
        catalogHash: 'd'.repeat(64),
        summary: { total: 1 },
        expiresAt: new Date(Date.now() + 86400000),
      };
      const historical = await client.supplierCatalogImport.create({
        data: { ...base, status: 'COMMITTED', committedAt: new Date() },
      });
      const pending = await client.supplierCatalogImport.create({ data: base });
      await client.supplierCatalogImportRow.create({
        data: {
          organizationId: organization.id,
          supplierId: supplierA,
          importId: historical.id,
          rowNumber: 2,
          outcome: 'CREATED',
          itemId: first,
          supplierCode: '00-a/B',
          data: {
            supplierCode: '00-a/B',
            description: 'Primero',
            price: '218505.11669999998',
            currency: 'ARS',
          },
          messages: [],
        },
      });
      for (const name of added)
        await cp(join(source, name), join(migrations, name), { recursive: true });
      migrate();
      const items = await client.supplierCatalogItem.findMany({ orderBy: { id: 'asc' } });
      assert.equal(items.find((item) => item.id === first)!.internalReferenceCode, 'A000001');
      assert.equal(items.find((item) => item.id === second)!.internalReferenceCode, 'A000002');
      assert.equal(items.find((item) => item.id === third)!.internalReferenceCode, 'B000001');
      assert.equal(items.find((item) => item.id === foreign)!.internalReferenceCode, 'A000001');
      assert.equal(items.find((item) => item.id === first)!.supplierProductId, link.id);
      assert.equal(items.find((item) => item.id === first)!.supplierCode, '00-a/B');
      assert.equal(items.find((item) => item.id === first)!.price!.toFixed(2), '218505.12');
      assert.equal(items.find((item) => item.id === second)!.price!.toFixed(2), '100.11');
      assert.equal(
        (await client.supplier.findUniqueOrThrow({ where: { id: supplierA } })).catalogNextSequence,
        3,
      );
      const snapshot = (
        await client.supplierCatalogImportRow.findFirstOrThrow({
          where: { importId: historical.id },
        })
      ).data as { price: string; internalReferenceCode: string; manufacturerText: null };
      assert.equal(snapshot.price, '218505.12');
      assert.equal(snapshot.internalReferenceCode, 'A000001');
      assert.equal(snapshot.manufacturerText, null);
      assert.ok(
        (await client.supplierCatalogImport.findUniqueOrThrow({ where: { id: pending.id } }))
          .expiresAt <= new Date(),
      );
      assert.equal(await client.product.count(), 1);
      assert.equal(await client.productIdentifier.count(), 0);
      assert.equal(await client.supplierProduct.count(), 1);
      assert.equal(await client.inventoryMovement.count(), 0);
      assert.equal(await client.inventoryBalance.count(), 0);
      const before = await client.supplierCatalogItem.findMany({ orderBy: { id: 'asc' } });
      migrate();
      assert.deepEqual(
        await client.supplierCatalogItem.findMany({ orderBy: { id: 'asc' } }),
        before,
      );
    } finally {
      await client.$disconnect();
      await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + databaseName + '" WITH (FORCE)');
      await parent.$disconnect();
      assert.ok(temporary.startsWith(cacheRoot + sep));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

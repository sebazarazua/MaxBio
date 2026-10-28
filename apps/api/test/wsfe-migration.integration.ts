import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';
import { testDatabaseManagement } from './test-database-management.js';
test(
  'WSFE migration: upgrade preserves ACTIVE/config/customer, zero install, constraints and no drift',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma/migrations'),
      cache = join(root, 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'wsfe-migration-')),
      migrations = join(temp, 'migrations');
    await mkdir(migrations);
    await cp(join(root, 'prisma/schema.prisma'), join(temp, 'schema.prisma'));
    await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    const config = join(temp, 'prisma.config.ts');
    await writeFile(
      config,
      "import {defineConfig} from 'prisma/config';export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    const names = (await readdir(source)).filter((n) => /^\d+_/.test(n)).sort();
    const parent = testDatabaseManagement(process.env.DATABASE_URL!);
    await parent.connect();
    const created: string[] = [];
    const cli = (url: string, args: string[]) =>
      execFileSync(
        process.execPath,
        [join(root, 'node_modules/prisma/build/index.js'), ...args, '--config', config],
        { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000 },
      ).toString();
    try {
      for (const name of names.filter((n) => n < '20261028200000'))
        await cp(join(source, name), join(migrations, name), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const name = 'maxbio_wsfe_migration_' + randomUUID().replaceAll('-', '');
        created.push(name);
        await parent.query('CREATE DATABASE "' + name + '"');
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + name;
        const db = createDatabaseClient(url.toString());
        let active: Awaited<ReturnType<typeof db.arcaCredential.findFirst>> = null,
          customerId: string | undefined,
          organizationId: string | undefined;
        try {
          if (mode === 'upgrade') {
            cli(url.toString(), ['migrate', 'deploy']);
            organizationId = (
              await db.organization.create({ data: { name: 'Pre V3', slug: randomUUID() } })
            ).id;
            customerId = randomUUID();
            await db.$executeRaw`INSERT INTO "Customer" (id,"organizationId",name,kind,"taxConditionText","searchText","updatedAt") VALUES (${customerId}::uuid,${organizationId}::uuid,'Preserved','COMPANY','Responsable Inscripto','preserved',now())`;
            await db.$executeRaw`INSERT INTO "ArcaIntegrationConfig" ("organizationId","lastResultCode","updatedAt") VALUES (${organizationId}::uuid,'SUCCESS',now())`;
            active = await db.arcaCredential.create({
              data: {
                organizationId,
                commonName: 'Existing active',
                legalName: 'Test',
                cuit: '27110247244',
                status: 'ACTIVE',
                generationOperationId: randomUUID(),
                generationHash: 'a'.repeat(64),
                privateKeyStorageKey: organizationId + '/' + randomUUID(),
                csrStorageKey: organizationId + '/' + randomUUID(),
                certificateStorageKey: organizationId + '/' + randomUUID(),
                certificateFingerprint: 'existing public fingerprint',
                certificateSerial: '123',
                certificateSubject: 'CN=Test',
                certificateIssuer: 'CN=Test',
                validFrom: new Date('2026-01-01'),
                validTo: new Date('2028-01-01'),
              },
            });
          }
          for (const name of names.filter((n) => n >= '20261028200000'))
            await cp(join(source, name), join(migrations, name), { recursive: true });
          cli(url.toString(), ['migrate', 'deploy']);
          assert.match(cli(url.toString(), ['migrate', 'status']), /up to date/);
          cli(url.toString(), [
            'migrate',
            'diff',
            '--from-config-datasource',
            '--to-schema',
            join(temp, 'schema.prisma'),
            '--exit-code',
          ]);
          assert.equal(await db.invoiceFiscalAttempt.count(), 0);
          assert.equal(await db.fiscalSequence.count(), 0);
          if (active && customerId && organizationId) {
            assert.deepEqual(
              await db.arcaCredential.findUniqueOrThrow({ where: { id: active.id } }),
              active,
            );
            const c = await db.customer.findUniqueOrThrow({ where: { id: customerId } });
            assert.equal(c.arcaVatConditionId, null);
            assert.equal(c.taxConditionText, 'Responsable Inscripto');
            const config = await db.arcaIntegrationConfig.findUniqueOrThrow({
              where: { organizationId },
            });
            assert.equal(config.lastResultCode, 'SUCCESS');
            assert.equal(config.pointOfSale, null);
            assert.equal(config.wsfeReferences, null);
            // CHECK must reject partial tuples even when a nullable field is UNKNOWN.
            await assert.rejects(
              db.arcaIntegrationConfig.update({
                where: { organizationId },
                data: { pointOfSaleCuit: '27110247244', pointOfSaleValidatedAt: new Date() },
              }),
            );
            await assert.rejects(
              db.fiscalSequence.create({
                data: { organizationId, pointOfSale: 0, documentType: 1 },
              }),
            );
          }
        } finally {
          await db.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_wsfe_migration_[a-f0-9]{32}$/);
        await parent.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.end();
      assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

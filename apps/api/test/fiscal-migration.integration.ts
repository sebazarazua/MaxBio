import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';
test(
  'Fiscal migration: upgrade existing V1, from zero, status, drift, constraints and no tenant defaults',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma/migrations'),
      cache = join(root, 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'fiscal-migration-')),
      migrations = join(temp, 'migrations'),
      config = join(temp, 'prisma.config.ts'),
      schema = join(temp, 'schema.prisma');
    await mkdir(migrations);
    await cp(join(root, 'prisma/schema.prisma'), schema);
    await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    await writeFile(
      config,
      "import {defineConfig} from 'prisma/config';export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    const names = (await readdir(source)).filter((n) => /^\d+_/.test(n)).sort(),
      parent = createDatabaseClient(process.env.DATABASE_URL!),
      created: string[] = [];
    const cli = (url: string, args: string[]) =>
      execFileSync(
        process.execPath,
        [join(root, 'node_modules/prisma/build/index.js'), ...args, '--config', config],
        { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000 },
      ).toString();
    try {
      for (const n of names.filter((n) => n < '20261027161753'))
        await cp(join(source, n), join(migrations, n), { recursive: true });
      for (const mode of ['upgrade', 'empty']) {
        const name = 'maxbio_fiscal_migration_' + randomUUID().replaceAll('-', '');
        await parent.$executeRawUnsafe('CREATE DATABASE "' + name + '"');
        created.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + name;
        const client = createDatabaseClient(url.toString());
        try {
          if (mode === 'upgrade') {
            cli(url.toString(), ['migrate', 'deploy']);
            const org = await client.organization.create({
              data: { name: 'Preserved V1', slug: randomUUID() },
            });
            await client.customer.create({
              data: { organizationId: org.id, name: 'Existing customer', kind: 'COMPANY' },
            });
            for (const n of names.filter((n) => n >= '20261027161753'))
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
          assert.equal(await client.invoice.count(), 0);
          assert.equal(await client.organizationFiscalProfile.count(), 0);
          assert.equal(await client.arcaCredential.count(), 0);
          assert.equal(await client.arcaIntegrationConfig.count(), 0);
          const org = await client.organization.create({
            data: { name: 'Constraint test', slug: randomUUID() },
          });
          await assert.rejects(
            client.organizationFiscalProfile.create({
              data: { organizationId: org.id, cuit: '27110247245' },
            }),
          );
          await assert.rejects(
            client.arcaIntegrationConfig.create({
              data: { organizationId: org.id, service: 'wsfev1' },
            }),
          );
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_fiscal_migration_[a-f0-9]{32}$/);
        await parent.$executeRawUnsafe('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.$disconnect();
      const target = resolve(temp);
      assert.ok(target.startsWith(resolve(cache) + sep));
      await rm(target, { recursive: true, force: true });
    }
  },
);

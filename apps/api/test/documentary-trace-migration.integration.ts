import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createDatabaseClient } from '@maxbio/database';
import { connectedTestDatabaseManagement } from './test-database-management.js';

test(
  'Stage 5 migration: upgrade/backfill uses ledger snapshots, drafts, empty history, from zero and corrupt history fails',
  { timeout: 180000 },
  async () => {
    const root = resolve('../../packages/database'),
      source = join(root, 'prisma/migrations'),
      cache = join(root, 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const temp = await mkdtemp(join(cache, 'trace-migration-')),
      migrations = join(temp, 'migrations');
    await mkdir(migrations);
    const config = join(temp, 'prisma.config.ts');
    await writeFile(
      config,
      "import {defineConfig} from 'prisma/config';export default defineConfig({schema:'schema.prisma',migrations:{path:'migrations'},datasource:{url:process.env.DATABASE_URL}});",
    );
    await cp(join(root, 'prisma/schema.prisma'), join(temp, 'schema.prisma'));
    await cp(join(source, 'migration_lock.toml'), join(migrations, 'migration_lock.toml'));
    const names = (await readdir(source)).filter((n) => /^\d+_/.test(n)).sort();
    const last = '20261026190000_delivery_documentary_trace';
    const parent = await connectedTestDatabaseManagement(process.env.DATABASE_URL!);
    const created: string[] = [];
    const cli = (url: string, args: string[]) =>
      execFileSync(
        process.execPath,
        [join(root, 'node_modules/prisma/build/index.js'), ...args, '--config', config],
        { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', timeout: 60000 },
      ).toString();
    try {
      // Only the migrations that precede Stage 5; later ones depend on its objects.
      for (const name of names.filter((n) => n < last))
        await cp(join(source, name), join(migrations, name), { recursive: true });
      for (const mode of ['upgrade', 'corrupt', 'empty']) {
        const name = 'maxbio_trace_migration_' + randomUUID().replaceAll('-', '');
        assert.match(name, /^maxbio_trace_migration_[a-f0-9]{32}$/);
        await parent.query('CREATE DATABASE "' + name + '"');
        created.push(name);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = '/' + name;
        const client = createDatabaseClient(url.toString());
        try {
          if (mode !== 'empty') {
            // The prior stages contain no table; fixtures are written only in this disposable database.
            for (const name of names.filter((n) => n >= last))
              await rm(join(migrations, name), { recursive: true, force: true });
            cli(url.toString(), ['migrate', 'deploy']);
            const org = await client.organization.create({
              data: { name: 'Legacy', slug: randomUUID() },
            });
            const user = await client.user.create({
              data: { email: randomUUID() + '@example.invalid', displayName: 'Legacy' },
            });
            const member = await client.membership.create({
              data: { organizationId: org.id, userId: user.id, role: 'ADMIN' },
            });
            const session = await client.session.create({
              data: {
                userId: user.id,
                activeMembershipId: member.id,
                tokenHash: 'a'.repeat(64),
                expiresAt: new Date('2099-01-01'),
                absoluteExpiresAt: new Date('2099-01-01'),
              },
            });
            const customer = await client.customer.create({
              select: { id: true, name: true },
              data: { organizationId: org.id, name: 'Legacy customer', kind: 'COMPANY' },
            });
            const product = await client.product.create({
              data: { organizationId: org.id, name: 'Legacy product', unitOfMeasure: 'UNIT' },
            });
            await client.productInventoryPolicy.create({
              data: { organizationId: org.id, productId: product.id },
            });
            const location = await client.inventoryLocation.create({
              data: { organizationId: org.id, code: 'MAIN', name: 'Main' },
            });
            const lot = await client.inventoryLot.create({
              data: {
                organizationId: org.id,
                productId: product.id,
                lotNumber: 'LIVE',
                normalizedLotNumber: 'LIVE',
                expirationDate: new Date('2099-01-01'),
              },
            });
            const balance = await client.inventoryBalance.create({
              data: {
                organizationId: org.id,
                productId: product.id,
                locationId: location.id,
                lotId: lot.id,
                condition: 'USABLE',
                quantity: '5',
              },
            });
            const id = randomUUID(),
              draft = randomUUID(),
              without = randomUUID();
            await client.$transaction(async (tx) => {
              for (const [n, did] of [id, draft, without].entries()) {
                await tx.deliveryNote.create({
                  data: {
                    id: did,
                    organizationId: org.id,
                    customerId: customer.id,
                    documentDate: new Date('2026-10-26'),
                    documentPrefix: '1',
                    documentNumber: String(n + 1),
                    creationHash: 'a'.repeat(64),
                  },
                });
                const line = await tx.deliveryNoteLine.create({
                  data: {
                    organizationId: org.id,
                    deliveryNoteId: did,
                    productId: product.id,
                    ordinal: 0,
                    quantity: '2',
                    productNameSnapshot: product.name,
                    unitOfMeasureSnapshot: 'UNIT',
                  },
                });
                if (did !== without) {
                  const a = await tx.deliveryNoteAllocation.create({
                    data: {
                      organizationId: org.id,
                      productId: product.id,
                      lineId: line.id,
                      positionId: balance.id,
                      quantity: '2',
                    },
                  });
                  if (did === id) {
                    const m = await tx.inventoryMovement.create({
                      data: {
                        organizationId: org.id,
                        actorUserId: user.id,
                        membershipId: member.id,
                        sessionId: session.id,
                        type: 'OUTBOUND',
                        deliveryNoteId: did,
                      },
                    });
                    await tx.inventoryMovementLine.create({
                      data: {
                        organizationId: org.id,
                        productId: product.id,
                        locationId: location.id,
                        lotId: lot.id,
                        condition: 'USABLE',
                        movementId: m.id,
                        quantityDelta: '-2',
                        unitOfMeasure: 'UNIT',
                        productName: product.name,
                        lotNumber: 'HISTORICAL',
                        expirationDate: new Date('2098-12-31'),
                        deliveryAllocationId: a.id,
                      },
                    });
                    await tx.inventoryMovement.update({
                      where: { id: m.id },
                      data: { postedAt: new Date() },
                    });
                  }
                }
                if (did !== draft)
                  await tx.deliveryNote.update({
                    where: { id: did },
                    data: {
                      status: 'CONFIRMED',
                      version: 2,
                      confirmedAt: new Date(),
                      confirmedByUserId: user.id,
                      confirmedByMembershipId: member.id,
                      confirmationOperationId: randomUUID(),
                      requestHash: 'b'.repeat(64),
                      customerSnapshot: { name: customer.name },
                    },
                  });
              }
            });
            if (mode === 'corrupt') {
              // Deliberately manufacture invalid legacy history to verify a hard migration failure.
              await client.$executeRawUnsafe(
                'ALTER TABLE "InventoryMovementLine" DISABLE TRIGGER USER',
              );
              await client.inventoryMovementLine.deleteMany();
              await client.$executeRawUnsafe(
                'ALTER TABLE "InventoryMovementLine" ENABLE TRIGGER USER',
              );
            }
          }
          // Stage 5 and every later migration, so the result is compared with the current schema.
          for (const name of names.filter((n) => n >= last))
            await cp(join(source, name), join(migrations, name), { recursive: true });
          if (mode === 'corrupt') {
            assert.throws(() => cli(url.toString(), ['migrate', 'deploy']), /./);
            continue;
          }
          cli(url.toString(), ['migrate', 'deploy']);
          // Re-running deploy is an idempotent no-op, not a second INSERT/backfill.
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
          const traces = await client.deliveryNoteLineTrace.findMany({
            include: { line: { include: { deliveryNote: true } } },
          });
          assert.equal(traces.length, mode === 'empty' ? 0 : 2);
          if (mode === 'upgrade') {
            const historical = traces.find((t) => t.line.deliveryNote.status === 'CONFIRMED')!;
            assert.equal(historical.lotNumber, 'HISTORICAL');
            assert.equal(historical.expirationDate!.toISOString().slice(0, 10), '2098-12-31');
            assert.equal(historical.captureMethod, 'LEGACY');
            assert.equal(historical.scannedGtinSnapshot, null);
            assert.equal(historical.origin, 'INVENTORY');
            assert.deepEqual(historical.reviewedPriorTraceIds, []);
            assert.equal(
              traces.find((t) => t.line.deliveryNote.status === 'DRAFT')!.lotNumber,
              'LIVE',
            );
            assert.equal(await client.inventoryMovement.count(), 1);
            assert.equal(await client.deliveryNote.count(), 3);
          }
        } finally {
          await client.$disconnect();
        }
      }
    } finally {
      for (const name of created) {
        assert.match(name, /^maxbio_trace_migration_[a-f0-9]{32}$/);
        await parent.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
      }
      await parent.end();
      assert.ok(resolve(temp).startsWith(resolve(cache) + sep));
      await rm(temp, { recursive: true, force: true });
    }
  },
);

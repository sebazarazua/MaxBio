import { createDatabaseClient } from '@maxbio/database';
const client = createDatabaseClient(process.env.DATABASE_URL!);
const args = process.argv.slice(2);
const organizationId = args.includes('--organization')
  ? args[args.indexOf('--organization') + 1]
  : undefined;
const productId = args.includes('--product') ? args[args.indexOf('--product') + 1] : undefined;
const rebuild = args.includes('--rebuild');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
try {
  if (
    args.some(
      (a, i) =>
        !['--organization', '--product', '--rebuild'].includes(a) &&
        !['--organization', '--product'].includes(args[i - 1] ?? ''),
    ) ||
    (args.includes('--organization') && !organizationId) ||
    (args.includes('--product') && !productId) ||
    (organizationId && !uuid.test(organizationId)) ||
    (productId && !uuid.test(productId)) ||
    (rebuild && (!organizationId || !productId))
  )
    throw new Error(
      'Uso: inventory:verify [--organization UUID] [--product UUID] [--rebuild]. Rebuild requiere ambos IDs.',
    );
  if (rebuild) {
    await client.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM "Product" WHERE "organizationId"=${organizationId}::uuid AND id=${productId}::uuid FOR UPDATE`;
        if (!rows.length) throw new Error('Producto inexistente en esa organización.');
        if (
          await tx.inventoryStockScope.findFirst({
            where: { organizationId, productId, activeCountSessionId: { not: null } },
            select: { id: true },
          })
        )
          throw new Error('Terminá o cancelá los conteos activos antes de reconstruir.');
        const invalid = await tx.$queryRaw<
          Array<{ invalid: bigint }>
        >`WITH l AS (SELECT "locationId","lotId","serialId",condition,SUM("quantityDelta") q FROM "InventoryMovementLine" WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid GROUP BY 1,2,3,4) SELECT COUNT(*) invalid FROM l WHERE q<0 OR q>99999999999999.999999 OR ("serialId" IS NOT NULL AND q NOT IN (0,1))`;
        if (invalid[0]!.invalid !== 0n)
          throw new Error('El ledger contiene posiciones inválidas; no se reconstruirá.');
        await tx.inventoryBalance.updateMany({
          where: { organizationId, productId },
          data: { quantity: '0' },
        });
        await tx.$executeRaw`INSERT INTO "InventoryBalance" (id,"organizationId","productId","locationId","lotId","serialId",condition,quantity) SELECT gen_random_uuid(),"organizationId","productId","locationId","lotId","serialId",condition,SUM("quantityDelta") FROM "InventoryMovementLine" WHERE "organizationId"=${organizationId}::uuid AND "productId"=${productId}::uuid GROUP BY 2,3,4,5,6,7 ON CONFLICT ("organizationId","productId","locationId","lotId","serialId",condition) DO UPDATE SET quantity=EXCLUDED.quantity`;
        await tx.inventoryStockScope.updateMany({
          where: { organizationId, productId },
          data: { version: { increment: 1 } },
        });
      },
      { timeout: 10000 },
    );
  }
  const rows = await client.$queryRaw<
    Array<{ mismatch: bigint }>
  >`WITH l AS (SELECT "organizationId","productId","locationId","lotId","serialId",condition,SUM("quantityDelta") quantity FROM "InventoryMovementLine" WHERE (${organizationId ?? null}::uuid IS NULL OR "organizationId"=${organizationId ?? null}::uuid) AND (${productId ?? null}::uuid IS NULL OR "productId"=${productId ?? null}::uuid) GROUP BY 1,2,3,4,5,6), b AS (SELECT * FROM "InventoryBalance" WHERE (${organizationId ?? null}::uuid IS NULL OR "organizationId"=${organizationId ?? null}::uuid) AND (${productId ?? null}::uuid IS NULL OR "productId"=${productId ?? null}::uuid)) SELECT COUNT(*) mismatch FROM l FULL JOIN b ON l."organizationId"=b."organizationId" AND l."productId"=b."productId" AND l."locationId"=b."locationId" AND l."lotId" IS NOT DISTINCT FROM b."lotId" AND l."serialId" IS NOT DISTINCT FROM b."serialId" AND l.condition=b.condition WHERE COALESCE(l.quantity,0)<>COALESCE(b.quantity,0)`;
  console.log(JSON.stringify({ rebuilt: rebuild, mismatches: rows[0]!.mismatch.toString() }));
  if (rows[0]!.mismatch !== 0n) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : 'No se pudo verificar Inventory.');
  process.exitCode = 1;
} finally {
  await client.$disconnect();
}

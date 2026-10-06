import type { PrismaClient } from '@maxbio/database';

// Solo material temporal vencido; las importaciones confirmadas nunca se eliminan.
export function purgeExpiredCatalogReviews(client: PrismaClient, organizationId?: string) {
  const expiresAt = { lt: new Date() };
  const scope = organizationId ? { organizationId } : {};
  return client.$transaction(async (tx) => {
    const uploads = await tx.supplierCatalogUpload.deleteMany({ where: { ...scope, expiresAt } });
    const rows = await tx.supplierCatalogImportRow.deleteMany({
      where: { ...scope, import: { status: 'PREVIEW', expiresAt } },
    });
    const previews = await tx.supplierCatalogImport.deleteMany({
      where: { ...scope, status: 'PREVIEW', expiresAt },
    });
    return { uploads: uploads.count, rows: rows.count, previews: previews.count };
  });
}

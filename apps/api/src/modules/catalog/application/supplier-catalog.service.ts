import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import {
  catalogImportSummarySchema,
  catalogColumnMappingSchema,
  supplierCatalogDataSchema,
  supplierCatalogLimits,
  type CatalogListQuery,
  type SupplierCatalogQuery,
  type CatalogPreviewInput,
  type CatalogCommitInput,
  type CatalogImportRowsQuery,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { CatalogRuleError } from '../domain/identifiers.js';
import { parseCatalogFile } from '../domain/catalog-file.js';
import { purgeExpiredCatalogReviews } from './catalog-review-retention.js';
import {
  digest,
  inspectSheet,
  planImport,
  catalogFingerprint,
  validateReference,
  type CatalogSheet,
  type PlannedRow,
} from '../domain/catalog-import.js';

const supplierSelect = { id: true, name: true, archivedAt: true } as const;
const importInclude = {
  supplier: { select: supplierSelect },
  membership: { select: { user: { select: { id: true, displayName: true } } } },
} as const;
type ImportRecord = Prisma.SupplierCatalogImportGetPayload<{ include: typeof importInclude }>;
const itemInclude = { supplier: { select: supplierSelect } } as const;
type ItemRecord = Prisma.SupplierCatalogItemGetPayload<{ include: typeof itemInclude }>;
const itemView = (row: ItemRecord) => {
  const { organizationId: _scope, ...view } = row;
  void _scope;
  return { ...view, associationStatus: 'UNASSOCIATED' as const };
};
function importView(row: ImportRecord) {
  const {
    organizationId: _scope,
    actorUserId: _user,
    membershipId: _member,
    sessionId: _session,
    catalogHash: _hash,
    membership,
    ...view
  } = row;
  void _scope;
  void _user;
  void _member;
  void _session;
  void _hash;
  return {
    ...view,
    mapping: catalogColumnMappingSchema.parse(row.mapping),
    summary: catalogImportSummarySchema.parse(row.summary),
    actor: membership.user,
  };
}
const windowFor = (query: CatalogListQuery) => ({
  skip: (query.page - 1) * query.limit,
  take: query.limit,
});
const pageResult = <T>(items: T[], total: number, query: CatalogListQuery) => ({
  items,
  total,
  page: query.page,
  limit: query.limit,
});
const search = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const planRow = (row: {
  rowNumber: number;
  outcome: PlannedRow['outcome'];
  itemId: string | null;
  supplierCode: string | null;
  data: unknown;
  messages: unknown;
}): PlannedRow => ({
  rowNumber: row.rowNumber,
  outcome: row.outcome,
  itemId: row.itemId,
  supplierCode: row.supplierCode,
  data: row.data === null ? null : supplierCatalogDataSchema.parse(row.data),
  messages: row.messages as string[],
});
function previewDigest(
  row: {
    supplierId: string;
    fileName: string;
    contentHash: string;
    format: string;
    sheetName: string;
    headerRow: number;
    mapping: unknown;
    mode: string;
    catalogHash: string;
    summary: unknown;
  },
  rows: PlannedRow[],
) {
  return digest({
    supplierId: row.supplierId,
    fileName: row.fileName,
    contentHash: row.contentHash,
    format: row.format,
    sheetName: row.sheetName,
    headerRow: row.headerRow,
    mapping: row.mapping,
    mode: row.mode,
    catalogHash: row.catalogHash,
    summary: row.summary,
    rows,
  });
}

@Injectable()
export class SupplierCatalogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  private admin(context: RequestActorContext) {
    if (context.role !== 'ADMIN')
      throw new ForbiddenException('Solo un administrador puede importar listas de proveedores.');
  }
  private async authorize(
    context: RequestActorContext,
    tx: Prisma.TransactionClient = this.database.client,
  ) {
    this.admin(context);
    const now = new Date();
    const membership = await tx.membership.findFirst({
      where: {
        id: context.membershipId,
        userId: context.userId,
        organizationId: context.organizationId,
        role: 'ADMIN',
        revokedAt: null,
        user: { disabledAt: null },
        organization: { archivedAt: null },
      },
    });
    const session = await tx.session.findFirst({
      where: {
        id: context.sessionId,
        userId: context.userId,
        activeMembershipId: context.membershipId,
        revokedAt: null,
        expiresAt: { gt: now },
        absoluteExpiresAt: { gt: now },
      },
    });
    if (!membership || !session)
      throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
  }
  private async supplier(
    context: RequestActorContext,
    id: string,
    tx: Prisma.TransactionClient = this.database.client,
    active = false,
  ) {
    const supplier = await tx.supplier.findFirst({
      where: { organizationId: context.organizationId, id },
    });
    if (!supplier) throw new NotFoundException();
    if (active && supplier.archivedAt)
      throw new ConflictException('El proveedor está archivado. Restauralo antes de importar.');
    return supplier;
  }
  private async translated<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CatalogRuleError) throw new BadRequestException(error.message);
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'P2002' || error.code === 'P2034')
          throw new ConflictException(
            'Otra importación modificó este catálogo. Generá y revisá una vista previa nueva.',
          );
        if (error.code === 'P2003' || error.code === 'P2025') throw new NotFoundException();
      }
      throw error;
    }
  }
  async listItems(context: RequestActorContext, query: SupplierCatalogQuery, supplierId?: string) {
    if (supplierId) await this.supplier(context, supplierId);
    const where: Prisma.SupplierCatalogItemWhereInput = {
      organizationId: context.organizationId,
      ...(supplierId || query.supplierId ? { supplierId: supplierId ?? query.supplierId } : {}),
      ...(query.includeArchived ? {} : { archivedAt: null, supplier: { archivedAt: null } }),
      ...(query.q
        ? {
            OR: [
              { supplierCode: search(query.q) },
              { description: search(query.q) },
              { brandText: search(query.q) },
              { reportedGtin: search(query.q) },
              { normalizedReportedGtin: search(query.q) },
              { supplier: { name: search(query.q) } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.database.client.supplierCatalogItem.findMany({
        where,
        ...windowFor(query),
        orderBy: [{ supplierCode: 'asc' }, { id: 'asc' }],
        include: itemInclude,
      }),
      this.database.client.supplierCatalogItem.count({ where }),
    ]);
    return pageResult(items.map(itemView), total, query);
  }
  async getItem(context: RequestActorContext, id: string) {
    const row = await this.database.client.supplierCatalogItem.findFirst({
      where: { organizationId: context.organizationId, id },
      include: itemInclude,
    });
    if (!row) throw new NotFoundException();
    return itemView(row);
  }
  async inspect(
    context: RequestActorContext,
    supplierId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    await this.authorize(context);
    await this.supplier(context, supplierId, this.database.client, true);
    return this.translated(async () => {
      const parsed = await parseCatalogFile(file.buffer, file.originalname, file.mimetype);
      await this.cleanup(context);
      const live = await this.database.client.supplierCatalogUpload.count({
        where: { organizationId: context.organizationId, actorUserId: context.userId },
      });
      if (live >= 5)
        throw new HttpException(
          { message: 'Ya tenés cinco archivos en revisión. Esperá hasta que venzan (30 minutos).' },
          429,
        );
      const expiresAt = new Date(Date.now() + supplierCatalogLimits.previewMinutes * 60000);
      const row = await this.database.client.supplierCatalogUpload.create({
        data: {
          organizationId: context.organizationId,
          supplierId,
          actorUserId: context.userId,
          membershipId: context.membershipId,
          sessionId: context.sessionId,
          fileName: parsed.fileName,
          contentHash: parsed.contentHash,
          format: parsed.format,
          sheets: parsed.sheets as unknown as Prisma.InputJsonValue,
          expiresAt,
        },
      });
      return {
        uploadId: row.id,
        fileName: row.fileName,
        contentHash: row.contentHash,
        format: row.format,
        expiresAt,
        sheets: parsed.sheets.map(inspectSheet),
      };
    });
  }
  // Invocable por mantenimiento; sin timer ni infraestructura de jobs.
  async cleanup(context: RequestActorContext) {
    this.admin(context);
    return purgeExpiredCatalogReviews(this.database.client, context.organizationId);
  }
  async preview(context: RequestActorContext, supplierId: string, input: CatalogPreviewInput) {
    await this.authorize(context);
    return this.translated(async () => {
      const supplier = await this.supplier(context, supplierId, this.database.client, true);
      const upload = await this.database.client.supplierCatalogUpload.findFirst({
        where: {
          id: input.uploadId,
          organizationId: context.organizationId,
          supplierId,
          actorUserId: context.userId,
          sessionId: context.sessionId,
          expiresAt: { gt: new Date() },
        },
      });
      if (!upload) throw new NotFoundException('La revisión del archivo venció. Volvé a elegirlo.');
      const sheet = (upload.sheets as unknown as CatalogSheet[]).find(
        (sheet) => sheet.name === input.sheet,
      );
      if (!sheet) throw new BadRequestException('Elegí una hoja que exista en el archivo.');
      const existing = await this.database.client.supplierCatalogItem.findMany({
        where: { organizationId: context.organizationId, supplierId },
      });
      const plan = planImport(sheet, input.headerRow, input.mapping, existing, input.mode);
      const data = {
        organizationId: context.organizationId,
        supplierId,
        actorUserId: context.userId,
        membershipId: context.membershipId,
        sessionId: context.sessionId,
        fileName: upload.fileName,
        contentHash: upload.contentHash,
        format: upload.format,
        sheetName: sheet.name,
        headerRow: input.headerRow,
        mapping: input.mapping,
        mode: input.mode,
        catalogHash: catalogFingerprint(existing, supplier.version),
        summary: plan.summary,
        expiresAt: upload.expiresAt,
      };
      return this.database.client.$transaction(
        async (tx) => {
          await this.authorize(context, tx);
          const row = await tx.supplierCatalogImport.create({
            data: { ...data, previewHash: previewDigest(data, plan.rows) },
            include: importInclude,
          });
          for (let offset = 0; offset < plan.rows.length; offset += 1000)
            await tx.supplierCatalogImportRow.createMany({
              data: plan.rows.slice(offset, offset + 1000).map((item) => ({
                organizationId: context.organizationId,
                supplierId,
                importId: row.id,
                rowNumber: item.rowNumber,
                outcome: item.outcome,
                itemId: item.itemId,
                supplierCode: item.supplierCode,
                ...(item.data ? { data: item.data } : {}),
                messages: item.messages,
              })),
            });
          return importView(row);
        },
        { timeout: 10000 },
      );
    });
  }
  private async findImport(
    context: RequestActorContext,
    id: string,
    tx: Prisma.TransactionClient = this.database.client,
  ) {
    const row = await tx.supplierCatalogImport.findFirst({
      where: { id, organizationId: context.organizationId },
      include: importInclude,
    });
    if (
      !row ||
      (row.status === 'PREVIEW' &&
        (row.actorUserId !== context.userId ||
          row.sessionId !== context.sessionId ||
          row.expiresAt < new Date()))
    )
      throw new NotFoundException();
    return row;
  }
  async getImport(context: RequestActorContext, id: string) {
    return importView(await this.findImport(context, id));
  }
  async listImports(context: RequestActorContext, supplierId: string, query: CatalogListQuery) {
    await this.supplier(context, supplierId);
    const where: Prisma.SupplierCatalogImportWhereInput = {
      organizationId: context.organizationId,
      supplierId,
      status: 'COMMITTED',
      ...(query.q ? { fileName: search(query.q) } : {}),
    };
    const [items, total] = await Promise.all([
      this.database.client.supplierCatalogImport.findMany({
        where,
        ...windowFor(query),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: importInclude,
      }),
      this.database.client.supplierCatalogImport.count({ where }),
    ]);
    return pageResult(items.map(importView), total, query);
  }
  async rows(context: RequestActorContext, id: string, query: CatalogImportRowsQuery) {
    await this.findImport(context, id);
    const where: Prisma.SupplierCatalogImportRowWhereInput = {
      organizationId: context.organizationId,
      importId: id,
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.q ? { supplierCode: search(query.q) } : {}),
    };
    const [items, total] = await Promise.all([
      this.database.client.supplierCatalogImportRow.findMany({
        where,
        ...windowFor(query),
        orderBy: { rowNumber: 'asc' },
      }),
      this.database.client.supplierCatalogImportRow.count({ where }),
    ]);
    return pageResult(
      items.map((row) => ({ id: row.id, ...planRow(row) })),
      total,
      query,
    );
  }
  async commit(context: RequestActorContext, id: string, input: CatalogCommitInput) {
    await this.authorize(context);
    // Validación y lectura de las observaciones fuera de la transacción comercial.
    const preview = await this.findImport(context, id);
    if (preview.actorUserId !== context.userId || preview.sessionId !== context.sessionId)
      throw new ForbiddenException('Confirmá desde la sesión que revisó esta lista.');
    if (input.previewHash !== preview.previewHash)
      throw new ConflictException(
        'La confirmación no corresponde a esta vista previa. Volvé a revisar la lista.',
      );
    if (preview.status === 'COMMITTED') return importView(preview);
    const observations = await this.database.client.supplierCatalogImportRow.findMany({
      where: { organizationId: context.organizationId, importId: id },
      orderBy: { rowNumber: 'asc' },
    });
    const plan = observations.map(planRow);
    const summary = catalogImportSummarySchema.parse(preview.summary);
    if (previewDigest(preview, plan) !== preview.previewHash)
      throw new ConflictException('La vista previa cambió. Volvé a revisar el archivo.');
    if ((summary.errors || summary.conflicts) && !input.excludeInvalidRows)
      throw new BadRequestException(
        'Corregí los errores y conflictos, o confirmá expresamente que querés excluir esas filas.',
      );
    const accepted = plan.filter(
      (row) => row.data && ['CREATED', 'UPDATED', 'UNCHANGED'].includes(row.outcome),
    );
    if (!accepted.length)
      throw new BadRequestException(
        'No hay referencias válidas para importar. Revisá el archivo y las columnas.',
      );
    for (const row of accepted) {
      const { normalizedReportedGtin: _gtin, ...fields } = row.data!;
      void _gtin;
      const validated = validateReference(fields);
      if (validated.errors.length || digest(validated.data) !== digest(row.data))
        throw new ConflictException(
          'Los datos de la vista previa no son válidos. Volvé a revisar el archivo.',
        );
    }
    const changes = accepted
      .filter((row) => row.outcome !== 'UNCHANGED')
      .map((row) => ({ ...row.data!, id: row.itemId ?? randomUUID(), outcome: row.outcome }));
    const codes = accepted.map((row) => row.supplierCode!);
    const itemIds = new Map(accepted.map((row) => [row.supplierCode!, row.itemId!]));
    for (const item of changes) itemIds.set(item.supplierCode, item.id);
    const rowLinks = observations
      .filter((row) => ['CREATED', 'UPDATED', 'UNCHANGED', 'DUPLICATE'].includes(row.outcome))
      .map((row) => ({ id: row.id, itemId: itemIds.get(row.supplierCode!)! }));
    return this.translated(() =>
      this.database.client.$transaction(
        async (tx) => {
          await this.authorize(context, tx);
          // Mismo lock que archivo/edición del proveedor; orden proveedor -> import.
          await tx.$queryRaw`SELECT "id" FROM "Supplier" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${preview.supplierId}::uuid FOR UPDATE`;
          const supplier = await this.supplier(context, preview.supplierId, tx, true);
          await tx.$queryRaw`SELECT "id" FROM "SupplierCatalogImport" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
          const current = await this.findImport(context, id, tx);
          if (current.status === 'COMMITTED') return importView(current);
          const existing = await tx.supplierCatalogItem.findMany({
            where: { organizationId: context.organizationId, supplierId: preview.supplierId },
          });
          if (catalogFingerprint(existing, supplier.version) !== preview.catalogHash)
            throw new ConflictException(
              'El catálogo cambió desde la vista previa. Generá y revisá una nueva antes de confirmar.',
            );
          // La unique resuelve cada escritura sin joins dependientes de estadísticas
          // aún obsoletas. La identidad esperada debe coincidir; no reasignar códigos.
          for (let offset = 0; offset < changes.length; offset += 500) {
            const batch = changes.slice(offset, offset + 500);
            const data = JSON.stringify(batch);
            const written =
              await tx.$executeRaw`INSERT INTO "SupplierCatalogItem" AS i ("id","organizationId","supplierId","supplierCode","description","brandText","presentationText","reportedGtin","normalizedReportedGtin","updatedAt")
              SELECT r.id::uuid,${context.organizationId}::uuid,${preview.supplierId}::uuid,r."supplierCode",r.description,r."brandText",r."presentationText",r."reportedGtin",r."normalizedReportedGtin",CURRENT_TIMESTAMP
              FROM jsonb_to_recordset(${data}::jsonb) AS r(id text,"supplierCode" text,description text,"brandText" text,"presentationText" text,"reportedGtin" text,"normalizedReportedGtin" text)
              ON CONFLICT ("organizationId","supplierId","supplierCode") DO UPDATE SET
                "description"=EXCLUDED."description","brandText"=EXCLUDED."brandText","presentationText"=EXCLUDED."presentationText","reportedGtin"=EXCLUDED."reportedGtin","normalizedReportedGtin"=EXCLUDED."normalizedReportedGtin","version"=i."version"+1,"updatedAt"=CURRENT_TIMESTAMP
              WHERE i.id=EXCLUDED.id AND i."archivedAt" IS NULL`;
            if (written !== batch.length)
              throw new ConflictException(
                'Una referencia cambió durante la importación. Volvé a revisar la lista.',
              );
          }
          if (preview.mode === 'COMPLETE' && !summary.absencesSuppressed) {
            const now = new Date();
            await tx.supplierCatalogItem.updateMany({
              where: {
                organizationId: context.organizationId,
                supplierId: preview.supplierId,
                archivedAt: null,
                supplierCode: { notIn: codes },
                missingFromLatestCompleteListAt: null,
              },
              data: { missingFromLatestCompleteListAt: now, version: { increment: 1 } },
            });
            await tx.supplierCatalogItem.updateMany({
              where: {
                organizationId: context.organizationId,
                supplierId: preview.supplierId,
                supplierCode: { in: codes },
                missingFromLatestCompleteListAt: { not: null },
              },
              data: { missingFromLatestCompleteListAt: null, version: { increment: 1 } },
            });
          }
          // IDs ya resueltos en el plan: evitar un join de dos tablas recién cargadas
          // cuyas estadísticas aún no describen las 10.000 filas nuevas.
          for (let offset = 0; offset < rowLinks.length; offset += 500) {
            const links = JSON.stringify(rowLinks.slice(offset, offset + 500));
            await tx.$executeRaw`UPDATE "SupplierCatalogImportRow" AS r SET "itemId"=v."itemId"::uuid
          FROM jsonb_to_recordset(${links}::jsonb) AS v(id text,"itemId" text)
          WHERE r."organizationId"=${context.organizationId}::uuid AND r."importId"=${id}::uuid AND r.id=v.id::uuid`;
          }
          const committed = await tx.supplierCatalogImport.update({
            where: { id, organizationId: context.organizationId },
            data: {
              status: 'COMMITTED',
              committedAt: new Date(),
              excludedInvalidRows: input.excludeInvalidRows,
            },
            include: importInclude,
          });
          await this.audit.append(
            {
              organizationId: context.organizationId,
              actorUserId: context.userId,
              sessionId: context.sessionId,
              requestId: context.requestId,
              action: 'SUPPLIER_CATALOG_IMPORTED',
              resourceType: 'SupplierCatalogImport',
              resourceId: id,
              result: 'SUCCESS',
              metadata: {
                supplierId: preview.supplierId,
                importId: id,
                created: summary.created,
                updated: summary.updated,
                unchanged: summary.unchanged,
                ignored: summary.duplicates + summary.empty,
                errors: summary.errors,
                conflicts: summary.conflicts,
                missing: summary.missing,
                mode: preview.mode,
              },
            },
            tx,
          );
          // No se conserva el original ni el staging de columnas no elegidas tras confirmar.
          await tx.supplierCatalogUpload.deleteMany({
            where: {
              organizationId: context.organizationId,
              supplierId: preview.supplierId,
              actorUserId: context.userId,
              sessionId: context.sessionId,
              contentHash: preview.contentHash,
            },
          });
          return importView(committed);
        },
        { timeout: 10000, maxWait: 5000 },
      ),
    );
  }
}

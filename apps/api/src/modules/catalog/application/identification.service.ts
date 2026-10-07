import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@maxbio/database';
import type {
  IdentificationConfirm,
  ScanInput,
  ScanIdentity,
  CatalogListQuery,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { AuditService } from '../../audit/audit.service.js';
import { parseScan } from '../domain/catalog-scan.js';
import { productInclude, productView } from './catalog.service.js';
import { searchTokens, textContains } from '../domain/catalog-search.js';
import { itemInclude, itemView } from './supplier-catalog.service.js';

@Injectable()
export class IdentificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}
  async listSupplierIdentifiers(
    context: RequestActorContext,
    productId: string,
    query: CatalogListQuery,
  ) {
    const organizationId = context.organizationId;
    if (
      !(await this.database.client.product.findFirst({ where: { organizationId, id: productId } }))
    )
      throw new NotFoundException();
    const where: Prisma.SupplierScanIdentifierWhereInput = {
      organizationId,
      supplierProduct: {
        productId,
        ...(query.includeArchived ? {} : { archivedAt: null, supplier: { archivedAt: null } }),
      },
      ...(query.includeArchived ? {} : { archivedAt: null }),
      AND: searchTokens(query.q).map((token) => ({
        OR: [
          { value: textContains(token) },
          { supplierProduct: { supplier: { searchText: textContains(token) } } },
        ],
      })),
    };
    const [rows, total] = await Promise.all([
      this.database.client.supplierScanIdentifier.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: [{ value: 'asc' }, { id: 'asc' }],
        include: {
          supplierProduct: {
            select: {
              archivedAt: true,
              supplier: { select: { id: true, name: true, archivedAt: true } },
            },
          },
        },
      }),
      this.database.client.supplierScanIdentifier.count({ where }),
    ]);
    return {
      items: rows.map(({ organizationId: _scope, supplierProduct, ...row }) => {
        void _scope;
        return {
          ...row,
          supplier: supplierProduct.supplier,
          linkArchivedAt: supplierProduct.archivedAt,
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async resolve(context: RequestActorContext, input: ScanInput) {
    const identity = parseScan(input);
    if ('status' in identity) return identity;
    const scope = { organizationId: context.organizationId };
    if (
      input.supplierId &&
      !(await this.database.client.supplier.findFirst({
        where: { ...scope, id: input.supplierId },
      }))
    )
      throw new NotFoundException();
    if (identity.kind === 'SUPPLIER_BARCODE' && !identity.supplierId) {
      const count = await this.database.client.supplierScanIdentifier.count({
        where: { ...scope, normalizedValue: identity.normalizedValue },
      });
      return {
        status: count ? ('AMBIGUOUS' as const) : ('UNKNOWN' as const),
        identity,
        message:
          'Código externo: elegí su proveedor para reconocerlo o asociarlo. No es un identificador universal.',
      };
    }
    const found = await this.findIdentifier(this.database.client, context.organizationId, identity);
    if (found) {
      const product = productView(found.product);
      return found.archived
        ? {
            status: 'ARCHIVED' as const,
            identity,
            product,
            message:
              'Este identificador está reservado por un registro archivado. Un administrador debe revisar su restauración.',
          }
        : { status: 'KNOWN' as const, identity, product };
    }
    const where: Prisma.SupplierCatalogItemWhereInput = {
      ...scope,
      archivedAt: null,
      supplier: { archivedAt: null },
      ...(identity.kind === 'GTIN'
        ? { normalizedReportedGtin: identity.normalizedValue }
        : { supplierId: identity.supplierId!, supplierCode: identity.normalizedValue }),
    };
    // Internal identifiers have their own namespace; supplierCode never declares them.
    if (identity.kind === 'INTERNAL_CODE' || identity.kind === 'INTERNAL_BARCODE')
      return {
        status: 'UNKNOWN' as const,
        identity,
        message: 'Código interno desconocido. Seleccioná una referencia y confirmá el producto.',
      };
    const [candidates, total] = await Promise.all([
      this.database.client.supplierCatalogItem.findMany({
        where,
        include: itemInclude,
        take: 20,
        orderBy: [{ supplierCode: 'asc' }, { id: 'asc' }],
      }),
      this.database.client.supplierCatalogItem.count({ where }),
    ]);
    if (total)
      return {
        status: 'CANDIDATES' as const,
        identity,
        candidates: candidates.map(itemView),
        total,
        message:
          'Coincidencia declarada por el proveedor. Compará y confirmá explícitamente; no crea ni asocia productos automáticamente.',
      };
    return {
      status: 'UNKNOWN' as const,
      identity,
      message:
        'Código desconocido. Buscá la referencia del proveedor para identificar el producto.',
    };
  }

  private async findIdentifier(
    tx: Prisma.TransactionClient,
    organizationId: string,
    identity: ScanIdentity,
  ) {
    if (identity.kind === 'SUPPLIER_BARCODE') {
      const row = await tx.supplierScanIdentifier.findFirst({
        where: {
          organizationId,
          supplierId: identity.supplierId!,
          normalizedValue: identity.normalizedValue,
        },
        include: {
          supplierProduct: { include: { product: { include: productInclude }, supplier: true } },
        },
      });
      return row
        ? {
            id: row.id,
            product: row.supplierProduct.product,
            archived: Boolean(
              row.archivedAt ||
              row.supplierProduct.archivedAt ||
              row.supplierProduct.supplier.archivedAt ||
              row.supplierProduct.product.archivedAt,
            ),
          }
        : null;
    }
    const row = await tx.productIdentifier.findFirst({
      where: { organizationId, kind: identity.kind, normalizedValue: identity.normalizedValue },
      include: { product: { include: productInclude } },
    });
    return row
      ? {
          id: row.id,
          product: row.product,
          archived: Boolean(row.archivedAt || row.product.archivedAt),
        }
      : null;
  }

  private async authorize(tx: Prisma.TransactionClient, context: RequestActorContext) {
    if (!['ADMIN', 'OPERATOR'].includes(context.role)) throw new ForbiddenException();
    const now = new Date();
    const member = await tx.membership.findFirst({
      where: {
        id: context.membershipId,
        userId: context.userId,
        organizationId: context.organizationId,
        role: context.role,
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
    if (!member || !session)
      throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
  }
  private active(archivedAt: Date | null) {
    if (archivedAt)
      throw new ConflictException(
        'El registro está archivado; no puede reutilizarse. Pedí su revisión a un administrador.',
      );
  }
  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw new ConflictException(
        'Otra persona modificó esta información. Volvé a cargarla y revisá la asociación antes de confirmar.',
      );
  }
  private async lock(tx: Prisma.TransactionClient, key: string) {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  }
  private async receipt(
    tx: Prisma.TransactionClient,
    record: { id: string; referenceId: string; supplierProductId: string; supplierId: string },
    organizationId: string,
    replayed: boolean,
  ) {
    const link = await tx.supplierProduct.findFirstOrThrow({
      where: { organizationId, supplierId: record.supplierId, id: record.supplierProductId },
      include: { product: { include: productInclude } },
    });
    return {
      confirmationId: record.id,
      referenceId: record.referenceId,
      supplierProductId: record.supplierProductId,
      product: productView(link.product),
      replayed,
    };
  }

  async confirm(context: RequestActorContext, input: IdentificationConfirm) {
    const identity = parseScan(input.scan);
    if ('status' in identity) throw new BadRequestException(identity.message);
    if (identity.kind === 'SUPPLIER_BARCODE' && !identity.supplierId)
      throw new BadRequestException('Elegí explícitamente el proveedor del código externo.');
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const organizationId = context.organizationId;
    try {
      return await this.database.client.$transaction(
        async (tx) => {
          await this.authorize(tx, context);
          await this.lock(tx, `identification-operation:${organizationId}:${input.operationId}`);
          const previous = await tx.catalogIdentification.findUnique({
            where: {
              organizationId_operationId: { organizationId, operationId: input.operationId },
            },
          });
          if (previous) {
            if (previous.actorUserId !== context.userId || previous.requestHash !== requestHash)
              throw new ConflictException(
                'Esta clave de operación ya fue utilizada con otros datos. Iniciá una nueva confirmación.',
              );
            return this.receipt(tx, previous, organizationId, true);
          }
          await this.lock(
            tx,
            `scan:${organizationId}:${identity.kind}:${identity.supplierId ?? ''}:${identity.normalizedValue}`,
          );
          const initial = await tx.supplierCatalogItem.findFirst({
            where: { organizationId, id: input.referenceId },
          });
          if (!initial) throw new NotFoundException();
          if (identity.kind === 'SUPPLIER_BARCODE' && identity.supplierId !== initial.supplierId)
            throw new BadRequestException('El proveedor elegido no corresponde a esta referencia.');
          let productId: string;
          if (input.target.mode === 'EXISTING') {
            productId = input.target.productId;
            await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "organizationId"=${organizationId}::uuid AND "id"=${productId}::uuid FOR UPDATE`;
            const product = await tx.product.findFirst({
              where: { organizationId, id: productId },
            });
            if (!product) throw new NotFoundException();
            this.active(product.archivedAt);
            this.version(product.version, input.target.expectedProductVersion);
          } else {
            if (initial.supplierProductId)
              throw new ConflictException(
                'La referencia ya corresponde a un producto. Usá ese producto para agregar el identificador.',
              );
            for (const kind of ['brand', 'category'] as const) {
              const id = input.target.product[kind === 'brand' ? 'brandId' : 'categoryId'];
              if (!id) continue;
              if (kind === 'brand')
                await tx.$queryRaw`SELECT "id" FROM "Brand" WHERE "organizationId"=${organizationId}::uuid AND "id"=${id}::uuid FOR UPDATE`;
              else
                await tx.$queryRaw`SELECT "id" FROM "Category" WHERE "organizationId"=${organizationId}::uuid AND "id"=${id}::uuid FOR UPDATE`;
              const row = await (kind === 'brand'
                ? tx.brand.findFirst({ where: { organizationId, id } })
                : tx.category.findFirst({ where: { organizationId, id } }));
              if (!row) throw new NotFoundException();
              this.active(row.archivedAt);
            }
            const product = await tx.product.create({
              data: { organizationId, ...input.target.product },
            });
            productId = product.id;
            await this.audit.success(
              context,
              'PRODUCT_CREATED_FROM_IDENTIFICATION',
              'Product',
              productId,
              tx,
            );
          }
          await tx.$queryRaw`SELECT "id" FROM "Supplier" WHERE "organizationId"=${organizationId}::uuid AND "id"=${initial.supplierId}::uuid FOR UPDATE`;
          const supplier = await tx.supplier.findFirstOrThrow({
            where: { organizationId, id: initial.supplierId },
          });
          this.active(supplier.archivedAt);
          await tx.$queryRaw`SELECT "id" FROM "SupplierCatalogItem" WHERE "organizationId"=${organizationId}::uuid AND "id"=${initial.id}::uuid FOR UPDATE`;
          const reference = await tx.supplierCatalogItem.findFirstOrThrow({
            where: { organizationId, id: initial.id },
          });
          this.active(reference.archivedAt);
          this.version(reference.version, input.expectedReferenceVersion);
          let link = await tx.supplierProduct.findUnique({
            where: {
              organizationId_supplierId_productId: {
                organizationId,
                supplierId: reference.supplierId,
                productId,
              },
            },
          });
          if (reference.supplierProductId && reference.supplierProductId !== link?.id)
            throw new ConflictException(
              'La referencia ya corresponde a otro producto. No se puede reasignar desde identificación.',
            );
          if (link) {
            await tx.$queryRaw`SELECT "id" FROM "SupplierProduct" WHERE "organizationId"=${organizationId}::uuid AND "id"=${link.id}::uuid FOR UPDATE`;
            link = await tx.supplierProduct.findFirstOrThrow({
              where: { organizationId, id: link.id },
            });
            this.active(link.archivedAt);
          } else {
            link = await tx.supplierProduct.create({
              data: {
                organizationId,
                supplierId: reference.supplierId,
                productId,
                supplierCode: reference.supplierCode,
                supplierDescription: reference.description,
              },
            });
          }
          const existing = await this.findIdentifier(tx, organizationId, identity);
          if (existing) {
            if (existing.archived || existing.product.id !== productId)
              throw new ConflictException(
                'Este identificador ya está reservado por otro registro. Revisá el producto reconocido antes de confirmar.',
              );
          } else {
            const identifier =
              identity.kind === 'SUPPLIER_BARCODE'
                ? await tx.supplierScanIdentifier.create({
                    data: {
                      organizationId,
                      supplierId: reference.supplierId,
                      supplierProductId: link.id,
                      value: identity.value,
                      normalizedValue: identity.normalizedValue,
                    },
                  })
                : await tx.productIdentifier.create({
                    data: {
                      organizationId,
                      productId,
                      kind: identity.kind,
                      value: identity.value,
                      normalizedValue: identity.normalizedValue,
                    },
                  });
            await this.audit.success(
              context,
              'PRODUCT_IDENTIFIER_ADDED_FROM_IDENTIFICATION',
              identity.kind === 'SUPPLIER_BARCODE' ? 'SupplierScanIdentifier' : 'ProductIdentifier',
              identifier.id,
              tx,
            );
          }
          if (!reference.supplierProductId) {
            await tx.supplierCatalogItem.update({
              where: {
                organizationId_supplierId_id: {
                  organizationId,
                  supplierId: reference.supplierId,
                  id: reference.id,
                },
              },
              data: { supplierProductId: link.id, version: { increment: 1 } },
            });
            await this.audit.success(
              context,
              'CATALOG_REFERENCE_ASSOCIATED',
              'SupplierCatalogItem',
              reference.id,
              tx,
            );
          }
          // Parent version protects general catalog forms from losing workflow changes.
          await tx.product.update({
            where: { organizationId_id: { organizationId, id: productId } },
            data: { version: { increment: 1 } },
          });
          const record = await tx.catalogIdentification.create({
            data: {
              organizationId,
              operationId: input.operationId,
              actorUserId: context.userId,
              membershipId: context.membershipId,
              sessionId: context.sessionId,
              requestHash,
              supplierId: reference.supplierId,
              referenceId: reference.id,
              supplierProductId: link.id,
            },
          });
          return this.receipt(tx, record, organizationId, false);
        },
        { timeout: 10000 },
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (['P2002', 'P2034', 'P2010'].includes(String(error.code)))
          throw new ConflictException(
            'Otra operación reservó este código o modificó la asociación. Volvé a cargar la información y revisala.',
          );
        if (['P2003', 'P2025'].includes(String(error.code))) throw new NotFoundException();
      }
      throw error;
    }
  }
}

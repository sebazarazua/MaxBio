import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@maxbio/database';
import type {
  CatalogListQuery,
  ProductListQuery,
  ProductCreate,
  ProductUpdate,
  SupplierCreate,
  SupplierUpdate,
  IdentifierInput,
  NamedCreate,
  NamedUpdate,
  SupplierProductCreate,
  SupplierProductUpdate,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { CatalogRuleError, normalizeIdentifier, normalizeName } from '../domain/identifiers.js';

import { searchTokens, textContains } from '../domain/catalog-search.js';

const classificationSelect = { id: true, name: true, archivedAt: true } as const;
export const productInclude = {
  brand: { select: classificationSelect },
  category: { select: classificationSelect },
  identifiers: {
    where: { kind: 'INTERNAL_CODE', archivedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 3,
    select: { value: true },
  },
} satisfies Prisma.ProductInclude;
const linkInclude = {
  supplier: { select: classificationSelect },
  product: { select: classificationSelect },
} as const;
type ProductRecord = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type NamedKind = 'brand' | 'category';
const orderBy = [{ name: 'asc' }, { id: 'asc' }] as const;
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
const textSearch = (q: string) => ({ contains: q, mode: 'insensitive' as const });
export const productView = (row: ProductRecord) => {
  const { organizationId: _organizationId, searchText: _search, identifiers, ...view } = row;
  void _search;
  void _organizationId;
  return { ...view, internalCodes: identifiers.map((identifier) => identifier.value) };
};
function publicRow<T extends { organizationId: string }>(row: T) {
  const { organizationId: _organizationId, ...view } = row;
  void _organizationId;
  const {
    catalogPrefix: _prefix,
    catalogPrefixLength: _prefixLength,
    catalogNextSequence: _sequence,
    searchText: _search,
    ...publicView
  } = view as typeof view & {
    catalogPrefix?: unknown;
    catalogPrefixLength?: unknown;
    catalogNextSequence?: unknown;
    searchText?: unknown;
  };
  void _prefix;
  void _prefixLength;
  void _sequence;
  void _search;
  return publicView;
}
function namedView<T extends { organizationId: string; normalizedName: string }>(row: T) {
  const { normalizedName: _normalizedName, ...view } = publicRow(row);
  void _normalizedName;
  return view;
}

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // Cada caso de uso recibe contexto. El rol se exige también en application,
  // para que una futura llamada interna no saltee la política del controlador.
  private async write<T>(
    context: RequestActorContext,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    duplicateMessage = 'Ese código o vínculo ya está registrado. Revisá también los archivados.',
  ) {
    if (context.role !== 'ADMIN')
      throw new ForbiddenException('No tenés permiso para modificar el catálogo.');
    try {
      return await this.database.client.$transaction(async (tx) => {
        const now = new Date();
        const author = await tx.membership.findFirst({
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
        if (!author || !session)
          throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
        return operation(tx);
      });
    } catch (error) {
      if (error instanceof CatalogRuleError) throw new BadRequestException(error.message);
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'P2002') throw new ConflictException(duplicateMessage);
        if (error.code === 'P2034')
          throw new ConflictException('Otra operación modificó estos datos. Volvé a intentar.');
        if (error.code === 'P2003' || error.code === 'P2025') throw new NotFoundException();
      }
      throw error;
    }
  }

  private expectVersion(actual: number, expected: number, label = 'registro') {
    if (actual !== expected)
      throw new ConflictException(
        `Este ${label} fue modificado por otra persona. Actualizá la información antes de guardar.`,
      );
  }
  private active(archivedAt: Date | null) {
    if (archivedAt)
      throw new ConflictException('Este registro está archivado. Restauralo antes de modificarlo.');
  }
  private async lockProduct(
    tx: Prisma.TransactionClient,
    context: RequestActorContext,
    id: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
    const row = await tx.product.findFirst({
      where: { organizationId: context.organizationId, id },
      include: productInclude,
    });
    if (!row) throw new NotFoundException();
    return row;
  }
  private async lockSupplier(
    tx: Prisma.TransactionClient,
    context: RequestActorContext,
    id: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "Supplier" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
    const row = await tx.supplier.findFirst({
      where: { organizationId: context.organizationId, id },
    });
    if (!row) throw new NotFoundException();
    return row;
  }
  private async classification(
    tx: Prisma.TransactionClient,
    context: RequestActorContext,
    kind: NamedKind,
    id: string,
  ) {
    // El mismo lock serializa asignación con archivo/renombre del catálogo auxiliar.
    if (kind === 'brand')
      await tx.$queryRaw`SELECT "id" FROM "Brand" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT "id" FROM "Category" WHERE "organizationId" = ${context.organizationId}::uuid AND "id" = ${id}::uuid FOR UPDATE`;
    const args = { where: { organizationId: context.organizationId, id } };
    const row = await (kind === 'brand' ? tx.brand.findFirst(args) : tx.category.findFirst(args));
    if (!row) throw new NotFoundException();
    return row;
  }
  private async bumpProduct(
    tx: Prisma.TransactionClient,
    context: RequestActorContext,
    id: string,
  ) {
    return productView(
      await tx.product.update({
        where: { organizationId_id: { organizationId: context.organizationId, id } },
        data: { version: { increment: 1 } },
        include: productInclude,
      }),
    );
  }

  async listProducts(context: RequestActorContext, query: ProductListQuery) {
    let canonicalGtin: string | undefined;
    try {
      canonicalGtin = normalizeIdentifier({ kind: 'GTIN', value: query.q }).normalizedValue;
    } catch {
      /* La búsqueda de texto no exige un GTIN. */
    }
    const where: Prisma.ProductWhereInput = {
      organizationId: context.organizationId,
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.supplierId
        ? {
            supplierProducts: {
              some: {
                organizationId: context.organizationId,
                supplierId: query.supplierId,
                ...(query.includeArchived
                  ? {}
                  : { archivedAt: null, supplier: { archivedAt: null } }),
              },
            },
          }
        : {}),
      AND: searchTokens(query.q).map((token) => ({
        OR: [
          { searchText: textContains(token) },
          {
            identifiers: {
              some: {
                organizationId: context.organizationId,
                ...(query.includeArchived ? {} : { archivedAt: null }),
                OR: [
                  { value: textContains(token) },
                  { normalizedValue: textContains(token) },
                  ...(canonicalGtin
                    ? [{ kind: 'GTIN' as const, normalizedValue: canonicalGtin }]
                    : []),
                ],
              },
            },
          },
          {
            supplierProducts: {
              some: {
                organizationId: context.organizationId,
                OR: [
                  { supplierCode: textContains(token) },
                  { supplier: { searchText: textContains(token) } },
                ],
                ...(query.includeArchived
                  ? {}
                  : { archivedAt: null, supplier: { archivedAt: null } }),
              },
            },
          },
        ],
      })),
    };
    const { rows, total } = await this.database.client.$transaction(
      async (tx) => {
        const rows = await tx.product.findMany({
          where,
          ...windowFor(query),
          orderBy: [...orderBy],
          include: productInclude,
        });
        const total = await tx.product.count({ where });
        return { rows, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return pageResult(rows.map(productView), total, query);
  }
  async getProduct(context: RequestActorContext, id: string) {
    const row = await this.database.client.product.findFirst({
      where: { organizationId: context.organizationId, id },
      include: productInclude,
    });
    if (!row) throw new NotFoundException();
    return productView(row);
  }
  async createProduct(context: RequestActorContext, input: ProductCreate) {
    return this.write(
      context,
      async (tx) => {
        if (input.brandId)
          this.active((await this.classification(tx, context, 'brand', input.brandId)).archivedAt);
        if (input.categoryId)
          this.active(
            (await this.classification(tx, context, 'category', input.categoryId)).archivedAt,
          );
        const { identifiers = [], ...fields } = input;
        const normalized = identifiers.map(normalizeIdentifier);
        const row = await tx.product.create({
          data: { ...fields, organizationId: context.organizationId },
          include: productInclude,
        });
        await this.audit.success(context, 'PRODUCT_CREATED', 'Product', row.id, tx);
        for (const identifier of normalized) {
          const created = await tx.productIdentifier.create({
            data: { ...identifier, organizationId: context.organizationId, productId: row.id },
          });
          await this.audit.success(
            context,
            'PRODUCT_IDENTIFIER_ADDED',
            'ProductIdentifier',
            created.id,
            tx,
          );
        }
        return productView(
          await tx.product.findFirstOrThrow({
            where: { organizationId: context.organizationId, id: row.id },
            include: productInclude,
          }),
        );
      },
      'Ya existe un producto con ese código. Los códigos archivados también se reservan.',
    );
  }
  async updateProduct(context: RequestActorContext, id: string, input: ProductUpdate) {
    return this.write(context, async (tx) => {
      const row = await this.lockProduct(tx, context, id);
      this.expectVersion(row.version, input.expectedVersion, 'producto');
      this.active(row.archivedAt);
      if (input.unitOfMeasure && input.unitOfMeasure !== row.unitOfMeasure) {
        const policy = await tx.productInventoryPolicy.findUnique({
          where: {
            organizationId_productId: { organizationId: context.organizationId, productId: id },
          },
        });
        if (policy?.serialRequired && !['UNIT', 'PAIR'].includes(input.unitOfMeasure))
          throw new ConflictException(
            'El producto requiere series individuales; su unidad debe ser Unidad o Par.',
          );
        const history = await tx.inventoryMovementLine.findFirst({
          where: { organizationId: context.organizationId, productId: id },
          select: { id: true },
        });
        const counted = await tx.inventoryCountScope.findFirst({
          where: {
            organizationId: context.organizationId,
            productId: id,
            confirmedAt: { not: null },
          },
          select: { id: true },
        });
        if (history || counted)
          throw new ConflictException(
            'No se puede cambiar la unidad porque el producto ya tiene movimientos de stock o inventario inicial confirmado.',
          );
        const counting = await tx.inventoryStockScope.findFirst({
          where: {
            organizationId: context.organizationId,
            productId: id,
            activeCountSessionId: { not: null },
          },
          select: { id: true },
        });
        if (counting)
          throw new ConflictException('No se puede cambiar la unidad durante un conteo activo.');
      }
      if (input.brandId && input.brandId !== row.brandId)
        this.active((await this.classification(tx, context, 'brand', input.brandId)).archivedAt);
      if (input.categoryId && input.categoryId !== row.categoryId)
        this.active(
          (await this.classification(tx, context, 'category', input.categoryId)).archivedAt,
        );
      const { expectedVersion, ...fields } = input;
      const updated = await tx.product.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { ...fields, version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.success(context, 'PRODUCT_UPDATED', 'Product', id, tx);
      return productView(updated);
    });
  }
  async productState(
    context: RequestActorContext,
    id: string,
    expectedVersion: number,
    restore: boolean,
  ) {
    return this.write(context, async (tx) => {
      const row = await this.lockProduct(tx, context, id);
      this.expectVersion(row.version, expectedVersion, 'producto');
      if (Boolean(row.archivedAt) === !restore) return productView(row);
      if (!restore) {
        const stock = await tx.inventoryBalance.findFirst({
          where: { organizationId: context.organizationId, productId: id, quantity: { gt: 0 } },
          select: { id: true },
        });
        const counting = await tx.inventoryStockScope.findFirst({
          where: {
            organizationId: context.organizationId,
            productId: id,
            activeCountSessionId: { not: null },
          },
          select: { id: true },
        });
        if (stock || counting)
          throw new ConflictException(
            'No se puede archivar un producto con existencia física o un conteo activo.',
          );
      }
      const updated = await tx.product.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { archivedAt: restore ? null : new Date(), version: { increment: 1 } },
        include: productInclude,
      });
      await this.audit.success(
        context,
        restore ? 'PRODUCT_RESTORED' : 'PRODUCT_ARCHIVED',
        'Product',
        id,
        tx,
      );
      return productView(updated);
    });
  }

  async listIdentifiers(context: RequestActorContext, productId: string, query: CatalogListQuery) {
    await this.getProduct(context, productId);
    const where = {
      organizationId: context.organizationId,
      productId,
      ...(query.includeArchived ? {} : { archivedAt: null }),
      ...(query.q ? { value: textSearch(query.q) } : {}),
    };
    const { rows, total } = await this.database.client.$transaction(
      async (tx) => {
        const rows = await tx.productIdentifier.findMany({
          where,
          ...windowFor(query),
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const total = await tx.productIdentifier.count({ where });
        return { rows, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return pageResult(rows.map(publicRow), total, query);
  }
  async resolveIdentifier(context: RequestActorContext, input: IdentifierInput) {
    let identifier;
    try {
      identifier = normalizeIdentifier(input);
    } catch (error) {
      if (error instanceof CatalogRuleError) throw new BadRequestException(error.message);
      throw error;
    }
    const row = await this.database.client.productIdentifier.findFirst({
      where: {
        organizationId: context.organizationId,
        kind: identifier.kind,
        normalizedValue: identifier.normalizedValue,
        archivedAt: null,
        product: { archivedAt: null },
      },
      include: { product: { include: productInclude } },
    });
    if (!row) throw new NotFoundException();
    return productView(row.product);
  }
  async addIdentifier(
    context: RequestActorContext,
    productId: string,
    input: IdentifierInput & { expectedVersion: number },
  ) {
    return this.write(
      context,
      async (tx) => {
        const product = await this.lockProduct(tx, context, productId);
        this.expectVersion(product.version, input.expectedVersion, 'producto');
        this.active(product.archivedAt);
        const identifier = await tx.productIdentifier.create({
          data: {
            ...normalizeIdentifier(input),
            organizationId: context.organizationId,
            productId,
          },
        });
        await this.audit.success(
          context,
          'PRODUCT_IDENTIFIER_ADDED',
          'ProductIdentifier',
          identifier.id,
          tx,
        );
        return {
          identifier: publicRow(identifier),
          product: await this.bumpProduct(tx, context, productId),
        };
      },
      'Ya existe un producto con ese código. Los códigos archivados también se reservan.',
    );
  }
  async identifierState(
    context: RequestActorContext,
    productId: string,
    id: string,
    expectedVersion: number,
    restore: boolean,
  ) {
    return this.write(context, async (tx) => {
      const product = await this.lockProduct(tx, context, productId);
      this.expectVersion(product.version, expectedVersion, 'producto');
      if (restore) this.active(product.archivedAt);
      const row = await tx.productIdentifier.findFirst({
        where: { organizationId: context.organizationId, productId, id },
      });
      if (!row) throw new NotFoundException();
      if (Boolean(row.archivedAt) === !restore)
        return { identifier: publicRow(row), product: productView(product) };
      const changed = await tx.productIdentifier.update({
        where: { id, organizationId: context.organizationId, productId },
        data: { archivedAt: restore ? null : new Date() },
      });
      await this.audit.success(
        context,
        restore ? 'PRODUCT_IDENTIFIER_RESTORED' : 'PRODUCT_IDENTIFIER_ARCHIVED',
        'ProductIdentifier',
        id,
        tx,
      );
      return {
        identifier: publicRow(changed),
        product: await this.bumpProduct(tx, context, productId),
      };
    });
  }

  async listSuppliers(context: RequestActorContext, query: CatalogListQuery) {
    const where: Prisma.SupplierWhereInput = {
      organizationId: context.organizationId,
      ...(query.includeArchived ? {} : { archivedAt: null }),
      AND: searchTokens(query.q).map((token) => ({ searchText: textContains(token) })),
    };
    const { rows, total } = await this.database.client.$transaction(
      async (tx) => {
        const rows = await tx.supplier.findMany({
          where,
          ...windowFor(query),
          orderBy: [...orderBy],
        });
        const total = await tx.supplier.count({ where });
        return { rows, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return pageResult(rows.map(publicRow), total, query);
  }
  async getSupplier(context: RequestActorContext, id: string) {
    const row = await this.database.client.supplier.findFirst({
      where: { organizationId: context.organizationId, id },
    });
    if (!row) throw new NotFoundException();
    return publicRow(row);
  }
  async createSupplier(context: RequestActorContext, input: SupplierCreate) {
    return this.write(context, async (tx) => {
      const row = await tx.supplier.create({
        data: { ...input, organizationId: context.organizationId },
      });
      await this.audit.success(context, 'SUPPLIER_CREATED', 'Supplier', row.id, tx);
      return publicRow(row);
    });
  }
  async updateSupplier(context: RequestActorContext, id: string, input: SupplierUpdate) {
    return this.write(context, async (tx) => {
      const row = await this.lockSupplier(tx, context, id);
      this.expectVersion(row.version, input.expectedVersion, 'proveedor');
      this.active(row.archivedAt);
      const { expectedVersion, ...fields } = input;
      const changed = await tx.supplier.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { ...fields, version: { increment: 1 } },
      });
      await this.audit.success(context, 'SUPPLIER_UPDATED', 'Supplier', id, tx);
      return publicRow(changed);
    });
  }
  async supplierState(
    context: RequestActorContext,
    id: string,
    expectedVersion: number,
    restore: boolean,
  ) {
    return this.write(context, async (tx) => {
      const row = await this.lockSupplier(tx, context, id);
      this.expectVersion(row.version, expectedVersion, 'proveedor');
      if (Boolean(row.archivedAt) === !restore) return publicRow(row);
      const changed = await tx.supplier.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { archivedAt: restore ? null : new Date(), version: { increment: 1 } },
      });
      await this.audit.success(
        context,
        restore ? 'SUPPLIER_RESTORED' : 'SUPPLIER_ARCHIVED',
        'Supplier',
        id,
        tx,
      );
      return publicRow(changed);
    });
  }

  async listNamed(context: RequestActorContext, kind: NamedKind, query: CatalogListQuery) {
    const where = {
      organizationId: context.organizationId,
      ...(query.includeArchived ? {} : { archivedAt: null }),
      AND: searchTokens(query.q, false).map((token) => ({ name: textContains(token) })),
    };
    const args = { where, ...windowFor(query), orderBy: [...orderBy] };
    const { rows, total } = await this.database.client.$transaction(
      async (tx) => {
        const rows = await (kind === 'brand'
          ? tx.brand.findMany(args)
          : tx.category.findMany(args));
        const total = await (kind === 'brand'
          ? tx.brand.count({ where })
          : tx.category.count({ where }));
        return { rows, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return pageResult(rows.map(namedView), total, query);
  }
  async createNamed(context: RequestActorContext, kind: NamedKind, input: NamedCreate) {
    return this.write(
      context,
      async (tx) => {
        const args = {
          data: { ...normalizeName(input.name), organizationId: context.organizationId },
        };
        const row = await (kind === 'brand' ? tx.brand.create(args) : tx.category.create(args));
        await this.audit.success(
          context,
          kind === 'brand' ? 'BRAND_CREATED' : 'CATEGORY_CREATED',
          kind === 'brand' ? 'Brand' : 'Category',
          row.id,
          tx,
        );
        return namedView(row);
      },
      `Ya existe una ${kind === 'brand' ? 'marca' : 'categoría'} con ese nombre. Revisá también los archivados.`,
    );
  }
  async updateNamed(context: RequestActorContext, kind: NamedKind, id: string, input: NamedUpdate) {
    return this.write(
      context,
      async (tx) => {
        const row = await this.classification(tx, context, kind, id);
        this.expectVersion(row.version, input.expectedVersion);
        this.active(row.archivedAt);
        const args = {
          where: { id, organizationId: context.organizationId, version: input.expectedVersion },
          data: { ...normalizeName(input.name), version: { increment: 1 } },
        };
        const changed = await (kind === 'brand' ? tx.brand.update(args) : tx.category.update(args));
        await this.audit.success(
          context,
          kind === 'brand' ? 'BRAND_UPDATED' : 'CATEGORY_UPDATED',
          kind === 'brand' ? 'Brand' : 'Category',
          id,
          tx,
        );
        return namedView(changed);
      },
      `Ya existe una ${kind === 'brand' ? 'marca' : 'categoría'} con ese nombre. Revisá también los archivados.`,
    );
  }
  async namedState(
    context: RequestActorContext,
    kind: NamedKind,
    id: string,
    expectedVersion: number,
    restore: boolean,
  ) {
    return this.write(context, async (tx) => {
      const row = await this.classification(tx, context, kind, id);
      this.expectVersion(row.version, expectedVersion);
      if (Boolean(row.archivedAt) === !restore) return namedView(row);
      const args = {
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { archivedAt: restore ? null : new Date(), version: { increment: 1 } },
      };
      const changed = await (kind === 'brand' ? tx.brand.update(args) : tx.category.update(args));
      const prefix = kind === 'brand' ? 'BRAND' : 'CATEGORY';
      await this.audit.success(
        context,
        `${prefix}_${restore ? 'RESTORED' : 'ARCHIVED'}`,
        kind === 'brand' ? 'Brand' : 'Category',
        id,
        tx,
      );
      return namedView(changed);
    });
  }

  async listLinks(
    context: RequestActorContext,
    parent: { productId: string } | { supplierId: string },
    query: CatalogListQuery,
  ) {
    if ('productId' in parent) await this.getProduct(context, parent.productId);
    else await this.getSupplier(context, parent.supplierId);
    const where: Prisma.SupplierProductWhereInput = {
      organizationId: context.organizationId,
      ...parent,
      ...(query.includeArchived
        ? {}
        : { archivedAt: null, product: { archivedAt: null }, supplier: { archivedAt: null } }),
      AND: searchTokens(query.q).map((token) => ({
        OR: [
          { supplierCode: textContains(token) },
          { supplier: { searchText: textContains(token) } },
          { product: { searchText: textContains(token) } },
        ],
      })),
    };
    const { rows, total } = await this.database.client.$transaction(
      async (tx) => {
        const rows = await tx.supplierProduct.findMany({
          where,
          ...windowFor(query),
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: linkInclude,
        });
        const total = await tx.supplierProduct.count({ where });
        return { rows, total };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return pageResult(rows.map(publicRow), total, query);
  }
  async createLink(context: RequestActorContext, productId: string, input: SupplierProductCreate) {
    return this.write(
      context,
      async (tx) => {
        const product = await this.lockProduct(tx, context, productId);
        this.expectVersion(product.version, input.expectedVersion, 'producto');
        this.active(product.archivedAt);
        this.active((await this.lockSupplier(tx, context, input.supplierId)).archivedAt);
        const { expectedVersion: _version, ...fields } = input;
        void _version;
        const link = await tx.supplierProduct.create({
          data: { ...fields, organizationId: context.organizationId, productId },
          include: linkInclude,
        });
        await this.audit.success(
          context,
          'SUPPLIER_PRODUCT_LINKED',
          'SupplierProduct',
          link.id,
          tx,
        );
        return { link: publicRow(link), product: await this.bumpProduct(tx, context, productId) };
      },
      'Este proveedor ya está asociado al producto, o ya utiliza ese código. Revisá también los vínculos archivados.',
    );
  }
  async updateLink(context: RequestActorContext, id: string, input: SupplierProductUpdate) {
    return this.write(context, async (tx) => {
      const initial = await tx.supplierProduct.findFirst({
        where: { organizationId: context.organizationId, id },
      });
      if (!initial) throw new NotFoundException();
      const product = await this.lockProduct(tx, context, initial.productId);
      this.active(product.archivedAt);
      this.active((await this.lockSupplier(tx, context, initial.supplierId)).archivedAt);
      const row = await tx.supplierProduct.findFirstOrThrow({
        where: { organizationId: context.organizationId, id },
      });
      this.expectVersion(row.version, input.expectedVersion);
      this.active(row.archivedAt);
      const { expectedVersion, ...fields } = input;
      const link = await tx.supplierProduct.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { ...fields, version: { increment: 1 } },
        include: linkInclude,
      });
      await this.audit.success(context, 'SUPPLIER_PRODUCT_UPDATED', 'SupplierProduct', id, tx);
      return {
        link: publicRow(link),
        product: await this.bumpProduct(tx, context, initial.productId),
      };
    });
  }
  async linkState(
    context: RequestActorContext,
    id: string,
    expectedVersion: number,
    restore: boolean,
  ) {
    return this.write(context, async (tx) => {
      const initial = await tx.supplierProduct.findFirst({
        where: { organizationId: context.organizationId, id },
      });
      if (!initial) throw new NotFoundException();
      const product = await this.lockProduct(tx, context, initial.productId);
      const supplier = await this.lockSupplier(tx, context, initial.supplierId);
      if (restore) {
        this.active(product.archivedAt);
        this.active(supplier.archivedAt);
      }
      const row = await tx.supplierProduct.findFirstOrThrow({
        where: { organizationId: context.organizationId, id },
        include: linkInclude,
      });
      this.expectVersion(row.version, expectedVersion);
      if (Boolean(row.archivedAt) === !restore)
        return { link: publicRow(row), product: productView(product) };
      const link = await tx.supplierProduct.update({
        where: { id, organizationId: context.organizationId, version: expectedVersion },
        data: { archivedAt: restore ? null : new Date(), version: { increment: 1 } },
        include: linkInclude,
      });
      await this.audit.success(
        context,
        restore ? 'SUPPLIER_PRODUCT_RESTORED' : 'SUPPLIER_PRODUCT_ARCHIVED',
        'SupplierProduct',
        id,
        tx,
      );
      return {
        link: publicRow(link),
        product: await this.bumpProduct(tx, context, initial.productId),
      };
    });
  }
}

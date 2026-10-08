import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Customer, Prisma } from '@maxbio/database';
import type {
  CustomerCreate,
  CustomerUpdate,
  CustomerListQuery,
  CustomerView,
} from '@maxbio/contracts';
import { DatabaseService } from '../../../infrastructure/database/database.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { textContains } from '../../catalog/domain/catalog-search.js';
import { customerSearchTokens } from '../domain/customer-search.js';

const editable = [
  'name',
  'kind',
  'legalName',
  'cuit',
  'taxConditionText',
  'addressLine',
  'locality',
  'province',
  'postalCode',
  'contactName',
  'phone',
  'email',
  'notes',
] as const;
// Explicit transport mapping: never expose tenant or the database search projection.
function view(row: Customer): CustomerView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    legalName: row.legalName,
    cuit: row.cuit,
    taxConditionText: row.taxConditionText,
    addressLine: row.addressLine,
    locality: row.locality,
    province: row.province,
    postalCode: row.postalCode,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
function creationFields(input: CustomerCreate) {
  return {
    name: input.name,
    kind: input.kind,
    legalName: input.legalName ?? null,
    cuit: input.cuit ?? null,
    taxConditionText: input.taxConditionText ?? null,
    addressLine: input.addressLine ?? null,
    locality: input.locality ?? null,
    province: input.province ?? null,
    postalCode: input.postalCode ?? null,
    contactName: input.contactName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    notes: input.notes ?? null,
  };
}

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  private async write<T>(
    c: RequestActorContext,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    if (c.role !== 'ADMIN')
      throw new ForbiddenException('No tenés permiso para modificar clientes.');
    try {
      return await this.database.client.$transaction(async (tx) => {
        const now = new Date();
        const membership = await tx.membership.findFirst({
          where: {
            id: c.membershipId,
            organizationId: c.organizationId,
            userId: c.userId,
            role: 'ADMIN',
            revokedAt: null,
            user: { disabledAt: null },
            organization: { archivedAt: null },
          },
        });
        const session = await tx.session.findFirst({
          where: {
            id: c.sessionId,
            userId: c.userId,
            activeMembershipId: c.membershipId,
            revokedAt: null,
            expiresAt: { gt: now },
            absoluteExpiresAt: { gt: now },
          },
        });
        if (!membership || !session)
          throw new ForbiddenException('Tu acceso cambió. Volvé a iniciar sesión.');
        return operation(tx);
      });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        if (error.code === 'P2002')
          throw new ConflictException(
            'Ese CUIT ya pertenece a un cliente. Revisá también los archivados.',
          );
        if (error.code === 'P2003' || error.code === 'P2025') throw new NotFoundException();
        if (error.code === 'P2034')
          throw new ConflictException('Otra operación coincidió con ésta. Volvé a intentar.');
      }
      throw error;
    }
  }
  private version(actual: number, expected: number) {
    if (actual !== expected)
      throw new ConflictException(
        'Este cliente fue modificado por otra persona. Cargá la información actual antes de guardar.',
      );
  }
  private async lock(tx: Prisma.TransactionClient, c: RequestActorContext, id: string) {
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE "organizationId"=${c.organizationId}::uuid AND id=${id}::uuid FOR UPDATE`;
    const row = await tx.customer.findFirst({ where: { organizationId: c.organizationId, id } });
    if (!row) throw new NotFoundException();
    return row;
  }
  async list(c: RequestActorContext, q: CustomerListQuery) {
    const where: Prisma.CustomerWhereInput = {
      organizationId: c.organizationId,
      ...(q.includeArchived ? {} : { archivedAt: null }),
      AND: customerSearchTokens(q.q).map((token) => ({ searchText: textContains(token) })),
    };
    return this.database.client.$transaction(
      async (tx) => {
        const rows = await tx.customer.findMany({
          where,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          skip: (q.page - 1) * q.limit,
          take: q.limit,
        });
        const total = await tx.customer.count({ where });
        return { items: rows.map(view), total, page: q.page, limit: q.limit };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async get(c: RequestActorContext, id: string) {
    const row = await this.database.client.customer.findFirst({
      where: { organizationId: c.organizationId, id },
    });
    if (!row) throw new NotFoundException();
    return view(row);
  }
  async create(c: RequestActorContext, input: CustomerCreate) {
    return this.write(c, async (tx) => {
      // Stable draft-style UUID, serialized even when no row exists yet.
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`customer-create:${input.id}`},0))`;
      const prior = await tx.customer.findUnique({ where: { id: input.id } });
      const fields = creationFields(input);
      if (prior) {
        if (prior.organizationId !== c.organizationId) throw new NotFoundException();
        if (editable.some((key) => prior[key] !== fields[key]))
          throw new ConflictException(
            'Este cliente ya fue creado con otros datos. Cargá su ficha antes de continuar.',
          );
        return view(prior);
      }
      const row = await tx.customer.create({
        data: { id: input.id, organizationId: c.organizationId, ...fields },
      });
      await this.audit.success(c, 'CUSTOMER_CREATED', 'Customer', row.id, tx);
      return view(row);
    });
  }
  async update(c: RequestActorContext, id: string, input: CustomerUpdate) {
    return this.write(c, async (tx) => {
      const row = await this.lock(tx, c, id);
      this.version(row.version, input.expectedVersion);
      if (row.archivedAt)
        throw new ConflictException(
          'Este cliente está archivado. Restauralo antes de modificarlo.',
        );
      const { expectedVersion, ...fields } = input;
      if (!editable.some((key) => fields[key] !== undefined && fields[key] !== row[key]))
        return view(row);
      const changed = await tx.customer.update({
        where: {
          organizationId_id: { organizationId: c.organizationId, id },
          version: expectedVersion,
        },
        data: { ...fields, version: { increment: 1 } },
      });
      await this.audit.success(c, 'CUSTOMER_UPDATED', 'Customer', id, tx);
      return view(changed);
    });
  }
  async state(c: RequestActorContext, id: string, expectedVersion: number, restore: boolean) {
    return this.write(c, async (tx) => {
      const row = await this.lock(tx, c, id);
      this.version(row.version, expectedVersion);
      if (Boolean(row.archivedAt) === !restore) return view(row);
      const changed = await tx.customer.update({
        where: {
          organizationId_id: { organizationId: c.organizationId, id },
          version: expectedVersion,
        },
        data: { archivedAt: restore ? null : new Date(), version: { increment: 1 } },
      });
      await this.audit.success(
        c,
        restore ? 'CUSTOMER_RESTORED' : 'CUSTOMER_ARCHIVED',
        'Customer',
        id,
        tx,
      );
      return view(changed);
    });
  }
}

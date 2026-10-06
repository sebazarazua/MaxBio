import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@maxbio/database';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import type { RequestActorContext } from '../../common/auth/request-context.js';

interface AuditInput {
  organizationId?: string | null;
  actorUserId?: string | null;
  sessionId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  result: 'SUCCESS' | 'FAILURE';
  requestId: string;
  metadata?: {
    reason?: 'INVALID_CREDENTIALS';
    count?: number;
    supplierId?: string;
    importId?: string;
    mode?: 'PARTIAL' | 'COMPLETE';
    created?: number;
    updated?: number;
    unchanged?: number;
    ignored?: number;
    errors?: number;
    conflicts?: number;
    missing?: number;
  };
}

@Injectable()
export class AuditService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  append(event: AuditInput, tx: Prisma.TransactionClient = this.database.client) {
    // Allowlist explícita y acotada: no copiar DTO, headers ni objetos arbitrarios.
    const metadata: Record<string, string | number> = {};
    if (event.metadata?.reason === 'INVALID_CREDENTIALS') metadata.reason = event.metadata.reason;
    if (event.metadata?.count !== undefined) {
      if (!Number.isSafeInteger(event.metadata.count) || event.metadata.count < 0)
        throw new Error('Invalid audit count');
      metadata.count = event.metadata.count;
    }
    if (event.action === 'SUPPLIER_CATALOG_IMPORTED') {
      for (const key of ['supplierId', 'importId'] as const) {
        const value = event.metadata?.[key];
        if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Invalid audit resource');
        metadata[key] = value;
      }
      for (const key of [
        'created',
        'updated',
        'unchanged',
        'ignored',
        'errors',
        'conflicts',
        'missing',
      ] as const) {
        const value = event.metadata?.[key];
        if (value === undefined || !Number.isSafeInteger(value) || value < 0)
          throw new Error('Invalid audit count');
        metadata[key] = value;
      }
      if (event.metadata?.mode !== 'PARTIAL' && event.metadata?.mode !== 'COMPLETE')
        throw new Error('Invalid audit mode');
      metadata.mode = event.metadata.mode;
    }
    return tx.auditEvent.create({
      data: {
        organizationId: event.organizationId,
        actorUserId: event.actorUserId,
        sessionId: event.sessionId,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        result: event.result,
        requestId: event.requestId,
        metadata,
      },
    });
  }

  success(
    context: RequestActorContext,
    action: string,
    resourceType: string,
    resourceId: string,
    tx: Prisma.TransactionClient,
  ) {
    return this.append(
      {
        organizationId: context.organizationId,
        actorUserId: context.userId,
        sessionId: context.sessionId,
        requestId: context.requestId,
        action,
        resourceType,
        resourceId,
        result: 'SUCCESS',
      },
      tx,
    );
  }
}

import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@maxbio/database';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
export async function requireFiscalAdmin(
  tx: Prisma.TransactionClient,
  c: RequestActorContext,
  now: Date,
) {
  if (c.role !== 'ADMIN') throw new ForbiddenException('Esta acción requiere un administrador.');
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
}

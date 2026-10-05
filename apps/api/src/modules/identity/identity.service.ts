import { createHash, randomBytes } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@maxbio/database';
import { DatabaseService } from '../../infrastructure/database/database.service.js';
import { AuditService } from '../audit/audit.service.js';
import { hashPassword, passwordNeedsRehash, verifyPassword } from './password.js';
import type {
  RequestActorContext,
  AuthenticatedRequest,
} from '../../common/auth/request-context.js';

export const tokenVerifier = (token: string) => createHash('sha256').update(token).digest('hex');
const activeMemberships = { revokedAt: null, organization: { archivedAt: null } };
const sessionInvalid = () =>
  new UnauthorizedException({
    code: 'SESSION_ENDED',
    message: 'Tu sesión terminó. Iniciá sesión nuevamente para continuar.',
  });

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  private expiry(now: Date, absolute: Date) {
    return new Date(
      Math.min(
        absolute.getTime(),
        now.getTime() + this.config.getOrThrow<number>('SESSION_IDLE_DAYS') * 86400000,
      ),
    );
  }

  async login(email: string, password: string, deviceName: string | undefined, requestId: string) {
    const user = await this.database.client.user.findUnique({
      where: { email },
      include: {
        memberships: { where: activeMemberships, include: { organization: true } },
      },
    });
    const verified = await verifyPassword(user?.passwordHash ?? null, password);
    if (
      !user ||
      !user.passwordHash ||
      !verified ||
      user.disabledAt ||
      user.memberships.length === 0
    ) {
      // Sin email, actor o tenant: igual evento para identidades conocidas y desconocidas.
      await this.audit.append({
        action: 'AUTH_LOGIN_FAILED',
        resourceType: 'Identity',
        result: 'FAILURE',
        requestId,
        metadata: { reason: 'INVALID_CREDENTIALS' },
      });
      throw new UnauthorizedException('Email o contraseña incorrectos.');
    }
    const newHash = passwordNeedsRehash(user.passwordHash)
      ? await hashPassword(password)
      : undefined;
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const absoluteExpiresAt = new Date(
      now.getTime() + this.config.getOrThrow<number>('SESSION_ABSOLUTE_DAYS') * 86400000,
    );
    const session = await this.database.client.$transaction(async (tx) => {
      // Serializa login con disable/revoke-all; no revive un usuario deshabilitado durante el hash.
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        include: {
          memberships: { where: activeMemberships },
        },
      });
      if (
        current.disabledAt ||
        current.passwordHash !== user.passwordHash ||
        !current.memberships.length
      )
        throw sessionInvalid();
      if (newHash)
        await tx.user.update({ where: { id: user.id }, data: { passwordHash: newHash } });
      const membership = current.memberships.length === 1 ? current.memberships[0] : undefined;
      const created = await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: tokenVerifier(token),
          activeMembershipId: membership?.id,
          deviceName,
          lastUsedAt: now,
          expiresAt: this.expiry(now, absoluteExpiresAt),
          absoluteExpiresAt,
        },
      });
      await this.audit.append(
        {
          actorUserId: user.id,
          organizationId: membership?.organizationId,
          sessionId: created.id,
          action: 'AUTH_LOGIN_SUCCEEDED',
          resourceType: 'Session',
          resourceId: created.id,
          result: 'SUCCESS',
          requestId,
        },
        tx,
      );
      return created;
    });
    return { token, session };
  }

  async authenticate(
    token: string | undefined,
    requestId: string,
  ): Promise<AuthenticatedRequest['identity']> {
    if (!token) throw new UnauthorizedException('Iniciá sesión para continuar.');
    const session = await this.database.client.session.findUnique({
      where: { tokenHash: tokenVerifier(token) },
      include: { user: true, activeMembership: { include: { organization: true } } },
    });
    const now = new Date();
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.user.disabledAt
    )
      throw sessionInvalid();
    const membership = session.activeMembership;
    if (membership && (membership.revokedAt || membership.organization.archivedAt))
      throw sessionInvalid();
    if (
      !membership &&
      (await this.database.client.membership.count({
        where: { userId: session.userId, ...activeMemberships },
      })) === 0
    )
      throw sessionInvalid();
    const context: RequestActorContext | null = membership
      ? {
          userId: session.userId,
          organizationId: membership.organizationId,
          membershipId: membership.id,
          role: membership.role,
          sessionId: session.id,
          requestId,
        }
      : null;
    const threshold = new Date(
      now.getTime() - this.config.getOrThrow<number>('SESSION_ACTIVITY_MINUTES') * 60000,
    );
    if (session.lastUsedAt <= threshold) {
      const expiresAt = this.expiry(now, session.absoluteExpiresAt);
      const changed = await this.database.client.session.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
          lastUsedAt: { lte: threshold },
          user: { disabledAt: null },
        },
        data: { lastUsedAt: now, expiresAt },
      });
      if (changed.count) {
        session.lastUsedAt = now;
        session.expiresAt = expiresAt;
      } else {
        const current = await this.database.client.session.findUnique({
          where: { id: session.id },
        });
        if (!current || current.revokedAt || current.expiresAt <= now) throw sessionInvalid();
        session.expiresAt = current.expiresAt;
      }
    }
    return { session, user: session.user, context };
  }

  async view(identity: AuthenticatedRequest['identity']) {
    const memberships = await this.database.client.membership.findMany({
      where: { userId: identity.user.id, ...activeMemberships },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    const active = memberships.find((item) => item.id === identity.session.activeMembershipId);
    return {
      user: {
        id: identity.user.id,
        email: identity.user.email,
        displayName: identity.user.displayName,
      },
      session: {
        id: identity.session.id,
        expiresAt: identity.session.expiresAt.toISOString(),
        absoluteExpiresAt: identity.session.absoluteExpiresAt.toISOString(),
      },
      activeOrganization: active
        ? {
            id: active.organizationId,
            name: active.organization.name,
            membershipId: active.id,
            role: active.role,
          }
        : null,
      organizations: memberships.map((item) => ({
        id: item.organizationId,
        name: item.organization.name,
        membershipId: item.id,
        role: item.role,
      })),
    };
  }

  async selectOrganization(
    identity: AuthenticatedRequest['identity'],
    membershipId: string,
    requestId: string,
  ) {
    await this.database.client.$transaction(async (tx) => {
      const membership = await tx.membership.findFirst({
        where: { id: membershipId, userId: identity.user.id, ...activeMemberships },
      });
      if (!membership) throw new ForbiddenException('No tenés acceso a esa organización.');
      const now = new Date();
      const changed = await tx.session.updateMany({
        where: {
          id: identity.session.id,
          userId: identity.user.id,
          revokedAt: null,
          expiresAt: { gt: now },
          user: { disabledAt: null },
        },
        data: { activeMembershipId: membership.id },
      });
      if (!changed.count) throw sessionInvalid();
      await this.audit.append(
        {
          actorUserId: identity.user.id,
          organizationId: membership.organizationId,
          sessionId: identity.session.id,
          action: 'ACTIVE_ORGANIZATION_SELECTED',
          resourceType: 'Membership',
          resourceId: membership.id,
          result: 'SUCCESS',
          requestId,
        },
        tx,
      );
    });
  }

  async listSessions(userId: string) {
    const now = new Date();
    return this.database.client.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      select: {
        id: true,
        deviceName: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
        absoluteExpiresAt: true,
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  async revokeSession(
    identity: AuthenticatedRequest['identity'],
    sessionId: string,
    requestId: string,
    logout = false,
  ) {
    return this.database.client.$transaction(async (tx) => {
      const changed = await tx.session.updateMany({
        where: { id: sessionId, userId: identity.user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (!changed.count && !logout) throw new NotFoundException();
      if (changed.count)
        await this.audit.append(
          {
            actorUserId: identity.user.id,
            organizationId: identity.context?.organizationId,
            sessionId: identity.session.id,
            action: logout ? 'AUTH_LOGOUT' : 'SESSION_REVOKED',
            resourceType: 'Session',
            resourceId: sessionId,
            result: 'SUCCESS',
            requestId,
          },
          tx,
        );
    });
  }

  private async revokeAll(
    tx: Prisma.TransactionClient,
    userId: string,
    actor: AuthenticatedRequest['identity'],
    requestId: string,
  ) {
    const { count } = await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.append(
      {
        actorUserId: actor.user.id,
        organizationId: actor.context?.organizationId,
        sessionId: actor.session.id,
        action: 'USER_SESSIONS_REVOKED',
        resourceType: 'User',
        resourceId: userId,
        result: 'SUCCESS',
        requestId,
        metadata: { count },
      },
      tx,
    );
  }

  async revokeAllSessions(actor: AuthenticatedRequest['identity'], requestId: string) {
    await this.database.client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${actor.user.id}::uuid FOR UPDATE`;
      await this.revokeAll(tx, actor.user.id, actor, requestId);
    });
  }

  // Capability application-only. Un admin de tenant no puede deshabilitar identidades de otros tenants.
  async disableUser(context: RequestActorContext, targetUserId: string) {
    return this.manageUser(context, targetUserId, { action: 'DISABLE' });
  }

  async revokeUserSessions(context: RequestActorContext, targetUserId: string) {
    return this.manageUser(context, targetUserId, { action: 'REVOKE_ALL' });
  }

  async revokeUserSession(context: RequestActorContext, targetUserId: string, sessionId: string) {
    return this.manageUser(context, targetUserId, { action: 'REVOKE_ONE', sessionId });
  }

  private async manageUser(
    context: RequestActorContext,
    targetUserId: string,
    operation: { action: 'DISABLE' | 'REVOKE_ALL' } | { action: 'REVOKE_ONE'; sessionId: string },
  ) {
    if (context.role !== 'ADMIN') throw new ForbiddenException();
    await this.database.client.$transaction(async (tx) => {
      const author = await tx.membership.findFirst({
        where: {
          id: context.membershipId,
          userId: context.userId,
          organizationId: context.organizationId,
          role: 'ADMIN',
          ...activeMemberships,
          user: { disabledAt: null },
        },
      });
      const actorSession = await tx.session.findFirst({
        where: {
          id: context.sessionId,
          userId: context.userId,
          activeMembershipId: context.membershipId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
          absoluteExpiresAt: { gt: new Date() },
        },
      });
      if (!author || !actorSession) throw new ForbiddenException();
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${targetUserId}::uuid FOR UPDATE`;
      const target = await tx.user.findUnique({
        where: { id: targetUserId },
        include: { memberships: true },
      });
      if (
        !target ||
        !target.memberships.some(
          (item) => item.organizationId === context.organizationId && !item.revokedAt,
        ) ||
        target.memberships.some(
          (item) => item.organizationId !== context.organizationId && !item.revokedAt,
        )
      )
        throw new NotFoundException();
      if (operation.action === 'DISABLE')
        await tx.user.update({ where: { id: targetUserId }, data: { disabledAt: new Date() } });
      const changed = await tx.session.updateMany({
        where: {
          userId: targetUserId,
          revokedAt: null,
          ...(operation.action === 'REVOKE_ONE' ? { id: operation.sessionId } : {}),
        },
        data: { revokedAt: new Date() },
      });
      if (operation.action === 'REVOKE_ONE' && !changed.count) throw new NotFoundException();
      await this.audit.success(
        context,
        operation.action === 'DISABLE'
          ? 'USER_DISABLED'
          : operation.action === 'REVOKE_ONE'
            ? 'SESSION_REVOKED'
            : 'USER_SESSIONS_REVOKED',
        operation.action === 'REVOKE_ONE' ? 'Session' : 'User',
        operation.action === 'REVOKE_ONE' ? operation.sessionId : targetUserId,
        tx,
      );
    });
  }
}

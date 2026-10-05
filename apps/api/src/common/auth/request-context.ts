import type { Request } from 'express';
import type { Session, User } from '@maxbio/database';

export interface RequestActorContext {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: 'ADMIN' | 'OPERATOR';
  sessionId: string;
  requestId: string;
}

export interface AuthenticatedRequest extends Request {
  identity: { session: Session; user: User; context: RequestActorContext | null };
}

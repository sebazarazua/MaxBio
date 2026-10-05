import { ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PUBLIC_ROUTE } from './public.decorator.js';
import { IDENTITY_ONLY, REQUIRED_ROLES } from './roles.decorator.js';
import { IdentityService } from '../../modules/identity/identity.service.js';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedRequest } from './request-context.js';
import type { Response } from 'express';
import {
  readSessionToken,
  setSessionCookie,
  clearSessionCookie,
} from '../../modules/identity/session-cookie.js';

@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const production = this.config.get('NODE_ENV') === 'production';
    const token = readSessionToken(request, production);
    try {
      request.identity = await this.identity.authenticate(token, String(response.locals.requestId));
    } catch (error) {
      if (error instanceof UnauthorizedException) clearSessionCookie(response, production);
      throw error;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (
      !request.identity.context &&
      !this.reflector.getAllAndOverride<boolean>(IDENTITY_ONLY, targets)
    )
      throw new ForbiddenException('Elegí una organización para continuar.');
    const roles = this.reflector.getAllAndOverride<string[]>(REQUIRED_ROLES, targets);
    if (roles && (!request.identity.context || !roles.includes(request.identity.context.role)))
      throw new ForbiddenException('No tenés permiso para realizar esta acción.');
    // Reemitir cookie también en visitas nuevas aunque la actualización DB esté throttled.
    if (token) setSessionCookie(response, token, request.identity.session.expiresAt, production);
    return true;
  }
}

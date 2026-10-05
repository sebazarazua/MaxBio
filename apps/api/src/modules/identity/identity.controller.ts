import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../common/auth/request-context.js';
import { Public } from '../../common/auth/public.decorator.js';
import { IdentityOnly, Roles } from '../../common/auth/roles.decorator.js';
import { IdentityService } from './identity.service.js';
import { LoginLimiter } from './login-limiter.js';
import { clearSessionCookie, setSessionCookie } from './session-cookie.js';

class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(1) @MaxLength(128) password!: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) deviceName?: string;
}
class OrganizationDto {
  @IsUUID('4') membershipId!: string;
}

@Controller('auth')
export class IdentityController {
  constructor(
    @Inject(IdentityService) private readonly service: IdentityService,
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(LoginLimiter) private readonly limiter: LoginLimiter,
  ) {}
  private production() {
    return this.config.get('NODE_ENV') === 'production';
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const email = body.email.trim().toLowerCase();
    const release = this.limiter.enter(request.ip ?? 'unknown', email);
    try {
      const result = await this.service.login(
        email,
        body.password,
        body.deviceName,
        String(response.locals.requestId),
      );
      setSessionCookie(response, result.token, result.session.expiresAt, this.production());
      return { ok: true };
    } finally {
      release();
    }
  }

  @IdentityOnly()
  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return this.service.view(request.identity);
  }

  @IdentityOnly()
  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.service.revokeSession(
      request.identity,
      request.identity.session.id,
      String(response.locals.requestId),
      true,
    );
    clearSessionCookie(response, this.production());
    return { ok: true };
  }

  @IdentityOnly()
  @Post('organization')
  @HttpCode(200)
  async organization(
    @Body() body: OrganizationDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.service.selectOrganization(
      request.identity,
      body.membershipId,
      String(response.locals.requestId),
    );
    return { ok: true };
  }

  @IdentityOnly()
  @Get('sessions')
  sessions(@Req() request: AuthenticatedRequest) {
    return this.service.listSessions(request.identity.user.id);
  }

  @IdentityOnly()
  @Post('sessions/revoke-all')
  @HttpCode(200)
  async revokeAll(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.service.revokeAllSessions(request.identity, String(response.locals.requestId));
    clearSessionCookie(response, this.production());
    return { ok: true };
  }

  @IdentityOnly()
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  async revoke(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.service.revokeSession(request.identity, id, String(response.locals.requestId));
    if (id === request.identity.session.id) clearSessionCookie(response, this.production());
    return { ok: true };
  }

  @Roles('ADMIN')
  @Get('admin-check')
  admin(@Req() request: AuthenticatedRequest) {
    return { ok: true, organizationId: request.identity.context!.organizationId };
  }
}

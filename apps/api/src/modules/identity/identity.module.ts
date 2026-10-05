import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { AuditService } from '../audit/audit.service.js';
import { IdentityService } from './identity.service.js';
import { IdentityController } from './identity.controller.js';
import { LoginLimiter } from './login-limiter.js';

@Module({
  imports: [DatabaseModule],
  controllers: [IdentityController],
  providers: [IdentityService, AuditService, LoginLimiter],
  exports: [IdentityService, AuditService],
})
export class IdentityModule {}

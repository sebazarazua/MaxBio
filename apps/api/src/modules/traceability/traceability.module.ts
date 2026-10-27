import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { TraceabilityController } from './api/traceability.controller.js';
import { TraceabilityService } from './application/traceability.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [TraceabilityController],
  providers: [TraceabilityService],
})
export class TraceabilityModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CustomersController } from './api/customers.controller.js';
import { CustomersService } from './application/customers.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CustomersController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { InventoryService } from './application/inventory.service.js';
import { InventoryController } from './api/inventory.controller.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}

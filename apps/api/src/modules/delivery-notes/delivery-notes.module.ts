import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { DeliveryNotesService } from './application/delivery-notes.service.js';
import { DeliveryNotesController } from './api/delivery-notes.controller.js';
@Module({
  imports: [DatabaseModule, IdentityModule, InventoryModule],
  controllers: [DeliveryNotesController],
  providers: [DeliveryNotesService],
})
export class DeliveryNotesModule {}

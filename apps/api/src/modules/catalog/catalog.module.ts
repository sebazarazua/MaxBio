import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogController } from './api/catalog.controller.js';
import { CatalogService } from './application/catalog.service.js';
import { SupplierCatalogService } from './application/supplier-catalog.service.js';
import { SupplierCatalogController } from './api/supplier-catalog.controller.js';
import { IdentificationController } from './api/identification.controller.js';
import { IdentificationService } from './application/identification.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CatalogController, SupplierCatalogController, IdentificationController],
  providers: [CatalogService, SupplierCatalogService, IdentificationService],
  exports: [CatalogService],
})
export class CatalogModule {}

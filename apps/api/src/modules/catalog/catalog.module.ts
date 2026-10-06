import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogController } from './api/catalog.controller.js';
import { CatalogService } from './application/catalog.service.js';
import { SupplierCatalogService } from './application/supplier-catalog.service.js';
import { SupplierCatalogController } from './api/supplier-catalog.controller.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CatalogController, SupplierCatalogController],
  providers: [CatalogService, SupplierCatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

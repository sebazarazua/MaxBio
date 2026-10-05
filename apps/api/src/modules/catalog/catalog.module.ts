import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CatalogController } from './api/catalog.controller.js';
import { CatalogService } from './application/catalog.service.js';

@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}

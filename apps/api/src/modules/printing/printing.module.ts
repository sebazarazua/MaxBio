import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PrintingService } from './application/printing.service.js';
import { PrintingController } from './api/printing.controller.js';
import { LocalPrivatePrintStorage, PRINT_STORAGE } from './infrastructure/private-print-storage.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [PrintingController],
  providers: [PrintingService, { provide: PRINT_STORAGE, useClass: LocalPrivatePrintStorage }],
  exports: [PrintingService],
})
export class PrintingModule {}

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { InvoicingController } from './api/invoicing.controller.js';
import { InvoicingService } from './application/invoicing.service.js';
import { InvoiceFiscalService } from './application/invoice-fiscal.service.js';
import { FiscalModule } from '../fiscal/fiscal.module.js';

// Facturación V1 interna. Sin ARCA/WSAA/WSFEv1/CAE ni certificados.
@Module({
  imports: [DatabaseModule, IdentityModule, FiscalModule],
  controllers: [InvoicingController],
  providers: [InvoicingService, InvoiceFiscalService],
})
export class InvoicingModule {}

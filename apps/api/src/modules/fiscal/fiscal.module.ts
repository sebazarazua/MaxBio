import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { FiscalController } from './api/fiscal.controller.js';
import { FiscalService } from './application/fiscal.service.js';
import {
  CREDENTIAL_STORAGE,
  LocalPrivateCredentialStorage,
} from './infrastructure/private-credential-storage.js';
import { CMS_SIGNER, OpenSslArcaCrypto } from './arca/openssl-crypto.js';
import { ARCA_CLOCK, systemArcaClock, type ArcaClock } from './arca/arca-errors.js';
import { ArcaWsaaClient } from './arca/wsaa-client.js';
import { ArcaTicketProvider } from './arca/ticket-provider.js';
import { ArcaWsfeClient } from './arca/wsfe-client.js';
import { ArcaWsfeProvider } from './arca/wsfe-provider.js';
import { FISCAL_PROVIDER } from './arca/wsfe-types.js';
import { WsfeConfigurationService } from './application/wsfe-configuration.service.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [FiscalController],
  providers: [
    FiscalService,
    WsfeConfigurationService,
    ArcaWsfeProvider,
    { provide: ArcaWsfeClient, useFactory: () => new ArcaWsfeClient() },
    { provide: FISCAL_PROVIDER, useExisting: ArcaWsfeProvider },
    OpenSslArcaCrypto,
    { provide: CREDENTIAL_STORAGE, useFactory: () => new LocalPrivateCredentialStorage() },
    { provide: CMS_SIGNER, useExisting: OpenSslArcaCrypto },
    { provide: ARCA_CLOCK, useValue: systemArcaClock },
    { provide: ArcaWsaaClient, useFactory: () => new ArcaWsaaClient() },
    {
      provide: ArcaTicketProvider,
      inject: [ARCA_CLOCK],
      useFactory: (clock: ArcaClock) => new ArcaTicketProvider(clock),
    },
  ],
  exports: [ArcaTicketProvider, FISCAL_PROVIDER, WsfeConfigurationService, ARCA_CLOCK],
})
export class FiscalModule {}

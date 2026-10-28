import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { RequestActorContext } from '../../../common/auth/request-context.js';
import { FiscalService } from '../application/fiscal.service.js';
import { ArcaWsfeClient } from './wsfe-client.js';
import type { FiscalProvider, WsfeInvoice, WsfeIdentity } from './wsfe-types.js';

@Injectable()
export class ArcaWsfeProvider implements FiscalProvider {
  constructor(
    @Inject(FiscalService) private readonly fiscal: FiscalService,
    @Inject(ArcaWsfeClient) private readonly client: ArcaWsfeClient,
  ) {}
  private async auth(c: RequestActorContext, expectedCuit?: string) {
    const auth = await this.fiscal.authenticate(c);
    if (expectedCuit && auth.cuit !== expectedCuit)
      throw new ConflictException('El CUIT del emisor cambió. No se envió la operación fiscal.');
    return {
      token: auth.ticket.token,
      sign: auth.ticket.sign,
      cuit: auth.cuit,
      credentialId: auth.credentialId,
    };
  }
  async references(c: RequestActorContext) {
    const auth = await this.auth(c);
    return {
      references: await this.client.references(auth),
      cuit: auth.cuit,
      credentialId: auth.credentialId,
    };
  }
  async last(c: RequestActorContext, identity: WsfeIdentity) {
    return this.client.last(await this.auth(c, identity.issuerCuit), identity);
  }
  async authorize(c: RequestActorContext, invoice: WsfeInvoice) {
    return this.client.authorize(await this.auth(c, invoice.issuerCuit), invoice);
  }
  async consult(c: RequestActorContext, identity: WsfeIdentity, number: number) {
    return this.client.consult(await this.auth(c, identity.issuerCuit), identity, number);
  }
}

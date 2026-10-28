import { z } from 'zod';
import type { FiscalMessage, WsfeReferences } from '@maxbio/contracts';
import type { RequestActorContext } from '../../../common/auth/request-context.js';

const money = z.string().regex(/^(0|[1-9][0-9]{0,12})\.[0-9]{2}$/);
export const wsfeInvoiceSchema = z
  .object({
    issuerCuit: z.string().regex(/^\d{11}$/),
    pointOfSale: z.number().int().min(1).max(99999),
    documentType: z.union([z.literal(1), z.literal(6), z.literal(11)]),
    number: z.number().int().min(1).max(99999999).nullable(),
    issueDate: z.string().regex(/^\d{8}$/),
    docType: z.literal(80),
    docNumber: z.string().regex(/^\d{11}$/),
    receiverVatConditionId: z.number().int().positive(),
    concept: z.literal(1),
    currency: z.literal('PES'),
    exchangeRate: z.literal('1'),
    total: money,
    notTaxed: money,
    net: money,
    exempt: money,
    vat: money,
    tributes: z.literal('0.00'),
    iva: z.array(z.object({ id: z.number().int(), base: money, amount: money }).strict()),
  })
  .strict();
export type WsfeInvoice = z.infer<typeof wsfeInvoiceSchema>;
// Consultation also describes different registered vouchers, for conflict detection.
export const wsfeRegisteredInvoiceSchema = wsfeInvoiceSchema
  .extend({
    docType: z.number().int().min(0).max(99),
    docNumber: z.string().regex(/^\d{1,20}$/),
    receiverVatConditionId: z.number().int().positive().nullable(),
    concept: z.number().int().min(1).max(3),
    currency: z.string().regex(/^[A-Z]{3}$/),
    exchangeRate: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
    tributes: money,
  })
  .strict();
export type WsfeComparableInvoice = z.infer<typeof wsfeRegisteredInvoiceSchema>;
export type WsfeIdentity = Pick<WsfeInvoice, 'issuerCuit' | 'pointOfSale' | 'documentType'>;
export type WsfeResult = {
  result: 'A' | 'R';
  cae: string | null;
  caeExpiration: string | null;
  messages: FiscalMessage[];
  observations: FiscalMessage[];
  events: FiscalMessage[];
};
export type WsfeRegistered = { invoice: WsfeComparableInvoice; result: WsfeResult };
export class WsfeError extends Error {
  constructor(
    readonly code:
      'NETWORK' | 'INVALID_RESPONSE' | 'SOAP_FAULT' | 'REMOTE_ERROR' | 'DIVERGENT_RECORD',
    readonly details: FiscalMessage[] = [],
  ) {
    super(
      {
        NETWORK: 'No pudimos comunicarnos con ARCA.',
        INVALID_RESPONSE: 'ARCA devolvió una respuesta fiscal incompleta o inválida.',
        SOAP_FAULT: 'ARCA no pudo completar la operación fiscal.',
        REMOTE_ERROR: 'ARCA informó un error en la consulta fiscal.',
        DIVERGENT_RECORD:
          'ARCA registra otro comprobante en esta secuencia. Requiere revisión fiscal.',
      }[code],
    );
    this.name = 'WsfeError';
  }
}
export const FISCAL_PROVIDER = Symbol('FISCAL_PROVIDER');
export interface FiscalProvider {
  references(
    c: RequestActorContext,
  ): Promise<{ references: WsfeReferences; cuit: string; credentialId: string }>;
  last(c: RequestActorContext, identity: WsfeIdentity): Promise<number>;
  authorize(c: RequestActorContext, invoice: WsfeInvoice): Promise<WsfeResult>;
  consult(
    c: RequestActorContext,
    identity: WsfeIdentity,
    number: number,
  ): Promise<WsfeRegistered | null>;
}

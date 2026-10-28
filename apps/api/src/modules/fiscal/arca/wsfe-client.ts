import { z } from 'zod';
import {
  moneyCents,
  formatCents,
  type FiscalMessage,
  type WsfeReferences,
} from '@maxbio/contracts';
import { parseWsaaXml, SOAP_NS } from './wsaa-xml.js';
import { businessDate } from '../../inventory/domain/quantity.js';
import {
  WsfeError,
  wsfeInvoiceSchema,
  wsfeRegisteredInvoiceSchema,
  type WsfeInvoice,
  type WsfeIdentity,
  type WsfeResult,
  type WsfeRegistered,
} from './wsfe-types.js';

export const WSFE_HOMOLOGATION_ENDPOINT = 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx';
export const WSFE_NS = 'http://ar.gov.afip.dif.FEV1/';
export type WsfeAuth = { token: string; sign: string; cuit: string };
type Node = ReturnType<typeof parseWsaaXml>;
function invalid(): never {
  throw new WsfeError('INVALID_RESPONSE');
}
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const tag = (name: string, value: string | number) => `<${name}>${escape(String(value))}</${name}>`;
function child(n: Node, name: string, optional = false, ns = n.ns): Node | undefined {
  if (n.text.trim()) invalid();
  const found = n.children.filter((c) => c.name === name);
  if (found.some((c) => c.ns !== ns) || found.length > 1 || (!optional && found.length !== 1))
    invalid();
  return found[0];
}
function value(n: Node, name: string, optional = false): string {
  const c = child(n, name, optional);
  if (!c) return '';
  if (c.children.length) invalid();
  const result = c.text.trim();
  if (!optional && !result) invalid();
  return result;
}
function integer(s: string, min = 1, max = 99999999): number {
  if (!/^\d+$/.test(s)) return invalid();
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) invalid();
  return n;
}
function date(s: string) {
  if (
    !/^\d{8}$/.test(s) ||
    !z.iso.date().safeParse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`).success
  )
    invalid();
  return s;
}
function money(s: string) {
  if (!/^\d+(?:\.\d{1,6})?$/.test(s)) return invalid();
  const [whole, fraction = ''] = s.split('.');
  if (/[^0]/.test(fraction.slice(2))) invalid();
  try {
    return formatCents(
      moneyCents(`${BigInt(whole!).toString()}.${fraction.padEnd(2, '0').slice(0, 2)}`),
    );
  } catch {
    return invalid();
  }
}
function items(n: Node, parent: string, item: string) {
  const list = child(n, parent, true);
  if (!list) return [];
  if (list.text.trim() || list.children.some((c) => c.name !== item || c.ns !== WSFE_NS)) invalid();
  return list.children;
}
function sanitized(message: string, auth: WsfeAuth) {
  let clean = message.replace(/\p{Cc}/gu, ' ');
  for (const secret of [auth.token, auth.sign])
    if (secret) clean = clean.split(secret).join('[dato reservado]');
  if (/PRIVATE KEY|<\/?(?:Token|Sign)\b/i.test(clean))
    return 'ARCA informó un mensaje fiscal reservado.';
  return clean.slice(0, 500);
}
function messages(n: Node, parent: string, item: string, auth: WsfeAuth): FiscalMessage[] {
  return items(n, parent, item).map((m) => ({
    code: String(integer(value(m, 'Code'), 0, 2147483647)),
    message: sanitized(value(m, 'Msg'), auth),
  }));
}
export function invoiceRequestXml(i: WsfeInvoice) {
  wsfeInvoiceSchema.parse(i);
  if (!i.number) throw new Error('A fiscal number must be reserved before sending.');
  return (
    `<FeCAEReq><FeCabReq><CantReg>1</CantReg>${tag('PtoVta', i.pointOfSale)}${tag('CbteTipo', i.documentType)}</FeCabReq><FeDetReq><FECAEDetRequest>` +
    tag('Concepto', 1) +
    tag('DocTipo', 80) +
    tag('DocNro', i.docNumber) +
    tag('CbteDesde', i.number) +
    tag('CbteHasta', i.number) +
    tag('CbteFch', i.issueDate) +
    tag('ImpTotal', i.total) +
    tag('ImpTotConc', i.notTaxed) +
    tag('ImpNeto', i.net) +
    tag('ImpOpEx', i.exempt) +
    tag('ImpTrib', '0.00') +
    tag('ImpIVA', i.vat) +
    tag('MonId', 'PES') +
    tag('MonCotiz', '1') +
    tag('CondicionIVAReceptorId', i.receiverVatConditionId) +
    (i.iva.length
      ? '<Iva>' +
        i.iva
          .map(
            (v) =>
              '<AlicIva>' +
              tag('Id', v.id) +
              tag('BaseImp', v.base) +
              tag('Importe', v.amount) +
              '</AlicIva>',
          )
          .join('') +
        '</Iva>'
      : '') +
    '</FECAEDetRequest></FeDetReq></FeCAEReq>'
  );
}

export class ArcaWsfeClient {
  constructor(
    private readonly send: typeof fetch = fetch,
    private readonly timeoutMs = 12000,
  ) {}
  private async call(method: string, auth?: WsfeAuth, fields = ''): Promise<Node> {
    const authentication = auth
      ? `<Auth>${tag('Token', auth.token)}${tag('Sign', auth.sign)}${tag('Cuit', auth.cuit)}</Auth>`
      : '';
    const body = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Body><${method} xmlns="${WSFE_NS}">${authentication}${fields}</${method}></soap:Body></soap:Envelope>`;
    try {
      const response = await this.send(WSFE_HOMOLOGATION_ENDPOINT, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"${WSFE_NS}${method}"` },
        body,
      });
      if (
        response.redirected ||
        !response.body ||
        !/^(?:text\/xml|application\/(?:soap\+)?xml)(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        invalid();
      if (Number(response.headers.get('content-length')) > 1048576) {
        await response.body.cancel();
        invalid();
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 1048576) {
            await reader.cancel();
            invalid();
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      let envelope: Node;
      try {
        envelope = parseWsaaXml(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
          { bytes: 1048576, nodes: 20000, depth: 24 },
        );
      } catch {
        return invalid();
      }
      if (envelope.name !== 'Envelope' || envelope.ns !== SOAP_NS) invalid();
      const soapBody = child(envelope, 'Body')!;
      if (soapBody.children.length !== 1) invalid();
      if (soapBody.children[0]!.name === 'Fault') throw new WsfeError('SOAP_FAULT');
      if (!response.ok) throw new WsfeError('REMOTE_ERROR');
      const result = child(
        child(soapBody, method + 'Response', false, WSFE_NS)!,
        method + 'Result',
      )!;
      return result;
    } catch (e) {
      if (e instanceof WsfeError) throw e;
      throw new WsfeError('NETWORK');
    }
  }
  private errors(n: Node, auth: WsfeAuth) {
    const errors = messages(n, 'Errors', 'Err', auth);
    if (errors.length) throw new WsfeError('REMOTE_ERROR', errors);
  }
  async dummy() {
    const n = await this.call('FEDummy');
    return {
      app: value(n, 'AppServer'),
      database: value(n, 'DbServer'),
      authentication: value(n, 'AuthServer'),
    };
  }
  async references(auth: WsfeAuth): Promise<WsfeReferences> {
    const [points, types, iva, ...conditions] = await Promise.all([
      this.call('FEParamGetPtosVenta', auth),
      this.call('FEParamGetTiposCbte', auth),
      this.call('FEParamGetTiposIva', auth),
      ...['A', 'B', 'C'].map((cls) =>
        this.call('FEParamGetCondicionIvaReceptor', auth, tag('ClaseCmp', cls)),
      ),
    ]);
    for (const n of [points!, types!, iva!, ...conditions]) this.errors(n, auth);
    const publicRefs = (n: Node, item: string) =>
      items(n, 'ResultGet', item)
        .filter((row) => {
          const until = value(row, 'FchHasta', true),
            from = value(row, 'FchDesde', true);
          const today = businessDate(new Date()).replaceAll('-', '');
          return (
            (!from || from === 'NULL' || from === '00000000' || date(from) <= today) &&
            (!until || until === 'NULL' || until === '00000000' || date(until) >= today)
          );
        })
        .map((row) => ({
          id: integer(value(row, 'Id')),
          label: sanitized(value(row, 'Desc'), auth).slice(0, 180),
        }));
    const pointNumbers = items(points!, 'ResultGet', 'PtoVenta')
      .filter((row) => {
        const blocked = value(row, 'Bloqueado'),
          retired = value(row, 'FchBaja', true);
        if (!['S', 'N'].includes(blocked)) invalid();
        return (
          value(row, 'EmisionTipo') === 'CAE' &&
          blocked === 'N' &&
          ['', 'NULL', '00000000'].includes(retired)
        );
      })
      .map((row) => integer(value(row, 'Nro'), 1, 99999));
    const byClass = Object.fromEntries(
      ['A', 'B', 'C'].map((cls, index) => [
        cls,
        items(conditions[index]!, 'ResultGet', 'CondicionIvaReceptor').map((row) => {
          if (value(row, 'Cmp_Clase') !== cls) invalid();
          return {
            id: integer(value(row, 'Id')),
            label: sanitized(value(row, 'Desc'), auth).slice(0, 180),
          };
        }),
      ]),
    ) as WsfeReferences['conditions'];
    return {
      points: [...new Set(pointNumbers)].sort((a, b) => a - b),
      conditions: byClass,
      documentTypes: publicRefs(types!, 'CbteTipo'),
      ivaTypes: publicRefs(iva!, 'IvaTipo'),
    };
  }
  async last(auth: WsfeAuth, identity: WsfeIdentity) {
    const n = await this.call(
      'FECompUltimoAutorizado',
      auth,
      tag('PtoVta', identity.pointOfSale) + tag('CbteTipo', identity.documentType),
    );
    this.errors(n, auth);
    if (
      integer(value(n, 'PtoVta'), 1, 99999) !== identity.pointOfSale ||
      integer(value(n, 'CbteTipo')) !== identity.documentType
    )
      invalid();
    return integer(value(n, 'CbteNro'), 0, 99999999);
  }
  private outcome(n: Node, auth: WsfeAuth, consulted = false): WsfeResult {
    const result = value(n, 'Resultado');
    if (!['A', 'R'].includes(result)) invalid();
    const cae = value(n, consulted ? 'CodAutorizacion' : 'CAE', true),
      expiration = value(n, consulted ? 'FchVto' : 'CAEFchVto', true);
    if (result === 'A' && (!/^\d{14}$/.test(cae) || !expiration)) invalid();
    if (result === 'R' && (cae || expiration)) invalid();
    return {
      result: result as 'A' | 'R',
      cae: cae || null,
      caeExpiration: expiration ? date(expiration) : null,
      messages: [],
      observations: messages(n, 'Observaciones', 'Obs', auth),
      events: [],
    };
  }
  async authorize(auth: WsfeAuth, invoice: WsfeInvoice): Promise<WsfeResult> {
    const n = await this.call('FECAESolicitar', auth, invoiceRequestXml(invoice));
    const cab = child(n, 'FeCabResp')!;
    if (
      value(cab, 'Cuit') !== auth.cuit ||
      integer(value(cab, 'PtoVta'), 1, 99999) !== invoice.pointOfSale ||
      integer(value(cab, 'CbteTipo')) !== invoice.documentType ||
      integer(value(cab, 'CantReg')) !== 1
    )
      invalid();
    const rows = items(n, 'FeDetResp', 'FECAEDetResponse');
    if (rows.length !== 1) invalid();
    const row = rows[0]!;
    for (const [name, expected] of [
      ['Concepto', '1'],
      ['DocTipo', '80'],
      ['DocNro', invoice.docNumber],
      ['CbteDesde', String(invoice.number)],
      ['CbteHasta', String(invoice.number)],
      ['CbteFch', invoice.issueDate],
    ] as const)
      if (value(row, name) !== expected) invalid();
    const result = this.outcome(row, auth);
    if (value(cab, 'Resultado') !== result.result) invalid();
    result.messages = messages(n, 'Errors', 'Err', auth);
    result.events = messages(n, 'Events', 'Evt', auth);
    if (result.result === 'A' && result.messages.length) invalid();
    if (result.result === 'R' && !result.messages.length && !result.observations.length) invalid();
    return result;
  }
  async consult(
    auth: WsfeAuth,
    identity: WsfeIdentity,
    number: number,
  ): Promise<WsfeRegistered | null> {
    const n = await this.call(
      'FECompConsultar',
      auth,
      '<FeCompConsReq>' +
        tag('CbteTipo', identity.documentType) +
        tag('CbteNro', number) +
        tag('PtoVta', identity.pointOfSale) +
        '</FeCompConsReq>',
    );
    const errors = messages(n, 'Errors', 'Err', auth),
      row = child(n, 'ResultGet', true);
    if (!row && errors.length && errors.every((m) => m.code === '602')) return null;
    this.errors(n, auth);
    if (!row) invalid();
    // Validate the queried identity before classifying a different fiscal mode.
    if (
      integer(value(row, 'PtoVta'), 1, 99999) !== identity.pointOfSale ||
      integer(value(row, 'CbteTipo')) !== identity.documentType ||
      integer(value(row, 'CbteDesde')) !== number ||
      integer(value(row, 'CbteHasta')) !== number
    )
      invalid();
    if (value(row, 'EmisionTipo') === 'CAEA') throw new WsfeError('DIVERGENT_RECORD');
    if (value(row, 'EmisionTipo') !== 'CAE') invalid();
    const rate = value(row, 'MonCotiz');
    if (!/^\d+(?:\.\d{1,6})?$/.test(rate)) invalid();
    const [rateWhole, rateFraction = ''] = rate.split('.');
    const fraction = rateFraction.replace(/0+$/, '');
    const normalizedRate = BigInt(rateWhole!).toString() + (fraction ? '.' + fraction : '');
    const receiverCondition = value(row, 'CondicionIVAReceptorId', true);
    const parsed = wsfeRegisteredInvoiceSchema.safeParse({
      issuerCuit: auth.cuit,
      pointOfSale: integer(value(row, 'PtoVta'), 1, 99999),
      documentType: integer(value(row, 'CbteTipo')),
      number: integer(value(row, 'CbteDesde')),
      issueDate: date(value(row, 'CbteFch')),
      docType: integer(value(row, 'DocTipo'), 0, 99),
      docNumber: value(row, 'DocNro'),
      receiverVatConditionId: receiverCondition ? integer(receiverCondition) : null,
      concept: integer(value(row, 'Concepto')),
      currency: value(row, 'MonId'),
      exchangeRate: normalizedRate,
      total: money(value(row, 'ImpTotal')),
      net: money(value(row, 'ImpNeto')),
      vat: money(value(row, 'ImpIVA')),
      notTaxed: money(value(row, 'ImpTotConc')),
      exempt: money(value(row, 'ImpOpEx')),
      tributes: money(value(row, 'ImpTrib')),
      iva: items(row, 'Iva', 'AlicIva').map((v) => ({
        id: integer(value(v, 'Id')),
        base: money(value(v, 'BaseImp')),
        amount: money(value(v, 'Importe')),
      })),
    });
    if (!parsed.success) return invalid();
    const record = parsed.data;
    if (
      record.number !== integer(value(row, 'CbteHasta')) ||
      record.number !== number ||
      record.pointOfSale !== identity.pointOfSale ||
      record.documentType !== identity.documentType ||
      new Set(record.iva.map((v) => v.id)).size !== record.iva.length
    )
      invalid();
    const result = this.outcome(row, auth, true);
    if (result.result !== 'A') invalid();
    result.events = messages(n, 'Events', 'Evt', auth);
    return { invoice: record, result };
  }
}

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  invoiceLineAmounts,
  invoiceTotals,
  moneyCents,
  formatCents,
  type InvoiceVatRate,
  type WsfeReferences,
} from '@maxbio/contracts';
import type { InvoiceRecord } from '../src/modules/invoicing/application/invoice-view.js';
import {
  mapFiscalInvoice,
  localFiscalReasons,
  sameFiscalInvoice,
  validateFiscalDate,
} from '../src/modules/invoicing/domain/fiscal-mapper.js';
import {
  ArcaWsfeClient,
  invoiceRequestXml,
  WSFE_HOMOLOGATION_ENDPOINT,
  WSFE_NS,
  type WsfeAuth,
} from '../src/modules/fiscal/arca/wsfe-client.js';
import { WsfeError, type WsfeInvoice } from '../src/modules/fiscal/arca/wsfe-types.js';
const now = new Date('2026-10-28T18:00:00Z');
const refs: WsfeReferences = {
  points: [23],
  conditions: {
    A: [{ id: 1, label: 'Responsable Inscripto' }],
    B: [{ id: 5, label: 'Consumidor Final' }],
    C: [{ id: 1, label: 'Responsable Inscripto' }],
  },
  documentTypes: [
    { id: 1, label: 'A' },
    { id: 6, label: 'B' },
    { id: 11, label: 'C' },
  ],
  ivaTypes: [
    { id: 3, label: '0' },
    { id: 4, label: '10.5' },
    { id: 5, label: '21' },
    { id: 6, label: '27' },
  ],
};
const issuer = { cuit: '27110247244', vatCondition: 'RESPONSABLE_INSCRIPTO' };
const d = (v: string) => ({
  toFixed: (digits?: number) => (digits === 2 ? formatCents(moneyCents(v)) : v),
});
function invoice(
  rates: InvoiceVatRate[] = ['VAT_21'],
  price = '100.00',
  type: InvoiceRecord['invoiceType'] = 'INVOICE_A',
): InvoiceRecord {
  const lines = rates.map((vatRate) => {
    const totals = invoiceLineAmounts('1', price, vatRate);
    return {
      quantity: d('1'),
      unitPrice: d(price),
      vatRate,
      netAmount: d(totals.netAmount),
      vatAmount: d(totals.vatAmount),
      totalAmount: d(totals.totalAmount),
    };
  });
  const totals = invoiceTotals(
    lines.map((l) => ({ netAmount: l.netAmount.toFixed(2), vatAmount: l.vatAmount.toFixed(2) })),
  );
  return {
    status: 'READY',
    invoiceType: type,
    receiverVatConditionId: type === 'INVOICE_B' ? 5 : 1,
    issueDate: new Date('2026-10-28T00:00:00Z'),
    lines,
    customerSnapshot: {
      id: randomUUID(),
      name: 'Test',
      kind: 'COMPANY',
      legalName: null,
      cuit: '20123456786',
      taxConditionText: 'Legacy free text',
      addressLine: null,
      locality: null,
      province: null,
      postalCode: null,
    },
    netAmount: d(totals.netAmount),
    vatAmount: d(totals.vatAmount),
    totalAmount: d(totals.totalAmount),
  } as unknown as InvoiceRecord;
}
test('WSFE mapper: A/B/C, document, structured receiver, goods, PES and each VAT class', () => {
  for (const [rate, id, vat] of [
    ['VAT_0', 3, '0.00'],
    ['VAT_10_5', 4, '10.50'],
    ['VAT_21', 5, '21.00'],
    ['VAT_27', 6, '27.00'],
  ] as const) {
    const mapped = mapFiscalInvoice(invoice([rate]), issuer, 23, refs, now);
    assert.deepEqual(mapped.iva, [{ id, base: '100.00', amount: vat }]);
    assert.equal(mapped.vat, vat);
    assert.equal(mapped.docType, 80);
    assert.equal(mapped.docNumber, '20123456786');
    assert.equal(mapped.concept, 1);
    assert.equal(mapped.currency, 'PES');
    assert.equal(mapped.exchangeRate, '1');
    assert.equal(mapped.receiverVatConditionId, 1);
  }
  const mixed = mapFiscalInvoice(
    invoice(['VAT_0', 'VAT_10_5', 'VAT_21', 'VAT_27', 'EXEMPT', 'NOT_TAXED']),
    issuer,
    23,
    refs,
    now,
  );
  assert.equal(mixed.net, '400.00');
  assert.equal(mixed.vat, '58.50');
  assert.equal(mixed.exempt, '100.00');
  assert.equal(mixed.notTaxed, '100.00');
  assert.equal(mixed.total, '658.50');
  assert.equal(mixed.tributes, '0.00');
  assert.equal(
    mapFiscalInvoice(invoice(['VAT_21'], '100.00', 'INVOICE_B'), issuer, 23, refs, now)
      .documentType,
    6,
  );
  const c = mapFiscalInvoice(
    invoice(['VAT_0', 'EXEMPT', 'NOT_TAXED'], '100.00', 'INVOICE_C'),
    { ...issuer, vatCondition: 'MONOTRIBUTO' },
    23,
    refs,
    now,
  );
  assert.equal(c.documentType, 11);
  assert.equal(c.net, '300.00');
  assert.equal(c.exempt, '0.00');
  assert.equal(c.notTaxed, '0.00');
  assert.equal(c.vat, '0.00');
  assert.deepEqual(c.iva, []);
});
test('WSFE mapper: no inference, no invented documents, issuer compatibility and fiscal precision limits', () => {
  const missing = invoice();
  missing.receiverVatConditionId = null;
  assert.throws(() => mapFiscalInvoice(missing, issuer, 23, refs, now), /condición IVA/);
  const noDocument = invoice();
  (noDocument.customerSnapshot as { cuit: null }).cuit = null;
  assert.throws(() => mapFiscalInvoice(noDocument, issuer, 23, refs, now), /CUIT del receptor/);
  assert.throws(
    () => mapFiscalInvoice(invoice(['VAT_0'], '1.00', 'INVOICE_C'), issuer, 23, refs, now),
    /condición IVA del emisor/,
  );
  assert.throws(
    () => mapFiscalInvoice(invoice(), { ...issuer, vatCondition: 'MONOTRIBUTO' }, 23, refs, now),
    /condición IVA del emisor/,
  );
  assert.throws(() => mapFiscalInvoice(invoice(), issuer, 99, refs, now), /punto de venta/);
  assert.throws(
    () => mapFiscalInvoice(invoice(['VAT_0'], '10000000000000.00'), issuer, 23, refs, now),
    /límite de importes/,
  );
  assert.equal(
    mapFiscalInvoice(invoice(['VAT_0'], '9999999999999.99'), issuer, 23, refs, now).total,
    '9999999999999.99',
  );
});
test('WSFE rounding: V1 half-up retained within rational ARCA tolerance; aggregate drift blocks before sending', () => {
  assert.equal(mapFiscalInvoice(invoice(['VAT_21'], '0.50'), issuer, 23, refs, now).vat, '0.11'); // half-even reference: 0.10, difference < 0.01
  assert.equal(
    mapFiscalInvoice(invoice(['VAT_21', 'VAT_21'], '0.02'), issuer, 23, refs, now).vat,
    '0.00',
  );
  assert.throws(
    () => mapFiscalInvoice(invoice(['VAT_21', 'VAT_21', 'VAT_21'], '0.02'), issuer, 23, refs, now),
    /redondeo/,
  );
  assert.throws(
    () =>
      mapFiscalInvoice(
        invoice(
          Array.from({ length: 10 }, () => 'VAT_10_5'),
          '0.05',
        ),
        issuer,
        23,
        refs,
        now,
      ),
    /redondeo/,
  );
});
test('WSFE dates: Buenos Aires, five-day window, month boundary and previous sequence date', () => {
  validateFiscalDate('2026-10-23', now);
  validateFiscalDate('2026-10-31', now);
  for (const date of ['2026-10-22', '2026-11-01'])
    assert.throws(() => validateFiscalDate(date, now));
  assert.throws(() => validateFiscalDate('2026-10-28', now, '20261029'), /último comprobante/);
});
const auth: WsfeAuth = {
  token: 'TEST_TOKEN_NOT_REAL',
  sign: 'TEST_SIGN_NOT_REAL',
  cuit: issuer.cuit,
};
const payload: WsfeInvoice = { ...mapFiscalInvoice(invoice(), issuer, 23, refs, now), number: 1 };

test('Local invoice requirements are complete even without ARCA references/POS', () => {
  const i = invoice();
  i.customerSnapshot = { ...(i.customerSnapshot as object), cuit: null };
  i.receiverVatConditionId = null;
  i.invoiceType = null;
  i.lines[0]!.unitPrice = null;
  const reasons = localFiscalReasons(i, { cuit: null, vatCondition: null }, now);
  for (const text of [
    'CUIT del cliente',
    'condición IVA del receptor',
    'tipo de comprobante',
    'CUIT del emisor',
    'importes',
  ])
    assert.ok(
      reasons.some((r) => r.includes(text)),
      text,
    );
  assert.deepEqual(localFiscalReasons(invoice(), issuer, now), []);
});
const soap = (method: string, result: string) =>
  `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${method}Response xmlns="${WSFE_NS}"><${method}Result>${result}</${method}Result></${method}Response></soap:Body></soap:Envelope>`;
const detail = (i = payload) =>
  `<Concepto>1</Concepto><DocTipo>80</DocTipo><DocNro>${i.docNumber}</DocNro><CbteDesde>${i.number}</CbteDesde><CbteHasta>${i.number}</CbteHasta><CbteFch>${i.issueDate}</CbteFch>`;
const authorized = (outcome = 'A') =>
  soap(
    'FECAESolicitar',
    `<FeCabResp><Cuit>${auth.cuit}</Cuit><PtoVta>23</PtoVta><CbteTipo>1</CbteTipo><CantReg>1</CantReg><Resultado>${outcome}</Resultado></FeCabResp><FeDetResp><FECAEDetResponse>${detail()}<Resultado>${outcome}</Resultado>${outcome === 'A' ? '<CAE>74123456789012</CAE><CAEFchVto>20261107</CAEFchVto>' : '<Observaciones><Obs><Code>10016</Code><Msg>Rechazo controlado</Msg></Obs></Observaciones>'}</FECAEDetResponse></FeDetResp>`,
  );
const response = (xml: string) =>
  new Response(xml, { headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
test('WSFE SOAP: one request, field order, auth escaping, strict CAE/rejection and no commercial details', async () => {
  const body = invoiceRequestXml(payload);
  assert.match(body, /<CantReg>1<\/CantReg>/);
  assert.match(body, /<ImpTotal>121.00<\/ImpTotal>/);
  assert.match(body, /<CondicionIVAReceptorId>1<\/CondicionIVAReceptorId>/);
  assert.doesNotMatch(body, /Producto|quantity|description/);
  assert.throws(() => invoiceRequestXml({ ...payload, number: null }));
  let xml = authorized();
  const client = new ArcaWsfeClient(async (url, init) => {
    assert.equal(url, WSFE_HOMOLOGATION_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('SOAPAction'), `"${WSFE_NS}FECAESolicitar"`);
    return response(xml);
  });
  assert.equal((await client.authorize(auth, payload)).cae, '74123456789012');
  xml = authorized('R');
  const rejected = await client.authorize(auth, payload);
  assert.equal(rejected.cae, null);
  assert.equal(rejected.observations[0]?.code, '10016');
  for (const bad of [
    authorized().replace('<CAE>74123456789012</CAE>', ''),
    authorized().replace('<PtoVta>23</PtoVta>', '<PtoVta>24</PtoVta>'),
    authorized().replace('<DocTipo>80</DocTipo>', '<DocTipo>80</DocTipo><DocTipo>80</DocTipo>'),
    '<broken>',
    `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///secret">]>${authorized()}`,
  ]) {
    xml = bad;
    await assert.rejects(client.authorize(auth, payload), WsfeError);
  }
});
test('WSFE SOAP consult: complete normalized comparison, 602 absence, malformed fields, no secret error reflection', async () => {
  const wire = invoiceRequestXml(payload)
    .split('<FECAEDetRequest>')[1]!
    .split('</FECAEDetRequest>')[0]!;
  let xml = soap(
    'FECompConsultar',
    `<ResultGet>${wire}<Resultado>A</Resultado><CodAutorizacion>74123456789012</CodAutorizacion><EmisionTipo>CAE</EmisionTipo><FchVto>20261107</FchVto><PtoVta>23</PtoVta><CbteTipo>1</CbteTipo></ResultGet>`,
  );
  const client = new ArcaWsfeClient(async () => response(xml));
  const found = await client.consult(auth, payload, 1);
  assert.ok(found);
  assert.equal(sameFiscalInvoice(payload, found.invoice), true);
  assert.equal(sameFiscalInvoice(payload, { ...found.invoice, docNumber: '27110247244' }), false);
  const valid = xml;
  xml = xml.replace('<ImpNeto>100.00</ImpNeto>', '');
  await assert.rejects(client.consult(auth, payload, 1), WsfeError);
  xml = soap(
    'FECompConsultar',
    '<Errors><Err><Code>602</Code><Msg>No existen datos</Msg></Err></Errors>',
  );
  assert.equal(await client.consult(auth, payload, 1), null);
  xml = soap(
    'FECompConsultar',
    `<Errors><Err><Code>600</Code><Msg>${auth.token} ${auth.sign}</Msg></Err></Errors>`,
  );
  await assert.rejects(
    client.consult(auth, payload, 1),
    (e) =>
      e instanceof WsfeError &&
      !JSON.stringify(e).includes(auth.token) &&
      !JSON.stringify(e).includes(auth.sign),
  );
  xml = valid.replace('<MonId>PES</MonId>', '<MonId>DOL</MonId>');
  assert.equal(
    sameFiscalInvoice(payload, (await client.consult(auth, payload, 1))!.invoice),
    false,
  );
  xml = valid
    .replace('<DocTipo>80</DocTipo>', '<DocTipo>99</DocTipo>')
    .replace('<DocNro>20123456786</DocNro>', '<DocNro>0</DocNro>')
    .replace(/<CondicionIVAReceptorId>.*?<\/CondicionIVAReceptorId>/, '');
  assert.equal(
    sameFiscalInvoice(payload, (await client.consult(auth, payload, 1))!.invoice),
    false,
  );
  xml = valid.replace('<MonCotiz>1</MonCotiz>', '<MonCotiz>1.000000</MonCotiz>');
  assert.equal(sameFiscalInvoice(payload, (await client.consult(auth, payload, 1))!.invoice), true);
  xml = valid.replace('<EmisionTipo>CAE</EmisionTipo>', '<EmisionTipo>CAEA</EmisionTipo>');
  await assert.rejects(
    client.consult(auth, payload, 1),
    (e) => e instanceof WsfeError && e.code === 'DIVERGENT_RECORD',
  );
});
test('WSFE bounded transport: network, HTTP, content type, invalid UTF-8, size and SOAP faults', async () => {
  for (const send of [
    async () => {
      throw new Error('TEST_TOKEN_NOT_REAL');
    },
    async () => new Response('TEST_TOKEN_NOT_REAL', { status: 500 }),
    async () => new Response('x'.repeat(1048577), { headers: { 'Content-Type': 'text/xml' } }),
    async () => new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'text/xml' } }),
    async () =>
      response(
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultstring>TEST_TOKEN_NOT_REAL</faultstring></soap:Fault></soap:Body></soap:Envelope>',
      ),
  ]) {
    await assert.rejects(
      new ArcaWsfeClient(send).authorize(auth, payload),
      (e) => e instanceof WsfeError && !JSON.stringify(e).includes(auth.token),
    );
  }
});

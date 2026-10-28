import { Parser } from 'saxen';
import { ArcaError, MAX_TICKET_MS } from './arca-errors.js';

export const WSAA_SERVICE = 'wsfe' as const;
export const WSAA_HOMOLOGATION_ENDPOINT = 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms';
export const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
export const WSAA_NS = 'http://wsaa.view.sua.dvadac.desein.afip.gov';
export interface AccessTicket {
  token: string;
  sign: string;
  obtainedAt: Date;
  expiresAt: Date;
}
export class TraFactory {
  private last = 0;
  create(now: Date) {
    // unsignedInt; a temporal, monotonic sequence even for concurrent calls in the same second.
    const uniqueId = Math.max(Math.floor(now.getTime() / 1000), this.last + 1);
    if (uniqueId < 1 || uniqueId > 0xffffffff) throw new ArcaError('CLOCK_ERROR');
    this.last = uniqueId;
    const xml = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${uniqueId}</uniqueId><generationTime>${new Date(now.getTime() - 120000).toISOString()}</generationTime><expirationTime>${new Date(now.getTime() + 600000).toISOString()}</expirationTime></header><service>${WSAA_SERVICE}</service></loginTicketRequest>`;
    return { uniqueId, xml };
  }
}
export const soapRequest = (cms: string) => {
  if (!/^[A-Za-z0-9+/=]+$/.test(cms)) throw new ArcaError('INVALID_RESPONSE');
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:ws="${WSAA_NS}"><soap:Body><ws:loginCms><ws:in0>${cms}</ws:in0></ws:loginCms></soap:Body></soap:Envelope>`;
};
type XmlNode = {
  name: string;
  ns: string;
  text: string;
  children: XmlNode[];
  attributes: Record<string, string>;
};
// Tiny bounded tree on the existing SAX parser. No DTD/entity resolution, recovery or arbitrary paths.
export function parseWsaaXml(
  xml: string,
  limits = { bytes: 262144, nodes: 100, depth: 12 },
): XmlNode {
  const invalid = (): never => {
    throw new ArcaError('INVALID_RESPONSE');
  };
  if (
    !xml ||
    Buffer.byteLength(xml) > limits.bytes ||
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) ||
    Array.from(xml).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
  )
    invalid();
  const stack: { node: XmlNode; rawName: string; namespaces: Record<string, string> }[] = [];
  let root: XmlNode | undefined,
    count = 0;
  const parser = new Parser();
  parser.on('error', invalid).on('warn', invalid).on('attention', invalid);
  const decodeStrict = (text: string, decode: (text: string) => string) => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-fA-F]+);)/.test(text)) invalid();
    return decode(text);
  };
  parser.on('openTag', (rawName, attrs, decode) => {
    if (++count > limits.nodes || stack.length >= limits.depth) invalid();
    const attributes = Object.fromEntries(
      Object.entries(attrs()).map(([k, v]) => [k, decodeStrict(v, decode)]),
    );
    const namespaces = { ...stack.at(-1)?.namespaces };
    for (const [key, value] of Object.entries(attributes)) {
      if (key === 'xmlns') namespaces[''] = value;
      else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value;
    }
    const parts = rawName.split(':');
    if (parts.length > 2 || (parts.length === 2 && !namespaces[parts[0]!])) invalid();
    const node: XmlNode = {
      name: parts.at(-1)!,
      ns: namespaces[parts.length === 2 ? parts[0]! : ''] ?? '',
      text: '',
      children: [],
      attributes,
    };
    if (stack.length) stack.at(-1)!.node.children.push(node);
    else if (root) invalid();
    else root = node;
    stack.push({ node, rawName, namespaces });
  });
  parser.on('closeTag', (name) => {
    if (stack.pop()?.rawName !== name) invalid();
  });
  parser.on('text', (text, decode) => {
    const value = decodeStrict(text, decode);
    if (stack.length) stack.at(-1)!.node.text += value;
    else if (value.trim()) invalid();
  });
  parser.on('cdata', (text) => {
    if (!stack.length) invalid();
    stack.at(-1)!.node.text += text;
  });
  try {
    if (parser.parse(xml) || stack.length || !root) invalid();
  } catch {
    invalid();
  }
  return root!;
}
function child(node: XmlNode, name: string, ns = node.ns) {
  const found = node.children.filter((c) => c.name === name && c.ns === ns);
  if (found.length !== 1 || node.text.trim()) throw new ArcaError('INVALID_RESPONSE');
  return found[0]!;
}
const value = (node: XmlNode, name: string) => {
  const n = child(node, name);
  if (n.children.length || !n.text.trim()) throw new ArcaError('INVALID_RESPONSE');
  return n.text.trim();
};
function fault(code: string): ArcaError {
  if (/coe\.notAuthorized/.test(code)) return new ArcaError('SERVICE_UNAUTHORIZED');
  if (/coe\.alreadyAuthenticated/.test(code)) return new ArcaError('ALREADY_AUTHENTICATED');
  if (/xml\.(generationTime|expirationTime)/.test(code)) return new ArcaError('CLOCK_ERROR');
  if (/cms\.cert\.expired/.test(code)) return new ArcaError('CERTIFICATE_EXPIRED');
  if (/cms\./.test(code)) return new ArcaError('CERTIFICATE_INVALID');
  return new ArcaError('WSAA_ERROR');
}
export function parseSoapTicket(
  soap: string,
  expected: { cuit: string; commonName: string },
  now: Date,
): AccessTicket {
  const envelope = parseWsaaXml(soap);
  if (envelope.name !== 'Envelope' || envelope.ns !== SOAP_NS)
    throw new ArcaError('INVALID_RESPONSE');
  const body = child(envelope, 'Body');
  if (body.children.length !== 1) throw new ArcaError('INVALID_RESPONSE');
  const response = body.children[0]!;
  if (response.name === 'Fault' && response.ns === SOAP_NS) {
    const faultCode = response.children.find((n) => n.name === 'faultcode');
    if (!faultCode || faultCode.children.length) throw new ArcaError('INVALID_RESPONSE');
    throw fault(faultCode.text);
  }
  if (
    response.name !== 'loginCmsResponse' ||
    response.ns !== WSAA_NS ||
    response.children.length !== 1
  )
    throw new ArcaError('INVALID_RESPONSE');
  const returned = response.children[0]!;
  if (
    returned.name !== 'loginCmsReturn' ||
    !['', WSAA_NS].includes(returned.ns) ||
    returned.children.length
  )
    throw new ArcaError('INVALID_RESPONSE');
  const ticket = parseWsaaXml(returned.text);
  if (
    ticket.name !== 'loginTicketResponse' ||
    ticket.ns !== '' ||
    ticket.children.length !== 2 ||
    (ticket.attributes.version && ticket.attributes.version !== '1.0')
  )
    throw new ArcaError('INVALID_RESPONSE');
  const header = child(ticket, 'header'),
    credentials = child(ticket, 'credentials');
  if (header.children.length !== 5 || credentials.children.length !== 2)
    throw new ArcaError('INVALID_RESPONSE');
  // RFC2253 representation is not ordered. Exact individual identity attributes are required.
  const dn = (s: string) =>
    new Map(
      s.split(/(?<!\\),\s*/).map((part) => {
        const at = part.indexOf('=');
        return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
      }),
    );
  const source = dn(value(header, 'source')),
    destination = dn(value(header, 'destination'));
  if (
    source.get('cn')?.toLowerCase() !== 'wsaahomo' ||
    source.get('serialnumber') !== 'CUIT 33693450239' ||
    source.get('c')?.toUpperCase() !== 'AR' ||
    destination.get('serialnumber') !== `CUIT ${expected.cuit}` ||
    destination.get('cn') !== expected.commonName
  )
    throw new ArcaError('INVALID_RESPONSE');
  if (
    !/^\d{1,10}$/.test(value(header, 'uniqueId')) ||
    Number(value(header, 'uniqueId')) > 0xffffffff
  )
    throw new ArcaError('INVALID_RESPONSE');
  const date = (name: string) => {
    const s = value(header, name);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(s))
      throw new ArcaError('INVALID_RESPONSE');
    return new Date(s);
  };
  const generation = date('generationTime'),
    expiration = date('expirationTime');
  if (
    !Number.isFinite(generation.getTime()) ||
    !Number.isFinite(expiration.getTime()) ||
    generation.getTime() > now.getTime() + 120000 ||
    generation.getTime() < now.getTime() - MAX_TICKET_MS ||
    expiration <= now ||
    expiration <= generation ||
    expiration.getTime() - generation.getTime() > MAX_TICKET_MS + 120000
  )
    throw new ArcaError('CLOCK_ERROR');
  return {
    token: value(credentials, 'token'),
    sign: value(credentials, 'sign'),
    obtainedAt: now,
    expiresAt: expiration,
  };
}

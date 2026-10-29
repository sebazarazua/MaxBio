import { ArcaError } from './arca-errors.js';
import {
  parseSoapTicket,
  soapRequest,
  WSAA_HOMOLOGATION_ENDPOINT,
  type AccessTicket,
} from './wsaa-xml.js';

export function homologationEndpoint(
  value = process.env.ARCA_WSAA_ENDPOINT ?? WSAA_HOMOLOGATION_ENDPOINT,
) {
  // Exact server-side allowlist. No redirect following, URL credentials, ports or production.
  if (value !== WSAA_HOMOLOGATION_ENDPOINT) throw new Error('Invalid ARCA homologation endpoint');
  return value;
}
export class ArcaWsaaClient {
  constructor(
    private readonly send: typeof fetch = fetch,
    private readonly timeoutMs = 12000,
  ) {}
  async login(
    cms: string,
    identity: { cuit: string; commonName: string },
    now: Date,
  ): Promise<AccessTicket> {
    try {
      const response = await this.send(homologationEndpoint(), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
        body: soapRequest(cms),
      });
      if (
        response.redirected ||
        !response.body ||
        !/^(?:text\/xml|application\/(?:soap\+)?xml)(?:;|$)/i.test(
          response.headers.get('content-type') ?? '',
        )
      )
        throw new ArcaError('INVALID_RESPONSE');
      const length = Number(response.headers.get('content-length'));
      if (length > 262144) {
        await response.body.cancel();
        throw new ArcaError('INVALID_RESPONSE');
      }
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 262144) {
            await reader.cancel();
            throw new ArcaError('INVALID_RESPONSE');
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      let xml: string;
      try {
        xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new ArcaError('INVALID_RESPONSE');
      }
      const ticket = parseSoapTicket(xml, identity, now);
      // A TA inside an unsuccessful HTTP response is not proof of a definitive rejection.
      if (!response.ok) throw new ArcaError('INVALID_RESPONSE');
      return ticket;
    } catch (e) {
      if (e instanceof ArcaError) throw e;
      throw new ArcaError('NETWORK_ERROR');
    }
  }
}

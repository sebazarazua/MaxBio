import { ArcaError, TICKET_MARGIN_MS, type ArcaClock, systemArcaClock } from './arca-errors.js';
import type { AccessTicket } from './wsaa-xml.js';
import type {
  PrivateTicketStorage,
  TicketScope,
} from '../infrastructure/private-ticket-storage.js';

// Server-only port for V3. Neither this type nor Token/Sign is a browser contract.
export class ArcaTicketProvider {
  private readonly tickets = new Map<string, AccessTicket>();
  private readonly flights = new Map<string, Promise<AccessTicket>>();
  constructor(
    private readonly clock: ArcaClock = systemArcaClock,
    private readonly storage?: PrivateTicketStorage,
  ) {}
  private key(org: string, credential: string, cuit = '') {
    return `${org}:HOMOLOGATION:wsfe:${credential}:${cuit}`;
  }
  peek(org: string, credential: string, cuit = '') {
    const key = this.key(org, credential, cuit),
      ticket = this.tickets.get(key);
    if (ticket && ticket.expiresAt <= this.clock.now()) {
      this.tickets.delete(key);
      return undefined;
    }
    return ticket;
  }
  async restore(scope: TicketScope) {
    const memory = this.peek(scope.organizationId, scope.credentialId, scope.cuit);
    if (memory) return memory;
    const ticket = await this.storage?.load(scope, this.clock.now());
    if (ticket) this.retain(this.key(scope.organizationId, scope.credentialId, scope.cuit), ticket);
    return ticket;
  }
  async persist(scope: TicketScope, ticket: AccessTicket) {
    if (ticket.expiresAt.getTime() - this.clock.now().getTime() <= TICKET_MARGIN_MS)
      throw new ArcaError('TICKET_TIME_INVALID');
    await this.storage?.save(scope, ticket);
  }
  async remove(org: string, credential: string) {
    this.invalidate(org);
    await this.storage?.remove(org, credential);
  }
  private retain(key: string, ticket: AccessTicket) {
    for (const [k, v] of this.tickets) if (v.expiresAt <= this.clock.now()) this.tickets.delete(k);
    if (this.tickets.size >= 1000 && !this.tickets.has(key)) throw new ArcaError('WAITING');
    this.tickets.set(key, ticket);
  }
  get(
    org: string,
    credential: string,
    acquire: () => Promise<AccessTicket>,
    scope?: TicketScope,
  ): Promise<AccessTicket> {
    if (scope && (scope.organizationId !== org || scope.credentialId !== credential))
      return Promise.reject(new ArcaError('CUIT_MISMATCH'));
    const key = this.key(org, credential, scope?.cuit),
      ticket = this.peek(org, credential, scope?.cuit);
    if (ticket && ticket.expiresAt.getTime() - this.clock.now().getTime() > TICKET_MARGIN_MS)
      return Promise.resolve(ticket);
    // WSAA forbids another TA while the preceding TA remains valid (spec 1.2.2).
    // Do not use a nearly expired ticket or hammer loginCms: refresh after real expiration.
    if (ticket) return Promise.reject(new ArcaError('EXPIRING_TICKET'));
    const pending = this.flights.get(key);
    if (pending) return pending;
    const promise = Promise.resolve()
      .then(async () => {
        const restored = scope ? await this.restore(scope) : undefined;
        if (restored) {
          if (restored.expiresAt.getTime() - this.clock.now().getTime() <= TICKET_MARGIN_MS)
            throw new ArcaError('EXPIRING_TICKET');
          return restored;
        }
        return acquire();
      })
      .then((result) => {
        if (result.expiresAt.getTime() - this.clock.now().getTime() <= TICKET_MARGIN_MS)
          throw new ArcaError('TICKET_TIME_INVALID');
        this.retain(key, result);
        return result;
      })
      .finally(() => {
        this.flights.delete(key);
      });
    this.flights.set(key, promise);
    return promise;
  }
  invalidate(org: string) {
    for (const key of this.tickets.keys()) if (key.startsWith(org + ':')) this.tickets.delete(key);
  }
}

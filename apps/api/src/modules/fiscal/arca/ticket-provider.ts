import { ArcaError, TICKET_MARGIN_MS, type ArcaClock, systemArcaClock } from './arca-errors.js';
import type { AccessTicket } from './wsaa-xml.js';

// Server-only port for V3. Neither this type nor Token/Sign is a browser contract.
export class ArcaTicketProvider {
  private readonly tickets = new Map<string, AccessTicket>();
  private readonly flights = new Map<string, Promise<AccessTicket>>();
  constructor(private readonly clock: ArcaClock = systemArcaClock) {}
  private key(org: string, credential: string) {
    return `${org}:HOMOLOGATION:wsfe:${credential}`;
  }
  peek(org: string, credential: string) {
    const key = this.key(org, credential),
      ticket = this.tickets.get(key);
    if (ticket && ticket.expiresAt <= this.clock.now()) {
      this.tickets.delete(key);
      return undefined;
    }
    return ticket;
  }
  get(
    org: string,
    credential: string,
    acquire: () => Promise<AccessTicket>,
  ): Promise<AccessTicket> {
    const key = this.key(org, credential),
      ticket = this.peek(org, credential);
    if (ticket && ticket.expiresAt.getTime() - this.clock.now().getTime() > TICKET_MARGIN_MS)
      return Promise.resolve(ticket);
    // WSAA forbids another TA while the preceding TA remains valid (spec 1.2.2).
    // Do not use a nearly expired ticket or hammer loginCms: refresh after real expiration.
    if (ticket) return Promise.reject(new ArcaError('EXPIRING_TICKET'));
    const pending = this.flights.get(key);
    if (pending) return pending;
    const promise = Promise.resolve()
      .then(acquire)
      .then((result) => {
        if (result.expiresAt.getTime() - this.clock.now().getTime() <= TICKET_MARGIN_MS)
          throw new ArcaError('TICKET_TIME_INVALID');
        // Bound retained secrets. Expired entries are also dropped on every acquisition.
        for (const [k, v] of this.tickets)
          if (v.expiresAt <= this.clock.now()) this.tickets.delete(k);
        if (this.tickets.size >= 1000) throw new ArcaError('WAITING');
        this.tickets.set(key, result);
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

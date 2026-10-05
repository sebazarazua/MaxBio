import { createHash } from 'node:crypto';
import { Injectable, HttpException } from '@nestjs/common';

@Injectable()
export class LoginLimiter {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  private inFlight = 0;

  enter(address: string, email: string): () => void {
    const now = Date.now();
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key);
    const keys = [
      ['ip:' + address, 30],
      ['email:' + createHash('sha256').update(email).digest('hex'), 10],
    ] as const;
    if (
      this.inFlight >= 4 ||
      this.attempts.size >= 10000 ||
      keys.some(([key, limit]) => (this.attempts.get(key)?.count ?? 0) >= limit)
    ) {
      throw new HttpException('Hubo muchos intentos. Esperá unos minutos y volvé a intentar.', 429);
    }
    for (const [key] of keys) {
      const entry = this.attempts.get(key) ?? { count: 0, until: now + 15 * 60 * 1000 };
      entry.count++;
      this.attempts.set(key, entry);
    }
    this.inFlight++;
    return () => {
      this.inFlight--;
    };
  }
}

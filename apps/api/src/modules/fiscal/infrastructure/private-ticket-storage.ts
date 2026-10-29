import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ArcaError, MAX_TICKET_MS } from '../arca/arca-errors.js';
import type { AccessTicket } from '../arca/wsaa-xml.js';
import {
  LocalPrivateCredentialStorage,
  type PrivateCredentialStorage,
} from './private-credential-storage.js';

// Server-only. Never export this through contracts or an API controller.
export interface TicketScope {
  organizationId: string;
  credentialId: string;
  cuit: string;
  privateKeyStorageKey: string;
}
export interface PrivateTicketStorage {
  load(scope: TicketScope, now: Date): Promise<AccessTicket | undefined>;
  save(scope: TicketScope, ticket: AccessTicket): Promise<void>;
  remove(org: string, credential: string): Promise<void>;
}
export const TICKET_STORAGE = Symbol('TICKET_STORAGE');
const scopeSchema = z
  .object({
    organizationId: z.uuidv4(),
    credentialId: z.uuidv4(),
    cuit: z.string().regex(/^\d{11}$/),
    privateKeyStorageKey: z.string(),
  })
  .strict();
const persisted = z
  .object({
    organizationId: z.uuidv4(),
    credentialId: z.uuidv4(),
    cuit: z.string().regex(/^\d{11}$/),
    service: z.literal('wsfe'),
    environment: z.literal('HOMOLOGATION'),
    obtainedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    token: z.string().min(1).max(65536),
    sign: z.string().min(1).max(8192),
  })
  .strict();
export class EncryptedPrivateTicketStorage implements PrivateTicketStorage {
  constructor(
    private readonly credentials: PrivateCredentialStorage,
    private readonly files = new LocalPrivateCredentialStorage(
      resolve(
        process.env.ARCA_CREDENTIAL_STORAGE_DIR ?? '.maxbio-private-credentials',
        'wsaa-tickets',
      ),
    ),
  ) {}
  private identity(scope: TicketScope) {
    scopeSchema.parse(scope);
    return {
      organizationId: scope.organizationId,
      credentialId: scope.credentialId,
      cuit: scope.cuit,
      service: 'wsfe' as const,
      environment: 'HOMOLOGATION' as const,
    };
  }
  private async key(scope: TicketScope) {
    const secret = await this.credentials.read(scope.organizationId, scope.privateKeyStorageKey);
    try {
      return Buffer.from(
        hkdfSync('sha256', secret, 'MaxBio/WSAA/TA/v1', JSON.stringify(this.identity(scope)), 32),
      );
    } finally {
      secret.fill(0);
    }
  }
  private file(scope: TicketScope) {
    return `${scope.organizationId}/${scope.credentialId}`;
  }
  async save(scope: TicketScope, ticket: AccessTicket) {
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      const identity = this.identity(scope);
      const data = persisted.parse({
        ...identity,
        ...ticket,
        obtainedAt: ticket.obtainedAt.toISOString(),
        expiresAt: ticket.expiresAt.toISOString(),
      });
      key = await this.key(scope);
      plain = Buffer.from(JSON.stringify(data));
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(identity)));
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      await this.files.replace(
        scope.organizationId,
        this.file(scope),
        Buffer.concat([Buffer.from('MBTA1'), nonce, cipher.getAuthTag(), ciphertext]),
      );
    } catch {
      throw new ArcaError('TICKET_STORAGE_UNAVAILABLE');
    } finally {
      key?.fill(0);
      plain?.fill(0);
    }
  }
  async load(scope: TicketScope, now: Date): Promise<AccessTicket | undefined> {
    const identity = this.identity(scope);
    let bytes: Buffer;
    try {
      bytes = await this.files.read(scope.organizationId, this.file(scope));
    } catch (e) {
      if (typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT')
        return undefined;
      throw new ArcaError('TICKET_STORAGE_UNAVAILABLE');
    }
    let key: Buffer | undefined, plain: Buffer | undefined;
    try {
      if (bytes.subarray(0, 5).toString() !== 'MBTA1' || bytes.length < 34) throw new Error();
      key = await this.key(scope);
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(5, 17));
      decipher.setAAD(Buffer.from(JSON.stringify(identity)));
      decipher.setAuthTag(bytes.subarray(17, 33));
      plain = Buffer.concat([decipher.update(bytes.subarray(33)), decipher.final()]);
      const data = persisted.parse(JSON.parse(plain.toString('utf8')));
      for (const k of ['organizationId', 'credentialId', 'cuit', 'service', 'environment'] as const)
        if (data[k] !== identity[k]) throw new Error();
      const obtainedAt = new Date(data.obtainedAt),
        expiresAt = new Date(data.expiresAt);
      if (
        obtainedAt.getTime() > now.getTime() + 120000 ||
        expiresAt <= obtainedAt ||
        expiresAt.getTime() - obtainedAt.getTime() > MAX_TICKET_MS + 120000 ||
        expiresAt <= now
      )
        throw new Error();
      return { token: data.token, sign: data.sign, obtainedAt, expiresAt };
    } catch {
      // Authentication failures, expiry and scope mismatch remove only this scoped TA.
      await this.remove(scope.organizationId, scope.credentialId);
      return undefined;
    } finally {
      key?.fill(0);
      plain?.fill(0);
      bytes.fill(0);
    }
  }
  async remove(org: string, credential: string) {
    try {
      await this.files.remove(org, `${org}/${credential}`);
    } catch {
      throw new ArcaError('TICKET_STORAGE_UNAVAILABLE');
    }
  }
}

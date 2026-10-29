import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPrivateCredentialStorage } from '../src/modules/fiscal/infrastructure/private-credential-storage.js';
import {
  EncryptedPrivateTicketStorage,
  type TicketScope,
} from '../src/modules/fiscal/infrastructure/private-ticket-storage.js';
import { ArcaTicketProvider } from '../src/modules/fiscal/arca/ticket-provider.js';
import { ArcaError } from '../src/modules/fiscal/arca/arca-errors.js';
import { ArcaWsfeProvider } from '../src/modules/fiscal/arca/wsfe-provider.js';
import type { ArcaWsfeClient } from '../src/modules/fiscal/arca/wsfe-client.js';
import type { FiscalService } from '../src/modules/fiscal/application/fiscal.service.js';
import type { RequestActorContext } from '../src/common/auth/request-context.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'maxbio-ticket-'));
  const keys = new LocalPrivateCredentialStorage(join(root, 'keys'));
  const files = new LocalPrivateCredentialStorage(join(root, 'tickets'));
  const scope: TicketScope = {
    organizationId: randomUUID(),
    credentialId: randomUUID(),
    cuit: '27110247244',
    privateKeyStorageKey: '',
  };
  scope.privateKeyStorageKey = await keys.put(scope.organizationId, randomBytes(128));
  const store = () => new EncryptedPrivateTicketStorage(keys, files);
  return {
    root,
    keys,
    files,
    scope,
    store,
    async close() {
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      assert.ok(root.includes('maxbio-ticket-'));
      await rm(root, { recursive: true, force: true });
    },
  };
}
const ticket = (at: Date) => ({
  token: 'FIXTURE_TOKEN_SECRET',
  sign: 'FIXTURE_SIGN_SECRET',
  obtainedAt: new Date(at),
  expiresAt: new Date(at.getTime() + 43200000),
});

test('TA encrypted at rest, survives provider/process recreation, and is reused for a WSFE call without loginCms', async () => {
  const f = await fixture();
  try {
    const at = new Date(),
      clock = { now: () => at };
    let logins = 0;
    const first = new ArcaTicketProvider(clock, f.store());
    const t = await first.get(
      f.scope.organizationId,
      f.scope.credentialId,
      async () => {
        logins++;
        const value = ticket(at);
        await first.persist(f.scope, value);
        return value;
      },
      f.scope,
    );
    const encrypted = await readFile(
      join(f.root, 'tickets', f.scope.organizationId, f.scope.credentialId),
    );
    assert.ok(
      !encrypted.includes(Buffer.from(t.token)) && !encrypted.includes(Buffer.from(t.sign)),
    );
    const restarted = new ArcaTicketProvider(clock, f.store());
    assert.equal(
      restarted.peek(f.scope.organizationId, f.scope.credentialId, f.scope.cuit),
      undefined,
    );
    const recovered = await restarted.get(
      f.scope.organizationId,
      f.scope.credentialId,
      async () => {
        logins++;
        throw new Error('loginCms must not run');
      },
      f.scope,
    );
    assert.equal(logins, 1);
    assert.equal(recovered.token === t.token && recovered.sign === t.sign, true);
    // A genuinely new Node process has no access to this provider's memory.
    const child = `
      import {LocalPrivateCredentialStorage} from ${JSON.stringify(new URL('../src/modules/fiscal/infrastructure/private-credential-storage.js', import.meta.url).href)};
      import {EncryptedPrivateTicketStorage} from ${JSON.stringify(new URL('../src/modules/fiscal/infrastructure/private-ticket-storage.js', import.meta.url).href)};
      import {ArcaTicketProvider} from ${JSON.stringify(new URL('../src/modules/fiscal/arca/ticket-provider.js', import.meta.url).href)};
      const {scope,keys,tickets,now}=JSON.parse(process.argv[1]);
      const store=new EncryptedPrivateTicketStorage(new LocalPrivateCredentialStorage(keys),new LocalPrivateCredentialStorage(tickets));
      const provider=new ArcaTicketProvider({now:()=>new Date(now)},store);
      const value=await provider.get(scope.organizationId,scope.credentialId,async()=>{throw new Error('Unexpected loginCms');},scope);
      process.stdout.write(JSON.stringify({recovered:Boolean(value),expiresAt:value.expiresAt.toISOString()}));
    `;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        child,
        JSON.stringify({
          scope: f.scope,
          keys: join(f.root, 'keys'),
          tickets: join(f.root, 'tickets'),
          now: at.toISOString(),
        }),
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    assert.deepEqual(JSON.parse(output), { recovered: true, expiresAt: t.expiresAt.toISOString() });
    const wsfe = new ArcaWsfeProvider(
      {
        authenticate: async () => ({
          ticket: await restarted.get(
            f.scope.organizationId,
            f.scope.credentialId,
            async () => {
              logins++;
              throw new Error('Must reuse TA');
            },
            f.scope,
          ),
          cuit: f.scope.cuit,
          credentialId: f.scope.credentialId,
        }),
      } as unknown as FiscalService,
      {
        last: async (auth: { token: string; sign: string }) =>
          auth.token === t.token && auth.sign === t.sign ? 7 : -1,
      } as unknown as ArcaWsfeClient,
    );
    assert.equal(
      await wsfe.last({ organizationId: f.scope.organizationId } as RequestActorContext, {
        issuerCuit: f.scope.cuit,
        pointOfSale: 23,
        documentType: 6,
      }),
      7,
    );
    assert.equal(logins, 1);
  } finally {
    await f.close();
  }
});

test('Expired TA is deleted, renewal is permitted, and the replacement survives another restart', async () => {
  const f = await fixture();
  try {
    let at = new Date();
    const clock = { now: () => at };
    await f.store().save(f.scope, ticket(at));
    at = new Date(at.getTime() + 43200001);
    const provider = new ArcaTicketProvider(clock, f.store());
    assert.equal(await provider.restore(f.scope), undefined);
    await assert.rejects(
      readFile(join(f.root, 'tickets', f.scope.organizationId, f.scope.credentialId)),
    );
    let calls = 0;
    await provider.get(
      f.scope.organizationId,
      f.scope.credentialId,
      async () => {
        calls++;
        const value = ticket(at);
        await provider.persist(f.scope, value);
        return value;
      },
      f.scope,
    );
    assert.equal(calls, 1);
    assert.ok(await new ArcaTicketProvider(clock, f.store()).restore(f.scope));
  } finally {
    await f.close();
  }
});

test('Credential/tenant/CUIT binding, tampering and near-expiry all fail closed; cleanup is idempotent', async () => {
  const f = await fixture();
  try {
    const at = new Date(),
      store = f.store();
    await store.save(f.scope, ticket(at));
    const bytes = await f.files.read(
      f.scope.organizationId,
      `${f.scope.organizationId}/${f.scope.credentialId}`,
    );
    const other = { ...f.scope, credentialId: randomUUID() };
    await f.files.replace(
      other.organizationId,
      `${other.organizationId}/${other.credentialId}`,
      bytes,
    );
    assert.equal(await store.load(other, at), undefined);
    assert.ok(await store.load(f.scope, at));
    assert.equal(await store.load({ ...f.scope, organizationId: randomUUID() }, at), undefined);
    assert.equal(await store.load({ ...f.scope, cuit: '20123456786' }, at), undefined);
    await store.save(f.scope, ticket(at));
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await f.files.replace(
      f.scope.organizationId,
      `${f.scope.organizationId}/${f.scope.credentialId}`,
      bytes,
    );
    assert.equal(await store.load(f.scope, at), undefined);
    await store.save(f.scope, ticket(at));
    const near = new Date(at.getTime() + 43200000 - 60000);
    await assert.rejects(
      new ArcaTicketProvider({ now: () => near }, store).get(
        f.scope.organizationId,
        f.scope.credentialId,
        async () => {
          throw new Error('Must not authenticate');
        },
        f.scope,
      ),
      (e) => e instanceof ArcaError && e.code === 'EXPIRING_TICKET',
    );
    await store.remove(f.scope.organizationId, f.scope.credentialId);
    await store.remove(f.scope.organizationId, f.scope.credentialId);
    assert.equal(await store.load(f.scope, at), undefined);
  } finally {
    await f.close();
  }
});

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createPublicKey } from 'node:crypto';
import { mkdtemp, readdir, rmdir, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import {
  fiscalProfileUpdateSchema,
  fiscalCompleteness,
  fiscalVatConditionSchema,
  cuitSchema,
  validCuit,
  formatFiscalCuit,
  arcaGenerateSchema,
  arcaCertificateSchema,
  fiscalRouteContract,
  arcaReadinessSchema,
} from '@maxbio/contracts';
import { LocalPrivateCredentialStorage } from '../src/modules/fiscal/infrastructure/private-credential-storage.js';
import { ArcaError, TICKET_MARGIN_MS } from '../src/modules/fiscal/arca/arca-errors.js';
import {
  TraFactory,
  parseSoapTicket,
  parseWsaaXml,
  WSAA_SERVICE,
  WSAA_HOMOLOGATION_ENDPOINT,
} from '../src/modules/fiscal/arca/wsaa-xml.js';
import { ArcaWsaaClient, homologationEndpoint } from '../src/modules/fiscal/arca/wsaa-client.js';
import { ArcaTicketProvider } from '../src/modules/fiscal/arca/ticket-provider.js';
import { HttpErrorFilter } from '../src/common/http/http-error.filter.js';
import type { ArgumentsHost } from '@nestjs/common';
import {
  crypto,
  ephemeralFiles,
  now,
  soap,
  soapFault,
  testCertificate,
  ticketXml,
} from './arca-fixtures.js';

export const profileInput = {
  legalName: 'Empresa Test',
  tradeName: null,
  cuit: '27-11024724-4',
  vatCondition: 'RESPONSABLE_INSCRIPTO',
  grossIncomeRegime: 'MULTILATERAL_AGREEMENT',
  grossIncomeNumber: '901-034461-6',
  addressLine: 'Bogotá 2314, piso 1, oficina 5',
  locality: 'CABA',
  province: 'CABA',
  postalCode: '1406',
  country: 'AR',
  nationalActivityCode: '477330',
  multilateralActivityCode: '464330',
  expectedVersion: 0,
};
test('Fiscal: CUIT Bourbon, checksum, canonicalization, formatting, enum and completeness', () => {
  assert.equal(cuitSchema.parse('27 - 11024724 - 4'), '27110247244');
  assert.equal(formatFiscalCuit('27110247244'), '27-11024724-4');
  for (const cuit of [
    '27110247245',
    '00000000000',
    '2711024724',
    '271102472444',
    'CUIT 27110247244',
  ])
    assert.equal(validCuit(cuit), false);
  const p = fiscalProfileUpdateSchema.parse(profileInput);
  assert.equal(fiscalCompleteness(p), 'COMPLETE');
  for (const key of [
    'cuit',
    'legalName',
    'vatCondition',
    'addressLine',
    'locality',
    'province',
    'postalCode',
    'country',
    'grossIncomeNumber',
  ] as const)
    assert.equal(fiscalCompleteness({ ...p, [key]: null }), 'INCOMPLETE');
  assert.equal(fiscalCompleteness(null), 'INCOMPLETE');
  assert.equal(fiscalVatConditionSchema.safeParse('Responsable inscripto').success, false);
  for (const key of [
    'organizationId',
    'privateKey',
    'token',
    'sign',
    'endpoint',
    'productionUrl',
    'rawSoap',
  ]) {
    assert.equal(
      fiscalProfileUpdateSchema.safeParse({ ...profileInput, [key]: 'secret' }).success,
      false,
    );
    assert.equal(
      arcaGenerateSchema.safeParse({
        operationId: randomUUID(),
        expectedVersion: 0,
        commonName: 'MaxBio Homologacion',
        [key]: 'secret',
      }).success,
      false,
    );
    assert.equal(
      arcaCertificateSchema.safeParse({
        expectedVersion: 1,
        certificateBase64: 'YWJj',
        [key]: 'secret',
      }).success,
      false,
    );
  }
  assert.equal(
    fiscalRouteContract('fiscal/arca/credentials/' + randomUUID() + '/private-key', 'GET'),
    null,
  );
  assert.equal(fiscalRouteContract('fiscal/arca/production', 'POST'), null);
});
test('Private storage: tenant scope, traversal, exclusive files, permissions, symlinks and removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maxbio-storage-test-')),
    org = randomUUID(),
    foreign = randomUUID();
  const s = new LocalPrivateCredentialStorage(root);
  try {
    const first = await s.put(org, Buffer.from('secret')),
      second = await s.put(org, Buffer.from('new'));
    assert.notEqual(first, second);
    assert.equal((await s.read(org, first)).toString(), 'secret');
    await assert.rejects(s.read(foreign, first));
    await assert.rejects(s.read(org, '../' + first));
    await assert.rejects(s.put('../bad', Buffer.from('secret')));
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(root, first))).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, org))).mode & 0o777, 0o700);
      const link = org + '/' + randomUUID();
      await symlink(join(root, first), join(root, link));
      await assert.rejects(s.read(org, link));
      await assert.rejects(s.remove(org, link));
      await unlink(join(root, link));
    }
    await s.remove(org, first);
    await s.remove(org, second);
    assert.deepEqual(await readdir(join(root, org)), []);
  } finally {
    await rmdir(join(root, org)).catch(() => {});
    await rmdir(root);
  }
});
test('CSR PKCS#10 and CMS: independent OpenSSL verifies RSA, subject, public key, signature and exact XML', async () => {
  const generated = await crypto.generate('Empresa Test', '27110247244', 'MaxBio Homologacion');
  try {
    await ephemeralFiles({ 'request.csr': generated.csr }, async (dir) => {
      const details = (
        await crypto.command([
          'req',
          '-in',
          join(dir, 'request.csr'),
          '-verify',
          '-noout',
          '-subject',
          '-text',
        ])
      ).toString();
      assert.match(details, /C\s*=\s*AR/);
      assert.match(details, /O\s*=\s*Empresa Test/);
      assert.match(details, /CN\s*=\s*MaxBio Homologacion/);
      assert.match(details, /serialNumber\s*=\s*CUIT 27110247244/);
      assert.match(details, /2048 bit/);
      const pub = await crypto.command([
        'req',
        '-in',
        join(dir, 'request.csr'),
        '-pubkey',
        '-noout',
      ]);
      assert.deepEqual(
        createPublicKey(pub).export({ type: 'spki', format: 'der' }),
        createPublicKey(generated.privateKey).export({ type: 'spki', format: 'der' }),
      );
    });
    const cert = await testCertificate(generated.privateKey);
    const checked = await crypto.certificate(
      cert,
      generated.privateKey,
      '27110247244',
      'MaxBio Homologacion',
      now,
    );
    assert.ok(checked.fingerprint);
    const xml = new TraFactory().create(now).xml,
      cms = await crypto.sign(xml, generated.privateKey, cert);
    await ephemeralFiles(
      { 'cms.der': Buffer.from(cms, 'base64'), 'cert.pem': cert },
      async (dir) => {
        const actual = await crypto.command([
          'cms',
          '-verify',
          '-binary',
          '-inform',
          'DER',
          '-in',
          join(dir, 'cms.der'),
          '-noverify',
          '-nointern',
          '-certfile',
          join(dir, 'cert.pem'),
        ]);
        assert.equal(actual.toString(), xml);
        const details = (
          await crypto.command([
            'cms',
            '-cmsout',
            '-print',
            '-inform',
            'DER',
            '-in',
            join(dir, 'cms.der'),
          ])
        ).toString();
        assert.match(details, /pkcs7-signedData/);
        assert.match(details, /sha1/);
      },
    );
    const other = await crypto.generate('Otra', '27110247244', 'MaxBio Homologacion');
    try {
      await assert.rejects(
        crypto.certificate(cert, other.privateKey, '27110247244', 'MaxBio Homologacion', now),
        (e) => e instanceof ArcaError && e.code === 'KEY_MISMATCH',
      );
    } finally {
      other.privateKey.fill(0);
    }
    await assert.rejects(
      crypto.certificate(cert, generated.privateKey, '20123456786', 'MaxBio Homologacion', now),
      /CUIT/,
    );
    await assert.rejects(
      crypto.certificate(
        cert,
        generated.privateKey,
        '27110247244',
        'MaxBio Homologacion',
        new Date(now.getTime() + 4 * 86400000),
      ),
      /vencido/,
    );
    await assert.rejects(
      crypto.certificate(
        Buffer.from('bad'),
        generated.privateKey,
        '27110247244',
        'MaxBio Homologacion',
        now,
      ),
    );
    await assert.rejects(
      crypto.certificate(
        Buffer.concat([cert, cert]),
        generated.privateKey,
        '27110247244',
        'MaxBio Homologacion',
        now,
      ),
    );
  } finally {
    generated.privateKey.fill(0);
  }
});
test('TRA service is wsfe, temporal uint32 uniqueness, UTC and skew', () => {
  const f = new TraFactory(),
    ids = new Set<number>();
  for (let i = 0; i < 20; i++) {
    const tra = f.create(now);
    ids.add(tra.uniqueId);
    assert.match(tra.xml, /<service>wsfe<\/service>/);
    assert.match(tra.xml, /<generationTime>[^<]+Z<\/generationTime>/);
    assert.equal(parseWsaaXml(tra.xml).name, 'loginTicketRequest');
  }
  assert.equal(ids.size, 20);
  assert.equal(WSAA_SERVICE, 'wsfe');
  assert.notEqual(WSAA_SERVICE as string, 'wsfev1');
});
test('SOAP/XML: identities, dates, namespace, duplicates, XXE, malformed, fault sanitization', () => {
  const id = { cuit: '27110247244', commonName: 'MaxBio Homologacion' };
  const parsed = parseSoapTicket(soap(ticketXml()), id, now);
  assert.equal(parsed.token, 'SECRET_TEST_TOKEN');
  for (const xml of [
    soap(ticketXml(now, '20123456786')),
    soap(ticketXml(new Date(now.getTime() - 86400000))),
    soap(ticketXml().replace('wsaahomo', 'wsaa')),
    soap(ticketXml().replace('<token>', '<token>x</token><token>')),
    soap(ticketXml().replace('</sign>', '')),
    '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x>&e;</x>',
    '<a/><b/>',
    '<a>&evil;</a>',
  ])
    assert.throws(() => parseSoapTicket(xml, id, now), ArcaError);
  for (const [code, expected] of [
    ['coe.notAuthorized', 'SERVICE_UNAUTHORIZED'],
    ['cms.cert.expired', 'CERTIFICATE_EXPIRED'],
    ['xml.generationTime.invalid', 'CLOCK_ERROR'],
    ['coe.alreadyAuthenticated', 'ALREADY_AUTHENTICATED'],
    ['wsaa.internalError', 'WSAA_ERROR'],
  ]) {
    assert.throws(
      () => parseSoapTicket(soapFault(code!), id, now),
      (e) => e instanceof ArcaError && e.code === expected && !e.message.includes('SECRET'),
    );
  }
  assert.throws(() => homologationEndpoint('https://wsaa.afip.gov.ar/ws/services/LoginCms'));
  assert.throws(() => homologationEndpoint('http://127.0.0.1/'));
});
test('WSAA bounded HTTP transport against mock server: success, fault, timeout, malformed, oversized, network', async () => {
  let mode = 'success';
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/xml; charset=utf-8');
    if (mode === 'timeout') return;
    if (mode === 'fault') {
      res.statusCode = 500;
      res.end(soapFault('coe.notAuthorized'));
    } else if (mode === 'oversize') res.end('x'.repeat(262145));
    else if (mode === 'malformed') res.end('<bad>');
    else res.end(soap(ticketXml()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const send: typeof fetch = (url, init) => {
    assert.equal(url, WSAA_HOMOLOGATION_ENDPOINT);
    assert.equal(init?.redirect, 'error');
    return fetch(`http://127.0.0.1:${addr.port}`, init);
  };
  const client = new ArcaWsaaClient(send, 60),
    id = { cuit: '27110247244', commonName: 'MaxBio Homologacion' };
  try {
    assert.equal((await client.login('YWJj', id, now)).sign, 'SECRET_TEST_SIGN');
    for (const next of ['fault', 'malformed', 'oversize', 'timeout']) {
      mode = next;
      await assert.rejects(client.login('YWJj', id, now), ArcaError);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assert.rejects(client.login('YWJj', id, now), /comunicarnos/);
});
test('Tickets: reuse, expiry, safe near-expiry renewal, 20 calls single flight, failure releases and tenant isolation', async () => {
  let at = new Date(now),
    calls = 0;
  const cache = new ArcaTicketProvider({ now: () => at });
  const acquire = async () => {
    calls++;
    return {
      token: 'secret',
      sign: 'secret',
      obtainedAt: at,
      expiresAt: new Date(at.getTime() + 43200000),
    };
  };
  await Promise.all(Array.from({ length: 20 }, () => cache.get('A', 'credential', acquire)));
  assert.equal(calls, 1);
  await cache.get('A', 'credential', acquire);
  assert.equal(calls, 1);
  at = new Date(now.getTime() + 43200000 - TICKET_MARGIN_MS + 1);
  await assert.rejects(cache.get('A', 'credential', acquire), /próximo/);
  assert.equal(calls, 1);
  at = new Date(now.getTime() + 43200001);
  await cache.get('A', 'credential', acquire);
  assert.equal(calls, 2);
  await cache.get('B', 'credential', acquire);
  assert.equal(calls, 3);
  await assert.rejects(
    cache.get('C', 'credential', async () => {
      throw new Error('test failure');
    }),
  );
  await cache.get('C', 'credential', acquire);
  assert.equal(calls, 4);
  assert.equal(arcaReadinessSchema.safeParse({ token: 'secret' }).success, false);
});

test('Secret leakage: logger and HTTP errors never include exception bodies, keys, Token or Sign', () => {
  const secret = '-----BEGIN PRIVATE KEY----- SECRET_TEST_TOKEN SECRET_TEST_SIGN';
  const filter = new HttpErrorFilter(),
    logs: unknown[] = [],
    responses: unknown[] = [];
  Object.assign(filter, { logger: { error: (v: unknown) => logs.push(v) } });
  const response = {
    locals: { requestId: randomUUID() },
    status: () => response,
    json: (v: unknown) => responses.push(v),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ path: '/api/v1/fiscal/arca/wsaa/test' }),
    }),
  } as unknown as ArgumentsHost;
  filter.catch(new Error(secret), host);
  assert.equal(logs.length, 1);
  assert.equal(responses.length, 1);
  assert.doesNotMatch(
    JSON.stringify({ logs, responses }),
    /PRIVATE KEY|SECRET_TEST_TOKEN|SECRET_TEST_SIGN/,
  );
});

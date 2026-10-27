import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { validateEnvironment } from '../src/config/environment.js';
import { ArcaError, arcaMessages } from '../src/modules/fiscal/arca/arca-errors.js';
import {
  OpenSslArcaCrypto,
  opensslFailure,
  type OpenSslRunner,
} from '../src/modules/fiscal/arca/openssl-crypto.js';

const run = promisify(execFile);
const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/maxbio' };
const environmentModule = new URL('../src/config/environment.js', import.meta.url).href;

// Same mechanism as `pnpm dev` / `pnpm start`: Node loads the file, the API validates process.env.
async function loadWithEnvFile(contents: string, extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'maxbio-env-test-'));
  const file = join(dir, '.env');
  await writeFile(file, contents);
  try {
    const script = `const { validateEnvironment } = await import(${JSON.stringify(environmentModule)});
const env = validateEnvironment(process.env);
console.log(JSON.stringify({ path: env.ARCA_OPENSSL_PATH ?? null, endpoint: env.ARCA_WSAA_ENDPOINT }));`;
    const { stdout } = await run(
      process.execPath,
      [`--env-file=${file}`, '--input-type=module', '-e', script],
      // Deterministic child: no inherited ARCA_* or DATABASE_URL from the developer machine.
      { env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '', ...extra } },
    );
    return JSON.parse(stdout) as { path: string | null; endpoint: string };
  } finally {
    await unlink(file).catch(() => {});
    await rmdir(dir).catch(() => {});
  }
}
const envFile = [
  '# local',
  'DATABASE_URL=postgresql://user:pass@localhost:5432/maxbio',
  'ARCA_OPENSSL_PATH=C:/Program Files/OpenSSL-Win64/bin/openssl.exe',
  '',
].join('\n');

test('Env: dev/start scripts load the root .env through Node; Nest never reads a file', async () => {
  const scripts = (
    JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  assert.match(scripts.dev!, /node --env-file=\.\.\/\.\.\/\.env --watch dist\/main\.js/);
  assert.match(scripts.start!, /node --env-file-if-exists=\.\.\/\.\.\/\.env dist\/main\.js/);
  // Unit tests stay deterministic: they never load a developer .env.
  assert.doesNotMatch(scripts.test!, /env-file/);
  const appModule = await readFile(new URL('../../src/app.module.ts', import.meta.url), 'utf8');
  assert.match(appModule, /ignoreEnvFile: true, validate: validateEnvironment/);
});

test('Env: .env values reach validateEnvironment, including a Windows path with spaces', async () => {
  const loaded = await loadWithEnvFile(envFile);
  assert.equal(loaded.path, 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe');
  assert.equal(loaded.endpoint, 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms');
});

test('Env: a real process variable overrides the .env value', async () => {
  const loaded = await loadWithEnvFile(envFile, { ARCA_OPENSSL_PATH: '/usr/bin/openssl' });
  assert.equal(loaded.path, '/usr/bin/openssl');
});

test('Env: ARCA_OPENSSL_PATH accepted, optional, non-empty; WSAA endpoint stays homologation-only', () => {
  assert.equal(
    validateEnvironment({
      ...base,
      ARCA_OPENSSL_PATH: 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe',
    }).ARCA_OPENSSL_PATH,
    'C:/Program Files/OpenSSL-Win64/bin/openssl.exe',
  );
  assert.equal(validateEnvironment(base).ARCA_OPENSSL_PATH, undefined);
  assert.throws(() => validateEnvironment({ ...base, ARCA_OPENSSL_PATH: '' }), /ARCA_OPENSSL_PATH/);
  for (const endpoint of [
    'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    'http://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    'https://127.0.0.1/LoginCms',
  ])
    assert.throws(
      () => validateEnvironment({ ...base, ARCA_WSAA_ENDPOINT: endpoint }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ARCA_WSAA_ENDPOINT/);
        assert.doesNotMatch(error.message, /user:pass|wsaa\.afip|127\.0\.0\.1/);
        return true;
      },
    );
});

function capture() {
  const logs: string[] = [];
  const original = { warn: Logger.prototype.warn, log: Logger.prototype.log };
  Logger.prototype.warn = function (message: unknown) {
    logs.push(String(message));
  };
  Logger.prototype.log = function (message: unknown) {
    logs.push(String(message));
  };
  return { logs, restore: () => Object.assign(Logger.prototype, original) };
}
async function withOpenSslPath<T>(value: string | undefined, fn: () => Promise<T>) {
  const prior = process.env.ARCA_OPENSSL_PATH;
  if (value === undefined) delete process.env.ARCA_OPENSSL_PATH;
  else process.env.ARCA_OPENSSL_PATH = value;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.ARCA_OPENSSL_PATH;
    else process.env.ARCA_OPENSSL_PATH = prior;
  }
}

test('OpenSSL: nonexistent ARCA_OPENSSL_PATH gives a controlled human error and NOT_EXECUTABLE', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxbio-openssl-missing-'));
  const { logs, restore } = capture();
  try {
    await withOpenSslPath(join(dir, 'missing-openssl.exe'), async () => {
      const crypto = new OpenSslArcaCrypto();
      assert.deepEqual(await crypto.availability(), {
        available: false,
        reason: 'NOT_EXECUTABLE',
      });
      await assert.rejects(
        crypto.generate('Biotecnología Test', '27110247244', 'MaxBio Homologacion'),
        (error: unknown) => {
          assert.ok(error instanceof ArcaError);
          assert.equal(error.code, 'OPENSSL_UNAVAILABLE');
          assert.equal(
            error.message,
            'OpenSSL no está disponible en el servidor. Revisá ARCA_OPENSSL_PATH.',
          );
          assert.doesNotMatch(error.message, /missing-openssl|maxbio-openssl-missing/);
          return true;
        },
      );
    });
  } finally {
    restore();
    await rmdir(dir).catch(() => {});
  }
  assert.ok(logs.some((l) => /OpenSSL req: no se pudo ejecutar \(ENOENT\)/.test(l)));
});

test('OpenSSL (mock runner): UTF-8 argv on Windows, configured path, fallback and readiness probe', async () => {
  const calls: { file: string; args: string[]; utf8?: string }[] = [];
  const runner: OpenSslRunner = async (file, args, options) => {
    calls.push({ file, args, utf8: options.env?.OPENSSL_WIN32_UTF8 });
    if (args[0] === 'version') return { stdout: Buffer.from('OpenSSL 4.1.0 23 Oct 2026\n') };
    if (args[1] === '-help') return { stdout: Buffer.alloc(0) };
    return { stdout: Buffer.from('-----BEGIN CERTIFICATE REQUEST-----\n') };
  };
  await withOpenSslPath('C:/Program Files/OpenSSL-Win64/bin/openssl.exe', async () => {
    const crypto = new OpenSslArcaCrypto(runner);
    assert.deepEqual(await crypto.availability(0), {
      available: true,
      version: 'OpenSSL 4.1.0 23 Oct 2026',
    });
    await crypto.availability(1000);
    assert.equal(calls.length, 4, 'cached within the TTL');
    assert.deepEqual(
      calls.map((c) => c.args.join(' ')),
      ['version', 'req -help', 'x509 -help', 'cms -help'],
    );
    const generated = await crypto.generate(
      'Compañía Ñandú S.A.',
      '27110247244',
      'MaxBio Homologacion',
    );
    assert.match(generated.csr.toString(), /BEGIN CERTIFICATE REQUEST/);
    const req = calls.at(-1)!;
    assert.equal(req.file, 'C:/Program Files/OpenSSL-Win64/bin/openssl.exe');
    assert.equal(req.utf8, '1');
    assert.ok(
      req.args.includes(
        '/C=AR/O=Compañía Ñandú S.A./CN=MaxBio Homologacion/serialNumber=CUIT 27110247244',
      ),
    );
  });
  await withOpenSslPath(undefined, async () => {
    calls.length = 0;
    await new OpenSslArcaCrypto(runner).command(['version']);
    assert.equal(calls[0]!.file, 'openssl');
  });
});

test('OpenSSL (mock runner): missing subcommand, failed command and no secret leakage', async () => {
  const secret = '-----BEGIN PRIVATE KEY----- SECRET_TEST_TOKEN postgresql://user:pass@host';
  const fail = (code: unknown) =>
    Object.assign(new Error(`Command failed: ${secret}`), { code, stderr: Buffer.from(secret) });
  const { logs, restore } = capture();
  try {
    const noCms = new OpenSslArcaCrypto(async (_file, args) => {
      if (args[0] === 'cms') throw fail(1);
      return { stdout: Buffer.from('OpenSSL 4.1.0\n') };
    });
    assert.deepEqual(await noCms.availability(), { available: false, reason: 'MISSING_COMMANDS' });
    const failing = new OpenSslArcaCrypto(async () => {
      throw fail(1);
    });
    assert.deepEqual(await failing.availability(), { available: false, reason: 'FAILED' });
    await assert.rejects(failing.command(['req', '-new', secret]), (error: unknown) => {
      assert.ok(error instanceof ArcaError);
      assert.equal(error.code, 'CRYPTO_UNAVAILABLE');
      assert.equal(error.message, arcaMessages.CRYPTO_UNAVAILABLE);
      return true;
    });
    const denied = new OpenSslArcaCrypto(async () => {
      throw fail('EACCES');
    });
    await assert.rejects(denied.command(['cms', secret]), { code: 'OPENSSL_UNAVAILABLE' });
  } finally {
    restore();
  }
  assert.deepEqual(logs, [
    'OpenSSL req: código de salida 1.',
    'OpenSSL cms: no se pudo ejecutar (EACCES).',
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE KEY|SECRET_TEST_TOKEN|user:pass/);
  assert.deepEqual(
    opensslFailure(Object.assign(new Error(), { killed: true, signal: 'SIGTERM' })),
    {
      launch: false,
      detail: 'tiempo de espera agotado',
    },
  );
  assert.equal(opensslFailure(null).launch, false);
});

// Opt-in: MAXBIO_OPENSSL_SMOKE=1 with ARCA_OPENSSL_PATH (or openssl in PATH) on the real machine.
test(
  'OpenSSL smoke (opt-in): real executable, req/x509/cms and accented CSR subject',
  { skip: process.env.MAXBIO_OPENSSL_SMOKE !== '1' },
  async () => {
    const crypto = new OpenSslArcaCrypto();
    const availability = await crypto.availability();
    assert.equal(availability.available, true, JSON.stringify(availability));
    const generated = await crypto.generate(
      'Biotecnología Compañía Ñandú S.A.',
      '27110247244',
      'MaxBio Homologacion',
    );
    const dir = await mkdtemp(join(tmpdir(), 'maxbio-openssl-smoke-'));
    const file = join(dir, 'request.csr');
    await writeFile(file, generated.csr);
    try {
      const subject = (
        await crypto.command([
          'req',
          '-in',
          file,
          '-verify',
          '-noout',
          '-subject',
          '-nameopt',
          'utf8',
        ])
      ).toString('utf8');
      assert.match(subject, /O=Biotecnología Compañía Ñandú S\.A\./);
      assert.match(subject, /serialNumber=CUIT 27110247244/);
    } finally {
      await unlink(file).catch(() => {});
      await rmdir(dir).catch(() => {});
    }
  },
);

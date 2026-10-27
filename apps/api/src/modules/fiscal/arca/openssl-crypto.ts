import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap } from '@nestjs/common';
import { execFile, type ExecFileOptionsWithBufferEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import {
  generateKeyPair,
  X509Certificate,
  createPrivateKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { chmod, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArcaError } from './arca-errors.js';

const run = promisify(execFile),
  keyPair = promisify(generateKeyPair);
export interface CmsSigner {
  sign(xml: string, key: Buffer, certificate: Buffer): Promise<string>;
}
export const CMS_SIGNER = Symbol('CMS_SIGNER');
export type CertificateMetadata = {
  pem: string;
  fingerprint: string;
  serial: string;
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
};

export type OpenSslRunner = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithBufferEncoding,
) => Promise<{ stdout: Buffer }>;
export const OPENSSL_RUNNER = Symbol('OPENSSL_RUNNER');
export type OpenSslAvailability =
  | { available: true; version: string }
  | { available: false; reason: 'NOT_EXECUTABLE' | 'FAILED' | 'MISSING_COMMANDS' };
export const REQUIRED_OPENSSL_COMMANDS = ['req', 'x509', 'cms'] as const;
// execFile reports launch failures with a string errno code; a finished process has a numeric exit code.
const LAUNCH_ERRORS = new Set([
  'ENOENT',
  'EACCES',
  'EPERM',
  'EISDIR',
  'ENOTDIR',
  'EINVAL',
  'UNKNOWN',
]);
const AVAILABILITY_TTL_MS = 30000;
export function opensslFailure(error: unknown) {
  const { code, killed, signal } = ((typeof error === 'object' && error) || {}) as {
    code?: unknown;
    killed?: boolean;
    signal?: unknown;
  };
  if (typeof code === 'string' && LAUNCH_ERRORS.has(code))
    return { launch: true, detail: `no se pudo ejecutar (${code})` };
  if (killed || signal) return { launch: false, detail: 'tiempo de espera agotado' };
  if (typeof code === 'number') return { launch: false, detail: `código de salida ${code}` };
  return { launch: false, detail: typeof code === 'string' ? code : 'error desconocido' };
}

// Temp files have fixed names, never client-controlled paths. No shell, inherited stdout or stderr.
@Injectable()
export class OpenSslArcaCrypto implements CmsSigner, OnApplicationBootstrap {
  private readonly logger = new Logger('ArcaOpenSSL');
  private probe?: { at: number; result: Promise<OpenSslAvailability> };
  constructor(@Optional() @Inject(OPENSSL_RUNNER) private readonly runner: OpenSslRunner = run) {}
  private get binary() {
    return process.env.ARCA_OPENSSL_PATH ?? 'openssl';
  }
  onApplicationBootstrap() {
    // Diagnostic only: the API keeps starting; ARCA actions report OPENSSL_UNAVAILABLE on use.
    if (process.env.NODE_ENV === 'test') return;
    const source =
      process.env.NODE_ENV === 'production'
        ? 'ARCA_OPENSSL_PATH o PATH'
        : process.env.ARCA_OPENSSL_PATH
          ? `ARCA_OPENSSL_PATH=${process.env.ARCA_OPENSSL_PATH}`
          : 'PATH del sistema (ARCA_OPENSSL_PATH sin configurar)';
    void this.availability().then((result) => {
      if (result.available)
        this.logger.log(`OpenSSL disponible para ARCA: ${result.version} (${source}).`);
      else
        this.logger.warn(
          `OpenSSL no disponible para ARCA (${result.reason}; ${source}). La generación de solicitudes fallará hasta corregir ARCA_OPENSSL_PATH.`,
        );
    });
  }
  /** Cached probe of the executable and the subcommands used by ARCA (req, x509, cms). */
  availability(now = Date.now()) {
    if (!this.probe || now - this.probe.at > AVAILABILITY_TTL_MS)
      this.probe = { at: now, result: this.diagnose() };
    return this.probe.result;
  }
  private async diagnose(): Promise<OpenSslAvailability> {
    let version: string;
    try {
      version = (await this.exec(['version'])).toString('utf8').trim().split(/\r?\n/)[0]!;
    } catch (e) {
      return { available: false, reason: opensslFailure(e).launch ? 'NOT_EXECUTABLE' : 'FAILED' };
    }
    const missing = await Promise.all(
      REQUIRED_OPENSSL_COMMANDS.map((command) =>
        this.exec([command, '-help']).then(
          () => false,
          () => true,
        ),
      ),
    );
    if (missing.some(Boolean)) return { available: false, reason: 'MISSING_COMMANDS' };
    return { available: true, version: version.slice(0, 120) };
  }
  private async exec(args: string[]) {
    const result = await this.runner(this.binary, args, {
      timeout: 15000,
      maxBuffer: 262144,
      encoding: 'buffer',
      windowsHide: true,
      // OpenSSL for Windows reads argv in the ANSI code page unless this is set; -utf8 subjects
      // with accented legal names (e.g. "Biotecnología") would otherwise fail. Ignored elsewhere.
      env: { ...process.env, OPENSSL_WIN32_UTF8: '1' },
    });
    return result.stdout;
  }
  private async files<T>(
    contents: Record<string, Buffer | string>,
    operation: (directory: string) => Promise<T>,
  ) {
    const directory = await mkdtemp(join(tmpdir(), 'maxbio-arca-'));
    const names = Object.keys(contents);
    try {
      if (process.platform !== 'win32') await chmod(directory, 0o700);
      for (const name of names)
        await writeFile(join(directory, name), contents[name]!, { mode: 0o600, flag: 'wx' });
      return await operation(directory);
    } finally {
      // No recursive deletion; only the fixed files created here and this new directory.
      for (const name of names) await unlink(join(directory, name)).catch(() => {});
      await rmdir(directory).catch(() => {});
    }
  }
  async command(args: string[]) {
    try {
      return await this.exec(args);
    } catch (e) {
      // Only the subcommand and failure kind: never stderr, arguments, keys or file contents.
      const failure = opensslFailure(e);
      this.logger.warn(`OpenSSL ${args[0]}: ${failure.detail}.`);
      if (failure.launch) {
        this.probe = undefined;
        throw new ArcaError('OPENSSL_UNAVAILABLE');
      }
      throw new ArcaError('CRYPTO_UNAVAILABLE');
    }
  }
  async generate(legalName: string, cuit: string, commonName: string) {
    const { privateKey } = await keyPair('rsa', {
      modulusLength: 2048,
      publicExponent: 0x10001,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const escape = (v: string) =>
      v.replace(/\\/g, '\\\\').replace(/\//g, '\\/').replace(/\+/g, '\\+');
    const subject = `/C=AR/O=${escape(legalName)}/CN=${escape(commonName)}/serialNumber=CUIT ${cuit}`;
    const csr = await this.files({ 'key.pem': privateKey }, (d) =>
      this.command([
        'req',
        '-new',
        '-utf8',
        '-sha256',
        '-key',
        join(d, 'key.pem'),
        '-subj',
        subject,
      ]),
    );
    return { privateKey: Buffer.from(privateKey), csr };
  }
  async certificate(
    bytes: Buffer,
    key: Buffer,
    cuit: string,
    commonName: string,
    now: Date,
  ): Promise<CertificateMetadata> {
    try {
      if (!bytes.length || bytes.length > 102400) throw new ArcaError('CERTIFICATE_INVALID');
      const text = bytes.toString('utf8');
      if (
        text.includes('-----') &&
        !/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
          text,
        )
      )
        throw new ArcaError('CERTIFICATE_INVALID');
      const cert = new X509Certificate(bytes);
      if (!text.includes('-----') && !cert.raw.equals(bytes))
        throw new ArcaError('CERTIFICATE_INVALID');
      const validFrom = new Date(cert.validFrom),
        validTo = new Date(cert.validTo);
      if (validTo <= now) throw new ArcaError('CERTIFICATE_EXPIRED');
      if (
        validFrom > now ||
        cert.ca ||
        cert.publicKey.asymmetricKeyType !== 'rsa' ||
        (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new ArcaError('CERTIFICATE_INVALID');
      const subject = cert.toLegacyObject().subject;
      if (subject.serialNumber !== `CUIT ${cuit}`) throw new ArcaError('CUIT_MISMATCH');
      if (subject.C !== 'AR' || subject.CN !== commonName)
        throw new ArcaError('CERTIFICATE_INVALID');
      if (/producci[oó]n|production/i.test(cert.issuer)) throw new ArcaError('PRODUCTION_BLOCKED');
      const challenge = randomBytes(32);
      if (
        !verify(
          'sha256',
          challenge,
          cert.publicKey,
          sign('sha256', challenge, createPrivateKey(key)),
        )
      )
        throw new ArcaError('KEY_MISMATCH');
      const details = (
        await this.files({ 'cert.pem': cert.toString() }, (d) =>
          this.command(['x509', '-in', join(d, 'cert.pem'), '-noout', '-text']),
        )
      ).toString('utf8');
      const usage = /X509v3 Key Usage:[^\r\n]*\r?\n\s*([^\r\n]+)/.exec(details)?.[1];
      if (usage && !usage.includes('Digital Signature')) throw new ArcaError('CERTIFICATE_INVALID');
      if (cert.subject.length > 2000 || cert.issuer.length > 2000 || cert.serialNumber.length > 128)
        throw new ArcaError('CERTIFICATE_INVALID');
      return {
        pem: cert.toString(),
        fingerprint: cert.fingerprint256,
        serial: cert.serialNumber,
        subject: cert.subject,
        issuer: cert.issuer,
        validFrom,
        validTo,
      };
    } catch (e) {
      if (e instanceof ArcaError) throw e;
      throw new ArcaError('CERTIFICATE_INVALID');
    }
  }
  async sign(xml: string, key: Buffer, certificate: Buffer) {
    return this.files(
      { 'key.pem': key, 'cert.pem': certificate, 'request.xml': xml },
      async (d) => {
        // SHA1+RSA is explicitly required by WSAA spec 1.2.2, not a general-purpose signing default.
        const der = await this.command([
          'cms',
          '-sign',
          '-binary',
          '-nodetach',
          '-md',
          'sha1',
          '-in',
          join(d, 'request.xml'),
          '-signer',
          join(d, 'cert.pem'),
          '-inkey',
          join(d, 'key.pem'),
          '-outform',
          'DER',
        ]);
        return der.toString('base64');
      },
    );
  }
}

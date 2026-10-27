import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
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

// Temp files have fixed names, never client-controlled paths. No shell, inherited stdout or stderr.
@Injectable()
export class OpenSslArcaCrypto implements CmsSigner {
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
      const result = await run(process.env.ARCA_OPENSSL_PATH ?? 'openssl', args, {
        timeout: 15000,
        maxBuffer: 262144,
        encoding: 'buffer',
        windowsHide: true,
      });
      return result.stdout;
    } catch {
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

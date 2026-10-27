import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenSslArcaCrypto } from '../src/modules/fiscal/arca/openssl-crypto.js';
// Test-only convenience for this Windows workstation, not a runtime fallback.
if (
  !process.env.ARCA_OPENSSL_PATH &&
  process.platform === 'win32' &&
  existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
)
  process.env.ARCA_OPENSSL_PATH = 'C:/Program Files/Git/usr/bin/openssl.exe';
export const crypto = new OpenSslArcaCrypto();
export async function ephemeralFiles<T>(
  files: Record<string, Buffer | string>,
  fn: (dir: string) => Promise<T>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'maxbio-arca-test-'));
  try {
    for (const [name, value] of Object.entries(files))
      await writeFile(join(dir, name), value, { mode: 0o600 });
    return await fn(dir);
  } finally {
    for (const name of Object.keys(files)) await unlink(join(dir, name)).catch(() => {});
    await rmdir(dir).catch(() => {});
  }
}
export async function testCertificate(
  key: Buffer,
  cuit = '27110247244',
  commonName = 'MaxBio Homologacion',
  extra: string[] = [],
) {
  return ephemeralFiles({ 'key.pem': key }, (dir) =>
    crypto.command([
      'req',
      '-new',
      '-x509',
      '-utf8',
      '-key',
      join(dir, 'key.pem'),
      '-days',
      '2',
      '-subj',
      `/C=AR/O=Empresa Test/CN=${commonName}/serialNumber=CUIT ${cuit}`,
      '-addext',
      'basicConstraints=critical,CA:FALSE',
      '-addext',
      'keyUsage=critical,digitalSignature',
      ...extra,
    ]),
  );
}
export const now = new Date(Date.now() + 10000);
export function ticketXml(at = now, cuit = '27110247244', cn = 'MaxBio Homologacion') {
  return `<loginTicketResponse version="1.0"><header><source>CN=wsaahomo, O=AFIP, C=AR, SERIALNUMBER=CUIT 33693450239</source><destination>SERIALNUMBER=CUIT ${cuit}, CN=${cn}, O=Empresa Test, C=AR</destination><uniqueId>42</uniqueId><generationTime>${at.toISOString()}</generationTime><expirationTime>${new Date(at.getTime() + 43200000).toISOString()}</expirationTime></header><credentials><token>SECRET_TEST_TOKEN</token><sign>SECRET_TEST_SIGN</sign></credentials></loginTicketResponse>`;
}
export function soap(xml: string) {
  return `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><loginCmsResponse xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov"><loginCmsReturn>${xml.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</loginCmsReturn></loginCmsResponse></s:Body></s:Envelope>`;
}
export const soapFault = (code: string) =>
  `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>${code}</faultcode><faultstring>DO_NOT_LEAK PRIVATE KEY SECRET_TEST_TOKEN</faultstring></s:Fault></s:Body></s:Envelope>`;

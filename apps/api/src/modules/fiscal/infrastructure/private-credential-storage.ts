import { Injectable } from '@nestjs/common';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PrivateCredentialStorage {
  put(organizationId: string, bytes: Uint8Array): Promise<string>;
  read(organizationId: string, key: string): Promise<Buffer>;
  remove(organizationId: string, key: string): Promise<void>;
}
export const CREDENTIAL_STORAGE = Symbol('CREDENTIAL_STORAGE');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
@Injectable()
export class LocalPrivateCredentialStorage implements PrivateCredentialStorage {
  private readonly root: string;
  constructor(root = process.env.ARCA_CREDENTIAL_STORAGE_DIR ?? '.maxbio-private-credentials') {
    this.root = resolve(root);
  }
  private path(org: string, key: string) {
    const parts = key.split('/');
    if (!uuid.test(org) || parts.length !== 2 || parts[0] !== org || !uuid.test(parts[1]!))
      throw new Error('Invalid credential reference');
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root + sep)) throw new Error('Invalid credential reference');
    return target;
  }
  private async directory(org: string, create: boolean) {
    if (!uuid.test(org)) throw new Error('Invalid credential scope');
    const directory = resolve(this.root, org);
    if (create) {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    for (const p of [this.root, directory]) {
      const stat = await lstat(p);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error('Invalid credential directory');
      if (process.platform !== 'win32') await chmod(p, 0o700);
    }
    const actualRoot = await realpath(this.root),
      actualDirectory = await realpath(directory);
    if (!actualDirectory.startsWith(actualRoot + sep))
      throw new Error('Invalid credential directory');
  }
  async put(org: string, bytes: Uint8Array) {
    const key = org + '/' + randomUUID(),
      target = this.path(org, key);
    await this.directory(org, true);
    const file = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(bytes);
    } catch {
      await unlink(target).catch(() => {});
      throw new Error('Credential storage unavailable');
    } finally {
      await file.close();
    }
    return key;
  }
  async read(org: string, key: string) {
    const target = this.path(org, key);
    await this.directory(org, false);
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 102400)
      throw new Error('Invalid credential file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error('Unsafe credential permissions');
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await file.readFile();
    } finally {
      await file.close();
    }
  }
  async remove(org: string, key: string) {
    const target = this.path(org, key);
    await this.directory(org, false);
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Invalid credential file');
    await unlink(target);
  }
}

import { Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface PrivatePrintStorage {
  put(organizationId: string, bytes: Uint8Array): Promise<string>;
  read(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}
export const PRINT_STORAGE = Symbol('PRINT_STORAGE');
@Injectable()
export class LocalPrivatePrintStorage implements PrivatePrintStorage {
  private readonly root = resolve(process.env.PRINT_STORAGE_DIR ?? '.maxbio-private-print');
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key)) throw new Error('Invalid private asset key');
    const target = resolve(this.root, key);
    if (!target.startsWith(this.root + sep)) throw new Error('Invalid private asset path');
    return target;
  }
  async put(organizationId: string, bytes: Uint8Array) {
    const key = organizationId + '/' + randomUUID(),
      target = this.path(key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    return key;
  }
  read(key: string) {
    return readFile(this.path(key));
  }
  async remove(key: string) {
    await unlink(this.path(key));
  }
}

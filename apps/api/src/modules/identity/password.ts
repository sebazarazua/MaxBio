import { randomBytes } from 'node:crypto';
import { argon2id, hash, verify, needsRehash } from 'argon2';

export const passwordOptions = {
  type: argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;
export const hashPassword = (password: string) => hash(password, passwordOptions);
// Mismo trabajo criptográfico para identidades inexistentes; nunca es una credencial utilizable.
let dummyHash: Promise<string> | undefined;
export async function verifyPassword(encoded: string | null, password: string) {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return verify(encoded ?? (await dummyHash), password);
}
export const passwordNeedsRehash = (encoded: string) => needsRehash(encoded, passwordOptions);

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSetCookie } from 'cookie';
import {
  hashPassword,
  verifyPassword,
  passwordNeedsRehash,
} from '../src/modules/identity/password.js';
import { LoginLimiter } from '../src/modules/identity/login-limiter.js';
import { sessionCookieName, setSessionCookie } from '../src/modules/identity/session-cookie.js';
import type { Response } from 'express';
import { tokenVerifier } from '../src/modules/identity/identity.service.js';

test('Argon2id autocontenido permite verificar y evolucionar parámetros', async () => {
  const encoded = await hashPassword('Una frase privada de prueba');
  assert.match(encoded, /^\$argon2id\$v=19\$/);
  const parameters = new Set(encoded.split('$')[3]!.split(','));
  assert.deepEqual(parameters, new Set(['m=65536', 't=3', 'p=1']));
  assert.equal(await verifyPassword(encoded, 'Una frase privada de prueba'), true);
  assert.equal(await verifyPassword(encoded, 'otra contraseña'), false);
  assert.equal(await verifyPassword(null, 'otra contraseña'), false);
  assert.equal(passwordNeedsRehash(encoded), false);
});

test('cookie de producción host-only, HttpOnly, Secure, SameSite y persistente', () => {
  let header = '';
  const response = {
    append: (_name: string, value: string) => {
      header = value;
    },
  } as unknown as Response;
  setSessionCookie(response, 'a'.repeat(43), new Date(Date.now() + 86400000), true);
  const cookie = parseSetCookie(header);
  assert.equal(cookie.name, '__Host-maxbio-session');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.sameSite, 'lax');
  assert.equal(cookie.path, '/');
  assert.equal(cookie.domain, undefined);
  assert.ok(cookie.maxAge && cookie.maxAge > 0);
  assert.equal(sessionCookieName(false), 'maxbio-session');
  assert.notEqual(tokenVerifier(cookie.value!), cookie.value);
  assert.equal(tokenVerifier(cookie.value!).length, 64);
});

test('limiter restringe cuenta, IP, concurrencia y libera trabajo en vuelo', () => {
  const limiter = new LoginLimiter();
  for (let i = 0; i < 10; i++) limiter.enter(`ip-${i}`, 'account@example.invalid')();
  assert.throws(() => limiter.enter('new-ip', 'account@example.invalid'), /muchos intentos/);
  const releases = Array.from({ length: 4 }, (_, i) =>
    limiter.enter(`other-${i}`, `user${i}@example.invalid`),
  );
  assert.throws(() => limiter.enter('other', 'other@example.invalid'), /muchos intentos/);
  releases.forEach((release) => release());
  limiter.enter('other', 'other@example.invalid')();
});

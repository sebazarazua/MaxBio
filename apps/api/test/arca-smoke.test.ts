import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arcaReadinessSchema } from '@maxbio/contracts';
test('WSAA REAL homologación (opt-in, requiere certificado y sesión ADMIN)', async (t) => {
  if (process.env.MAXBIO_ARCA_HOMO_SMOKE !== '1') {
    t.skip('No solicitado: MAXBIO_ARCA_HOMO_SMOKE=1 no está habilitado.');
    return;
  }
  const cookie = process.env.MAXBIO_ARCA_HOMO_SMOKE_COOKIE;
  if (!cookie) {
    t.skip('Sin sesión ADMIN ni certificado real configurado para este smoke.');
    return;
  }
  const base = new URL(process.env.MAXBIO_ARCA_HOMO_SMOKE_API_BASE ?? 'http://127.0.0.1:3001');
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(base.hostname),
    'Solo API local explícita para este smoke',
  );
  const r = await fetch(new URL('/api/v1/fiscal/arca/readiness', base), {
    headers: { Cookie: cookie },
    redirect: 'error',
  });
  assert.equal(r.status, 200, 'Se requiere una sesión ADMIN vigente');
  const readiness = arcaReadinessSchema.parse(await r.json());
  assert.equal(readiness.environment, 'HOMOLOGATION');
  if (!readiness.canTest) {
    t.skip('Faltan perfil/certificado de homologación activo o hay un ticket/reserva vigente.');
    return;
  }
  const result = await fetch(new URL('/api/v1/fiscal/arca/wsaa/test', base), {
    method: 'POST',
    redirect: 'error',
    headers: {
      Cookie: cookie,
      Origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(
    result.status,
    200,
    'ARCA no confirmó la autenticación; revisar Configuración sin volcar respuestas',
  );
  assert.equal(arcaReadinessSchema.parse(await result.json()).access.status, 'AUTHENTICATED');
});

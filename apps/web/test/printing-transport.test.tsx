import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { proxyPrinting } from '../src/lib/server/printing-transport.js';

const previousBase = process.env.API_BASE_URL,
  previousOrigin = process.env.WEB_ORIGIN;
process.env.API_BASE_URL = 'http://internal.invalid:3001';
process.env.WEB_ORIGIN = 'http://localhost:3000';
after(() => {
  if (previousBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = previousBase;
  if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
  else process.env.WEB_ORIGIN = previousOrigin;
});
const noteId = randomUUID(),
  templateId = randomUUID(),
  artifactId = randomUUID();
const input = {
  templateRevisionId: templateId,
  expectedVersion: 1,
  calibrationId: null,
  guides: false,
};
function post(body: unknown = input, extra: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/printing/delivery-notes/' + noteId + '/preview', {
    method: 'POST',
    headers: {
      Origin: 'http://localhost:3000',
      'X-Maxbio-Csrf': '1',
      'Content-Type': 'application/json',
      Cookie: 'unrelated=secret; maxbio-session=opaque; preferences=dark',
      ...extra,
    },
    body: JSON.stringify(body),
  });
}
const pdf = Uint8Array.from(Buffer.from('%PDF-1.7\nsynthetic transport fixture'));
test('BFF PDF: transporte binario, firma/MIME, no-store, cookies limitadas y cero JSON parsing', async () => {
  const response = await proxyPrinting(
    post(),
    ['delivery-notes', noteId, 'preview'],
    async (url, init) => {
      assert.equal(
        String(url),
        'http://internal.invalid:3001/api/v1/printing/delivery-notes/' + noteId + '/preview',
      );
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('Cookie'), 'maxbio-session=opaque');
      assert.equal(new Headers(init?.headers).get('X-Maxbio-Csrf'), '1');
      const upstream = new Response(pdf, {
        headers: {
          'Content-Type': 'application/pdf',
          'Set-Cookie': 'maxbio-session=rotated; HttpOnly',
        },
      });
      Object.defineProperty(upstream, 'json', {
        value: async () => {
          throw new Error('PDF must never be parsed as JSON');
        },
      });
      return upstream;
    },
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.match(response.headers.get('cache-control')!, /private, no-store/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('set-cookie')!, /rotated/);
  assert.equal(response.headers.get('content-disposition'), 'inline; filename="maxbio.pdf"');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});
test('BFF PDF: GET de artifact usa el mismo transporte privado', async () => {
  const request = new Request(
    'http://localhost:3000/api/printing/artifacts/' + artifactId + '/pdf',
  );
  const response = await proxyPrinting(
    request,
    ['artifacts', artifactId, 'pdf'],
    async () => new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});
test('BFF PDF: CSRF, origen, rutas, query y cuerpos strict se rechazan antes del upstream', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response();
  };
  for (const [request, path, status] of [
    [post(input, { 'X-Maxbio-Csrf': '' }), ['delivery-notes', noteId, 'preview'], 403],
    [
      post(input, { Origin: 'https://foreign.invalid' }),
      ['delivery-notes', noteId, 'preview'],
      403,
    ],
    [post({ ...input, zoom: 2 }), ['delivery-notes', noteId, 'preview'], 400],
    [new Request('http://localhost:3000/api/printing/config?q=private'), ['config'], 400],
    [post(), ['arbitrary', 'path'], 404],
  ] as const)
    assert.equal((await proxyPrinting(request, [...path], fetcher)).status, status);
  assert.equal(calls, 0);
});
test('BFF PDF: MIME o firma incompatibles fallan sin devolver contenido arbitrario', async () => {
  for (const response of [
    new Response('{"not":"pdf"}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('<html>not a PDF</html>', { headers: { 'Content-Type': 'application/pdf' } }),
  ]) {
    const r = await proxyPrinting(
      post(),
      ['delivery-notes', noteId, 'preview'],
      async () => response,
    );
    assert.equal(r.status, 503);
    assert.match(r.headers.get('content-type')!, /application\/json/);
  }
});
test('BFF PDF: errores API tipados preservan status; no se convierten en PDF exitoso', async () => {
  const r = await proxyPrinting(post(), ['delivery-notes', noteId, 'preview'], async () =>
    Response.json(
      {
        statusCode: 409,
        code: 'CONFLICT',
        message: 'El remito cambió.',
        requestId: randomUUID(),
        timestamp: new Date().toISOString(),
        path: '/api/v1/printing',
      },
      { status: 409 },
    ),
  );
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { message: string }).message, 'El remito cambió.');
});

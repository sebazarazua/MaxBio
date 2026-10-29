import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { afterEach, mock, test } from 'node:test';
import { act, createElement, type ReactNode } from 'react';
import { JSDOM } from 'jsdom';
import { arcaReadinessSchema, type ArcaReadiness } from '@maxbio/contracts';
registerHooks({
  resolve: (specifier, context, next) =>
    next(
      ['next/link', 'next/navigation'].includes(specifier) ? specifier + '.js' : specifier,
      context,
    ),
});
mock.module('server-only', { namedExports: {} });
mock.module('next/link', {
  defaultExport: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement('a', { href }, children),
});
mock.module('next/navigation', {
  namedExports: {
    useRouter: () => ({ replace() {}, push() {} }),
    usePathname: () => '/configuracion',
  },
});
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:3000/configuracion',
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  FormData: dom.window.FormData,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import('react-dom/client');
const { FiscalSettingsView, ArcaConnection } = await import('../src/components/fiscal/settings.js');
const { proxyFiscal } = await import('../src/lib/server/fiscal-proxy.js');
const { WsfeSettings } = await import('../src/components/fiscal/invoicing-settings.js');
const id = '00000000-0000-4000-8000-000000000001';
function readiness(extra: Partial<ArcaReadiness> = {}): ArcaReadiness {
  return arcaReadinessSchema.parse({
    environment: 'HOMOLOGATION',
    service: 'wsfe',
    version: 0,
    fiscalProfile: 'INCOMPLETE',
    cuitValid: false,
    cuit: null,
    lastVerifiedAt: null,
    openssl: 'AVAILABLE',
    privateKey: false,
    csr: false,
    certificateInstalled: false,
    certificateMatchesKey: false,
    canTest: false,
    activeCredentialId: null,
    pendingCredentialId: null,
    credentials: [],
    access: {
      status: 'PENDING',
      obtainedAt: null,
      expiresAt: null,
      retryAfter: null,
      message: null,
      lastResultCode: null,
      lastAttemptAt: null,
      lastError: null,
      testBlockedReason: null,
    },
    trust: 'PENDING_WSAA',
    wsfeImplemented: false,
    productionEnabled: false,
    ...extra,
  });
}
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
});
async function mount(element: ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    root,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const button = (host: HTMLElement, text: string) => {
  const b = [...host.querySelectorAll('button')].find((b) => b.textContent === text);
  assert.ok(b, text);
  return b;
};
const credential = (
  extra: Partial<ArcaReadiness['credentials'][number]> = {},
): ArcaReadiness['credentials'][number] => ({
  id,
  commonName: 'MaxBio Homologacion',
  status: 'ACTIVE',
  version: 3,
  createdAt: '2026-10-27T20:36:36.542Z',
  replacedAt: null,
  discardedAt: null,
  secretsDeletedAt: null,
  fingerprint: 'PUBLIC_FINGERPRINT',
  serial: '123',
  subject: 'CN=Test',
  issuer: 'CN=Computadores Test\nO=AFIP\nC=AR',
  validFrom: '2026-10-28T16:03:37.000Z',
  validTo: '2028-10-27T16:03:37.000Z',
  certificateState: 'VALID',
  ...extra,
});

test('ARCA overview shows active connection and 2028 expiry; pending/history and advanced actions stay collapsed', async () => {
  const pendingId = '00000000-0000-4000-8000-000000000002';
  const a = readiness({
    cuit: '27110247244',
    cuitValid: true,
    fiscalProfile: 'COMPLETE',
    certificateMatchesKey: true,
    activeCredentialId: id,
    pendingCredentialId: pendingId,
    lastVerifiedAt: '2026-10-28T18:29:47.130Z',
    credentials: [
      credential({ id: pendingId, status: 'CSR_READY', commonName: 'New request' }),
      credential(),
      credential({
        id: '00000000-0000-4000-8000-000000000003',
        status: 'REPLACED',
        commonName: 'Old request',
        secretsDeletedAt: '2026-10-28T19:00:00.000Z',
      }),
    ],
  });
  const ui = await mount(<ArcaConnection arca={a} changed={() => {}} />);
  try {
    const overview = ui.host.querySelector('.arca-overview')!;
    assert.match(overview.textContent!, /Credencial ARCA verificada/);
    assert.match(overview.textContent!, /27-11024724-4/);
    assert.match(overview.textContent!, /27\/10\/2028/);
    assert.match(overview.textContent!, /Última verificación exitosa/);
    assert.doesNotMatch(
      overview.textContent!,
      /New request|Old request|CSR_READY|REPLACED|00000000/,
    );
    for (const details of ui.host.querySelectorAll('details')) assert.equal(details.open, false);
    assert.match(
      ui.host.querySelector('[aria-labelledby=arca-active-title]')!.textContent!,
      /Computadores Test.*AFIP/,
    );
    assert.equal(ui.host.querySelectorAll('input[type=file]').length, 1);
  } finally {
    await ui.close();
  }
});

test('Discard UI requires explicit confirmation, uses pending id/version and preserves active overview', async () => {
  const pendingId = '00000000-0000-4000-8000-000000000002';
  const a = readiness({
    activeCredentialId: id,
    pendingCredentialId: pendingId,
    credentials: [credential(), credential({ id: pendingId, status: 'CSR_READY', version: 1 })],
  });
  const requests: { path: string; body: unknown }[] = [];
  let next: ArcaReadiness | undefined;
  globalThis.fetch = async (url, init) => {
    requests.push({ path: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({
      ...a,
      pendingCredentialId: null,
      credentials: [
        credential(),
        credential({
          id: pendingId,
          status: 'DISCARDED',
          discardedAt: '2026-10-28T19:00:00.000Z',
          secretsDeletedAt: '2026-10-28T19:00:00.000Z',
        }),
      ],
    });
  };
  const ui = await mount(
    <ArcaConnection
      arca={a}
      changed={(value) => {
        next = value;
      }}
    />,
  );
  try {
    await act(async () => button(ui.host, 'Descartar solicitud').click());
    assert.equal(requests.length, 0);
    assert.match(ui.host.textContent!, /La credencial activa se conserva/);
    await act(async () => button(ui.host, 'Conservar solicitud').click());
    assert.equal(requests.length, 0);
    await act(async () => button(ui.host, 'Descartar solicitud').click());
    await act(async () => {
      button(ui.host, 'Confirmar descarte').click();
      button(ui.host, 'Confirmar descarte').click();
    });
    assert.deepEqual(requests, [
      { path: `/api/fiscal/arca/credentials/${pendingId}/discard`, body: { expectedVersion: 1 } },
    ]);
    assert.equal(next?.activeCredentialId, id);
    assert.equal(next?.pendingCredentialId, null);
    assert.match(ui.host.textContent!, /Solicitud descartada/);
  } finally {
    await ui.close();
  }
});

test('Discard BFF enforces CSRF, tenant-free strict body and safe response contract', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(String(url), `http://127.0.0.1:3001/api/v1/fiscal/arca/credentials/${id}/discard`);
    return Response.json(readiness());
  };
  const post = (body: unknown, csrf = true) =>
    proxyFiscal(
      new Request(`http://localhost:3000/api/fiscal/arca/credentials/${id}/discard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { Origin: 'http://localhost:3000', 'X-Maxbio-Csrf': '1' } : {}),
        },
        body: JSON.stringify(body),
      }),
      ['arca', 'credentials', id, 'discard'],
    );
  assert.equal((await post({ expectedVersion: 1 }, false)).status, 403);
  assert.equal((await post({ expectedVersion: 1, organizationId: id })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post({ expectedVersion: 1 })).status, 200);
  assert.equal(calls, 1);
});
test('Fiscal settings: operator has no configuration requests or credential controls', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error();
  };
  const ui = await mount(<FiscalSettingsView isAdmin={false} />);
  try {
    assert.match(ui.host.textContent!, /requieren un administrador/);
    assert.equal(calls, 0);
    assert.equal(ui.host.querySelectorAll('input').length, 0);
  } finally {
    await ui.close();
  }
});
test('Fiscal profile UI: empty fields, CUIT validation and canonical server save', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requests.push({ path: String(url), body });
      return Response.json({ profile: null });
    }
    return Response.json(String(url).endsWith('/profile') ? { profile: null } : readiness());
  };
  const ui = await mount(<FiscalSettingsView isAdmin />);
  try {
    const cuit = ui.host.querySelector<HTMLInputElement>('[name=cuit]')!;
    assert.equal(cuit.value, '');
    cuit.value = '27110247245';
    await act(async () =>
      ui.host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.match(ui.host.textContent!, /dígito verificador/);
    assert.equal(requests.length, 0);
    assert.equal(document.activeElement, cuit);
    cuit.value = '27-11024724-4';
    await act(async () =>
      ui.host
        .querySelector('form')!
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })),
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.body.cuit, '27110247244');
    assert.equal(requests[0]!.body.expectedVersion, 0);
    assert.ok(!('organizationId' in requests[0]!.body));
  } finally {
    await ui.close();
  }
});
test('ARCA UI: generate once, pending request, certificate activation, expiry, errors and no fiscal authorization', async () => {
  let a = readiness({ fiscalProfile: 'COMPLETE', cuitValid: true }),
    sent = 0;
  const pending = {
    id,
    commonName: 'MaxBio Homologacion',
    status: 'CSR_READY' as const,
    version: 1,
    createdAt: '2026-10-27T10:00:00.000Z',
    replacedAt: null,
    discardedAt: null,
    secretsDeletedAt: null,
    fingerprint: null,
    serial: null,
    subject: null,
    issuer: null,
    validFrom: null,
    validTo: null,
    certificateState: 'MISSING' as const,
  };
  globalThis.fetch = async () => {
    sent++;
    return Response.json({
      ...a,
      version: 2,
      pendingCredentialId: id,
      credentials: [pending],
      privateKey: true,
      csr: true,
    });
  };
  const ui = await mount(
    <ArcaConnection
      arca={a}
      changed={(next) => {
        a = next;
      }}
    />,
  );
  try {
    await act(async () => {
      button(ui.host, 'Generar solicitud').click();
      button(ui.host, 'Generar solicitud').click();
    });
    assert.equal(sent, 1);
    await act(async () =>
      ui.root.render(
        <ArcaConnection
          arca={a}
          changed={(next) => {
            a = next;
          }}
        />,
      ),
    );
    assert.match(ui.host.textContent!, /Solicitud creada/);
    assert.ok(button(ui.host, 'Descargar CSR'));
    assert.ok(ui.host.querySelector('input[type=file]'));
    const installed = {
      ...pending,
      status: 'CERTIFICATE_INSTALLED' as const,
      version: 2,
      certificateState: 'VALID' as const,
      validFrom: '2026-10-27T10:00:00.000Z',
      validTo: '2027-10-27T10:00:00.000Z',
    };
    a = readiness({ ...a, certificateInstalled: true, credentials: [installed] });
    await act(async () =>
      ui.root.render(
        <ArcaConnection
          arca={a}
          changed={(next) => {
            a = next;
          }}
        />,
      ),
    );
    assert.ok(button(ui.host, 'Activar credencial de homologación'));
    a = readiness({
      ...a,
      pendingCredentialId: null,
      activeCredentialId: id,
      credentials: [{ ...installed, status: 'ACTIVE', certificateState: 'EXPIRED' }],
      canTest: false,
    });
    await act(async () => ui.root.render(<ArcaConnection arca={a} changed={() => {}} />));
    assert.equal(button(ui.host, 'Probar conexión con ARCA').disabled, true);
    assert.match(ui.host.textContent!, /vencido/);
    assert.doesNotMatch(ui.host.textContent!, /SECRET|BEGIN PRIVATE|FECAESolicitar/);
    assert.equal(
      [...ui.host.querySelectorAll('button')].some((b) => b.textContent === 'Autorizar'),
      false,
    );
  } finally {
    await ui.close();
  }
});
test('Fiscal BFF: route allowlist, CSRF/Origin, bounded JSON, strict responses, cookies and no endpoint override', async () => {
  process.env.API_BASE_URL = 'http://127.0.0.1:3001';
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'http://127.0.0.1:3001/api/v1/fiscal/arca/readiness');
    assert.equal(new Headers(init?.headers).get('cookie'), 'maxbio-session=test');
    return Response.json(readiness());
  };
  const request = (
    parts: string[],
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    proxyFiscal(
      new Request('http://localhost:3000/api/fiscal/' + parts.join('/'), {
        method,
        headers: {
          Cookie: 'maxbio-session=test; other=private',
          'Content-Type': 'application/json',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      parts,
    );
  assert.equal((await request(['arca', 'readiness'])).status, 200);
  assert.equal(calls, 1);
  assert.equal((await request(['arca', 'credentials', id, 'private-key'])).status, 404);
  assert.equal((await request(['arca', 'wsaa', 'test'], 'POST', {})).status, 403);
  const csrf = { Origin: 'http://localhost:3000', 'X-Maxbio-Csrf': '1' };
  assert.equal(
    (await request(['arca', 'wsaa', 'test'], 'POST', { endpoint: 'https://evil.invalid' }, csrf))
      .status,
    400,
  );
  assert.equal(
    (await request(['arca', 'wsaa', 'test'], 'POST', { token: 'secret' }, csrf)).status,
    400,
  );
  assert.equal(
    (await request(['arca', 'wsaa', 'test'], 'POST', { padding: 'x'.repeat(140001) }, csrf)).status,
    400,
  );
  globalThis.fetch = async () => Response.json({ ...readiness(), token: 'SECRET_TEST_TOKEN' });
  const leaked = await request(['arca', 'readiness']);
  assert.equal(leaked.status, 502);
  assert.doesNotMatch(await leaked.text(), /SECRET_TEST/);
});
const profileOk = { profile: null };
const settingsFetch =
  (handlers: { profile?: () => Promise<Response>; readiness?: () => Promise<Response> }) =>
  async (url: RequestInfo | URL) =>
    String(url).endsWith('/profile')
      ? (handlers.profile?.() ?? Response.json(profileOk))
      : (handlers.readiness?.() ?? Response.json(readiness()));
test('Fiscal settings: GET profile and readiness succeed, OpenSSL state is shown, no spinner left', async () => {
  const paths: string[] = [];
  const handler = settingsFetch({
    readiness: async () => Response.json(readiness({ openssl: 'UNAVAILABLE' })),
  });
  globalThis.fetch = async (url) => {
    paths.push(String(url));
    return handler(url);
  };
  const ui = await mount(<FiscalSettingsView isAdmin />);
  try {
    assert.deepEqual(paths.sort(), [
      '/api/fiscal/arca/invoicing',
      '/api/fiscal/arca/readiness',
      '/api/fiscal/profile',
    ]);
    assert.doesNotMatch(ui.host.textContent!, /Cargando configuración/);
    assert.match(ui.host.textContent!, /OpenSSL en el servidor: no disponible/);
    assert.match(ui.host.textContent!, /Revisá ARCA_OPENSSL_PATH/);
    assert.ok(ui.host.querySelector('[name=cuit]'));
  } finally {
    await ui.close();
  }
});
test('Fiscal settings: failed initial load shows error and retry, never an endless loading state', async () => {
  let calls = 0,
    fail = true;
  let release: () => void = () => {};
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls++;
    if (fail)
      return Response.json(
        {
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          message: 'No pudimos conectar. Volvé a intentar en unos momentos.',
          requestId: id,
          timestamp: new Date().toISOString(),
          path: '/api/fiscal/arca/readiness',
        },
        { status: 503 },
      );
    if (String(url).endsWith('/readiness')) await new Promise<void>((r) => (release = r));
    return settingsFetch({})(url);
  }) as typeof fetch;
  const ui = await mount(<FiscalSettingsView isAdmin />);
  try {
    assert.equal(calls, 2);
    assert.match(ui.host.textContent!, /No pudimos conectar/);
    assert.doesNotMatch(ui.host.textContent!, /Cargando configuración/);
    fail = false;
    await act(async () => button(ui.host, 'Volver a intentar').click());
    assert.match(ui.host.textContent!, /Cargando configuración/);
    assert.doesNotMatch(ui.host.textContent!, /No pudimos conectar/);
    assert.equal([...ui.host.querySelectorAll('button')].length, 0, 'no retry while loading');
    assert.equal(calls, 4, 'one request per endpoint, no duplicates');
    await act(async () => release());
    assert.doesNotMatch(ui.host.textContent!, /Cargando configuración|No pudimos conectar/);
    assert.ok(ui.host.querySelector('[name=cuit]'));
    assert.match(ui.host.textContent!, /OpenSSL en el servidor: disponible/);
  } finally {
    await ui.close();
  }
});
test('Fiscal settings: schema mismatch and non-JSON responses surface a human error, not a spinner', async () => {
  const { openssl: _omitted, ...stale } = readiness();
  void _omitted;
  globalThis.fetch = settingsFetch({ readiness: async () => Response.json(stale) }) as typeof fetch;
  let ui = await mount(<FiscalSettingsView isAdmin />);
  try {
    assert.match(ui.host.textContent!, /no coincide con esta versión de MaxBio/);
    assert.doesNotMatch(ui.host.textContent!, /Cargando configuración|openssl|invalid_value/);
    assert.ok(button(ui.host, 'Volver a intentar'));
  } finally {
    await ui.close();
  }
  globalThis.fetch = settingsFetch({
    profile: async () => new Response('<html>Internal Server Error</html>', { status: 500 }),
  }) as typeof fetch;
  ui = await mount(<FiscalSettingsView isAdmin />);
  try {
    assert.match(ui.host.textContent!, /No pudimos conectar/);
    assert.doesNotMatch(ui.host.textContent!, /Cargando configuración|Unexpected token|html/);
  } finally {
    await ui.close();
  }
});
test('Fiscal BFF: distinguishes config, network, timeout, JSON and contract failures with safe logs', async () => {
  process.env.WEB_ORIGIN = 'http://localhost:3000';
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  const get = () =>
    proxyFiscal(
      new Request('http://localhost:3000/api/fiscal/arca/readiness', {
        headers: { Cookie: 'maxbio-session=SECRET_SESSION_TOKEN' },
      }),
      ['arca', 'readiness'],
    );
  const expect = async (status: number, message: RegExp, log: RegExp) => {
    logs.length = 0;
    const response = await get();
    assert.equal(response.status, status);
    const text = await response.text();
    assert.match(text, message);
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, log);
    assert.doesNotMatch(
      logs.join('\n') + text,
      /SECRET_SESSION_TOKEN|SECRET_TEST_TOKEN|BEGIN PRIVATE|postgresql:/,
    );
  };
  try {
    delete process.env.API_BASE_URL;
    await expect(503, /No pudimos conectar/, /API_BASE_URL_MISSING/);
    process.env.API_BASE_URL = 'not a url';
    await expect(503, /No pudimos conectar/, /API_BASE_URL_INVALID/);
    process.env.API_BASE_URL = 'http://127.0.0.1:3001';
    globalThis.fetch = async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED', message: 'postgresql://user:pass@db' },
      });
    };
    await expect(503, /No pudimos conectar/, /API_UNREACHABLE \(ECONNREFUSED\)/);
    globalThis.fetch = async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    };
    await expect(504, /tardó demasiado/, /API_TIMEOUT/);
    globalThis.fetch = async () => new Response('-----BEGIN PRIVATE KEY----- not json');
    await expect(502, /respuesta inesperada/, /INVALID_JSON \(HTTP 200\)/);
    globalThis.fetch = async () => Response.json({ error: 'SECRET_TEST_TOKEN' }, { status: 500 });
    await expect(502, /respuesta inesperada/, /UNEXPECTED_RESPONSE \(HTTP 500\)/);
    const { openssl: _omitted, ...stale } = readiness();
    void _omitted;
    globalThis.fetch = async () => Response.json({ ...stale, token: 'SECRET_TEST_TOKEN' });
    await expect(
      502,
      /versión incompatible/,
      /CONTRACT_MISMATCH \(.*openssl: invalid_value.*\)|CONTRACT_MISMATCH \(.*openssl/,
    );
  } finally {
    console.error = original;
    process.env.API_BASE_URL = 'http://127.0.0.1:3001';
  }
});

test('V3 POS UI: source is ARCA, single point is proposed and requires explicit confirmation', async () => {
  const cfg = {
    environment: 'HOMOLOGATION',
    version: 2,
    pointOfSale: null,
    checkedAt: '2026-10-28T18:00:00.000Z',
    ready: false,
    reasons: ['Elegí un punto de venta.'],
    references: {
      points: [23],
      conditions: { A: [], B: [], C: [] },
      documentTypes: [],
      ivaTypes: [],
    },
  };
  const writes: { url: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      writes.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return Response.json({ ...cfg, pointOfSale: 23, ready: true, reasons: [] });
    }
    return Response.json(cfg);
  };
  const ui = await mount(<WsfeSettings />);
  try {
    const select = ui.host.querySelector('select')!;
    assert.equal(select.value, '23');
    assert.equal(ui.host.querySelectorAll('input').length, 0);
    assert.equal(writes.length, 0);
    await act(async () => button(ui.host, 'Confirmar punto de venta de homologación').click());
    assert.deepEqual(writes, [
      {
        url: '/api/fiscal/arca/invoicing/point-of-sale',
        body: { expectedVersion: 2, pointOfSale: 23 },
      },
    ]);
    assert.match(ui.host.textContent!, /Listo para emitir en homologación/);
  } finally {
    await ui.close();
  }
});
test('V3 POS UI: no points gives a human ARCA setup message, no numeric input', async () => {
  globalThis.fetch = async () =>
    Response.json({
      environment: 'HOMOLOGATION',
      version: 0,
      pointOfSale: null,
      checkedAt: null,
      ready: false,
      reasons: [],
      references: {
        points: [],
        conditions: { A: [], B: [], C: [] },
        documentTypes: [],
        ivaTypes: [],
      },
    });
  const ui = await mount(<WsfeSettings />);
  try {
    assert.match(ui.host.textContent!, /No hay un punto de venta habilitado/);
    assert.match(ui.host.textContent!, /Comprobantes en Línea/);
    assert.equal(ui.host.querySelectorAll('input,select').length, 0);
  } finally {
    await ui.close();
  }
});

test('Historical verification + WAITING preserves credential trust and explains missing live access and original error', async () => {
  const base = readiness();
  const a = readiness({
    activeCredentialId: id,
    credentials: [credential()],
    fiscalProfile: 'COMPLETE',
    certificateMatchesKey: true,
    lastVerifiedAt: '2026-10-28T18:29:47.130Z',
    access: {
      ...base.access,
      status: 'WAITING',
      retryAfter: '2026-10-30T01:58:37.421Z',
      lastResultCode: 'ALREADY_AUTHENTICATED',
      lastError: 'ARCA informó que ya existe un acceso vigente.',
      testBlockedReason: 'ARCA informó que ya existe un acceso vigente.',
    },
  });
  const ui = await mount(<ArcaConnection arca={a} changed={() => {}} />);
  try {
    assert.match(ui.host.textContent!, /Credencial ARCA verificada/);
    assert.match(ui.host.textContent!, /Esperando vencimiento/);
    assert.match(ui.host.textContent!, /Último intento: ARCA informó/);
    assert.doesNotMatch(ui.host.textContent!, /ARCA conectado|✓ Acceso activo/);
    const testButton = button(ui.host, 'Probar conexión con ARCA');
    assert.equal(testButton.disabled, true);
    const reason = document.getElementById(testButton.getAttribute('aria-describedby')!)!;
    assert.match(reason.textContent!, /acceso vigente.*29\/10\/2026.*22:58:37.*Buenos Aires/);
  } finally {
    await ui.close();
  }
});

test('Valid active credential with an available TA shows active temporal access separately', async () => {
  const base = readiness();
  const a = readiness({
    activeCredentialId: id,
    credentials: [credential()],
    fiscalProfile: 'COMPLETE',
    certificateMatchesKey: true,
    canTest: true,
    access: { ...base.access, status: 'AUTHENTICATED', expiresAt: '2026-10-30T01:58:37.421Z' },
  });
  const ui = await mount(<ArcaConnection arca={a} changed={() => {}} />);
  try {
    assert.match(ui.host.textContent!, /Credencial ARCA verificada/);
    assert.match(ui.host.textContent!, /✓ Acceso activo/);
    assert.match(ui.host.textContent!, /Vencimiento del acceso conocido/);
    assert.equal(button(ui.host, 'Probar conexión con ARCA').disabled, false);
  } finally {
    await ui.close();
  }
});

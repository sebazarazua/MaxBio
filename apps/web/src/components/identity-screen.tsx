'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { apiErrorSchema, identityResponseSchema } from '@maxbio/contracts';
import type { IdentityResponse } from '@maxbio/contracts';
import { ConnectionStatus } from './connection-status';

export function IdentityScreen({
  children,
}: {
  children?: (identity: IdentityResponse) => ReactNode;
}) {
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const authenticated = useRef(false);
  const refreshVersion = useRef(0);
  function invalidateRefresh() {
    refreshVersion.current++;
  }

  function refresh() {
    const version = ++refreshVersion.current;
    return fetch('/api/auth/me', { cache: 'no-store' })
      .then(async (response) => {
        const data: unknown = await response.json();
        if (version !== refreshVersion.current) return;
        if (response.status === 401) {
          const error = apiErrorSchema.parse(data);
          if (authenticated.current || error.code === 'SESSION_ENDED')
            setMessage('Tu sesión terminó. Iniciá sesión nuevamente para continuar.');
          authenticated.current = false;
          setIdentity(null);
          setUnavailable(false);
        } else if (response.ok) {
          setIdentity(identityResponseSchema.parse(data));
          authenticated.current = true;
          setUnavailable(false);
        } else throw new Error('Connection unavailable');
      })
      .catch(() => {
        if (version !== refreshVersion.current) return;
        setUnavailable(true);
        setMessage('No pudimos conectar. Volvé a intentar en unos momentos.');
      })
      .finally(() => {
        if (version === refreshVersion.current) setLoading(false);
      });
  }

  useEffect(() => {
    void refresh();
    const revisit = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', revisit);
    window.addEventListener('pageshow', revisit);
    window.addEventListener('maxbio-session-check', revisit);
    document.addEventListener('visibilitychange', revisit);
    // Mantener viva una pantalla usada, sin renovar pestañas abandonadas solo por un timer.
    let lastCheck = Date.now();
    const activity = () => {
      if (Date.now() - lastCheck > 15 * 60000) {
        lastCheck = Date.now();
        void refresh();
      }
    };
    window.addEventListener('pointerdown', activity);
    window.addEventListener('keydown', activity);
    return () => {
      window.removeEventListener('focus', revisit);
      window.removeEventListener('pageshow', revisit);
      window.removeEventListener('maxbio-session-check', revisit);
      document.removeEventListener('visibilitychange', revisit);
      window.removeEventListener('pointerdown', activity);
      window.removeEventListener('keydown', activity);
      invalidateRefresh();
    };
  }, []);

  async function mutate(path: string, body: Record<string, unknown> = {}) {
    invalidateRefresh();
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/auth/${path}`, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = apiErrorSchema.parse(await response.json());
        if (response.status === 401 && path !== 'login') {
          authenticated.current = false;
          setIdentity(null);
        }
        setMessage(error.message);
        return;
      }
      if (path === 'logout') {
        invalidateRefresh();
        authenticated.current = false;
        setIdentity(null);
        setMessage('Cerraste sesión en este dispositivo.');
      } else await refresh();
    } catch {
      setMessage('No pudimos conectar. Volvé a intentar en unos momentos.');
    } finally {
      setBusy(false);
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = {
      email: String(data.get('email')).trim(),
      password: String(data.get('password')),
    };
    await mutate('login', body);
    // No mantener la contraseña en el DOM después de enviarla.
    const password = form.elements.namedItem('password');
    if (password instanceof HTMLInputElement) password.value = '';
  }

  if (loading)
    return (
      <div className="auth-card">
        <p role="status">Abriendo MaxBio…</p>
      </div>
    );
  if (unavailable)
    return (
      <div className="auth-card">
        <h1>MaxBio</h1>
        <p role="alert">{message}</p>
        <button className="primary-button" onClick={() => void refresh()}>
          Volver a intentar
        </button>
      </div>
    );
  if (!identity)
    return (
      <section className="auth-card" aria-labelledby="login-title">
        <p className="auth-brand">MAXBIO</p>
        <h1 id="login-title">Iniciar sesión</h1>
        <form onSubmit={login}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
          />
          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
          {message && (
            <p role="alert" className="auth-message">
              {message}
            </p>
          )}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? 'Ingresando…' : 'Entrar'}
          </button>
        </form>
        <p className="auth-help">
          Tu sesión se mantiene en esta computadora. Cerrá sesión si usás un dispositivo compartido.
        </p>
      </section>
    );
  if (identity.activeOrganization && children) return children(identity);
  return (
    <section className="auth-card workspace-card" aria-labelledby="welcome-title">
      <p className="auth-brand">MAXBIO</p>
      <h1 id="welcome-title">Hola, {identity.user.displayName}</h1>
      {identity.activeOrganization ? (
        <>
          <p className="auth-organization">
            {identity.activeOrganization.name} ·{' '}
            {identity.activeOrganization.role === 'ADMIN' ? 'Administrador' : 'Operador'}
          </p>
          <p>Tu espacio de trabajo está preparado.</p>
          <ConnectionStatus />
        </>
      ) : (
        <>
          <p>Elegí la organización con la que querés trabajar.</p>
          <div className="organization-options">
            {identity.organizations.map((organization) => (
              <button
                className="secondary-button"
                disabled={busy}
                key={organization.membershipId}
                onClick={() =>
                  void mutate('organization', { membershipId: organization.membershipId })
                }
              >
                {organization.name}
              </button>
            ))}
          </div>
        </>
      )}
      {message && (
        <p role="alert" className="auth-message">
          {message}
        </p>
      )}
      <button
        className="secondary-button logout-button"
        disabled={busy}
        onClick={() => void mutate('logout')}
      >
        Cerrar sesión
      </button>
    </section>
  );
}

'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { IdentityResponse } from '@maxbio/contracts';
import { IdentityScreen } from './identity-screen';
import { Navigation } from './navigation';

const WorkspaceContext = createContext<IdentityResponse | null>(null);
export function useWorkspace() {
  const identity = useContext(WorkspaceContext);
  if (!identity?.activeOrganization) throw new Error('Workspace context missing');
  return { identity, isAdmin: identity.activeOrganization.role === 'ADMIN' };
}
function WorkspaceBody({
  identity,
  children,
}: {
  identity: IdentityResponse;
  children: ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function logout() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
        body: '{}',
      });
      if (!response.ok) throw new Error();
      window.dispatchEvent(new Event('maxbio-session-check'));
      router.replace('/');
    } catch {
      setError('No pudimos cerrar la sesión. Volvé a intentar.');
      setBusy(false);
    }
  }
  return (
    <WorkspaceContext value={identity}>
      <div className="app-shell">
        <Navigation />
        <div className="app-body">
          <header className="app-header">
            <div>
              <strong>{identity.activeOrganization?.name}</strong>
              <span>
                {identity.user.displayName} ·{' '}
                {identity.activeOrganization?.role === 'ADMIN' ? 'Administrador' : 'Operador'}
              </span>
            </div>
            <button className="secondary-button" disabled={busy} onClick={() => void logout()}>
              {busy ? 'Cerrando…' : 'Cerrar sesión'}
            </button>
          </header>
          {error && (
            <p role="alert" className="catalog-error">
              {error}
            </p>
          )}
          <div className="catalog-content">{children}</div>
        </div>
      </div>
    </WorkspaceContext>
  );
}
export function Workspace({ children }: { children: ReactNode }) {
  return (
    <IdentityScreen>
      {(identity) => (
        <WorkspaceBody key={identity.activeOrganization?.id} identity={identity}>
          {children}
        </WorkspaceBody>
      )}
    </IdentityScreen>
  );
}

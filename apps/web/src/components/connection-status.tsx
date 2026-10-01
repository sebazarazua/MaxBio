'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { healthResponseSchema } from '@maxbio/contracts';
import { Icon } from './icon';

type Status = 'checking' | 'connected' | 'unavailable';

async function readConnection(signal: AbortSignal): Promise<'connected' | 'unavailable'> {
  try {
    const response = await fetch('/api/system-status', { cache: 'no-store', signal });
    const data: unknown = await response.json();
    return response.ok && healthResponseSchema.safeParse(data).success
      ? 'connected'
      : 'unavailable';
  } catch {
    return 'unavailable';
  }
}

export function ConnectionStatus() {
  const [status, setStatus] = useState<Status>('checking');
  const pending = useRef<AbortController | null>(null);

  const checkConnection = useCallback(() => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 6_000);
    void readConnection(controller.signal)
      .then((nextStatus) => {
        if (pending.current === controller) setStatus(nextStatus);
      })
      .finally(() => clearTimeout(timer));
  }, []);

  useEffect(() => {
    void checkConnection();
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [checkConnection]);

  const title =
    status === 'connected'
      ? 'El sistema está conectado'
      : status === 'checking'
        ? 'Comprobando la conexión…'
        : 'La conexión no está disponible';
  const description =
    status === 'unavailable'
      ? 'Volvé a intentar en unos momentos. Si el problema continúa, contactá a quien administra el sistema.'
      : 'Podés comprobar la conexión cuando lo necesites.';

  return (
    <section className="connection-panel" aria-labelledby="connection-heading">
      <span className={`connection-icon ${status}`}>
        <Icon name={status === 'connected' ? 'check' : 'connection'} size={24} />
      </span>
      <div className="connection-copy" role="status" aria-live="polite" aria-atomic="true">
        <h2 id="connection-heading">{title}</h2>
        <p>{description}</p>
      </div>
      <button
        className="secondary-button"
        onClick={() => {
          setStatus('checking');
          void checkConnection();
        }}
        disabled={status === 'checking'}
      >
        {status === 'checking' ? 'Comprobando…' : 'Comprobar conexión'}
      </button>
    </section>
  );
}

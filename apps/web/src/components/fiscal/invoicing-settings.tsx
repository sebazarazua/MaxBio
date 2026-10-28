'use client';
import { useEffect, useState } from 'react';
import { wsfeConfigurationSchema, type WsfeConfiguration } from '@maxbio/contracts';
import { fiscalFetch } from '../../lib/fiscal-api.ts';
import { useMutation } from '../catalog/common.tsx';
export function WsfeSettings() {
  const [config, setConfig] = useState<WsfeConfiguration | null>(null),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [selection, setSelection] = useState<string | null>(null);
  const mutation = useMutation();
  useEffect(() => {
    const abort = new AbortController();
    void fiscalFetch('arca/invoicing', wsfeConfigurationSchema, 'GET', undefined, abort.signal)
      .then((c) => {
        if (!abort.signal.aborted) {
          setConfig(c);
          setError('');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(
            e instanceof Error ? e.message : 'No pudimos cargar la facturación electrónica.',
          );
      });
    return () => abort.abort();
  }, [revision]);
  const points = config?.references?.points ?? [],
    selected = selection ?? String(config?.pointOfSale ?? (points.length === 1 ? points[0] : ''));
  return (
    <section className="catalog-panel" aria-labelledby="wsfe-title">
      <h2 id="wsfe-title">Facturación electrónica</h2>
      <p>
        Homologación. La conexión WSAA y la preparación para emitir comprobantes se verifican por
        separado.
      </p>
      {!config && !error && <p role="status">Cargando requisitos de facturación…</p>}
      {error && (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => setRevision((v) => v + 1)}>
            Volver a cargar facturación electrónica
          </button>
        </>
      )}
      {config && (
        <>
          <p role="status">
            <strong>
              {config.ready
                ? '✓ Listo para emitir en homologación'
                : 'Falta completar la configuración de facturación'}
            </strong>
          </p>
          {config.reasons.length > 0 && (
            <ul>
              {config.reasons.map((r, n) => (
                <li key={n}>{r}</li>
              ))}
            </ul>
          )}
          <button
            className="secondary-button"
            disabled={mutation.busy}
            onClick={() =>
              void (async () => {
                const next = await mutation.run(() =>
                  fiscalFetch('arca/invoicing/refresh', wsfeConfigurationSchema, 'POST', {}),
                );
                if (next) {
                  setConfig(next);
                  setSelection(null);
                }
              })()
            }
          >
            Consultar puntos de venta y condiciones en ARCA
          </button>
          {config.references &&
            (points.length ? (
              <>
                <label className="field" htmlFor="wsfe-point-of-sale">
                  Punto de venta para facturación
                  <select
                    id="wsfe-point-of-sale"
                    value={selected}
                    disabled={mutation.busy}
                    onChange={(e) => setSelection(e.target.value)}
                  >
                    <option value="">Elegí un punto de venta habilitado</option>
                    {points.map((p) => (
                      <option key={p} value={p}>
                        {String(p).padStart(5, '0')} · Web Service / CAE
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="primary-button"
                  disabled={mutation.busy || !points.includes(Number(selected))}
                  onClick={() =>
                    void (async () => {
                      const next = await mutation.run(() =>
                        fiscalFetch(
                          'arca/invoicing/point-of-sale',
                          wsfeConfigurationSchema,
                          'POST',
                          { expectedVersion: config.version, pointOfSale: Number(selected) },
                        ),
                      );
                      if (next) {
                        setConfig(next);
                        setSelection(null);
                      }
                    })()
                  }
                >
                  Confirmar punto de venta de homologación
                </button>
              </>
            ) : (
              <p>
                No hay un punto de venta habilitado para este Web Service y emisión CAE. Configuralo
                en ARCA y volvé a consultar; un punto de Comprobantes en Línea no se habilita aquí
                automáticamente.
              </p>
            ))}
          {config.checkedAt && (
            <p>
              Última consulta:{' '}
              {new Date(config.checkedAt).toLocaleString('es-AR', {
                timeZone: 'America/Argentina/Buenos_Aires',
              })}
            </p>
          )}
        </>
      )}
      {mutation.busy && <p role="status">Consultando ARCA…</p>}
      {mutation.error && <p role="alert">{mutation.error}</p>}
    </section>
  );
}

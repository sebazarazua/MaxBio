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
    void fiscalFetch('arca/invoicing/prepare', wsfeConfigurationSchema, 'POST', {}, abort.signal)
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
      <h2 id="wsfe-title">Facturación electrónica con ARCA</h2>
      <p>
        Elegí una vez el punto de venta que querés usar con MaxBio. El acceso y la información de
        ARCA se preparan automáticamente al facturar.
      </p>
      <p>Ambiente: homologación. Estas consultas no emiten comprobantes.</p>
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
          <ul aria-label="Estado de configuración WSFE">
            {config.checks.map((check) => (
              <li key={check.id}>
                {check.ready ? '✓' : 'Pendiente:'} {check.label}
              </li>
            ))}
          </ul>
          <button
            className="secondary-button"
            disabled={mutation.busy}
            aria-busy={mutation.busy}
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
            {mutation.busy ? 'Consultando ARCA…' : 'Actualizar datos desde ARCA'}
          </button>
          {config.pointOfSale && config.checks.find((v) => v.id === 'point')?.ready && (
            <p>
              Punto de venta configurado: {String(config.pointOfSale).padStart(5, '0')}. Se usará
              automáticamente en las próximas facturas.
            </p>
          )}
          {config.references &&
            (points.length ? (
              <details open={!config.checks.find((v) => v.id === 'point')?.ready}>
                <summary>
                  {config.checks.find((v) => v.id === 'point')?.ready
                    ? 'Cambiar punto de venta'
                    : points.length === 1
                      ? `Punto de venta encontrado: ${String(points[0]).padStart(5, '0')}`
                      : '¿Qué punto de venta querés usar con MaxBio?'}
                </summary>
                <label className="field" htmlFor="wsfe-point-of-sale">
                  Punto de venta para facturación
                  <select
                    id="wsfe-point-of-sale"
                    aria-label="Punto de venta para facturación"
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
                  aria-busy={mutation.busy}
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
                  {points.length === 1 ? 'Usar este punto de venta' : 'Confirmar punto de venta'}
                </button>
              </details>
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

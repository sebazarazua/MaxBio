'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  invoiceFiscalReadinessSchema,
  invoiceFiscalStatusLabels,
  invoiceSchema,
  invoiceTypeLabels,
  type InvoiceView,
} from '@maxbio/contracts';
import { catalogFetch, humanError } from '../../lib/catalog-api.ts';
import { useMutation } from '../catalog/common.tsx';
import { formatMoney } from '../../lib/invoicing.ts';
import { useDeadlineRefresh } from '../../hooks/use-deadline-refresh.ts';

export function InvoiceFiscalPanel({
  invoice: i,
  isAdmin,
  changed,
  reload,
}: {
  invoice: InvoiceView;
  isAdmin: boolean;
  changed: (i: InvoiceView) => void;
  reload: () => void;
}) {
  const fiscal = i.fiscal;
  const fiscalStatus = fiscal?.status;
  const [loaded, setLoaded] = useState<{
    id: string;
    version: number;
    value: ReturnType<typeof invoiceFiscalReadinessSchema.parse>;
  } | null>(null);
  const requirements = loaded?.id === i.id && loaded.version === i.version ? loaded.value : null;
  const [loadError, setLoadError] = useState(''),
    [revision, setRevision] = useState(0),
    [condition, setCondition] = useState(''),
    [confirm, setConfirm] = useState(false),
    [notice, setNotice] = useState('');
  const operation = useRef<string | null>(null),
    guard = useRef(false),
    mutation = useMutation();
  useDeadlineRefresh(requirements?.retryAfter ?? requirements?.sequence?.validUntil, () =>
    setRevision((v) => v + 1),
  );
  useEffect(() => {
    if (!isAdmin || i.status !== 'READY' || fiscalStatus !== 'NOT_SUBMITTED') return;
    const abort = new AbortController();
    void catalogFetch(`${i.id}/fiscal/readiness`, invoiceFiscalReadinessSchema, {
      scope: 'invoices',
      signal: abort.signal,
    })
      .then((r) => {
        if (!abort.signal.aborted) {
          setLoaded({ id: i.id, version: i.version, value: r });
          setLoadError('');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) setLoadError(humanError(e));
      });
    return () => abort.abort();
  }, [i.id, i.version, i.status, fiscalStatus, isAdmin, revision]);
  if (!fiscal) return null;
  const latest = fiscal.attempts[0];
  async function authorize() {
    if (guard.current) return;
    guard.current = true;
    try {
      operation.current ??= crypto.randomUUID();
      const next = await mutation.run(() =>
        catalogFetch(`${i.id}/fiscal/authorize`, invoiceSchema, {
          scope: 'invoices',
          method: 'POST',
          body: { expectedVersion: i.version, operationId: operation.current },
        }),
      );
      if (next) {
        setConfirm(false);
        changed(next);
      }
    } finally {
      guard.current = false;
    }
  }
  async function verify() {
    const next = await mutation.run(() =>
      catalogFetch(`${i.id}/fiscal/verify`, invoiceSchema, {
        scope: 'invoices',
        method: 'POST',
        body: {},
      }),
    );
    if (next) {
      setNotice(
        next.fiscal?.status === 'AUTHORIZING'
          ? 'El envío está en curso. Volvé a verificar en unos momentos.'
          : 'Consulta de ARCA completada. Revisá el estado fiscal.',
      );
      changed(next);
    }
  }
  return (
    <section className="catalog-panel" aria-labelledby="invoice-fiscal-title">
      <h2 id="invoice-fiscal-title">Facturación electrónica · Homologación</h2>
      <p role="status">
        <strong>{invoiceFiscalStatusLabels[fiscal.status]}</strong>
      </p>
      <p>Los comprobantes de homologación son de prueba y no tienen efecto fiscal real.</p>
      {fiscal.receiverVatConditionLabel && (
        <p>Condición IVA del receptor: {fiscal.receiverVatConditionLabel}</p>
      )}
      {latest?.cae && (
        <dl className="data-grid">
          <div>
            <dt>Tipo</dt>
            <dd>{i.invoiceType ? invoiceTypeLabels[i.invoiceType] : '—'}</dd>
          </div>
          <div>
            <dt>Punto de venta</dt>
            <dd>{String(latest.pointOfSale).padStart(5, '0')}</dd>
          </div>
          <div>
            <dt>Número</dt>
            <dd>{String(latest.documentNumber).padStart(8, '0')}</dd>
          </div>
          <div>
            <dt>CAE</dt>
            <dd>{latest.cae}</dd>
          </div>
          <div>
            <dt>Vencimiento CAE</dt>
            <dd>{latest.caeExpiration?.split('-').reverse().join('/')}</dd>
          </div>
          <div>
            <dt>Autorización registrada en MaxBio</dt>
            <dd>
              {latest.authorizedAt
                ? new Date(latest.authorizedAt).toLocaleString('es-AR', {
                    timeZone: 'America/Argentina/Buenos_Aires',
                  })
                : '—'}
            </dd>
          </div>
        </dl>
      )}
      {latest?.verifiedAt && (
        <p>
          Última verificación:{' '}
          {new Date(latest.verifiedAt).toLocaleString('es-AR', {
            timeZone: 'America/Argentina/Buenos_Aires',
          })}
        </p>
      )}
      {latest &&
        [...latest.messages, ...latest.observations].map((m, n) => (
          <p key={n}>
            {m.code}: {m.message}
          </p>
        ))}
      {fiscal.status === 'UNCERTAIN' && (
        <p>
          Estamos verificando si ARCA registró este comprobante. No lo vuelvas a emitir hasta
          resolver esta consulta.
        </p>
      )}
      {fiscal.status === 'CONFLICT' && (
        <p role="alert">
          ARCA devolvió datos que no coinciden con el intento local. Esta secuencia queda bloqueada
          hasta revisar la inconsistencia.
        </p>
      )}
      {isAdmin && i.status === 'READY' && fiscal.status === 'NOT_SUBMITTED' && (
        <>
          {!requirements && !loadError && (
            <p role="status">Consultando requisitos de autorización…</p>
          )}
          {loadError && (
            <>
              <p role="alert">{loadError}</p>
              <button onClick={() => setRevision((v) => v + 1)}>Cargar requisitos</button>
            </>
          )}
          {requirements && (
            <>
              {requirements.reasons.length > 0 && (
                <>
                  <ul>
                    {requirements.reasons.map((r, n) => (
                      <li key={n}>{r}</li>
                    ))}
                  </ul>
                  <Link href="/configuracion">Revisar configuración ARCA</Link>
                  <p>
                    <Link href={`/clientes/${i.customer.id}`}>Revisar datos del cliente</Link>. Si
                    cambiás sus datos, volvé a preparar la factura para actualizar su copia fiscal.
                  </p>
                </>
              )}
              <ul aria-label="Diagnóstico para autorizar">
                {requirements.checks.map((check) => (
                  <li key={check.id}>
                    {check.ready ? '✓' : 'Pendiente:'} {check.label}
                  </li>
                ))}
              </ul>
              <button disabled={mutation.busy} onClick={() => setRevision((v) => v + 1)}>
                Actualizar requisitos
              </button>
              <button
                className="secondary-button"
                aria-busy={mutation.busy}
                disabled={mutation.busy || !requirements.canCheckSequence}
                aria-describedby="invoice-sequence-help"
                onClick={() =>
                  void (async () => {
                    const next = await mutation.run(() =>
                      catalogFetch(`${i.id}/fiscal/sequence`, invoiceFiscalReadinessSchema, {
                        scope: 'invoices',
                        method: 'POST',
                        body: {},
                      }),
                    );
                    if (next) setLoaded({ id: i.id, version: i.version, value: next });
                  })()
                }
              >
                {mutation.busy ? 'Consultando ARCA…' : 'Consultar numeración en ARCA'}
              </button>
              <p id="invoice-sequence-help">
                Esta consulta no emite ni reserva números.{' '}
                {!requirements.canCheckSequence && 'Primero completá los requisitos indicados.'}
              </p>
              {requirements.sequence?.status === 'VERIFIED' && (
                <p>
                  ✓ Secuencia consultada. Último número autorizado:{' '}
                  {requirements.sequence.lastNumber}. Se verificará nuevamente al enviar.
                </p>
              )}
              {requirements.conditions.length > 0 && (
                <div>
                  <label className="field" htmlFor="invoice-receiver-vat">
                    Condición IVA del receptor
                    <select
                      id="invoice-receiver-vat"
                      value={condition || String(fiscal.receiverVatConditionId ?? '')}
                      disabled={mutation.busy}
                      onChange={(e) => setCondition(e.target.value)}
                    >
                      <option value="">Elegí la condición informada por el cliente</option>
                      {requirements.conditions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    disabled={mutation.busy || !condition}
                    onClick={() =>
                      void (async () => {
                        const next = await mutation.run(() =>
                          catalogFetch(`${i.id}/fiscal/receiver`, invoiceSchema, {
                            scope: 'invoices',
                            method: 'POST',
                            body: { expectedVersion: i.version, conditionId: Number(condition) },
                          }),
                        );
                        if (next) changed(next);
                      })()
                    }
                  >
                    Guardar condición para el cliente y esta factura
                  </button>
                </div>
              )}
              {!confirm ? (
                <button
                  className="primary-button"
                  disabled={mutation.busy || !requirements.ready}
                  aria-busy={mutation.busy}
                  aria-describedby={!requirements.ready ? 'invoice-authorization-help' : undefined}
                  onClick={() => setConfirm(true)}
                >
                  Autorizar en ARCA
                </button>
              ) : (
                <div role="group" aria-label="Confirmar autorización en homologación">
                  <p>
                    Esto enviará el comprobante directamente a ARCA mediante Web Service. No se
                    abrirá una página de ARCA.
                  </p>
                  <p>Ambiente: HOMOLOGACIÓN</p>
                  <p>Este comprobante es de prueba y no tiene efecto fiscal real.</p>
                  <p>
                    {i.invoiceType ? invoiceTypeLabels[i.invoiceType] : ''} · Punto de venta{' '}
                    {requirements.pointOfSale} · Total {formatMoney(i.totalAmount)}
                  </p>
                  <p>
                    Receptor: {i.customer.name} · CUIT: {i.customer.cuit ?? 'Sin CUIT'}
                  </p>
                  <p>
                    Condición IVA:{' '}
                    {fiscal.receiverVatConditionLabel ??
                      requirements.conditions.find((c) => c.id === fiscal.receiverVatConditionId)
                        ?.label ??
                      'Pendiente'}
                  </p>
                  <p>
                    Neto: {formatMoney(i.netAmount)} · IVA: {formatMoney(i.vatAmount)} · Total:{' '}
                    {formatMoney(i.totalAmount)}
                  </p>
                  <button
                    className="primary-button"
                    disabled={mutation.busy || !requirements.ready}
                    aria-busy={mutation.busy}
                    onClick={() => void authorize()}
                  >
                    {mutation.busy ? 'Autorizando…' : 'Confirmar autorización de prueba'}
                  </button>
                  <button disabled={mutation.busy} onClick={() => setConfirm(false)}>
                    Cancelar
                  </button>
                </div>
              )}
              {!requirements.ready && (
                <p id="invoice-authorization-help">
                  La autorización no está disponible hasta completar todos los requisitos indicados.
                </p>
              )}
            </>
          )}
        </>
      )}
      {isAdmin &&
        ['AUTHORIZED', 'UNCERTAIN', 'AUTHORIZING', 'CONFLICT'].includes(fiscal.status) && (
          <button disabled={mutation.busy} onClick={() => void verify()}>
            {fiscal.status === 'AUTHORIZED' ? 'Verificar en ARCA' : 'Verificar con ARCA'}
          </button>
        )}
      {mutation.busy && (
        <p role="status">{confirm ? 'Autorizando con ARCA…' : 'Consultando ARCA…'}</p>
      )}
      {mutation.error && (
        <p className="catalog-error" role="alert">
          {mutation.error} Cargá la información actual para comprobar el estado antes de continuar.
        </p>
      )}
      {mutation.error && <button onClick={reload}>Cargar estado actual</button>}
      {notice && <p role="status">{notice}</p>}
      {fiscal.attempts.length > 0 && (
        <details>
          <summary>Historial fiscal</summary>
          {fiscal.attempts.map((a) => (
            <div key={a.id}>
              <p>
                {new Date(a.createdAt).toLocaleString('es-AR', {
                  timeZone: 'America/Argentina/Buenos_Aires',
                })}{' '}
                · Punto {a.pointOfSale} ·{' '}
                {a.documentNumber ? `Número ${a.documentNumber}` : 'Preparación sin número'}
              </p>
              <p>
                {
                  {
                    PREPARING: 'En preparación',
                    AUTHORIZING: 'Autorización en curso',
                    AUTHORIZED: 'Autorizada',
                    REJECTED: 'Rechazada',
                    UNCERTAIN: 'Resultado por verificar',
                    CONFLICT: 'Inconsistencia de secuencia',
                    NOT_FOUND: 'Ausencia confirmada en ARCA',
                    ABORTED: 'Preparación cancelada sin envío',
                  }[a.status]
                }
              </p>
              {[...a.messages, ...a.observations].map((m, n) => (
                <p key={n}>
                  {m.code}: {m.message}
                </p>
              ))}
              {a.reconciliation === 'ABSENCE_NOT_FINAL' && (
                <p>
                  ARCA todavía no encuentra el comprobante. Se requiere otra consulta después del
                  período de seguridad.
                </p>
              )}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

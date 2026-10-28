'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  arcaCsrSchema,
  arcaReadinessSchema,
  fiscalProfileResponseSchema,
  fiscalProfileUpdateSchema,
  fiscalVatLabels,
  grossIncomeLabels,
  formatFiscalCuit,
  type ArcaGenerate,
  type ArcaReadiness,
  type FiscalProfile,
} from '@maxbio/contracts';
import { fiscalFetch } from '../../lib/fiscal-api.ts';
import { useWorkspace } from '../workspace.tsx';

export function FiscalSettings() {
  const { isAdmin } = useWorkspace();
  return <FiscalSettingsView isAdmin={isAdmin} />;
}
export function FiscalSettingsView({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<{ profile: FiscalProfile | null; arca: ArcaReadiness } | null>(
      null,
    ),
    // Explicit load state: a failed load ends in 'error' (with retry), never in an endless spinner.
    [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading'),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const reload = () => {
    setStatus('loading');
    setError('');
    setRevision((v) => v + 1);
  };
  useEffect(() => {
    if (!isAdmin) return;
    const abort = new AbortController();
    void Promise.all([
      fiscalFetch('profile', fiscalProfileResponseSchema, 'GET', undefined, abort.signal),
      fiscalFetch('arca/readiness', arcaReadinessSchema, 'GET', undefined, abort.signal),
    ])
      .then(([p, arca]) => {
        if (!abort.signal.aborted) {
          setData({ profile: p.profile, arca });
          setStatus('ready');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setError(e instanceof Error ? e.message : 'No pudimos cargar la configuración.');
          setStatus('error');
        }
      });
    return () => abort.abort();
  }, [isAdmin, revision]);
  if (!isAdmin)
    return (
      <>
        <h1>Configuración</h1>
        <p>Los datos fiscales y la conexión con ARCA requieren un administrador.</p>
      </>
    );
  return (
    <>
      <h1>Configuración</h1>
      <p>
        Datos de tu organización y autenticación de prueba con ARCA. Las facturas internas siguen
        disponibles.
      </p>
      {status === 'error' && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      {!data ? (
        status === 'error' ? (
          <button className="secondary-button" onClick={reload}>
            Volver a intentar
          </button>
        ) : (
          <p role="status">Cargando configuración…</p>
        )
      ) : (
        <>
          <button className="secondary-button" disabled={status === 'loading'} onClick={reload}>
            Cargar información actual
          </button>
          <ArcaConnection
            key={revision}
            arca={data.arca}
            changed={(arca) => setData((d) => (d ? { ...d, arca } : d))}
          />
          <FiscalProfileForm
            key={data.profile?.version ?? 'new'}
            profile={data.profile}
            saved={(p) => setData((d) => (d ? { ...d, profile: p } : d))}
            refresh={reload}
          />
        </>
      )}
    </>
  );
}
const fields = [
  ['legalName', 'Nombre fiscal', 200],
  ['tradeName', 'Nombre comercial', 200],
  ['cuit', 'CUIT', 32],
  ['grossIncomeNumber', 'Número de Ingresos Brutos', 40],
  ['addressLine', 'Domicilio fiscal (calle, número, piso y departamento)', 250],
  ['locality', 'Localidad', 120],
  ['province', 'Provincia', 100],
  ['postalCode', 'Código postal', 20],
  ['nationalActivityCode', 'Actividad fiscal nacional (6 dígitos)', 6],
  ['multilateralActivityCode', 'Actividad Convenio Multilateral (6 dígitos)', 6],
] as const;
function FiscalProfileForm({
  profile,
  saved,
  refresh,
}: {
  profile: FiscalProfile | null;
  saved: (p: FiscalProfile | null) => void;
  refresh: () => void;
}) {
  const guard = useRef(false),
    [busy, setBusy] = useState(false),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [message, setMessage] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (guard.current) return;
    const form = event.currentTarget,
      values = Object.fromEntries(new FormData(form));
    const input = { ...values, country: 'AR', expectedVersion: profile?.version ?? 0 };
    for (const key of [
      'vatCondition',
      'grossIncomeRegime',
      'nationalActivityCode',
      'multilateralActivityCode',
    ])
      if (input[key as keyof typeof input] === '') Object.assign(input, { [key]: null });
    const parsed = fiscalProfileUpdateSchema.safeParse(input);
    if (!parsed.success) {
      const issues: Record<string, string> = {};
      for (const i of parsed.error.issues)
        issues[String(i.path[0])] =
          i.path[0] === 'cuit' ? 'Revisá el CUIT y su dígito verificador.' : i.message;
      setErrors(issues);
      (form.elements.namedItem(Object.keys(issues)[0]!) as HTMLElement | null)?.focus();
      return;
    }
    guard.current = true;
    setBusy(true);
    setErrors({});
    setMessage('');
    try {
      const result = await fiscalFetch('profile', fiscalProfileResponseSchema, 'PUT', parsed.data);
      saved(result.profile);
      refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'No pudimos guardar los datos.');
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="catalog-panel" aria-labelledby="fiscal-title">
      <h2 id="fiscal-title">Datos fiscales</h2>
      <p>
        Estado: {profile?.completeness === 'COMPLETE' ? 'Completos' : 'Pendientes de completar'}. Un
        perfil completo permite iniciar la configuración de ARCA.
      </p>
      <form className="catalog-form" onSubmit={(e) => void save(e)} noValidate>
        <fieldset disabled={busy} className="form-grid">
          <legend>Datos del emisor</legend>
          {fields.map(([key, label, max]) => (
            <label className="field" key={key} htmlFor={'fiscal-' + key}>
              {label}
              <input
                id={'fiscal-' + key}
                name={key}
                maxLength={max}
                defaultValue={
                  key === 'cuit' && profile?.cuit
                    ? formatFiscalCuit(profile.cuit)
                    : (profile?.[key] ?? '')
                }
                aria-invalid={Boolean(errors[key])}
                aria-describedby={errors[key] ? 'fiscal-' + key + '-error' : undefined}
              />
              {errors[key] && (
                <small id={'fiscal-' + key + '-error'} role="alert">
                  {errors[key]}
                </small>
              )}
            </label>
          ))}
          <label className="field" htmlFor="fiscal-vat">
            Condición frente al IVA
            <select id="fiscal-vat" name="vatCondition" defaultValue={profile?.vatCondition ?? ''}>
              <option value="">Sin completar</option>
              {Object.entries(fiscalVatLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="fiscal-iibb">
            Ingresos Brutos
            <select
              id="fiscal-iibb"
              name="grossIncomeRegime"
              defaultValue={profile?.grossIncomeRegime ?? ''}
            >
              <option value="">Sin completar</option>
              {Object.entries(grossIncomeLabels).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p>
            País: Argentina. Para completar el perfil se requieren nombre fiscal, CUIT válido, IVA,
            domicilio completo e Ingresos Brutos (número para régimen local o Convenio
            Multilateral).
          </p>
        </fieldset>
        {message && (
          <p className="catalog-error" role="alert">
            {message}
          </p>
        )}
        <button className="primary-button" disabled={busy} type="submit">
          {busy ? 'Guardando…' : 'Guardar datos fiscales'}
        </button>
      </form>
    </section>
  );
}
const date = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
    : 'Pendiente';
const day = (v: string | null) =>
  v
    ? new Date(v).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })
    : 'Pendiente';
export function ArcaConnection({
  arca,
  changed,
}: {
  arca: ArcaReadiness;
  changed: (a: ArcaReadiness) => void;
}) {
  const guard = useRef(false),
    attempt = useRef<ArcaGenerate | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [commonName, setCommonName] = useState('MaxBio Homologacion'),
    [rotate, setRotate] = useState(false),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = arca.credentials.find((c) => c.id === arca.pendingCredentialId),
    active = arca.credentials.find((c) => c.id === arca.activeCredentialId);
  async function run(task: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No pudimos completar la operación.');
      try {
        changed(await fiscalFetch('arca/readiness', arcaReadinessSchema));
      } catch {
        /* Preserve the original human error when the status cannot be refreshed. */
      }
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function generate() {
    attempt.current ??= {
      operationId: crypto.randomUUID(),
      expectedVersion: arca.version,
      commonName,
      replacePending: rotate,
    };
    const result = await fiscalFetch(
      'arca/credentials/generate',
      arcaReadinessSchema,
      'POST',
      attempt.current,
    );
    changed(result);
    attempt.current = null;
    setRotate(false);
    setNotice('Solicitud creada. Descargá el archivo y continuá manualmente en ARCA.');
  }
  async function download(id: string) {
    const result = await fiscalFetch(`arca/credentials/${id}/csr`, arcaCsrSchema);
    const url = URL.createObjectURL(new Blob([result.pem], { type: 'application/pkcs10' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'maxbio-homologacion.csr';
    a.click();
    URL.revokeObjectURL(url);
  }
  async function upload(file: File) {
    if (!pending || !file.size || file.size > 102400)
      throw new Error('Elegí un certificado de hasta 100 KiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    changed(
      await fiscalFetch(`arca/credentials/${pending.id}/certificate`, arcaReadinessSchema, 'POST', {
        expectedVersion: pending.version,
        certificateBase64: btoa(binary),
      }),
    );
    setNotice(
      'Certificado instalado en la nueva solicitud. La credencial activa se conserva hasta que actives su reemplazo.',
    );
  }
  const valid = Boolean(active && ['VALID', 'EXPIRING_SOON'].includes(active.certificateState)),
    connected =
      valid &&
      arca.certificateMatchesKey &&
      arca.fiscalProfile === 'COMPLETE' &&
      Boolean(arca.lastVerifiedAt || arca.access.status === 'AUTHENTICATED') &&
      arca.access.status !== 'ERROR',
    history = arca.credentials.filter((c) => ['REPLACED', 'DISCARDED'].includes(c.status));
  return (
    <section className="catalog-panel arca-settings" aria-labelledby="arca-title">
      <h2 id="arca-title">ARCA</h2>
      <div className={connected ? 'arca-overview arca-connected' : 'arca-overview'}>
        <p className="arca-connection-state" role="status">
          {connected
            ? '✓ ARCA conectado'
            : active
              ? 'Conexión pendiente de verificar'
              : 'ARCA sin conectar'}
        </p>
        <dl className="arca-facts">
          <div>
            <dt>Ambiente</dt>
            <dd>Homologación</dd>
          </div>
          <div>
            <dt>CUIT</dt>
            <dd>{arca.cuit ? formatFiscalCuit(arca.cuit) : 'Pendiente'}</dd>
          </div>
          <div>
            <dt>Certificado</dt>
            <dd>
              {valid
                ? `Vigente hasta ${day(active!.validTo)}`
                : active?.certificateState === 'EXPIRED'
                  ? 'vencido'
                  : 'Pendiente de un certificado activo vigente'}
            </dd>
          </div>
          <div>
            <dt>Última verificación exitosa</dt>
            <dd>{arca.lastVerifiedAt ? date(arca.lastVerifiedAt) : 'Todavía no registrada'}</dd>
          </div>
        </dl>
        {active?.certificateState === 'EXPIRING_SOON' && (
          <p role="status">
            El certificado está próximo a vencer. Prepará su renovación desde Acciones avanzadas.
          </p>
        )}
        <button
          className="primary-button"
          disabled={busy || !arca.canTest}
          onClick={() =>
            void run(async () => {
              changed(await fiscalFetch('arca/wsaa/test', arcaReadinessSchema, 'POST', {}));
              setNotice('Conexión con ARCA verificada correctamente.');
            })
          }
        >
          Probar conexión con ARCA
        </button>
        {arca.access.message && arca.access.status === 'ERROR' && (
          <p role="alert">{arca.access.message}</p>
        )}
        {arca.access.retryAfter && (
          <p>
            Podés volver a probar a partir de {date(arca.access.retryAfter)}. La última verificación
            exitosa se conserva; el acceso temporal debe renovarse después de su vencimiento.
          </p>
        )}
        {!connected && !arca.lastVerifiedAt && (
          <p>Probá la conexión para verificar la aceptación del certificado por ARCA.</p>
        )}
      </div>
      <p>Esta conexión de homologación no emite facturas.</p>
      {active && (
        <section aria-labelledby="arca-active-title" className="arca-active">
          <h3 id="arca-active-title">Credencial activa</h3>
          <p>
            <strong>{active.commonName}</strong> · Activa
          </p>
          <p>Emitido por: {active.issuer?.replaceAll('\n', ' · ') ?? 'Pendiente'}</p>
          <p>
            Vigencia: {day(active.validFrom)} — {day(active.validTo)}
          </p>
        </section>
      )}
      <details className="arca-secondary">
        <summary>Solicitudes e historial{pending ? ' · 1 solicitud pendiente' : ''}</summary>
        {pending ? (
          <section aria-label="Solicitud pendiente">
            <h3>Solicitud pendiente</h3>
            <p>
              Solicitud creada: <strong>{pending.commonName}</strong> · {date(pending.createdAt)}
            </p>
            <p>
              {pending.status === 'CSR_READY'
                ? 'Esperando el certificado de ARCA.'
                : 'Certificado instalado, pendiente de activación.'}{' '}
              {active && 'La conexión actual sigue utilizando la credencial activa.'}
            </p>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void run(() => download(pending.id))}
            >
              Descargar CSR
            </button>
            {pending.status === 'CSR_READY' && (
              <>
                <p>
                  Usá esta solicitud en WSASS para obtener y autorizar el certificado de
                  homologación para wsfe. Luego cargalo aquí.
                </p>
                <a
                  href="https://www.arca.gob.ar/ws/WSASS/html/index.html"
                  target="_blank"
                  rel="noreferrer"
                >
                  Instrucciones oficiales de WSASS
                </a>
                <label className="field" htmlFor="arca-certificate">
                  Certificado ARCA (PEM o CRT, hasta 100 KiB)
                  <input
                    id="arca-certificate"
                    type="file"
                    accept=".pem,.crt,.cer"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (file) void run(() => upload(file));
                    }}
                  />
                </label>
              </>
            )}
            {pending.status === 'CERTIFICATE_INSTALLED' && (
              <>
                <p>
                  Vigencia: {day(pending.validFrom)} — {day(pending.validTo)}
                </p>
                <p>
                  {active
                    ? 'Al activar esta solicitud se reemplaza la credencial activa, se conserva su historial y se elimina su material privado.'
                    : 'Activá la credencial para habilitar la prueba.'}
                </p>
                <button
                  disabled={busy || !['VALID', 'EXPIRING_SOON'].includes(pending.certificateState)}
                  onClick={() =>
                    void run(async () =>
                      changed(
                        await fiscalFetch(
                          `arca/credentials/${pending.id}/activate`,
                          arcaReadinessSchema,
                          'POST',
                          { expectedVersion: pending.version, expectedConfigVersion: arca.version },
                        ),
                      ),
                    )
                  }
                >
                  Activar credencial de homologación
                </button>
              </>
            )}
            {!confirmDiscard ? (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => setConfirmDiscard(true)}
              >
                Descartar solicitud
              </button>
            ) : (
              <div role="group" aria-label="Confirmar descarte">
                <p>
                  Esta solicitud dejará de poder usarse y se eliminarán sus archivos del servidor.
                  La credencial activa se conserva.
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      changed(
                        await fiscalFetch(
                          `arca/credentials/${pending.id}/discard`,
                          arcaReadinessSchema,
                          'POST',
                          { expectedVersion: pending.version },
                        ),
                      );
                      setConfirmDiscard(false);
                      attempt.current = null;
                      setNotice('Solicitud descartada. La credencial activa se conserva.');
                    })
                  }
                >
                  Confirmar descarte
                </button>
                <button disabled={busy} onClick={() => setConfirmDiscard(false)}>
                  Conservar solicitud
                </button>
              </div>
            )}
          </section>
        ) : (
          <p>No hay solicitudes pendientes.</p>
        )}
        {history.length > 0 && (
          <section aria-labelledby="arca-history-title">
            <h3 id="arca-history-title">Historial</h3>
            {history.map((c) => (
              <div key={c.id} className="arca-history-item">
                <p>
                  <strong>{c.commonName}</strong> ·{' '}
                  {c.status === 'REPLACED' ? 'Reemplazada' : 'Solicitud descartada'}
                </p>
                <p>
                  Creada: {date(c.createdAt)} ·{' '}
                  {c.status === 'REPLACED' ? 'Reemplazada' : 'Descartada'}:{' '}
                  {date(c.replacedAt ?? c.discardedAt)}
                </p>
                {c.validTo && (
                  <p>
                    Vigencia: {day(c.validFrom)} — {day(c.validTo)}
                  </p>
                )}
                {c.issuer && <p>Emisor: {c.issuer}</p>}
                {c.fingerprint && (
                  <details>
                    <summary>Datos del certificado histórico</summary>
                    <p>Huella pública: {c.fingerprint}</p>
                  </details>
                )}
                {!c.secretsDeletedAt && (
                  <>
                    <p>Limpieza de archivos pendiente. Este registro ya no puede utilizarse.</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          changed(
                            await fiscalFetch(
                              `arca/credentials/${c.id}/cleanup`,
                              arcaReadinessSchema,
                              'POST',
                              {},
                            ),
                          );
                          setNotice('Limpieza completada. Se conserva el historial.');
                        })
                      }
                    >
                      Completar limpieza
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}
      </details>
      <details className="arca-secondary">
        <summary>Acciones avanzadas</summary>
        <p>
          {active
            ? 'La credencial activa sigue funcionando mientras tramitás una nueva solicitud. Solo cambia cuando activás expresamente el nuevo certificado.'
            : 'Generá una solicitud y obtené su certificado de homologación en ARCA.'}
        </p>
        {pending && !rotate && (
          <p>Completá o descartá la solicitud pendiente antes de crear otra.</p>
        )}
        {!pending && !rotate && active && (
          <button
            disabled={busy}
            onClick={() => {
              setRotate(true);
              attempt.current = null;
            }}
          >
            Preparar nueva solicitud
          </button>
        )}
        {!pending && (!active || rotate) && (
          <>
            <label className="field" htmlFor="arca-common-name">
              Nombre del sistema
              <input
                id="arca-common-name"
                value={commonName}
                onChange={(e) => {
                  setCommonName(e.target.value);
                  attempt.current = null;
                }}
                maxLength={64}
                disabled={busy}
              />
            </label>
            <button
              className="primary-button"
              disabled={busy || arca.fiscalProfile !== 'COMPLETE' || arca.openssl !== 'AVAILABLE'}
              onClick={() => void run(generate)}
            >
              {rotate ? 'Confirmar nueva solicitud' : 'Generar solicitud'}
            </button>
            {rotate && (
              <button disabled={busy} onClick={() => setRotate(false)}>
                Cancelar nueva solicitud
              </button>
            )}
          </>
        )}
        <p>
          OpenSSL en el servidor: {arca.openssl === 'AVAILABLE' ? 'disponible' : 'no disponible'}
        </p>
        <p>Datos fiscales: {arca.fiscalProfile === 'COMPLETE' ? 'completos' : 'pendientes'}</p>
      </details>
      {arca.openssl === 'UNAVAILABLE' && (
        <p role="alert">OpenSSL no está disponible en el servidor. Revisá ARCA_OPENSSL_PATH.</p>
      )}
      {busy && <p role="status">Procesando…</p>}
      {error && (
        <p className="catalog-error" role="alert">
          {error} Podés cargar la información actual para comprobar el resultado.
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

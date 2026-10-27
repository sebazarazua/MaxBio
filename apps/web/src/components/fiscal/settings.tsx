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
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
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
          setError('');
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'No pudimos cargar la configuración.');
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
      {error && (
        <p className="catalog-error" role="alert">
          {error}
        </p>
      )}
      <button className="secondary-button" onClick={() => setRevision((v) => v + 1)}>
        Cargar información actual
      </button>
      {!data ? (
        <p role="status">Cargando configuración…</p>
      ) : (
        <>
          <FiscalProfileForm
            key={data.profile?.version ?? 'new'}
            profile={data.profile}
            saved={(p) => setData((d) => (d ? { ...d, profile: p } : d))}
            refresh={() => setRevision((v) => v + 1)}
          />
          <ArcaConnection
            key={revision}
            arca={data.arca}
            changed={(arca) => setData((d) => (d ? { ...d, arca } : d))}
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
const date = (v: string | null) => (v ? new Date(v).toLocaleString('es-AR') : 'Pendiente');
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
    [rotate, setRotate] = useState(false);
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
    setNotice('Certificado instalado. Activá esta credencial para probar la conexión.');
  }
  return (
    <section className="catalog-panel" aria-labelledby="arca-title">
      <h2 id="arca-title">Conexión con ARCA</h2>
      <p>
        Entorno: <strong>Homologación</strong>. Esta conexión de prueba no emite facturas.
      </p>
      <ul>
        <li>Datos fiscales: {arca.fiscalProfile === 'COMPLETE' ? 'completos' : 'pendientes'}</li>
        <li>CUIT: {arca.cuitValid ? 'válido' : 'pendiente'}</li>
        <li>
          OpenSSL en el servidor: {arca.openssl === 'AVAILABLE' ? 'disponible' : 'no disponible'}
        </li>
        <li>Clave privada: {arca.privateKey ? 'generada en el servidor' : 'pendiente'}</li>
        <li>Solicitud: {arca.csr ? 'creada' : 'pendiente'}</li>
        <li>Certificado ARCA: {arca.certificateInstalled ? 'instalado' : 'pendiente'}</li>
        <li>
          Certificado activo:{' '}
          {active
            ? {
                VALID: 'vigente',
                EXPIRING_SOON: 'próximo a vencer',
                EXPIRED: 'vencido',
                INVALID: 'inválido',
                MISSING: 'pendiente',
              }[active.certificateState]
            : 'pendiente de activación'}
        </li>
        <li>
          Certificado y clave:{' '}
          {arca.certificateMatchesKey
            ? 'verificados'
            : 'pendientes de verificar en la credencial activa'}
        </li>
        <li>
          Acceso:{' '}
          {arca.access.status === 'AUTHENTICATED'
            ? 'Conexión correcta con ARCA'
            : arca.access.status === 'WAITING'
              ? 'Esperando vencimiento'
              : arca.access.status === 'ERROR'
                ? 'Requiere revisión'
                : 'Pendiente'}
        </li>
        <li>Ticket de acceso: válido hasta {date(arca.access.expiresAt)}</li>
        <li>WSFEv1: todavía no implementado</li>
        <li>Producción: no configurada</li>
      </ul>
      {arca.openssl === 'UNAVAILABLE' && (
        <p role="alert">OpenSSL no está disponible en el servidor. Revisá ARCA_OPENSSL_PATH.</p>
      )}
      {arca.access.message && <p role="status">{arca.access.message}</p>}
      {arca.access.retryAfter && (
        <p>Podés volver a probar a partir de {date(arca.access.retryAfter)}.</p>
      )}
      {arca.trust === 'PENDING_WSAA' && (
        <p>
          La aceptación del certificado y su autorización se comprueban al probar la conexión con
          ARCA.
        </p>
      )}
      <h3>1. Solicitud de certificado</h3>
      {(!pending || rotate) && (
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
        </>
      )}
      {pending && (
        <>
          <p>Solicitud creada: {pending.commonName}</p>
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void run(() => download(pending.id))}
          >
            Descargar archivo para ARCA
          </button>
        </>
      )}
      <p>
        Ingresá manualmente a ARCA, abrí WSASS, utilizá este archivo para obtener un certificado de
        homologación y autorizalo para Facturación Electrónica (wsfe). Volvé a MaxBio para cargar el
        certificado.
      </p>
      <a href="https://www.arca.gob.ar/ws/WSASS/html/index.html" target="_blank" rel="noreferrer">
        Instrucciones oficiales de WSASS
      </a>
      <h3>2. Cargar certificado</h3>
      {pending?.status === 'CSR_READY' && (
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
      )}
      {pending?.status === 'CERTIFICATE_INSTALLED' && (
        <>
          <p>
            Certificado instalado. Válido desde {date(pending.validFrom)} hasta{' '}
            {date(pending.validTo)}.
          </p>
          <p>
            {active
              ? 'Activar reemplazará expresamente la credencial activa y conservará su historial.'
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
      <h3>3. Probar conexión</h3>
      <button
        className="primary-button"
        disabled={busy || !arca.canTest}
        onClick={() =>
          void run(async () => {
            changed(await fiscalFetch('arca/wsaa/test', arcaReadinessSchema, 'POST', {}));
            setNotice('Conexión correcta con ARCA');
          })
        }
      >
        Probar conexión con ARCA
      </button>
      {(pending || active) && (
        <details>
          <summary>Generar nueva credencial</summary>
          <p>
            Se generará otra clave. Un certificado emitido para una solicitud anterior no servirá
            para la nueva. La credencial activa se conserva hasta que actives su reemplazo.
          </p>
          <button
            disabled={busy}
            onClick={() => {
              setRotate(true);
              attempt.current = null;
            }}
          >
            Preparar nueva solicitud
          </button>
          {rotate && (
            <button disabled={busy} onClick={() => setRotate(false)}>
              Cancelar nueva solicitud
            </button>
          )}
        </details>
      )}
      <details>
        <summary>Información técnica</summary>
        {arca.credentials.map((c) => (
          <div key={c.id}>
            <p>
              {c.commonName} · {c.status} · {date(c.createdAt)}
            </p>
            <p>
              Vigencia: {date(c.validFrom)} — {date(c.validTo)}
            </p>
            <p>Huella: {c.fingerprint ?? 'Pendiente'}</p>
            <p>Emisor del certificado: {c.issuer ?? 'Pendiente'}</p>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void run(() => download(c.id))}
            >
              Descargar CSR de esta solicitud
            </button>
          </div>
        ))}
      </details>
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

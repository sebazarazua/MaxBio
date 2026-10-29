// Never retain upstream bodies, causes, command stderr or secret-bearing objects.
export const arcaMessages = {
  CERTIFICATE_MISSING: 'Todavía falta instalar el certificado de homologación.',
  CERTIFICATE_INVALID:
    'No pudimos validar el certificado. Cargá un único certificado de homologación vigente.',
  CERTIFICATE_EXPIRED: 'El certificado de ARCA está vencido.',
  KEY_MISMATCH: 'El certificado no corresponde a la clave privada utilizada para generar este CSR.',
  CUIT_MISMATCH: 'El CUIT del certificado no coincide con los datos fiscales.',
  PRODUCTION_BLOCKED: 'Esta versión admite únicamente certificados y conexiones de homologación.',
  SERVICE_UNAUTHORIZED:
    'El certificado existe, pero todavía no está autorizado para el servicio de facturación electrónica en homologación.',
  CLOCK_ERROR: 'ARCA rechazó el horario de la solicitud. Verificá la hora del servidor.',
  TICKET_TIME_INVALID:
    'Se recibió un acceso de ARCA cuyas fechas no pudimos validar. El resultado requiere esperar por seguridad.',
  WSAA_UNAVAILABLE:
    'El servicio de ARCA está temporalmente fuera de servicio. Esperá al menos un minuto antes de volver a probar.',
  NETWORK_ERROR: 'No pudimos comunicarnos con ARCA.',
  TICKET_STORAGE_UNAVAILABLE:
    'No pudimos recuperar o guardar el acceso de ARCA en el almacenamiento privado. Revisá el almacenamiento del servidor antes de volver a probar.',
  INVALID_RESPONSE: 'ARCA devolvió una respuesta que no pudimos validar.',
  ALREADY_AUTHENTICATED:
    'ARCA informa un acceso todavía vigente. Esperá su vencimiento antes de probar nuevamente.',
  WAITING:
    'Hay una autenticación vigente o con resultado incierto. Esperá hasta la fecha indicada para volver a probar.',
  EXPIRING_TICKET: 'El acceso está próximo a vencer. Esperá su vencimiento para renovarlo.',
  WSAA_ERROR: 'ARCA rechazó la conexión. Revisá el certificado y su autorización en WSASS.',
  OPENSSL_UNAVAILABLE: 'OpenSSL no está disponible en el servidor. Revisá ARCA_OPENSSL_PATH.',
  CRYPTO_UNAVAILABLE:
    'OpenSSL no pudo completar la operación en el servidor. Revisá los registros de la API.',
} as const;
export type ArcaErrorCode = keyof typeof arcaMessages;
export class ArcaError extends Error {
  constructor(public readonly code: ArcaErrorCode) {
    super(arcaMessages[code]);
    this.name = 'ArcaError';
  }
}
export interface ArcaClock {
  now(): Date;
}
export const ARCA_CLOCK = Symbol('ARCA_CLOCK');
export const systemArcaClock: ArcaClock = { now: () => new Date() };
export const TICKET_MARGIN_MS = 2 * 60 * 1000;
export const MAX_TICKET_MS = 12 * 60 * 60 * 1000;
export const UNCERTAIN_WINDOW_MS = MAX_TICKET_MS + 5 * 60 * 1000;
export const WSAA_RETRY_MS = 60 * 1000;

// WSAA specification 1.2.2, pp. 8/10. A SOAP rejection differs from an unvalidated TA.
// Network failures do not prove that loginCms was never delivered; never retry them automatically.
export function wsaaRetryCategory(code: ArcaErrorCode) {
  if (code === 'ALREADY_AUTHENTICATED') return 'EXISTING_TICKET' as const;
  if (
    [
      'NETWORK_ERROR',
      'INVALID_RESPONSE',
      'TICKET_TIME_INVALID',
      'TICKET_STORAGE_UNAVAILABLE',
    ].includes(code)
  )
    return 'UNCERTAIN' as const;
  if (code === 'WSAA_UNAVAILABLE') return 'TRANSIENT' as const;
  if (['WAITING', 'EXPIRING_TICKET'].includes(code)) return 'WAITING' as const;
  return 'CORRECTABLE' as const;
}

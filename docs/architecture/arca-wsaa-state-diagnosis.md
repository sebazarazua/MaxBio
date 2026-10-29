# Diagnóstico WSAA y preparación de Facturación V3

Consulta y trabajo local: 29/10/2026. HEAD inicial `c55f164` (`facturacion v3`), rama `main`, árbol limpio. Sin commit ni push.

## Evidencia original de la instalación local

Lectura de metadata exclusivamente; no se consultaron ni imprimieron Token, Sign, CMS, SOAP, claves, certificado completo ni URL de base.

| Campo original      | UTC                      | Buenos Aires            |
| ------------------- | ------------------------ | ----------------------- |
| lastResultCode      | WAITING                  | WAITING                 |
| authBlockedUntil    | 2026-10-30T01:58:37.421Z | 29/10/2026 22:58:37.421 |
| lastObtainedAt      | 2026-10-28T18:29:46.989Z | 28/10/2026 15:29:46.989 |
| lastTicketExpiresAt | 2026-10-29T06:29:46.875Z | 29/10/2026 03:29:46.875 |
| config.updatedAt    | 2026-10-29T13:53:37.422Z | 29/10/2026 10:53:37.422 |

Versión original de configuración: 7. Credential ACTIVE vigente hasta 27/10/2028. Audit `ARCA_WSAA_TEST_SUCCEEDED`: 28/10/2026 15:29:47.130 Buenos Aires. Último `ARCA_WSAA_TEST_FAILED`: 29/10/2026 10:53:40.653, metadata `{}`. Referencias WSFE y POS: ausentes. Cero intentos fiscales.

`artifacts/maxbio-dev.log` registra el proceso 20476 iniciado a las 10:52:55 y luego `Restarting 'dist/main.js'` mientras se atendía el POST de prueba. El BFF registra `API_UNREACHABLE (ECONNRESET)` para ese POST, seguido por `ECONNREFUSED` al leer readiness. El proceso 18016 inicia a las 10:53:40. Esto confirma un reinicio durante el intento; los logs no identifican el archivo o evento que lo provocó.

**Error WSAA original: DESCONOCIDO.** ECONNRESET es el error del transporte BFF → API, no un fault de ARCA. La reserva se confirmó antes del reinicio. No quedó evidencia de la respuesta de loginCms, ni de si llegó a generarse otro TA. No corresponde inventar NETWORK_ERROR, INVALID_RESPONSE o ALREADY_AUTHENTICATED como causa original.

El TA exitoso conocido ya había vencido antes del nuevo intento. La pérdida de aquel TA en memoria no explica por sí sola la reserva nueva. El reinicio durante el nuevo intento sí explica que sobreviva la reserva sin un resultado persistido; la eventual emisión de un TA nuevo sigue siendo incierta. El bloqueo actual es una protección justificada ante esa incertidumbre. Se conserva sin editar la configuración local.

## Fuentes oficiales consultadas

- [Índice oficial WSAA de ARCA](https://www.arca.gob.ar/ws/documentacion/wsaa.asp).
- [Especificación técnica WSAA 1.2.2](https://www.arca.gob.ar/ws/WSAA/Especificacion_Tecnica_WSAA_1.2.2.pdf), páginas 4, 8 y 10. Consulta: 29/10/2026. Establece validez de 12 horas, reutilización hasta vencer, espera mínima de 60 segundos para `wsaa.*`/`wsn.unavailable`, y corrección previa para los demás rechazos. Distingue errores del TRA de los datos de un TA recibido y requiere sincronización del reloj.
- [Manual del desarrollador WSAA, publicación 20.2.19](https://www.afip.gob.ar/ws/WSAA/WSAAmanualDev.pdf), sección 10.6. Consulta: 29/10/2026. Describe retención preventiva de 10 minutos en testing, variable sin aviso; recomienda reutilizar el TA hasta `expirationTime`. Esa ventana no demuestra que un TA haya vencido.

Los documentos no definen una política específica para un timeout local ni garantizan que una respuesta perdida implique que no se generó TA. La espera conservadora de MaxBio para resultados inciertos es una decisión local, explícita, no una regla de retry atribuida a ARCA.

## Política implementada

| Categoría                        | Códigos                                                                                                 | Conducta local                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| TA existente confirmado          | ALREADY_AUTHENTICATED                                                                                   | Conservar reserva larga; no forzar otro login. Si el TA está disponible, reutilizarlo.                                  |
| Resultado incierto               | NETWORK_ERROR, INVALID_RESPONSE, TICKET_TIME_INVALID, intento IN_PROGRESS interrumpido y WAITING legado | Conservar reserva previa al envío: 12 horas + 5 minutos desde el inicio. No retry automático.                           |
| Rechazo transitorio SOAP         | WSAA_UNAVAILABLE: wsaa.unavailable, wsaa.internalError, wsn.unavailable                                 | Pausa mínima de 60 segundos; nuevo intento manual.                                                                      |
| Rechazo corregible SOAP          | CLOCK_ERROR, SERVICE_UNAUTHORIZED, CERTIFICATE_EXPIRED/INVALID, WSAA_ERROR                              | No bloqueo de 12 horas. Corregir la causa antes de repetir; la aplicación conserva además un piso local de 60 segundos. |
| Error previo al envío            | Certificado, clave, perfil, firma o reloj local inválidos                                               | No crear una reserva de envío. Corregir la causa.                                                                       |
| TA utilizable o próximo a vencer | Caché vigente / EXPIRING_TICKET                                                                         | Reutilizar si está fuera del margen de 2 minutos; dentro del margen esperar su vencimiento real.                        |

`CLOCK_ERROR` identifica un rechazo de fechas del TRA, que no entregó TA. `TICKET_TIME_INVALID` identifica fechas inconsistentes en un TA recibido o en el proveedor de caché: no se puede inferir ausencia de TA. Antes ambos compartían CLOCK_ERROR y el bloqueo largo; esa agrupación era demasiado conservadora para el rechazo SOAP y necesaria para el resultado incierto.

No se cambia la duración de la reserva antigua ni se infiere un vencimiento nuevo a partir de un TA histórico ya expirado. No hay retry automático ni hammering. Los errores desconocidos de transporte conservan la protección.

## Estados y observabilidad

La credencial verificada históricamente se muestra por separado del acceso temporal. Solo `AUTHENTICATED`, calculado desde un TA disponible en este proceso y los controles vigentes, muestra “Acceso activo”. WAITING no implica conexión operativa.

Se reutiliza `lastResultCode`; no hay tablas, columnas ni migraciones nuevas. La reserva nueva usa `IN_PROGRESS`; un intento bloqueado no sobrescribe el resultado del login anterior. Readiness expone solamente código, fecha de intento auditado, mensaje humano y razón del bloqueo. El WAITING legado informa que no se registró la causa original. Las fechas de espera indican Buenos Aires en formato de 24 horas.

Audit registra TEST_STARTED, LOGIN_STARTED, LOGIN_SUCCEEDED/FAILED y TEST_SUCCEEDED/FAILED. El intento bloqueado registra WAITING y la fecha de reserva sin alterar la causa original. La allowlist de metadata admite únicamente códigos internos y fechas ISO; no admite cuerpos SOAP, errores arbitrarios ni secretos. Los logs de login incluyen requestId y código, y Nest identifica proceso/fecha para correlacionar reinicios.

Token/Sign siguen exclusivamente en memoria. Reinicios o varias instancias pueden perder el TA utilizable mientras permanece la reserva durable. Persistirlo requeriría diseño de secret storage cifrado, acceso, rotación y coordinación de instancias; queda como deuda de despliegue. No se resuelve guardándolo en PostgreSQL en texto plano.

## Facturas y operación segura

La factura READY de “aa” conserva una copia del cliente sin CUIT y sin condición IVA. Además faltan referencias, POS y acceso WSAA operativo. Esas causas ahora aparecen juntas antes de llamar a ARCA. La UI enlaza al cliente y aclara que hay que volver a preparar la factura para actualizar su copia fiscal. No se inventan CUIT ni opciones IVA. Las condiciones se consultan de ARCA y se revalidan al guardar.

La confirmación presenta tipo, POS, receptor/CUIT, condición IVA, neto, IVA y total. No anticipa un número fiscal: se determina dentro de la preparación serializada existente. Explica envío directo por Web Service, sin abrir página de ARCA, ambiente HOMOLOGACIÓN y ausencia de efecto fiscal real. El botón sigue bloqueado si readiness es falso.

Secuencia para una prueba futura, cuando termine la reserva:

1. Probar WSAA. Autenticación; no emite comprobante.
2. Consultar referencias: FEParamGetPtosVenta, FEParamGetCondicionIvaReceptor, FEParamGetTiposCbte y FEParamGetTiposIva. Solo consultas.
3. Confirmar un POS de homologación efectivamente informado por ARCA. Solo configuración.
4. FECompUltimoAutorizado se consulta al preparar la autorización. Solo consulta; no existe una acción separada para reservar o adelantar números en esta UI.
5. Solo con confirmación explícita, FECAESolicitar puede crear el comprobante de homologación. **Paso no ejecutado en esta tarea.**

El módulo normal conserva ArcaWsaaClient, ArcaWsfeClient y ArcaWsfeProvider reales; una regresión comprueba esas vinculaciones sin enviar tráfico. Los fakes se usan únicamente en tests.

## Verificación

Las integraciones fiscales usan bases descartables y proveedores falsos; los XML y credenciales de prueba son sintéticos. El smoke real WSAA queda deshabilitado durante esta tarea.

La verificación local con los servicios reales, sin llamar a authenticate ni a proveedores remotos, confirmó certificado/clave válidos, canTest=false, WAITING y los cinco bloqueos de la factura real. Comparó la configuración antes y después: idéntica. El total de intentos fiscales locales siguió en cero. Evidencia segura en `artifacts/wsaa-fix-local-readonly.log`.

La web y `/api/v1/health` responden HTTP 200 con el build corregido. El acceso automatizado al navegador informó que su host no estaba disponible; no se afirma una inspección visual manual. La UI se comprueba con pruebas React/JSDOM.

Regresiones agregadas: credencial histórica con WAITING sin falso “ARCA conectado”, TA disponible, causa original y razón asociada al botón deshabilitado, fecha de Buenos Aires en 24 horas, requisitos locales simultáneos sin referencias/POS, CUIT y condición IVA, readiness completo, confirmación de Web Service y homologación sin POST previo, clasificación de retry, persistencia de códigos y reserva después de reinicio, respuesta HTTP fallida con TA y UTF-8 inválido, y vinculación de proveedores reales.

Resultados ejecutados:

| Comando                            | Resultado                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| pnpm lint                          | Aprobado, exit 0                                                                     |
| pnpm format:check                  | Aprobado, exit 0                                                                     |
| pnpm typecheck                     | Aprobado, exit 0                                                                     |
| pnpm test                          | API: 141 aprobadas, 0 fallos, 2 opt-in omitidos; web: 75 aprobadas, 0 fallos         |
| pnpm test:database                 | Aprobado, exit 0: 1 prueba de database y API con 226 aprobadas, 0 fallos, 2 omitidas |
| pnpm build                         | Aprobado, exit 0; API recompilada tras el último ajuste de consulta de audit         |
| Fiscales unitarias específicas     | 19 aprobadas, 0 fallos                                                               |
| Integraciones fiscales específicas | 24 aprobadas, 0 fallos                                                               |

Los dos opt-in omitidos son el smoke WSAA real y el smoke OpenSSL independiente. Las pruebas fiscales normales sí usan OpenSSL local con certificados sintéticos, y la validación local comprobó la credencial existente.

En la suite de integración se omitieron dos opt-in ajenos a este cambio: Printing BFF real y aceptación de un archivo comercial original. No hubo fallos ni cancelaciones. El resto de las 226 integraciones de API y la prueba del paquete database pasaron.

No se hicieron llamadas reales WSAA/WSFE, FECAESolicitar ni generación de CAE real. La navegación externa se limitó a documentación. No se modificaron credenciales, WSASS, certificado, CSR, POS ni datos de la factura real. Producción intacta. Sin secretos expuestos; sin commit ni push.

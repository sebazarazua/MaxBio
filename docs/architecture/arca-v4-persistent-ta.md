# Homologación V4: TA persistente y preparación explícita de autorización

Trabajo local del 29/10/2026. HEAD inicial `ed217646d4f1a2c936f6528c01725d4a59f36ba1` (`facturacion v4`), rama main, árbol inicialmente limpio. Sin commit ni push.

## Diagnóstico de la instalación real

| Metadata inicial    | Valor UTC                | Buenos Aires            |
| ------------------- | ------------------------ | ----------------------- |
| lastResultCode      | WAITING                  | WAITING                 |
| authBlockedUntil    | 2026-10-30T01:58:37.421Z | 29/10/2026 22:58:37.421 |
| lastObtainedAt      | 2026-10-28T18:29:46.989Z | 28/10/2026 15:29:46.989 |
| lastTicketExpiresAt | 2026-10-29T06:29:46.875Z | 29/10/2026 03:29:46.875 |
| config.version      | 7                        | 7                       |

Credential ACTIVE: `e9f3ab1f-83f9-41f9-b58f-a95098286663`, CUIT 27110247244, certificado vigente hasta 27/10/2028. Perfil fiscal y certificate/key match válidos. Audit WSAA: éxito 28/10/2026 18:29:47.130Z; fallo 29/10/2026 13:53:40.653Z con metadata vacía. El diagnóstico anterior documenta el reinicio durante ese último POST; no hay código WSAA original recuperable.

Al comenzar no había persistencia de TA en esta versión ni un TA recuperable. La metadata de éxito anterior describe un acceso ya vencido; la reserva posterior sigue teniendo resultado incierto. **No se borró ni acortó la reserva.** Readiness ahora lo clasifica como `UNCERTAIN`. Para un éxito todavía vigente cuyo archivo no puede recuperarse, distingue `LOST_TICKET` y explica que se debe esperar el vencimiento.

Referencias WSFE: ausentes. POS: sin configurar. Intentos fiscales reales: cero. Las facturas READY relevadas conservan condición IVA estructurada pendiente; una conserva cliente sin CUIT y las más recientes tienen CUIT válido. No se completaron datos fiscales por inferencia. La última comprobación sobre los servicios reales detectó los mismos bloqueos, config versión 7 sin cambios, la misma ACTIVE y cero intentos fiscales. Evidencia segura: `artifacts/ta-local-readonly-final.log`.

El cursor de carga provenía de CSS: tanto `.primary-button:disabled` como `.secondary-button:disabled` usaban `cursor: wait`, incluso cuando no había petición. Se reemplazó por `not-allowed`. Solo los botones con `aria-busy=true` usan `progress` y texto de operación en curso.

## Persistencia y protección del TA

`EncryptedPrivateTicketStorage` reutiliza la frontera de `LocalPrivateCredentialStorage`. Mantiene un archivo por organización/credencial en `ARCA_CREDENTIAL_STORAGE_DIR/wsaa-tickets/<organizationId>/<credentialId>`. Si no se configuró la raíz, se usa `.maxbio-private-credentials/wsaa-tickets` en el directorio de ejecución de API, igual que el almacenamiento existente. No se agregó un secreto en `.env`, una tabla ni una columna.

El contenido se cifra con AES-256-GCM, nonce aleatorio de 96 bits y tag de autenticación de 128 bits. La clave de cifrado se deriva con HKDF-SHA256 de la clave privada existente de esa credencial, con dominio `MaxBio/WSAA/TA/v1` y contexto de organización, credencial, CUIT, servicio y ambiente. La identidad se autentica también como AAD. La clave privada no se modifica ni se genera otra. Poseer solamente el archivo cifrado no permite recuperar Token/Sign; comprometer la clave privada y la cuenta del servidor queda fuera de esa protección, como ya ocurre con la credencial ARCA.

Dentro del contenido cifrado se guardan Token, Sign, obtainedAt, expiresAt, organizationId, credentialId, CUIT, `wsfe` y `HOMOLOGATION`. La versión del archivo es `MBTA1`. No hay SOAP, CMS ni respuesta completa. El archivo no se sirve por HTTP y no hay contrato público ni endpoint para leerlo. Ningún Token/Sign se guarda en DB, audit, logs, navegador, Git o variables de entorno.

Se conservan las validaciones de rutas UUID, alcance de tenant, límites de tamaño, symlinks y permisos privados del storage existente. En POSIX, directorios 0700 y archivos 0600; en Windows se conserva la frontera de ACL del directorio privado del servidor. El despliegue debe mantener esa raíz accesible únicamente a la cuenta de API/administración. Los archivos cifrados y la clave existente pertenecen al respaldo privado del servidor. No se promete protección contra un administrador del sistema.

Las escrituras usan archivo temporal privado y reemplazo atómico. Se persiste el TA antes de confirmar SUCCESS en DB o devolver éxito al usuario. La persistencia, lectura/cleanup y retiro de credencial comparten el lock fiscal por organización. Un error de almacenamiento falla de forma cerrada con un código/mensaje interno seguro; no se sustituye por un login inmediato ni se incluye la excepción original en HTTP.

Un reinicio posterior a un éxito confirmado puede recuperar el TA. Si el proceso muere durante loginCms antes de recibir o guardar la respuesta, sigue existiendo incertidumbre: no es posible recuperar un secreto nunca recibido/persistido. Se conserva la reserva durable para ese caso.

## Recuperación y cleanup

Authenticate autoriza al caller y valida ACTIVE, CUIT, certificado y fechas. ArcaTicketProvider revisa memoria y luego intenta recuperar el archivo cifrado antes de solicitar un TA nuevo. Se validan organización, credencial, CUIT, ambiente, servicio, fechas y límites de vigencia. El margen de uso sigue en dos minutos. Un TA próximo a vencer conserva protección hasta su vencimiento real y se presenta como pendiente de renovación.

La recuperación no llama loginCms. El single-flight por identidad sigue vigente. Readiness también rehidrata desde el storage, por lo que después de un reinicio puede mostrar acceso operativo sin exigir que el usuario primero pulse “Probar conexión”. Las fechas del TA recuperado se obtienen del propio ticket validado.

Los archivos expirados o con contenido inválido se eliminan al cargarlos. Retirar/reemplazar una credencial elimina su TA antes de purgar su material privado. Cambiar CUIT elimina el TA de la identidad anterior después de confirmar el cambio de perfil, sin borrar el TA por un rollback de perfil. Readiness reintenta ese cleanup si corresponde. La eliminación es idempotente y tenant-scoped. El archivo cifrado de A no puede utilizarse para B ni otro CUIT; el contexto autenticado lo impide.

No se editó la reserva legacy local. Cuando `now >= authBlockedUntil`, deja de impedir autenticación; no requiere editar DB ni reiniciar. Se actualiza readiness aproximadamente un segundo después de retryAfter. El hook dispara una vez por fecha, cancela al desmontar y no repite consultas cada segundo si el servidor devuelve la misma fecha o hay diferencia de relojes. Las fechas de UI indican Buenos Aires en 24 horas.

## Retry

- TA válido recuperado: reutilización, sin login nuevo.
- TA próximo a vencer: esperar vencimiento real.
- ALREADY_AUTHENTICATED: conservar protección por TA existente.
- NETWORK_ERROR, INVALID_RESPONSE, TICKET_TIME_INVALID o resultado perdido: mantener reserva conservadora de 12 horas + 5 minutos desde el inicio del intento.
- TICKET_STORAGE_UNAVAILABLE tras recibir un TA: conservar la reserva; reparar storage antes de repetir.
- WSAA_UNAVAILABLE: pausa mínima de 60 segundos, intento manual posterior.
- CLOCK_ERROR de un SOAP Fault y otros rechazos corregibles: corregir la causa antes de repetir, con piso local de 60 segundos; no se les asignan 12 horas.

No hay retry automático de loginCms ni de FECAESolicitar. El auto-refresh solo consulta estado.

## Preparación de factura y numeración

Readiness presenta un diagnóstico con credencial, acceso WSAA, referencias vigentes, POS, perfil del emisor, CUIT receptor, condición IVA compatible, datos locales de factura y secuencia. Mantiene todas las razones locales aun sin referencias/POS. Se verifica moneda ARS, READY, tipo, fecha, líneas, precios/importes y las validaciones fiscales existentes.

El botón nuevo **Consultar numeración en ARCA** llama `POST /invoices/:id/fiscal/sequence`: valida ADMIN, sesión, tenant, CSRF, query y body estrictos. Usa FECompUltimoAutorizado y, si hay comprobante previo, FECompConsultar para validar fecha. **No reserva números, no crea intentos fiscales y nunca llama authorize.** Un error se muestra y mantiene la autorización deshabilitada.

El resultado diagnóstico dura cinco minutos y queda ligado a versión de factura, perfil y configuración/POS. Se invalida al cambiar ese contexto o vencer. Reiniciar API puede requerir repetir esta consulta inocua; POS continúa en PostgreSQL y el TA puede recuperarse del storage. Al autorizar se conserva además la consulta/verificación definitiva de secuencia dentro del flujo V3 existente. Los estados AUTHORIZED, REJECTED, UNCERTAIN y CONFLICT y la reconciliación no se reemplazaron ni se habilitó blind retry.

La condición IVA se elige solamente entre referencias ARCA compatibles con el tipo. No se deduce del texto libre del cliente. Para corregir el CUIT o datos congelados: Cliente → corregir → factura a DRAFT → READY para regenerar snapshot. No se modifican snapshots silenciosamente.

El primer clic en **Autorizar en ARCA** solo abre la confirmación. Se muestran tipo, receptor, CUIT, condición IVA, POS, neto, IVA y total, junto con envío directo por Web Service, ausencia de página externa, HOMOLOGACIÓN y falta de efecto fiscal real. Solo **Confirmar autorización de prueba** llama al endpoint de autorización.

## Fuentes oficiales consultadas el 29/10/2026

- [Índice WSAA](https://www.arca.gob.ar/ws/documentacion/wsaa.asp), [especificación 1.2.2](https://www.arca.gob.ar/ws/WSAA/Especificacion_Tecnica_WSAA_1.2.2.pdf) y [manual del desarrollador, sección 10.6](https://www.afip.gov.ar/ws/WSAA/WSAAmanualDev.pdf). Sustentan reutilización del TA, vencimiento de 12 horas, alreadyAuthenticated y tratamiento de los rechazos. El margen adicional para resultados inciertos es una protección local explícita, no una regla de ARCA para todo error de red.
- [Documentación de homologación](https://www.arca.gob.ar/ws/documentacion/homologacion-externa.asp) e [índice WSFE](https://www.arca.gob.ar/ws/documentacion/ws-factura-electronica.asp). Se mantuvieron las reglas fiscales V3 existentes; no se reinterpretaron vigencias tributarias a partir de índices/PDF con revisiones diferentes.
- Contratos SOAP oficiales actuales: [FEParamGetPtosVenta](https://servicios1.afip.gov.ar/wsfev1/service.asmx?op=FEParamGetPtosVenta), [FEParamGetCondicionIvaReceptor](https://servicios1.afip.gov.ar/wsfev1/service.asmx?op=FEParamGetCondicionIvaReceptor), [FECompUltimoAutorizado](https://servicios1.afip.gov.ar/wsfev1/service.asmx?op=FECompUltimoAutorizado), [FECompConsultar](https://servicios1.afip.gov.ar/wsfev1/service.asmx?op=FECompConsultar) y [FECAESolicitar](https://servicios1.afip.gov.ar/wsfev1/service.asmx?op=FECAESolicitar). Se leyeron páginas de documentación, sin invocar operaciones de negocio de producción ni enviar credenciales. Los adaptadores conservan la allowlist exacta de homologación.

PtosVenta informa números, tipo de emisión, bloqueo y baja. El adaptador sigue ofreciendo solamente los devueltos por ARCA para CAE, sin bloqueo/baja. No existe campo numérico para inventar un POS. Si no aparecen opciones, corresponde seguir la documentación oficial de homologación para los puntos de venta de esa CUIT y volver a consultar; MaxBio no crea POS ni convierte uno de Comprobantes en Línea en Web Service.

## Prueba de navegador y QA

Playwright recorrió Producto → Cliente → Remito confirmado → Factura READY → Configuración → prueba WSAA fixture → referencias → confirmación de POS fixture → consulta de numeración → primera confirmación. La creación de esos documentos se hizo con los helpers HTTP del test, y sus fichas se recorrieron en navegador. Se usó una base descartable, los servicios de aplicación reales y un proveedor fiscal falso exclusivo de tests.

La revisión automática rechazó el arranque de una segunda web con el motivo genérico `blocked by policy`. Se utilizó la web existente con un bridge de requests exclusivo de la sesión Playwright a la API descartable y una respuesta de perfil fiscal sintético; no se redirigió el runtime normal ni el navegador del usuario. Las rutas de autorización estaban además bloqueadas en ese contexto de QA.

Se verificaron en navegador cursor not-allowed para requisitos pendientes, aria-busy=true/cursor progress durante una petición, checklists y confirmación final habilitada tras la consulta de secuencia. **Se detuvo antes del segundo clic.** El test confirmó cero envíos y cero intentos fiscales para esa factura; la base se eliminó y la cookie sintética temporal se borró. Capturas: `artifacts/ta-browser-pending.png` y `artifacts/ta-browser-confirmation.png`.

La persistencia se probó con archivos cifrados reales y un proceso Node nuevo: memoria vacía, recuperación, sin ejecutar loginCms y continuidad por ArcaWsfeProvider. Incluye expiración, renovación, otro tenant/CUIT/credencial, tampering, margen próximo a vencer, cleanup, reserva legacy, protección de retry, temporizador, CSS, proveedores reales y secuencia read-only con error/expiración.

| Verificación                                          | Resultado                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------- |
| pnpm lint                                             | Aprobado, exit 0 en la verificación final                                   |
| pnpm format:check                                     | Aprobado, exit 0                                                            |
| pnpm typecheck                                        | Aprobado, exit 0 en la verificación final                                   |
| pnpm test                                             | API 144 aprobadas, 0 fallos, 2 opt-in omitidos; web 79 aprobadas            |
| pnpm test:database                                    | Paquete database 1 aprobada; API 227 aprobadas, 0 fallos, 3 opt-in omitidos |
| pnpm build                                            | Aprobado; API recompilada tras ajuste del mensaje de TA próximo a vencer    |
| Integraciones fiscales finales                        | 25 aprobadas; fixture browser omitida en esa corrida                        |
| Playwright opt-in separado                            | 1 aprobada; cero autorizaciones                                             |
| Prisma migrate status                                 | 26 migraciones, actualizado                                                 |
| Prisma migrate diff                                   | Exit 0, sin diferencias                                                     |
| Fresh install / upgrade / drift en bases descartables | Aprobados por la suite de migraciones                                       |

No hubo cambio de schema ni necesidad de nueva migración: Token/Sign se almacenan cifrados fuera de PostgreSQL. No se utilizó db push. Los opt-in normales omitidos fueron WSAA real, OpenSSL independiente, Printing BFF real y archivo comercial original; la fixture browser omitida en la suite general se ejecutó y aprobó por separado.

## Estado real y pasos pendientes

1. Esperar hasta 29/10/2026 22:58:37 Buenos Aires. Readiness se actualiza sin editar DB; no se fuerza WSAA durante la reserva.
2. Probar WSAA con la ACTIVE existente. El éxito futuro guardará el TA cifrado antes de confirmar el resultado y permitirá recuperarlo tras reiniciar API.
3. Consultar referencias reales. No se ejecutaron en esta tarea porque el acceso seguía bloqueado. Confirmar exclusivamente un POS real de homologación devuelto por ARCA.
4. Completar condición IVA compatible y revisar tipo/receptor. La factura más reciente relevada tiene CUIT válido; la anterior de “aa” aún requiere CUIT y regenerar snapshot.
5. Consultar numeración real. FECompUltimoAutorizado real quedó NO EJECUTADO por faltar TA/POS.
6. Solo cuando todos los checks estén completos, revisar la confirmación y que la persona pulse conscientemente **Confirmar autorización de prueba**.

**La instalación real todavía no está lista para el primer CAE:** quedan la espera segura y los datos/configuración pendientes. La funcionalidad se comprobó hasta la confirmación con fixtures; no se afirma una validación end-to-end contra ARCA real.

No se hicieron llamadas de negocio reales WSAA/WSFE, no se ejecutó FECAESolicitar real y no se generó CAE real. Se preservaron ACTIVE, certificado, clave, perfil e historial. El agente no modificó productos, clientes, Remitos ni facturas reales. Producción sigue técnicamente bloqueada. Sin commit ni push.

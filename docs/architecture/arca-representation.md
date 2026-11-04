# Representación fiscal entre CUIT distintos

## Diagnóstico y decisión

Antes de este cambio `ArcaCredential.cuit` identificaba simultáneamente al emisor WSFE y al titular del certificado. La instalación, activación, comprobación de archivos y validación del destino WSAA comparaban el certificado con ese CUIT. Esto impedía representar una sociedad con un certificado de una persona humana.

`cuit` conserva su significado de **emisor representado** y su vínculo con el perfil fiscal de la organización. `certificateHolderCuit` identifica el titular del certificado y el destino WSAA. La migración aditiva copia el CUIT anterior al nuevo campo; no modifica perfiles, facturas, numeración ni reservas. El fallback para filas legacy sin titular mantiene la compatibilidad con fixtures y herramientas anteriores. Las nuevas credenciales siempre guardan ambos CUIT.

Las validaciones criptográficas, vigencia, CN emitido por WSASS, coincidencia de clave, permisos ADMIN, tenant, versiones y auditoría permanecen. El ticket cifrado incorpora ambas identidades a su contexto autenticado cuando difieren. Para certificados propios, la representación del contexto sigue siendo idéntica a V4: los tickets existentes se pueden recuperar sin otro loginCms. Se mantienen single-flight, reservas durables y ventanas de espera.

WSFE recibe exclusivamente el CUIT emisor. Sus referencias conservan organización, CUIT y credencial; el punto de venta exige consulta real y confirmación humana. La preparación V6 y las validaciones de emisión permanecen.

Referencias oficiales: [WSASS y representación](https://www.afip.gob.ar/ws/WSASS/html/conceptos.html), [WSAA](https://www.afip.gov.ar/ws/documentacion/wsaa.asp), [manual WSFEv1, Auth.Cuit del representado/emisor](https://www.afip.gob.ar/ws/WSFEV1/documentos/manual_desarrollador_COMPG_v3_3.pdf).

## Importación administrativa local

Ejecutar en PowerShell desde la raíz, con acceso de propietario al servidor y los archivos. El email identifica al administrador responsable de la auditoría; este comando local es una operación de mantenimiento del servidor, no una autenticación remota por email. El administrador debe estar activo. No se pasan secretos como argumentos, variables de entorno ni contenido al navegador.

```powershell
pnpm arca:import --organization max-bio-sa --create-organization --issuer-name "MAX BIO S.A." --issuer-cuit 30719253136 --holder-cuit 20172868186 --actor-email admin@maxbio.local --key "C:/Users/sebas/.maxbio-private-credentials/javier-homologacion/maxbio-javier-homo.key" --csr "C:/Users/sebas/.maxbio-private-credentials/javier-homologacion/maxbio-javier-homo.csr" --certificate "C:/Users/sebas/.maxbio-private-credentials/javier-homologacion/maxbio-javier-homo.crt"
```

El comando verifica tamaños, enlaces simbólicos y permisos POSIX, certificado/clave, firma y clave pública del CSR, CUIT titular, vigencia e issuer de homologación `Computadores Test / AFIP / AR`. La aceptación local no sustituye la verificación remota WSAA. No genera claves ni CSR. Copia los archivos al almacenamiento privado existente, separado por UUID de organización; la base sólo conserva referencias y metadatos. Los buffers privados se limpian al finalizar. En Windows los permisos efectivos dependen de la ACL de la carpeta privada existente; debe ser accesible sólo al propietario/servicio.

Sin organización existente, `--create-organization` y `--issuer-name` crean una organización, perfil mínimo con los datos declarados y pertenencia ADMIN para el actor. No copian domicilio, condición fiscal, productos, clientes o documentos de otra organización. Una organización existente debe tener el CUIT indicado y una pertenencia ADMIN del actor; el comando no sobrescribe su perfil.

La importación deja `CERTIFICATE_INSTALLED`; no activa ni reemplaza credenciales. Repetir con el mismo certificado e identidades reutiliza la fila. Otra credencial pendiente bloquea la importación. Un fallo transaccional revierte fila y auditoría y elimina únicamente archivos nuevos no referenciados. La sesión de mantenimiento se revoca al finalizar.

Después de completar el perfil fiscal real, activar explícitamente desde **Configuración → Conexión con ARCA**. Para una organización sin credencial activa también se admite repetir el comando con `--activate`. Este flag se niega a reemplazar una credencial activa: ese reemplazo usa la UI con sus controles de versión. Para comprobar WSAA y consultar referencias/puntos, repetir con `--check` (y `--activate` si corresponde). La prueba de conexión y la consulta de referencias exigen razón social y CUIT emisor válido, no el perfil fiscal completo; la preparación y la autorización de comprobantes siguen exigiendo perfil `COMPLETE`. Estos flags respetan tickets vigentes y reservas: con un TA vigente no se envía `loginCms`. No eliminan esperas ni configuran automáticamente un punto de venta.

`--status` imprime el estado de credenciales, TA (restaurado del almacenamiento cifrado) y WSFE leyendo sólo la base y el almacenamiento privado, sin contactar ARCA. Se puede combinar con `--check`; en ese caso el estado se imprime antes de la consulta remota.

El CLI no contiene ninguna llamada a `authorize` ni `FECAESolicitar`. `--check` sólo llama a autenticación WSAA y lectura WSFE. No opera en producción.

## Aislamiento de las dos entidades

La organización legacy con slug `maxbio` tiene el perfil Adriana Lucía Leis, CUIT `27110247244`, y documentos históricos de Bourbon. Se conserva con su nombre, perfil, credenciales, punto de venta, reservas y documentos. MAX BIO S.A. usa otra organización, slug `max-bio-sa`, CUIT `30719253136`, y titular `20172868186`. No hay traslado ni conversión de documentos. El administrador puede elegir organización al iniciar sesión; una sesión ya abierta debe cerrarse y volver a entrar para ver la nueva pertenencia.

No completar el perfil de MAX BIO S.A. copiando los datos de Bourbon. Se necesitan IVA, domicilio fiscal completo y régimen/número de Ingresos Brutos confirmados por una persona responsable. Hasta entonces la credencial importada puede conservarse pendiente y la emisión permanece bloqueada.

## Verificación

Las pruebas cubren el caso legacy, representación Javier/MAX BIO, clave o CSR ajenos, titular incorrecto, vigencia futura/vencida, producción, destino WSAA incorrecto, rechazo remoto, aislamiento de tenant y del ticket cifrado, recuperación después de reiniciar, permisos, auditoría atómica e importación idempotente. Las suites existentes verifican reemplazo, concurrencia, reservas/reintentos, puntos de venta y ausencia de puntos. Los escenarios nuevos no crean facturas ni intentos fiscales.

## Cierre de la implementación (2026-11-04)

### Estado inicial

Rama `main` limpia en `a85b8a1` (`cambios en configuracion hasta ahora`), sin archivos sin rastrear. El commit contenía la implementación completa descrita arriba. La base local ya tenía aplicada la migración `20261104193000_certificate_holder_identity` (20:06 UTC) y, en la sesión anterior, se habían ejecutado la creación de `max-bio-sa`, la importación, la activación, un `loginCms` real y una consulta de referencias WSFE (auditoría de 20:13–20:16 UTC).

### Problemas detectados y correcciones

- `wsfe-migration.integration.ts` fallaba: insertaba una credencial con el cliente Prisma actual sobre un esquema anterior a la migración (`column certificateHolderCuit does not exist`). Se reemplazó por un `INSERT` SQL, igual que `fiscal-migration.integration.ts`, y ahora verifica que el backfill deje titular = emisor para credenciales legacy. Sólo cambia la prueba.
- El CLI reducía a un mensaje genérico los `ArcaError` producidos en la validación previa (por ejemplo `KEY_MISMATCH` frente a `CUIT_MISMATCH`). Ahora imprime también ese mensaje del catálogo fijo `arca-errors.ts`, que no contiene secretos, rutas ni stderr.
- Se agregó `--status` (sólo lectura) para comprobar el TA vigente antes de cualquier operación remota.
- La documentación afirmaba que `--check` exigía perfil completo; se corrigió (ver arriba).

No se encontraron errores en la separación de identidades: WSAA valida `destination` contra el titular (`20172868186`); `authenticate()` devuelve el CUIT emisor; `ArcaWsfeProvider` envía `Auth.Cuit` emisor (`30719253136`) y rechaza discrepancias con el emisor del comprobante; la facturación toma el emisor del perfil fiscal.

### Pruebas ejecutadas (simuladas, sin ARCA)

| Verificación                                            | Resultado                                                                                                                           |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                                     | OK                                                                                                                                  |
| `pnpm lint`                                             | OK                                                                                                                                  |
| `pnpm typecheck`                                        | OK                                                                                                                                  |
| `pnpm test`                                             | API 148/150 OK, 2 omitidas opt-in (smoke WSAA real y OpenSSL real); web 90/90 OK                                                    |
| `pnpm build`                                            | OK                                                                                                                                  |
| Integración con bases temporales `maxbio_*_test_<uuid>` | 145 pruebas: 143 OK, 0 fallas, 2 omitidas opt-in (Playwright, BFF de impresión). Antes de la corrección: 1 falla (`wsfe-migration`) |

No se ejecutó `pnpm test:database` completo: `catalog`, `customers`, `identification`, `identity` y `supplier-catalog` escriben en la base indicada por `DATABASE_URL` (la base real de desarrollo). Las organizaciones `identification-*` y `supplier-catalog-*` que existen en la base real provienen de corridas anteriores de esas suites. También quedan bases temporales `maxbio_*_migration_*` de corridas previas interrumpidas; no se eliminaron.

### Base real

- Migraciones: 28 de 28 aplicadas, `prisma migrate status` sin diferencias. `certificateHolderCuit` presente; las credenciales de Bourbon tienen titular = emisor.
- `maxbio` (Adriana Lucía Leis, `27110247244`, Ortopedia Bourbon): perfil sin cambios desde 2026-10-28, credenciales intactas (1 `ACTIVE`, 1 `REPLACED`, 1 `DISCARDED`). Su TA, obtenido antes de la migración, se restauró después de ella sin `loginCms`.
- `max-bio-sa` (MAX BIO S.A., `30719253136`): única pertenencia ADMIN `admin@maxbio.local`, el único administrador real (los demás usuarios son fixtures `@example.invalid`). Sin clientes ni facturas copiados. El domicilio fue cargado con `source: user-confirmed-address`. **Pendientes:** condición frente al IVA, régimen y número de Ingresos Brutos y actividades; el perfil queda `INCOMPLETE`.
- Credencial `a0ff6e6d-…b393`: `ACTIVE`, CN `maxbiohomojavier`, titular `20172868186`, emisor `30719253136`, autoridad `Computadores Test / AFIP / AR`, vigencia 2026-11-04 → 2028-11-03. El fingerprint SHA-256 coincide con el `.crt` original. Los originales se conservan sin modificaciones. Repetir el comando documentado devuelve `imported:false` (idempotente), y las sesiones de mantenimiento quedan revocadas.

### Consultas reales a ARCA homologación

- WSAA: TA vigente obtenido a las 20:16:31 UTC, vence `2026-11-05T08:16:30Z`. A las 20:52 UTC `--check` lo **reutilizó**: hubo `ARCA_WSAA_TEST_*` y no hubo `ARCA_WSAA_LOGIN_STARTED`. ARCA aceptó la representación: WSFE respondió a `Auth.Cuit=30719253136` usando el TA del certificado de `20172868186`.
- WSFE (`FEParamGet*`): se recibieron tipos de comprobante, alícuotas de IVA y condiciones del receptor reales.
- Puntos de venta (`FEParamGetPtosVenta`): **`[]`**, igual que para Bourbon (`27110247244`). El punto `00001` RECE de MAX BIO S.A. está dado de alta administrativamente en producción, pero el padrón de homologación no lo informa. Este resultado coincide con el de Bourbon, lo que indica un comportamiento del ambiente y no un fallo de la representación. MaxBio sólo acepta puntos informados por `FEParamGetPtosVenta`, por lo que la emisión en homologación queda bloqueada en el paso del punto de venta para ambas organizaciones.
- No se llamó a `FECAESolicitar` ni a ninguna operación de autorización. `InvoiceFiscalAttempt` = 0.

### Próximos pasos para una factura de homologación

1. Persona responsable: confirmar condición frente al IVA, régimen y número de Ingresos Brutos (y actividades, si corresponde) de MAX BIO S.A., y cargarlos en Configuración. No copiar los de Bourbon.
2. Decisión de producto sobre el punto de venta en homologación: (a) mantener la regla estricta y, por lo tanto, no emitir en homologación mientras ARCA no informe puntos; o (b) admitir, sólo en homologación, un punto confirmado por una persona y validado con la consulta de lectura `FECompUltimoAutorizado`. La opción (b) requiere un cambio de código explícito y revisado.
3. Con el perfil `COMPLETE` y el punto resuelto, seguir este flujo: factura interna → preparación fiscal → TA vigente → referencias (TTL de 15 min) → punto → numeración → autorización con confirmación humana explícita.

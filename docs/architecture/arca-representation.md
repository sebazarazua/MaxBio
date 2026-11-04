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

Después de completar el perfil fiscal real, activar explícitamente desde **Configuración → Conexión con ARCA**. Para una organización sin credencial activa también se admite repetir el comando con `--activate`. Este flag se niega a reemplazar una credencial activa: ese reemplazo usa la UI con sus controles de versión. Para comprobar WSAA y consultar referencias/puntos, repetir con `--check` (y `--activate` si corresponde). Estos flags mantienen los requisitos existentes de perfil completo y respetan las reservas. No eliminan esperas ni configuran automáticamente un punto de venta.

El CLI no contiene ninguna llamada a `authorize` ni `FECAESolicitar`. `--check` sólo llama a autenticación WSAA y lectura WSFE. No opera en producción.

## Aislamiento de las dos entidades

La organización legacy con slug `maxbio` tiene el perfil Adriana Lucía Leis, CUIT `27110247244`, y documentos históricos de Bourbon. Se conserva con su nombre, perfil, credenciales, punto de venta, reservas y documentos. MAX BIO S.A. usa otra organización, slug `max-bio-sa`, CUIT `30719253136`, y titular `20172868186`. No hay traslado ni conversión de documentos. El administrador puede elegir organización al iniciar sesión; una sesión ya abierta debe cerrarse y volver a entrar para ver la nueva pertenencia.

No completar el perfil de MAX BIO S.A. copiando los datos de Bourbon. Se necesitan IVA, domicilio fiscal completo y régimen/número de Ingresos Brutos confirmados por una persona responsable. Hasta entonces la credencial importada puede conservarse pendiente y la emisión permanece bloqueada.

## Verificación

Las pruebas cubren el caso legacy, representación Javier/MAX BIO, clave o CSR ajenos, titular incorrecto, vigencia futura/vencida, producción, destino WSAA incorrecto, rechazo remoto, aislamiento de tenant y del ticket cifrado, recuperación después de reiniciar, permisos, auditoría atómica e importación idempotente. Las suites existentes verifican reemplazo, concurrencia, reservas/reintentos, puntos de venta y ausencia de puntos. Los escenarios nuevos no crean facturas ni intentos fiscales.

Los resultados de ejecución y el estado real de la configuración local se registran al finalizar en esta sección.

# Configurar autenticación ARCA de homologación

V2 permite preparar el acceso de prueba. No emite facturas. Requiere ADMIN de la organización y un paso humano en ARCA. MaxBio nunca solicita ni almacena clave fiscal, contraseña, MFA o cookies del portal ARCA.

## Preparar el servidor

Aplicar `pnpm db:migrate` (Prisma Migrate, no db push). Instalar una rama mantenida de OpenSSL 3.x o superior (preferentemente 3.5 LTS; también se verificó 4.1.0 con `req`, `x509` y `cms`) y configurar su ejecutable en PATH o `ARCA_OPENSSL_PATH` en el entorno de API. En este Windows las pruebas encontraron 3.2.3 en `C:\Program Files\Git\usr\bin\openssl.exe`; esa rama está fuera de soporte. Actualizar o elegir una instalación mantenida antes de operar con credenciales reales. Reiniciar la API después de cambiar configuración.

En desarrollo, definir `ARCA_OPENSSL_PATH=C:/Program Files/OpenSSL-Win64/bin/openssl.exe` (con `/`) en el `.env` privado de la raíz: `pnpm dev` y `pnpm start` lo cargan con `node --env-file` y una variable real del proceso tiene precedencia. Nest no lee archivos `.env`; valida el entorno del proceso, por lo que producción usa sus variables reales y los tests unitarios no dependen del `.env` local. Al arrancar, la API registra si OpenSSL está disponible (sin bloquear el arranque) y **Conexión con ARCA** muestra `OpenSSL no disponible` y deshabilita **Generar solicitud** si el ejecutable no existe, no puede ejecutarse o le faltan `req`, `x509` o `cms`. MaxBio invoca OpenSSL con `OPENSSL_WIN32_UTF8=1` para que OpenSSL for Windows reciba los argumentos en UTF-8 (nombres fiscales con tildes o ñ). Smoke opcional con el ejecutable real: `MAXBIO_OPENSSL_SMOKE=1` y `node --env-file=../../.env --test dist-test/test/environment.test.js` en `apps/api` después de compilar con `pnpm exec tsc -p tsconfig.test.json`.

El almacenamiento predeterminado es `.maxbio-private-credentials` respecto del directorio de ejecución de API. `ARCA_CREDENTIAL_STORAGE_DIR` permite elegir un directorio privado persistente. Nunca ubicarlo dentro de una carpeta pública. Restringir ACL de Windows a la cuenta de servicio y administradores autorizados; POSIX aplica 0700/0600. Respaldar directorio y DB juntos. Mantener la hora del servidor sincronizada.

## Pasos de la persona administradora

1. En MaxBio, abrir **Configuración → Datos fiscales** de la organización correcta. Completar nombre fiscal, CUIT, IVA, domicilio y régimen/número IIBB. Guardar y verificar estado completo.
2. En **Conexión con ARCA**, conservar **Homologación**, revisar el nombre del sistema (por ejemplo `MaxBio Homologacion`) y seleccionar **Generar solicitud**. MaxBio genera la clave exclusivamente en el servidor.
3. Seleccionar **Descargar archivo para ARCA**. Es el CSR público; no incluye la clave privada. Conservar la solicitud pendiente y evitar regenerarla mientras se tramita su certificado.
4. Ingresar **manualmente** al portal oficial de ARCA desde el navegador propio, con la identidad habilitada para gestionar esta organización.
5. Abrir **WSASS / Autoservicio de Acceso a APIs de Homologación**. Si el servicio no está habilitado, realizar su adhesión mediante las opciones oficiales de la cuenta. No usar el administrador de certificados de producción.
6. En WSASS, elegir **Crear certificado** y cargar el contenido del CSR de MaxBio. Revisar alias, CUIT y entorno. Seguir el [manual oficial](https://www.arca.gob.ar/ws/WSASS/html/crearcertificado.html).
7. Elegir **Crear Autorización a Servicio**. Seleccionar el alias/certificado correspondiente, el CUIT representado de la organización y el servicio **Facturación Electrónica / wsfe**. El nombre de autenticación es `wsfe`, aunque el servicio comercial futuro se llama WSFEv1. Crear la autorización y revisar los datos antes de confirmar; ver [instrucciones oficiales](https://www.arca.gob.ar/ws/WSASS/html/crearautorizacion.html).
8. Descargar el certificado de homologación entregado por ARCA. No descargar ni cargar claves privadas/PFX ni archivos ZIP en MaxBio.
9. Volver a la misma organización de MaxBio y usar **Cargar certificado** (PEM/CRT/DER, hasta 100 KiB). MaxBio verifica contenido, fechas, CUIT y correspondencia criptográfica con la clave de esa solicitud. Después seleccionar **Activar credencial de homologación**. Una activación reemplaza expresamente a la anterior y conserva su historial.
10. Seleccionar **Probar conexión con ARCA**. Solo un resultado correcto con fecha vigente confirma autenticación operativa en homologación. Los secretos del ticket permanecen en API. V1 continúa siendo factura interna sin validez fiscal.

La interfaz principal usa nombres humanos; **Información técnica** muestra huella, emisor y vigencia, sin claves ni tickets. [Manual general WSASS](https://www.arca.gob.ar/ws/WSASS/html/index.html).

## Datos reales suministrados para Bourbon

Estos valores son referencia documental aportada por la empresa; **no se cargan automáticamente** ni son defaults multi-tenant. Usarlos únicamente en la organización que corresponda inequívocamente a Bourbon y revisar su vigencia con la persona responsable.

| Campo                             | Valor de referencia                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| Nombre fiscal / titular           | Adriana Lucía Leis                                                                   |
| Nombre comercial                  | ORTOPEDIA BOURBON                                                                    |
| CUIT                              | 27-11024724-4 (canónica 27110247244)                                                 |
| Tipo de persona                   | Física / unipersonal; no se exige persona jurídica en MaxBio                         |
| IVA                               | Responsable inscripto                                                                |
| Domicilio fiscal                  | Bogotá 2314, piso 1, departamento/oficina 5                                          |
| Localidad / Provincia / CP / País | CABA / CABA / 1406 / Argentina                                                       |
| Ingresos Brutos                   | Convenio Multilateral                                                                |
| Número IIBB documentado           | 901-034461-6                                                                         |
| Sede documentada                  | 901 - CABA (referencia, no código de autenticación)                                  |
| Actividad fiscal nacional         | 477330 — venta minorista de instrumental médico/odontológico y artículos ortopédicos |
| Actividad Convenio Multilateral   | 464330 — venta mayorista de instrumental médico/odontológico y artículos ortopédicos |

El establecimiento de Adolfo Alsina 1431/1433, 4.º piso, departamento A / UF 8, CABA, es comercial/depósito: no reemplazar silenciosamente el domicilio fiscal documentado. GS1 prefix 830044, GLN 7798300440000 y ANMAT Legajo 1038 / Disposición 0892/17 no se usan para ARCA.

## Errores y rotación

- Certificado de otra solicitud: volver al archivo correcto; las claves de distintas solicitudes no son intercambiables.
- Certificado vencido: generar otra credencial, tramitar su certificado, instalarlo y activarlo. No se reusa silenciosamente la clave vieja.
- Servicio no autorizado: revisar manualmente la autorización WSASS del alias y CUIT representado para wsfe. Un archivo válido por sí solo no concede acceso.
- Hora rechazada: corregir el reloj del servidor.
- Conexión interrumpida, reinicio o acceso ya vigente: respetar la fecha que muestra MaxBio antes de reintentar. El ticket no persiste en DB; una reserva de fechas evita pedir duplicados mientras pueda existir un TA vigente.
- Los últimos 2 minutos del ticket se reservan como margen; se renueva después de vencer, siguiendo WSAA. No hay reintentos automáticos.
- Si hay conflicto de versión, usar **Cargar información actual** y revisar antes de repetir la acción.

## Smoke real opcional

La suite normal usa certificados efímeros y servidor HTTP simulado; el smoke real figura **SKIP**. No se ejecutó autenticación real en esta implementación porque no se suministraron certificado de homologación ni autorización WSASS confirmada.

Solo cuando la persona solicite la prueba, con API local iniciada, certificado activo y sesión ADMIN vigente, definir temporalmente `MAXBIO_ARCA_HOMO_SMOKE=1`, `MAXBIO_ARCA_HOMO_SMOKE_COOKIE` (cookie de esa sesión, nunca una cookie de ARCA) y opcionalmente `MAXBIO_ARCA_HOMO_SMOKE_API_BASE`. Ejecutar desde `apps/api`, después de compilar tests: `node --env-file=../../.env --test dist-test/test/arca-smoke.test.js`. No copiar cookies a Git, archivos de configuración o tickets de soporte; eliminar las variables temporales al finalizar. El smoke omite explícitamente la prueba si falta sesión o preparación. Solo invoca readiness/loginCms; no emite comprobantes.

Las fuentes, versiones consultadas el 27/10/2026 y decisiones de protocolo están en [arca.md](arca.md#fuentes-oficiales-consultadas).

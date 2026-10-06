# Verificación de MaxBio

## Product Identification — segundo incremento, 6 de octubre de 2026

Windows, Node 22.18.0, pnpm 11.9.0 y PostgreSQL 17.9. Estado inicial de Git limpio. Sin commit/push ni cambios a secretos/.gitignore. Se preservaron la web existente en 3000 y los contenedores ajenos. El watcher original de API quedó sin listener después de recompilaciones; al finalizar se reinició solo ese proceso mediante `pnpm dev:api`, con API recuperada en 3001 y health/database ok. Fixture propio con ADMIN/OPERATOR y Docker Compose `maxbio-identification-verify`, puerto 15439. Web/API de prueba en 3010/3011; build aislado con `MAXBIO_BUILD_DIR=.next/identification-build` y dev con `.next/identification-verify`, dentro del directorio ignorado.

| Comando/comprobación realmente ejecutada | Resultado                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm lint                                | Correcto, incluida prohibición de Prisma/DB en web.                                                                                                                                                                            |
| pnpm format:check                        | Correcto, después de formatear cambios y documentos.                                                                                                                                                                           |
| pnpm typecheck                           | Correcto en cuatro paquetes/apps con código final.                                                                                                                                                                             |
| pnpm test                                | 33/33 pruebas unitarias/HTTP sin DB.                                                                                                                                                                                           |
| pnpm test:database                       | 1/1 database + 70/70 integración API, sin skips. Regresión Identity/Catalog/imports y 15 pruebas nuevas de identificación.                                                                                                     |
| pnpm build                               | Correcto; /identificar incluida. Build aislado conserva dev existente.                                                                                                                                                         |
| Prisma Migrate                           | Migración nueva generada por migrate diff contra las cuatro anteriores, SQL revisado y CHECKs antes de aplicar; deploy en fixture y base local existente. Sin db push ni edición de migraciones anteriores.                    |
| Migraciones desde cero                   | Cinco migrations aplicadas a maxbio_identification_fresh vacía; migrate status actualizado y diff --exit-code sin diferencias.                                                                                                 |
| Resolve                                  | KNOWN/UNKNOWN/CANDIDATES/ARCHIVED/AMBIGUOUS/INVALID/UNSUPPORTED, GTIN equivalente canonical14, reserva histórica y cero escrituras de negocio/auditoría.                                                                       |
| Concurrencia                             | Doble submit/retry misma clave: un recibo, mismos IDs y auditoría única. Mismo GTIN/dos Products y misma referencia/dos empleados: un 200, otro 409, sin parciales.                                                            |
| Rollback                                 | Fallo inyectado en tercer evento revierte Product/Identifier/SupplierProduct/referencia/recibo/eventos. Versiones obsoletas y clasificación ajena también rechazan.                                                            |
| Roles/tenant/DB                          | OPERATOR confirma workflow, sigue recibiendo 403 en CRUD ADMIN/importaciones. API y FKs PostgreSQL rechazan cruces de tenant/proveedor; CHECK externo rechaza bypass de GTIN.                                                  |
| Importación regresión                    | 5.000/10.000 referencias sin Products nuevos; reimportación conserva asociación/identidad.                                                                                                                                     |
| Navegador                                | Chrome mediante agent-browser; carga/login/navegación sin errores JS ni overlay. ADMIN crea proveedor e importa CSV real de dos filas; OPERATOR identifica y confirma.                                                         |
| Scanner simulado                         | Código + Enter por teclado; autofocus/restauración/select del input. Dos submits consecutivos: una solicitud resolve. Dos clicks consecutivos: una solicitud confirm. Enter en búsqueda conserva lectura sin disparar scanner. |
| Mobile/React                             | 390×844, scrollWidth 390; controles etiquetados, estado aria-live, teclado local y ref síncrono. Revisión react-best-practices y capturas visuales.                                                                            |

Recorrido real: ADMIN creó **Proveedor Walker HID**, importó DL2115/DL2116 mediante Archivo → Columnas → Revisar → Confirmar. DB: dos referencias, cero Products/Identifiers/SupplierProducts/recibos. OPERATOR ingresó GTIN desconocido `5901234123457`, buscó DL2115 y presionó Enter en la búsqueda sin nueva resolución. Seleccionó referencia, comparó, eligió nuevo Product **Bota Walker corta**, cambió unidad a PAIR, revisó y confirmó. DB: un Product, un ProductIdentifier, un SupplierProduct, un recibo y tres eventos semánticos. Mismo GTIN + Enter: Product reconocido; lista muestra Asociado y filtros ASSOCIATED/UNASSOCIATED retornan cada referencia correspondiente.

Luego OPERATOR agregó `MB-WALKER-HID` y `EXT-WALKER` con proveedor explícito a la referencia ya asociada. Se conservó el mismo Product y código principal DL2115. La ficha mostró GTIN + MB- + código externo/proveedor. Resultado final: un Product, dos ProductIdentifier, un SupplierScanIdentifier, un SupplierProduct, tres recibos; un evento de Product nuevo, uno de asociación y tres de identificador. Repetir lecturas no cambió esos registros. Checksum inválido se mostró como Lectura inválida; proveedor/código editado vacía resultado anterior y exige resolver nuevamente.

Capturas locales ignoradas: `artifacts/identification-initial.png`, `identification-review.png`, `identification-known.png`, `identification-associated.png`, `identification-mobile-final.png`, `identification-mobile-known-final.png`, `identification-product.png`. Fixture de credenciales local eliminado y stack temporal cerrado al terminar. La base habitual quedó migrada; no se alteraron datos de negocio existentes.

Límites: **no hubo scanner físico**; teclado simuló HID. Falta probar layout/prefijos/terminador/velocidad con equipo real, cámara y parser GS1 completo. Externos requieren proveedor y no hay endpoint administrativo para liberar/reasignar su reserva. Sin Inventory/Stock/Remitos/tablas físicas. pg/Prisma emite la advertencia previa de query concurrente en pruebas; agent-browser advierte engine >=24 frente a Node22 del repo, aunque las operaciones ejecutadas funcionaron. No se afirma auditoría WCAG completa ni despliegue remoto.

Reproducción aislada: fijar POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB de fixture y POSTGRES_PORT=15439, `docker compose -p maxbio-identification-verify --env-file .env.example up -d --wait`; DATABASE_URL de ese fixture, `pnpm db:migrate` y los seis comandos de calidad. Para navegador, API_PORT=3011, WEB_ORIGIN=http://localhost:3010; web API_BASE_URL=http://127.0.0.1:3011, mismo WEB_ORIGIN y MAXBIO_BUILD_DIR dentro de .next; `pnpm exec next dev --hostname 127.0.0.1 --port 3010` desde apps/web. No versionar usuarios/passwords/env de prueba. Modelo y procedimiento en [product-identification.md](product-identification.md).

## Supplier Catalog — evidencia nueva de esta notebook, 6 de octubre de 2026

Windows, Node 22.18.0, pnpm 11.9.0, Docker Desktop 28.5.1 y PostgreSQL 17.9. `.env` y configuración web local estaban presentes; no se imprimieron credenciales ni se modificaron esos archivos. La DB local existente recibió la migración. Las pruebas usan fixtures propios en bases temporales, sin datos privados ni usuarios/bootstrap anteriores. Sin commit/push.

| Comando/comprobación realmente ejecutada                                             | Resultado final                                                                                                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                     | Exit 0, antes de cambios y con lockfile final; resolución reproducible.                                                                       |
| `pnpm lint`                                                                          | Exit 0; sin errores de ESLint.                                                                                                                |
| `pnpm format:check`                                                                  | Exit 0; todos los archivos coinciden con Prettier.                                                                                            |
| `pnpm typecheck`                                                                     | Exit 0, contratos/database/API/web; Next typegen.                                                                                             |
| `pnpm test`                                                                          | Exit 0, 29/29, sin skips. 12 pruebas nuevas de Supplier Catalog más las 17 existentes.                                                        |
| `pnpm test:database`                                                                 | Exit 0: database 1/1 y API 55/55 (12 nuevas más 43 existentes), sin skips.                                                                    |
| `pnpm build`                                                                         | Exit 0; Prisma generado, paquetes/API compilados y Next build con las nuevas rutas.                                                           |
| `prisma format`, `pnpm prepare:packages`, compilaciones dirigidas                    | Exit 0 en comprobaciones finales.                                                                                                             |
| `prisma migrate dev --name supplier_catalog --create-only`                           | No ejecutó creación: rechazado por CLI no interactivo. Se utilizó el procedimiento diff/deploy siguiente.                                     |
| `prisma migrate diff --from-config-datasource --to-schema ... --script --output ...` | Exit 0 contra temporal con las tres migraciones previas; SQL revisado y CHECKs incluidos antes de aplicar.                                    |
| `prisma migrate deploy` sobre DB local `maxbio`                                      | Exit 0; nueva migración aplicada, sin editar migraciones previas.                                                                             |
| `prisma migrate deploy` en temporal `maxbio_verify`                                  | Exit 0; cadena previa y después nueva migración.                                                                                              |
| `prisma migrate deploy` desde cero en `maxbio_supplier_catalog_fresh`                | Exit 0; las cuatro migraciones; `prisma migrate status` confirmó actualizado.                                                                 |
| `pnpm catalog:cleanup`                                                               | Exit 0; CLI inicial sin vencidos. Caso posterior eliminó 1 upload/1 preview/1 fila vencidos y conservó 1 import confirmado/4 filas/1 Product. |
| `pnpm audit --prod --json`                                                           | Exit 1: 2 high y 1 moderate **preexistentes**, transitivas de Prisma, detalladas debajo. Ningún aviso en nuevas dependencias.                 |
| `git diff --check`                                                                   | Exit 0; sin errores de whitespace.                                                                                                            |

Se ejecutaron también metadata npm, revisión de las fuentes/dependencias, creación de fixtures OOXML/CSV, Docker Compose temporal, consultas PostgreSQL y comandos browser descritos a continuación. Los logs y capturas son locales en `artifacts/supplier-catalog-*`; el directorio continúa ignorado. Scripts/configuración privados no se agregan a Git.

### Casos de importación e invariantes

CSV: UTF-8/BOM, delimitadores, comillas, códigos con ceros/case/puntuación, mapeo corregible, vacías y errores/longitudes/límites. XLSX: varias hojas y elección, encabezados con título, ceros textuales, fila original/vacías finales; rechazo de ZIP inválido, macros, fórmulas, links/DTD/entidades, expansión y coordenadas dispersas incluso codificadas. Contratos estrictos/paginación/rutas explícitas.

Pruebas de DB/HTTP comprueban:

- Inspect/preview no escriben referencias ni Products. Importar una fila y **5.000 filas** crea cero Products, ProductIdentifiers y SupplierProducts; Product existente y vínculo ya confirmado permanecen intactos. Consultar schema verifica que no se crearon tablas de Inventory/Stock/movimientos/lotes/series.
- 5.000 referencias/observaciones se confirman y paginan; última medición **2457 ms** incluyendo inspect + preview + commit + consultas/assertions. Es una medición local, no un SLO ni tiempo aislado de transacción.
- Máximo **10.000 filas**, tanto alta como actualización en lote: pasa sin duplicados ni Products nuevos.
- Reimportación idempotente de datos, modificación solo de referencia, opcionales no mapeados conservados y GTIN inválido textual con advertencia.
- Parcial conserva ausentes; completa marca ausencia separada de archivedAt; completa con errores excluidos no cambia indicadores de completitud.
- ADMIN puede importar; OPERATOR lee/busca/abre y sus POST son 403, reforzado en application.
- IDs ajenos dan 404; FKs reales rechazan item/proveedor de distinto tenant, procedencia de pertenencia ajena y fila/item de otro proveedor.
- Hash incorrecto/DTO alterado/preview obsoleto/expirado rechazados; dos imports concurrentes mismo código producen un ganador; doble commit del mismo preview produce un evento; archivado no libera unique.
- Evento con actor/sesión/tenant/proveedor/import/cantidades y claves allowlisted. Fallo inyectado de auditoría revierte referencias, ausencias, vínculos de observaciones y estado del import.
- Filas históricas distinguen CREATED/UPDATED/UNCHANGED/DUPLICATE/EMPTY/ERROR/CONFLICT y ofrecen paginación/filtros.

### Evidencia visual y flujo real

Se aplicaron las skills agent-browser, agent-browser-verify, verification y react-best-practices. Se inició API/Next en **desarrollo** contra DB temporal, con origen localhost y variables temporales explícitas. Se utilizó una sesión browser dedicada y usuarios ADMIN/OPERATOR de fixture con contraseña aleatoria local; no credenciales privadas.

- Login visible y funcional; página con contenido, sin overlay ni errores de página; consola solo mensajes normales React/HMR.
- ADMIN abrió ficha → Catálogo → Importar lista → archivo CSV → columnas sugeridas/corregibles → preview (4 filas, 2 nuevas, 1 repetida, 1 vacía, 1 advertencia GTIN) → Confirmar → resultado → historial de filas.
- UI y consultas DB tras confirmar: **Products antes/después = 1**, referencias = 2, identifiers = 0, SupplierProducts = 0, imports confirmados = 1, evento de importación = 1.
- OPERATOR inició sesión, buscó DL2115 en referencias globales, abrió ficha, abrió catálogo de proveedor y buscó walker. Vio referencias «Sin asociar» con ayuda contextual, sin acciones de importación.
- Se inspeccionaron capturas de login/preview y catálogo en escritorio/móvil (390×844), con tabla de scroll horizontal local. Revisión básica de etiquetas, encabezados, feedback y navegación. No se afirma auditoría WCAG completa: el comando a11y del CLI devolvió cero checks/passes y no se utilizó como evidencia de conformidad.
- Un 503 transitorio ocurrió mientras el watch recompilaba/reiniciaba la API. El botón Volver a cargar recuperó la consulta; la navegación final funcionó.

Capturas locales: `supplier-catalog-login.png`, `supplier-catalog-preview.png`, `supplier-catalog-result.png`, `supplier-catalog-operator.png`, `supplier-catalog-mobile.png`, `supplier-catalog-supplier-operator-mobile.png`. La prueba visual de importación usó CSV; XLSX/múltiples hojas se verificaron mediante parser y HTTP/DB, no se afirma haber recorrido su upload completo visualmente.

### Incidencias, límites y verificaciones no realizadas

- `pnpm start` de API fue rechazado por revisión automática de ejecución (“blocked by policy”, sin razón adicional). El flujo se verificó con `pnpm dev`. **No se verificó runtime compilado de producción**; sí pasó build optimizado.
- `migrate dev` no interactivo rechazado; diff/deploy probado en existentes y desde cero.
- Contenedor temporal detenido durante un intento inicial: migrate diff informó P1001. Se reinició únicamente ese contenedor y luego pasó. No se borraron datos para reparar el entorno.
- Dos comandos que regeneraban Prisma en paralelo produjeron EEXIST en Windows. Se repitieron los checks en secuencia; últimos test/typecheck/build pasaron.
- Primeras versiones tuvieron errores de tipos/formato corregidos antes de los resultados finales. La prueba de 5.000 falló inicialmente por statement timeout en un join de filas; la adicional de 10.000 detectó otro join de actualización lento. Ambos revierten el commit y se corrigieron con lotes sobre unique/IDs; últimos tests de ambos tamaños pasaron sin ampliar timeouts generales.
- Algunas pruebas existentes emiten una deprecación de pg por queries concurrentes en la misma conexión; no hay fallos. La nueva autorización usa lecturas secuenciales dentro de transacción.
- agent-browser 0.38.2 (herramienta externa de verificación, no dependencia del repo) avisó engine Node >=24 con Node 22.18; los comandos utilizados/download de Chrome funcionaron. No se cambió el runtime del proyecto.
- No se probó cada combinación de formato comercial real, fechas/formato visual numérico, carga productiva concurrente prolongada ni RLS. Los códigos Excel deben almacenarse como Texto para conservar ceros/precisión. Los límites iniciales están documentados y requieren medición con listas reales.

Audit advisories de Prisma: [deepmerge-ts GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx), [mysql2 GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr), [mysql2 GHSA-rgwj-5xj2-c3m3](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3). Ya estaban presentes antes de agregar los lectores. Se registran sin forzar actualizaciones ajenas al incremento.

Las secciones siguientes son **evidencia histórica** de otras ejecuciones/notebook y no se cuentan como checks de este incremento.

Al finalizar se cerraron la sesión browser dedicada y los servidores de desarrollo, se retiró solamente el proyecto Docker temporal `maxbio-supplier-catalog-verify` con su volumen de fixtures, y se eliminó el archivo local de credenciales de prueba. La base local existente conserva sus datos y la nueva migración aplicada. Capturas/logs permanecen en artifacts, ignorados por Git.

## Catálogo — 5 de octubre de 2026

Entorno local existente: Windows, Node 22.18.0, pnpm 11.9.0, PostgreSQL 17.9 healthy, API 3001 y Next 3000. No se realizaron commits ni pushes. No se agregaron dependencias de aplicación.

| Comprobación                    | Resultado real                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pnpm lint                       | Exit 0; sin errores ni warnings de lint                                                                                                                                  |
| pnpm format:check               | Exit 0; todos los archivos con formato correcto                                                                                                                          |
| pnpm typecheck                  | Exit 0 en los cuatro proyectos; el typecheck API volvió a pasar después del ajuste final de lecturas transaccionales                                                     |
| pnpm test                       | Exit 0: 17 pruebas, 17 pass, 0 fail, 0 skipped                                                                                                                           |
| pnpm test:database              | Exit 0: 1 prueba del paquete database + 43 HTTP/DB de API; 44 pass, 0 fail, 0 skipped                                                                                    |
| Regresión del último ajuste API | pnpm --filter @maxbio/api test:integration: 43 pass, 0 fail, 0 skipped                                                                                                   |
| pnpm build                      | Exit 0: contracts, database, API y web; Next genera páginas y rutas comerciales sin fallos                                                                               |
| PostgreSQL                      | pnpm db:up: healthy; pnpm db:migrate: tres migraciones, sin pendientes; pnpm db:seed: organización preparada, sin usuarios/credenciales/productos ficticios              |
| Base vacía                      | Base temporal aleatoria: las tres migraciones se aplicaron; 12 CHECKs comerciales presentes; seed dejó 1 organización, 0 usuarios y 0 productos; base temporal eliminada |

Se agregaron 6 pruebas sin DB y 24 de integración de Catalog; se conservaron las anteriores. La suite verifica contratos estrictos, whitelist de rutas, checksum/canonización GTIN, códigos conservadores, tenant/roles, FKs y CHECKs reales, duplicados, reserva de archivados, filtros/paginación, versión obsoleta y dos actualizaciones simultáneas con un único ganador, creación atómica y rollback ante fallo de auditoría.

Recorrido real con agent-browser y Chrome local, un tenant UUID temporal y administrador de contraseña aleatoria:

| Flujo                          | Evidencia                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login                          | Formulario real → cookie HttpOnly → selección automática del tenant → navegación comercial                                                                                                   |
| Alta de producto               | «Cánula de verificación», código «00Cat-A/01», marca/categoría creadas dentro del formulario, presentación «Caja x 100 unidades», unidad UNIT; guardado abre ficha                           |
| Búsqueda/apertura              | Código interno encuentra el producto; enlace abre la ficha y conserva los ceros/case                                                                                                         |
| Edición                        | Nombre actualizado desde el formulario y persistido; datos actuales reaparecen en ficha                                                                                                      |
| GTIN inválido/válido           | 4006381333932 rechazado con mensaje del dígito de control; 4006381333931 agregado y visible                                                                                                  |
| Proveedor/asociación           | Proveedor creado dentro de la ficha; vínculo con PV-001 y descripción; edición de vínculo guarda PV-002                                                                                      |
| Edición de proveedor           | Contacto, email y teléfono guardados desde su formulario; ficha muestra producto/código asociados                                                                                            |
| Conflicto UI                   | Formulario abierto con versión 5; otra solicitud real guarda versión 6; intento viejo recibe 409 humano y botón Guardar deshabilitado; recarga explícita trae el cambio de la otra solicitud |
| Archivado de producto          | Confirmación real; producto pasa a versión 8; listado activo queda vacío; «Incluir archivados» lo recupera con estado Archivado                                                              |
| Proveedor archivado/restaurado | Confirmaciones reales; deja el listado normal al archivar y se restaura en su ficha                                                                                                          |
| OPERATOR                       | Rol cambiado solo en el fixture: consulta lista, no ve Nuevo/administración, POST válido con CSRF recibe 403; se restauró ADMIN                                                              |
| Proxy                          | 7 comprobaciones desde navegador: ruta ajena 404; tenant declarado 400; limit=1000000 400; query duplicada 400; sin CSRF 403; unidad BOX 400; resolución tipada de GTIN equivalente 200      |
| Auditoría                      | 17 eventos del recorrido incluido login/logout; 15 comerciales. Actor, sesión y tenant correctos; metadata {}. Se guardó resumen seguro antes de eliminar fixtures                           |
| Responsive                     | Producto en 1440×1000, 900×1100 y 390×844; scrollWidth no supera viewport. Administración secundaria también comprobada en tablet/móvil                                                      |
| Teclado                        | Tab inicial alcanza enlace de salto; Enter enfoca main-content; altas inline, formularios, recarga de conflicto y confirmaciones utilizados con teclado                                      |
| Consola                        | Sin errores JavaScript ni overlay. Navegación normal final solo muestra HMR/React DevTools; fallos HTTP esperados de pruebas negativas se distinguen                                         |
| Logout                         | Botón del shell cierra la sesión, regresa al login y GET comercial devuelve 401                                                                                                              |

Capturas y resumen seguro de auditoría en artifacts/ (ignorado por Git): catalog-product-desktop.png, catalog-product-tablet.png, catalog-product-mobile.png, catalog-conflict.png, catalog-operator.png, catalog-archived-default.png, catalog-archived-included.png, catalog-classifications-tablet.png y catalog-audit.json. Las imágenes desktop/móvil se inspeccionaron visualmente, además de snapshots y mediciones DOM.

El tenant temporal, sus usuarios, contactos, productos, relaciones, sesiones y eventos se eliminaron por UUID propio; se verificó el prefijo del fixture antes de limpiar. Se eliminó su archivo privado de credenciales y se cerró el navegador de prueba. La base de desarrollo y el administrador existente se conservaron; servidores locales siguen en 3000/3001.

Límites observados: recompilaciones/reinicios del API durante el desarrollo produjeron 503 transitorios; la UI mostró error y permitió reintentar sin perder el formulario. Prisma/adapter-pg emite una advertencia de deprecación de queries concurrentes del driver pg; no falló ninguna prueba y no se actualizó la dependencia. No se probaron despliegue productivo/TLS, carga masiva, RLS ni una auditoría WCAG completa. La prueba de conflicto UI usa dos solicitudes del mismo administrador temporal; la suite además ejecuta concurrencia simultánea real. La verificación de UI es de desarrollo; el build productivo compila correctamente, pero no se afirma ejecución browser del catálogo bajo next start.

Las decisiones y el contrato completo están en [catalog.md](catalog.md). Inventory, Scanner y Remitos continúan diferidos.

## Fundación de seguridad — 4 de octubre de 2026

Entorno: Windows, Node.js 22.18.0, pnpm 11.9.0, PostgreSQL 17.9 en Docker. La evidencia histórica del bootstrap se conserva abajo.

| Comprobación           | Resultado                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL             | Compose healthy; migración adicional aplicada en base local sin borrar datos                                                       |
| Migraciones desde cero | Base temporal independiente: ambas migraciones aplicadas mediante migrate deploy; seed sin passwords                               |
| Primer admin           | Comando real con credencial aleatoria temporal fuera de Git; segundo uso idempotente y sin modificar credenciales                  |
| Lint                   | `pnpm lint`: correcto                                                                                                              |
| Formato                | `pnpm format:check`: correcto                                                                                                      |
| Typecheck              | `pnpm typecheck`: correcto en todos los paquetes                                                                                   |
| Tests sin DB           | `pnpm test`: 11 correctos; bootstrap HTTP, hashing, cookies productivas y limiter                                                  |
| Tests PostgreSQL       | `pnpm test:database`: 1 de constraints + 19 de Identity correctos                                                                  |
| Build                  | `pnpm build`: contratos, database, API y web correctos; sin requerir DB en build                                                   |
| Login real             | Navegador → Next → Nest → PostgreSQL: cookie persistente, estado autenticado y health conectado                                    |
| Persistencia           | Estado de cookies guardado fuera de Git; navegador de prueba cerrado y nuevo contexto cargado con ese estado: entra sin contraseña |
| Logout                 | Botón real: vuelve al formulario; integración confirma que otro dispositivo sigue vigente                                          |
| Revocación propia      | Request real desde navegador al endpoint de revocación: 200; siguiente visita exige login                                          |
| Revocación remota      | Revocación de fixture en DB con cookie todavía presente: login muestra mensaje humano de sesión terminada                          |
| Responsive             | Desktop 1264×625, tablet 900×1100 y móvil 390×844; inspección visual de capturas y sin overflow horizontal                         |
| Teclado                | Tab desde password llega a Entrar y Enter hace login; foco en email y autocomplete username/current-password comprobados           |
| Navegador              | Sin errores JavaScript de la aplicación ni overlay; console registra HMR/React DevTools                                            |

Las pruebas PostgreSQL verifican login válido e inválido sin enumeración por mensaje, token solo hasheado, sesiones expiradas/revocadas, renovación limitada y throttled, logout individual, revocación específica/total, usuario deshabilitado, pertenencia revocada, organización archivada, ADMIN/OPERATOR, selección entre dos organizaciones, rechazo de IDs/headers arbitrarios, FK compuesta, auditoría sin credenciales, rollback conjunto y carrera renovación/logout. La administración application-only prueba dispositivos ajenos, identidades multi-tenant, revocación y disable autorizados. CSRF y rate limiting se prueban por HTTP, además de primitives sin DB.

Capturas en `artifacts/`, ignorado por Git. La base temporal y los archivos con credenciales/cookies de prueba se eliminan al terminar; la base local conserva sus datos y no recibe un administrador con contraseña ficticia. Crear el administrador propio siguiendo README. No se hicieron commits ni pushes.

Límites: la reapertura se simuló restaurando cookies en un contexto nuevo; no se esperaron 180 días reales (expiraciones se prueban con fechas controladas). No se probó TLS/CORS de una topología productiva, múltiples instancias, recuperación de passwords, administración completa, RLS, inmutabilidad frente al owner de DB ni operaciones comerciales. La prueba visual/teclado es básica, no una auditoría WCAG. `agent-browser` funcionó con Chrome local, aunque su CLI declara Node >=24 y este repo mantiene Node 22; no se agregó al proyecto como dependencia.

En la revisión final se comprobó transporte de la cookie y rechazo CSRF desde el proxy de desarrollo. El arranque adicional de `next start` con WEB_ORIGIN HTTP local fue rechazado por la revisión automática de ejecución (“blocked by policy”, sin detalle adicional). El build compilado pasó; esta comprobación adicional de autenticación compilada no se realizó. Los servidores de desarrollo quedaron en 3000/3001 contra la base local.

## Evidencia histórica del bootstrap

Fecha: 1 de octubre de 2026. Entorno: Windows, Node.js 22.18.0, pnpm 11.9.0 y Docker Desktop con contenedores Linux.

| Comprobación             | Resultado                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instalación con lockfile | `pnpm install --frozen-lockfile`: correcta; sin conflictos de peers                                                                              |
| PostgreSQL               | `docker compose up -d --wait`: healthy, puerto local 15432                                                                                       |
| Prisma                   | Cliente generado, migración inicial creada/aplicada y `migrate deploy` sin pendientes                                                            |
| Seed                     | Organización MaxBio creada; no usuarios ni credenciales                                                                                          |
| Lint                     | `pnpm lint`: correcto                                                                                                                            |
| Formato                  | `pnpm format:check`: correcto                                                                                                                    |
| Typecheck                | `pnpm typecheck`: correcto en los cuatro paquetes/aplicaciones                                                                                   |
| Tests API                | `pnpm test`: 8 pruebas correctas; incluyen DTO, rechazo de headers falsos, rutas cerradas y sanitización de errores normales y HttpException 500 |
| Tests PostgreSQL         | `pnpm test:database`: 1 prueba de integración correcta, con dos organizaciones, pertenencias, unicidad y FK Restrict                             |
| Build                    | `pnpm build`: correcto para contratos, database, API y web                                                                                       |
| Inicio de desarrollo     | `pnpm dev`: API y web inician; compilador de API informa cero errores                                                                            |
| API real                 | Readiness 200 con `database: ok`; liveness 200                                                                                                   |
| Comunicación real        | Navegador → Next.js → NestJS → PostgreSQL: 200 y “El sistema está conectado”                                                                     |
| Reintento                | Botón comprobado en navegador; nueva solicitud y respuesta 200                                                                                   |
| Caída de PostgreSQL      | Readiness 503 sanitizado; liveness 200; UI muestra “La conexión no está disponible”                                                              |
| Recuperación             | Base reiniciada sin borrar volumen; botón vuelve a estado conectado                                                                              |
| Responsive               | Vistas 1440×1000, 900×1100 y 390×844; sin overflow horizontal de la página; botón de 44px                                                        |
| Accesibilidad básica     | `lang=es-AR`, landmarks, estado anunciado y enlace de salto que mueve foco a `main-content`                                                      |
| Navegación               | Página 404 con mensaje claro; “Volver al inicio” retorna a `/`                                                                                   |
| Navegador                | Sin errores de JavaScript ni overlay de framework en operación normal; console solo informa HMR/React DevTools                                   |
| Producción local         | Procesos compilados en puertos temporales 3002/3003: página 200, API 200 y proxy contra API compilada 200; procesos de prueba cerrados           |

Las capturas de desktop, tablet, móvil e indisponibilidad quedan en `artifacts/`, excluido de Git. La base quedó recuperada y los servidores de desarrollo continúan en 3000/3001. Se respetó la restricción de no hacer commits ni pushes.

## Límites de esta evidencia

Al verificar el bootstrap todavía no existía autenticación. Identity ahora prueba autorización y pertenencias entre dos organizaciones; las operaciones empresariales continúan sin implementar. No se afirma aislamiento mediante RLS. La revisión de accesibilidad es básica y no constituye una auditoría WCAG completa.

El arranque y la comunicación se probaron localmente. La evidencia nueva de autenticación real figura arriba; no se probó despliegue remoto, backup/restauración, integraciones o módulos comerciales. Las decisiones pendientes están documentadas en [decisions.md](decisions.md).

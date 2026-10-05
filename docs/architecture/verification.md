# Verificación de MaxBio

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

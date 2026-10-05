# Verificación de MaxBio

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

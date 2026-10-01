# Verificación del bootstrap

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

No hay pruebas de aislamiento sobre operaciones empresariales porque esas operaciones y la autenticación aún no existen. La prueba de pertenencias verifica el modelo y sus constraints, no autorización ni RLS. La revisión de accesibilidad es básica y no constituye una auditoría WCAG completa.

El arranque y la comunicación se probaron localmente; no se probó un despliegue remoto, backup/restauración, autenticación real, integraciones o módulos comerciales. Las decisiones pendientes y la limitación de versión de ESLint están documentadas en [decisions.md](decisions.md).

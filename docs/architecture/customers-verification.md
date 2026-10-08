# Verificación de Clientes

Base: `main` / `475f909`, coincidente con origin/main al iniciar. Árbol inicialmente limpio. Incremento local, sin commit ni push. Modelo y comportamiento en [customers.md](customers.md).

## Resultado y archivos

Maestro comercial completo: mínimo nombre/tipo, datos opcionales, CUIT canónico, búsqueda PostgreSQL, permisos, edición por versión, archivado/restauración, auditoría y UI. Sin Remitos/OUTBOUND, pacientes, facturación ni impresión.

Nuevos:

- `packages/contracts/src/customers.ts`.
- `packages/database/prisma/migrations/20261008120000_customers/migration.sql`.
- `apps/api/src/modules/customers/customers.module.ts`, `api/customers.controller.ts`, `application/customers.service.ts`, `domain/customer-search.ts`.
- `apps/api/test/customers.test.ts`, `customers.integration.ts`, `customers-migration.integration.ts`.
- `apps/web/src/app/api/customers/route.ts`, `[...path]/route.ts`.
- `apps/web/src/app/clientes/page.tsx`, `nuevo/page.tsx`, `[id]/page.tsx`, `[id]/editar/page.tsx`.
- `apps/web/src/components/customers/list.tsx`, `detail.tsx`, `form.tsx`, `presentation.ts`.
- `apps/web/src/lib/customers-api.ts`, `server/customers-proxy.ts`.
- `docs/architecture/customers.md` y este reporte.

Modificados: schema Prisma (solo Customer/CustomerKind/Organization.customers), database y contracts exports, AppModule, navegación, helpers HTTP/resource para admitir Customers y separar identidad de recursos por scope, README. No hay cambios en implementaciones/contratos/migraciones anteriores de Inventory, Product, Supplier o Supplier Catalog. No hay dependencias nuevas de aplicación.

## Pruebas

Cinco unitarias nuevas cubren tipos/contratos estrictos, UUID v4, CUIT/checksum/formato humano, opcionales/límites/email, notas, edición con versión, rutas y búsqueda sin alterar códigos/teléfonos.

Dieciséis HTTP/PostgreSQL nuevas cubren mínimo/completo/null, CUIT único por tenant/archivado y carreras, alta idempotente/retry, búsqueda en todos los campos/tokens/tildes/CUIT, roles, FKs/tenant/404, ediciones simultáneas, no-op, archive/restore, cuatro eventos con metadata vacía, rollback de auditoría en alta/edición/ambos estados, paginación, constraints/trigger por SQL, CSRF/sesión revocada, ausencia de DELETE y cero efectos sobre los otros dominios.

Una prueba de migración nueva crea dos bases temporales: aplica las doce migraciones de HEAD y luego Customers preservando Product/Supplier previos; aplica las trece desde cero; inspecciona PK/FK/CHECKs/uniques/GIN, valida datos, migrate status y drift. Bases/archivos temporales eliminados con nombres/rutas propios verificados.

Resultado de suites: 64 API unitarias + 3 web pasaron. Database pasó 1 prueba; API integración pasó 115, falló 0, omitió 1 de 116. Total: 183 pasaron, 0 fallaron, 1 omitida. Las 22 pruebas nuevas de Customers pasaron. Después del último ajuste de tokenización se repitieron sus 16 integraciones: 16/16. No se suman estas repeticiones al total.

Única omitida: aceptación opcional de Supplier Catalog con Excel comercial original, porque MAXBIO_CATALOG_ACCEPTANCE_FILE no estaba configurada. No se declara ejecutada en este incremento.

## Comandos ejecutados

| Comando                                                                                                                       | Resultado final                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| git status/log/branch y git ls-remote origin refs/heads/main                                                                  | HEAD limpio y coincidente al iniciar.                                                              |
| pnpm install --frozen-lockfile                                                                                                | Exit 0; lockfile sin cambios.                                                                      |
| pnpm --filter @maxbio/database exec prisma format                                                                             | Ejecutado; se quitaron cambios de formato ajenos a Customer del diff.                              |
| pnpm --filter @maxbio/database exec prisma validate                                                                           | Exit 0.                                                                                            |
| pnpm prepare:packages                                                                                                         | Exit 0; incluye generate y builds compartidos.                                                     |
| pnpm db:migrate                                                                                                               | Exit 0; nueva migración aplicada en base local.                                                    |
| pnpm --filter @maxbio/database exec prisma migrate status                                                                     | Exit 0; 13 migraciones, up to date. Antes de aplicar informó la nueva pendiente (exit 1 esperado). |
| pnpm --filter @maxbio/database exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | Exit 0, No difference detected.                                                                    |
| pnpm format / pnpm format:check                                                                                               | Exit 0.                                                                                            |
| pnpm lint                                                                                                                     | Exit 0, sin errores/advertencias.                                                                  |
| pnpm typecheck                                                                                                                | Exit 0 en todos los paquetes.                                                                      |
| pnpm test                                                                                                                     | Exit 0; 64 + 3 pasaron.                                                                            |
| pnpm test:database                                                                                                            | Exit 0; resultados y omisión detallados arriba.                                                    |
| node --env-file=../../.env --test dist-test/test/customers.integration.js, desde apps/api                                     | Exit 0; 16/16, ejecución final específica.                                                         |
| MAXBIO_BUILD_DIR=.next/customers-build pnpm build                                                                             | Exit 0, incluidas rutas Clientes y proxies; directorio aislado del dev server.                     |
| git diff --check y self-review                                                                                                | Sin whitespace errors ni cambios conceptuales fuera del incremento.                                |

Durante implementación se corrigieron dos errores de lint por regex de controles y una firma de mock de auditoría en tests. Los comandos finales volvieron a pasar. No se usó db push.

Después del último ajuste del helper compartido también se ejecutaron `pnpm --filter @maxbio/web typecheck` y `MAXBIO_BUILD_DIR=.next/customers-build pnpm --filter @maxbio/web build`: ambos exit 0. La verificación del navegador se ejecutó con `node --env-file=.env artifacts/customers-browser/verify.mjs`: exit 0. `playwright-core` se instaló solamente en el directorio ignorado de artefactos mediante `npm install --prefix artifacts/customers-browser --no-save --package-lock=false playwright-core`, sin cambiar dependencias ni lockfile del workspace.

## Navegador y evidencia

El controlador CUA no tenía navegadores conectados. Se utilizó Edge instalado, headless mediante playwright-core en `artifacts/customers-browser`, sin agregar dependencia al workspace. Servidor web/API de desarrollo existente en localhost:3000/3001, contextos de navegador aislados y organización/usuarios/datos exclusivamente de prueba, eliminados al terminar. Una API temporal propia en 3411 se cerró; no se detuvieron los servidores del usuario.

Recorrido real: login de fixtures, listado, alta mínima por Enter sin CUIT, edición, archivo/filtro/restauración, formulario fiscal opcional, checksum inválido con foco, CUIT canónico y búsquedas invertidas/sin tildes/contacto/CUIT, OPERATOR sin acciones y PATCH 403. Se perdió una respuesta después del commit y se reintentó: un Customer/un Audit. Se cambió una versión externamente: 409 y recarga dejó editable el formulario con datos actuales.

Capturas inspeccionadas: escritorio 1440x1000, móvil 390x844 y ficha OPERATOR. Sin overflow horizontal ni errores JavaScript. El flujo comprueba también cero Product/Supplier/movimientos/líneas/balances/recepciones/conteos en su tenant. Se incluyó smoke de listados Products/Suppliers tras extender el helper compartido.

Evidencia local ignorada por Git: `artifacts/customers-*.log`, `customers-desktop.png`, `customers-mobile.png`, `customers-operator.png`, capturas del formulario y script `customers-browser/verify.mjs`. No se afirma prueba con personas reales ni auditoría WCAG completa.

## Self-review y límites

Revisados scope de queries/locks/updates y replay, autorización application/controller, CUIT TS/SQL/unique, versión/no-op/lifecycle, audit transaccional, búsqueda/escape, mapper público, proxy/CSRF, foco/feedback/retry, diff de schema y regresiones. El schema conserva intactos los modelos anteriores. Confirmación mediante pruebas: Customer produce cero stock y no crea entidades de otros módulos.

CUIT es validación local matemática, no registro fiscal. Un reenvío antiguo después de editar el mismo cliente puede requerir revisar la ficha; no duplica la UUID. Estado de intento incierto vive en la pantalla, sin persistir datos comerciales en storage. RLS y protección frente al DB owner siguen con los límites existentes. No quedan decisiones de negocio que bloqueen este maestro; Remitos/OUTBOUND requieren el siguiente incremento aprobado.

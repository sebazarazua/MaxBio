# Cierre técnico del motor de impresión de remitos

Sesión del 20 de octubre de 2026, America/Buenos_Aires. Se cierra el incremento existente; no se inicia otro.

## Estado inicial y entorno

- HEAD encontrado y esperado: `8b3d08ac04df17950ccd35b8d5445b5aaa64df5b` (`pre plantilla remitos`). `git status --short` vacío; ninguna diferencia respecto de ese commit.
- Comparación revisada contra `1a1be33a406da33cb96b7b6bb73341ccc40691ad`: 43 archivos, 5158 inserciones y 110 eliminaciones. Se inspeccionaron módulo Printing completo, contratos, migraciones, integración con confirmación, frontend, pruebas y documentación.
- Windows, PowerShell, Node 22.18.0, pnpm 11.9.0, Prisma 7.10.0, Next.js 16.3.8, Docker Engine 28.5.1 y PostgreSQL 17.9.
- Existían `.env` y `apps/web/.env.local`. No se modificaron ni copiaron sus credenciales a documentación. Docker estaba detenido; se inició Docker Desktop y `pnpm db:up` dejó PostgreSQL healthy.
- Se creó una base local aislada `maxbio_printing_verify_20261020_*`. `DATABASE_URL` se sobreescribió solamente en los procesos de verificación. No se migró ni se ejecutaron fixtures contra la base original del usuario. Las suites de migración, Inventory, Remitos y Printing crean además sus bases descartables propias.
- Logs locales en `%TEMP%/maxbio-printing-verification/`; no se versionan rutas privadas de conexión, sesiones ni archivos de storage.

## Implementación existente que se conservó

Revisiones inmutables de plantilla/calibración, geometría en mm, bindings allowlisted y contratos strict, proyección de allocations, reconciliación decimal exacta, lotes/vencimientos/series, SAFE/WARNING/BLOCKED, Noto Sans embebida, PDF custom vectorial, PNG exclusivamente en preview, overlay sin fondo, storage privado con hashes, artifacts idempotentes, reimpresión con el asset original, BFF binario, permisos y auditoría ya estaban implementados.

Se conservó `DeliveryNotesService.confirm`: locks y replay existentes, guard geométrico previo al posting, un OUTBOUND atómico por confirmación. Sin plantilla activa continúa el flujo previo. No se reescribió Inventory, DeliveryNote ni el motor geométrico.

## Cambios y causas

| Archivos                                                                                 | Cambio y motivo                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/web/src/components/printing/template-manager.tsx`, `test-delivery-note-picker.tsx` | Sustitución del input UUID por búsqueda por número/cliente/CUIT y lista paginada con fecha/estado. Reutiliza endpoint, contratos y controles existentes. Consulta privada en cuerpo, cancelación de requests obsoletos, recarga, errores y bloqueo de cancelados. UUID solo interno. |
| `apps/api/src/modules/printing/infrastructure/pdf-renderer.ts`                           | Faltaba solicitar PrintScaling=None en el PDF de calibración; se agregó la misma preferencia ya utilizada en preview/overlay. Sin escala configurable.                                                                                                                               |
| `apps/web/src/components/printing/delivery-print-panel.tsx`                              | Una generación rechazada con 4xx podía mostrar «El archivo está registrado». Ahora esa indicación se muestra únicamente si el servidor devolvió el artifact y falló la descarga posterior.                                                                                           |
| `apps/api/test/printing.test.ts`                                                         | Cobertura de alineaciones X/Y, wrapping sin perder palabras, umbrales, aplicación única de offsets, tamaño exacto en ambos modos, PrintScaling=None, ausencia de imágenes ocultas/guías en overlay, negro vectorial y cruces calibrados.                                             |
| `apps/api/test/printing.integration.ts`                                                  | Preview/evaluate conservan documento y stock; reprint preserva calibración no nula, revisión y versión; SQL rechaza cambio de calibración al reimprimir y hash incompatible; WARNING confirma y calibración insegura bloquea overlay; búsqueda humana atravesando el BFF real.       |
| `apps/api/test/printing-migration.integration.ts`                                        | Casos SQL de schemaVersion ausente y JSON null en upgrade y from-zero.                                                                                                                                                                                                               |
| Documentación de Printing y README                                                       | Referencias a esta evidencia y descripción precisa del selector, calibración y límites.                                                                                                                                                                                              |

No se modificaron schema Prisma, contratos compartidos ni migraciones SQL, históricas o de Printing. No se deshabilitaron pruebas ni se redujeron assertions existentes.

## Ejecución y resultados

La primera pasada de `pnpm test` dio API 72/72 y web 8/8. La primera suite completa de base dio database 1/1 y API 139 passed, 0 failed, 2 skipped: smoke Printing opt-in y aceptación de archivo comercial de Catalog. Posteriormente se habilitó el smoke Printing.

Durante la ampliación de cobertura se corrigieron dos supuestos del test nuevo de PDF/geometría: pdf-lib dibuja rectángulos mediante paths/strokes y una caja de dos líneas que ocupa más del 90 % del alto produce WARNING correctamente. Se ajustó el fixture y se comprobaron strokes y palabras exactas, conservando assertions. También se corrigió el request del test nuevo de búsqueda: el contrato existente recibe page/limit/includeArchived como strings, igual que la UI. No requirió cambiar implementación ni flexibilizar contratos. Los rechecks específicos pasaron.

| Comando ejecutado                                                                                                               | Resultado | Evidencia                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`                                                                                                | PASS      | Lockfile vigente, dependencias instaladas, sin cambios al lockfile.                                                            |
| `pnpm db:generate`                                                                                                              | PASS      | Cliente Prisma 7.10.0 generado.                                                                                                |
| `pnpm db:up`                                                                                                                    | PASS      | PostgreSQL healthy.                                                                                                            |
| `pnpm db:migrate`                                                                                                               | PASS      | Las 17 migraciones aplicadas sobre la base vacía aislada.                                                                      |
| `pnpm lint`                                                                                                                     | PASS      | Repetido después de cambios de código.                                                                                         |
| `pnpm format:check`                                                                                                             | PASS      | Repetido después de cambios de código.                                                                                         |
| `pnpm typecheck`                                                                                                                | PASS      | Paquetes, API y web.                                                                                                           |
| `pnpm test`                                                                                                                     | PASS      | API 73 passed; web 8 passed; 0 failed, 0 skipped.                                                                              |
| `pnpm build`                                                                                                                    | PASS      | Paquetes, API y Next compilados; rutas de Remitos/Printing incluidas.                                                          |
| `node --test dist-test/test/printing.test.js`                                                                                   | PASS      | 7 passed, 0 failed, 0 skipped tras corregir los fixtures nuevos. Ejecutado desde apps/api; también incluido en la suite final. |
| Printing HTTP con `MAXBIO_PRINT_BFF_SMOKE=1`                                                                                    | PASS      | 8 passed, 0 failed, 0 skipped en recheck específico; Next compilado → API → PostgreSQL/storage → PDF y worker local.           |
| `pnpm --filter @maxbio/database exec prisma migrate status`                                                                     | PASS      | 17 migraciones; Database schema is up to date.                                                                                 |
| `pnpm --filter @maxbio/database exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | PASS      | No difference detected; exit 0.                                                                                                |
| `MAXBIO_PRINT_BFF_SMOKE=1 pnpm test:database`                                                                                   | PASS      | Database 1 passed; API 140 passed, 0 failed, 1 skipped. Smoke Printing habilitado y aprobado.                                  |

En PowerShell la variable del smoke se cargó con `$env:MAXBIO_PRINT_BFF_SMOKE='1'`. `DATABASE_URL` apuntó siempre a la base aislada al ejecutar comandos de DB. Los scripts `prepare:packages` y Prisma generate también se ejecutaron como dependencias de los comandos reales.

## Migraciones y constraints

- Se preservaron separadas `20261019190000_delivery_note_printing` y `20261019191000_printing_constraints`; no se usó `prisma db push`.
- Upgrade: la prueba copia primero todas las migraciones anteriores al incremento, aplica deploy, verifica ausencia de PrintTemplate, crea Customer/Product y agrega las migraciones Printing. Verifica conservación de datos y cero movimientos/balances nuevos.
- From-zero: deploy de todas las migraciones en otra base vacía; tablas y triggers presentes; status al día y diff sin diferencias.
- Constraints revisadas: dimensiones/tolerancias, NULL de dimensiones PNG y schemaVersion, FKs compuestas tenant-scoped, activo PUBLISHED, assets/calibraciones/artifacts inmutables, publicación inmutable y fuente de artifact CONFIRMED/PUBLISHED/PDF con hash compatible. Reprint conserva asset, documento, revisión, calibración y versión.
- Los tests ejecutan rechazos reales de SQL, no solamente comprobaciones de presencia de triggers.

## Geometría, PDF, Inventory y seguridad

| Área          | Evidencia técnica                                                                                                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometría     | mm × 72 / 25.4, origen top-left convertido en PDF, nueve combinaciones de alineación horizontal/vertical, wrapping/multiline/maxLines/lineHeight/padding. Offsets medidos una vez; tolerancia por eje en ubicación y envolvente, sin cambiar fórmulas existentes.                                             |
| Estados       | SAFE con holgura; WARNING próximo al límite sin bloquear confirmación; BLOCKED por overflow/falta de trazabilidad/caracteres incompatibles o calibración insegura. Se rechaza overlay BLOCKED con 409 y sin artifact ni movimiento.                                                                           |
| Productos     | Allocation A/B produce filas independientes y suma exacta documental. Lote/vencimiento/serie no pueden omitirse. Serie requiere unidad. Capacidad por región y sin segunda página/truncado silencioso.                                                                                                        |
| PREVIEW       | Una página de 180 × 240 mm, fixture explícitamente sintético. Fondo PNG presente y banda visible como texto extraído; guías verificadas presentes solo al pedirlas.                                                                                                                                           |
| PRINT_OVERLAY | Una página del mismo tamaño exacto, Noto Sans embebida y negro vectorial; sin XObject de imagen ni stream de imagen oculto, banda de preview, guías ni invocaciones de dibujo de fondo. PrintScaling=None.                                                                                                    |
| Calibración   | Revisiones inmutables y compatibles con revisión exacta; nominal y offset X/Y; cruces PDF desplazados en puntos exactos; tamaño custom y PrintScaling=None. Escala fija 1.                                                                                                                                    |
| Artifacts     | Intento estable con retry concurrente sin duplicación; payload incompatible 409; actor/fecha/versiones/hash/asset persistidos y auditoría transaccional.                                                                                                                                                      |
| Reprint       | Bytes idénticos y mismo asset/hash/revisión/calibración/documentVersion, incluida calibración no nula; no llama al renderer.                                                                                                                                                                                  |
| Stock         | Preview modifica stock: NO. Evaluate modifica stock: NO. Generar overlay modifica stock: NO. Reimprimir modifica stock: NO. Se comparan movimientos/balances/documento antes/después. Solo confirmar crea exactamente el OUTBOUND correspondiente; BLOCKED no crea salida y retry válido conserva movementId. |
| Permisos      | ADMIN configura/publica/activa/sube PNG/calibra/prueba calibración. ADMIN/OPERATOR operan preview/evaluate/overlay/historial/descarga/reprint sobre revisiones permitidas; DRAFT de plantilla requiere ADMIN para preview. Guards servidor, tenant y revalidación transaccional revisados y probados.         |
| BFF/storage   | Allowlist, CSRF, firmas/MIME PDF/PNG, límites de cuerpo, private/no-store, nosniff, cookie de sesión acotada; lectura tenant-scoped, claves sin traversal y hashes. Rollback de auditoría elimina el archivo nuevo. No hay archivos de impresión en public.                                                   |

## Visual smoke y límites reales

No se realizó smoke visual. La herramienta de navegador devolvió inventario sin navegadores y `Browser is not available: iab` al intentar abrir localhost. No se afirman verificaciones visuales de lista/editor DRAFT, canvas PDF/zoom, mensajes SAFE/WARNING/BLOCKED, confirmación, historial, selector administrativo, OPERATOR ni viewport desktop/móvil. El BFF real se probó mediante HTTP y la UI fue compilada/revisada; eso no demuestra interacción ni layout en un navegador.

No hay PDF/DOCX/PNG de referencia ni medidas reales de Bourbon en el repositorio; no se inventó su plantilla. No se utilizó impresora física. El fixture sintético y los asserts sobre objetos/texto/operadores PDF validan el motor, no la alimentación mecánica, márgenes del driver, papel ni calidad física.

Storage filesystem local sigue siendo válido para desarrollo/piloto si es persistente y respaldado con la DB. **Un filesystem efímero no es válido para deployment productivo.** Crash entre escritura de archivo y commit puede dejar huérfanos; no se implementó GC ni storage cloud. La preferencia PrintScaling=None requiere que el operador compruebe 100 %, tamaño, orientación y bandeja.

La dependencia pg emite DeprecationWarning por consultas concurrentes ya presentes en operaciones transaccionales; las verificaciones no lo silencian. No se migró pg ni se reestructuró Inventory en este incremento.

Queda omitida la aceptación opcional de Catalog con un archivo comercial real si `MAXBIO_CATALOG_ACCEPTANCE_FILE` no está definido; pertenece a otro incremento. La plantilla Bourbon, la validación física y el smoke visual requieren sus materiales/dispositivos/herramienta y se reportan por separado.

## Alcance y estado

No se implementaron GS1 enriquecido, DataMatrix/cámara, facturación, ARCA/CAI, ANMAT/COT, Word runtime/importador universal, editor gráfico, impresión silenciosa/drivers/agente, reservas, devoluciones, presupuestos, packaging, IA ni etapas futuras. No hubo commit ni push. Cambios locales para revisión.

La segunda pasada completa terminó con exit 0: API de integración 140 passed, 0 failed, 1 skipped en 237983 ms; database 1 passed. Sumando unitarios (73 API + 8 web) e integración (140 API + 1 database): **222 passed, 0 failed, 1 skipped, 0 cancelled**. Estos totales no suman rechecks ni pasadas anteriores.

Se completó el self review del diff: scope, migraciones/constraints, tenant/roles, geometría/tolerancia/calibración, PDF/preview/overlay, artifacts/reprint/storage, confirmación/Inventory, BFF y UX/tests. `git diff --check` limpio. Se verificaron los enlaces relativos de README y los documentos de Printing. Las migraciones, schema y lockfile mantienen diff vacío.

La base temporal propia y el archivo temporal con su URL se eliminaron al terminar. Se conservaron únicamente logs locales de ejecución; PostgreSQL quedó disponible y los archivos de entorno originales no se modificaron.

**MOTOR DE IMPRESIÓN: CERRADO**

**PLANTILLA BOURBON REAL: PENDIENTE**

**PRUEBA FÍSICA: PENDIENTE**

Cierre técnico del motor. Plantilla real pendiente de referencias/medidas; prueba física pendiente de impresora/papel. Smoke visual desktop/móvil pendiente por navegador no disponible, sin atribuirle resultados al smoke HTTP.

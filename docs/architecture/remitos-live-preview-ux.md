# Remitos, plantilla y preview: corrección de UX

Fecha: 22 de octubre de 2026. Cambios locales, sin commit ni push.

## 1. HEAD inicial

`5742465fe54e36f1cc1679b024781aef4c9fb09e` — `plantilla remito`.
El HEAD coincidía con la consigna y el árbol de trabajo estaba limpio. Se revisaron el último incremento, Remitos, Printing, PrintTemplate, GeometryEditor, DeliveryPrintPanel, TemplateManager, contratos y tests antes de editar.

## 2. Diagnóstico

El formulario de carga y el papel estaban separados: había que guardar y abrir otra preview. El resumen textual duplicaba la revisión. La configuración comenzaba por revisiones, JSON y coordenadas; el editor visual quedaba después de numerosos controles. La arquitectura de impresión existente era adecuada y se conservó.

## 3. Archivos modificados o agregados

| Archivo                                                         | Cambio                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `packages/contracts/src/printing.ts`                            | Entrada parcial estricta, respuesta y allowlist del endpoint efímero.                  |
| `apps/api/src/modules/printing/api/printing.controller.ts`      | `POST draft-preview`.                                                                  |
| `apps/api/src/modules/printing/application/printing.service.ts` | Lecturas por organización y rendering transitorio.                                     |
| `apps/api/src/modules/printing/domain/print-document.ts`        | Valores mínimos de rendering, sin identidad de remito persistido.                      |
| `apps/api/src/modules/printing/domain/geometry.ts`              | Solo se amplió el tipo de entrada; algoritmo geométrico intacto.                       |
| `apps/api/src/modules/printing/infrastructure/pdf-renderer.ts`  | Mismo motor y fuente; opción interna para omitir el rótulo en la vista cotidiana.      |
| `apps/api/test/printing.integration.ts`                         | HTTP efímero, extracción de texto PDF, aislamiento, historial, invariantes y BFF real. |
| `apps/web/src/components/delivery-notes/editor.tsx`             | Carga y papel juntos; cliente compacto, productos y revisión simplificados.            |
| `apps/web/src/components/printing/live-delivery-preview.tsx`    | Vista automática con debounce y cancelación.                                           |
| `apps/web/src/components/printing/print-labels.ts`              | Nombres y mensajes humanos.                                                            |
| `apps/web/src/components/printing/delivery-print-panel.tsx`     | Preview automática del confirmado y acciones de impresión claras.                      |
| `apps/web/src/components/printing/geometry-editor.tsx`          | Papel protagonista, drag, selección, tamaño de Productos y ajuste preciso plegado.     |
| `apps/web/src/components/printing/pdf-preview.tsx`              | Ajuste visual del canvas al ancho disponible.                                          |
| `apps/web/src/components/printing/template-manager.tsx`         | Pantalla simple, reemplazo de PNG y ajustes de impresora.                              |
| `apps/web/src/lib/printing-api.ts`                              | Transporte con `AbortSignal`.                                                          |
| `apps/web/src/app/globals.css`                                  | Layout localizado, tamaños de controles y adaptación móvil.                            |
| `apps/web/test/printing-live.test.tsx`                          | Interacciones DOM, orden de respuestas, vacío, sin plantilla y drag.                   |
| `apps/web/test/printing-geometry.test.tsx`                      | Nombres y mensajes sin bindings/JSON.                                                  |
| `apps/web/package.json`, `pnpm-lock.yaml`                       | JSDOM y tipos solo para tests; mocks de módulos de Node.                               |
| `apps/web/tsconfig.json`, `apps/web/tsconfig.test.json`         | Imports TypeScript compartidos entre Turbopack y compilación de tests.                 |
| `README.md`                                                     | Flujo actualizado.                                                                     |
| `docs/architecture/remitos-live-preview-ux.md`                  | Este reporte.                                                                          |

## 4. Nuevo flujo Hacer remito

1. Elegir cliente.
2. Completar fecha, número del talonario y datos opcionales.
3. Agregar productos con el scanner o búsqueda existentes y elegir existencias físicas.
4. Ver el resultado sobre el papel mientras se completa.
5. Guardar borrador cuando corresponde.
6. Revisar y confirmar explícitamente la salida.
7. Generar para imprimir después de confirmar.

El guardado persiste el DRAFT; la vista funciona antes y durante la edición local. La fecha comienza vacía en un remito nuevo para que la primera representación no contenga datos agregados automáticamente.

## 5. Preview vacía

Al consultar la configuración, si hay plantilla activa publicada se muestra su PNG privado sin esperar un guardado. El PDF efímero posterior usa ese mismo fondo y ningún dato de ejemplo. `{}` renderiza un papel sin textos. Si falta la plantilla activa aparece «Todavía no hay una plantilla de remito lista para usar»; ADMIN tiene acceso a preparación. No se sustituye por un DRAFT.

## 6. Preview en tiempo real

El estado local de cliente, fecha, paciente, afiliado, observaciones, productos, cantidades y allocations dispara una actualización tras 220 ms. Se aborta la solicitud anterior y se verifica su señal antes de aplicar el resultado, incluso si la respuesta llega tarde. La escritura permanece habilitada. Las entradas temporalmente inválidas reciben un aviso humano. Si falla la vista, se informa que podría conservar datos anteriores y el formulario sigue funcionando.

## 7. Endpoint efímero

`POST /api/v1/printing/draft-preview`, mediante `POST /api/printing/draft-preview` del BFF.

Acepta identificador de cliente opcional, campos editables parciales y líneas con `productId`, `quantity` y allocations `positionId/quantity`. No necesita ID de remito ni IDs de líneas. Rechaza nombres aportados por navegador, organización, plantilla alternativa, geometría y guías. El servidor resuelve cliente, producto, lote, vencimiento y serie dentro de la organización autenticada. Usa la plantilla activa PUBLISHED, `layoutDocument`, NotoSans y el renderer PDF existente. Devuelve PDF en memoria y evaluación; no devuelve envelopes operativos.

## 8. Cero escrituras de negocio

La resolución del documento usa una transacción PostgreSQL `READ ONLY` con aislamiento `RepeatableRead`. El método no guarda DeliveryNote, Customer, Product, InventoryMovement, InventoryBalance, PrintArtifact, assets ni auditorías de negocio; no llama a storage.put ni reserva stock. El PDF se devuelve desde memoria. Se compararon registros completos, estado físico, auditorías, assets y archivos antes y después de las solicitudes. La autenticación mantiene su mecanismo habitual de renovación de sesión; esa infraestructura no se modificó.

## 9. Desktop

Dos áreas con carga a la izquierda y papel a la derecha. La vista permanece sticky al recorrer la carga; «Ampliar» permite verla ocupando la pantalla. El canvas se adapta al ancho disponible. Se conservaron las clases y el estilo general de MaxBio.

## 10. Móvil

A 950 px o menos las áreas se apilan: carga y vista debajo. No se mantienen dos columnas pequeñas. El canvas se ajusta al contenedor. Esta adaptación fue implementada, pero no se afirma verificación visual en un viewport móvil.

## 11. Cliente

Después de elegirlo, se reemplazan los resultados dominantes por una tarjeta con nombre, CUIT, domicilio y «Cambiar cliente».

## 12. Productos

Se conserva scanner/búsqueda y la selección física existente. Cada producto mantiene nombre, presentación y cantidad. Las existencias elegidas pueden cerrarse en un resumen de lote, vencimiento y serie, con «Cambiar lote o serie». No se alteraron políticas, FEFO, restricciones de series ni reglas de stock.

## 13. Confirmación

«Revisar y confirmar salida» abre una revisión compacta con cliente, número del papel, productos y lotes/series. El papel permanece al lado. Una advertencia explícita informa que se descontará stock y que el documento dejará de ser editable. El último botón confirma la salida existente. Se conserva el control de versión, idempotencia y exactamente un OUTBOUND. El confirmado queda en solo lectura, con vista automática y acciones «Generar para imprimir», «Descargar nuevamente» y «Registrar reimpresión». Se mantiene «Colocá el remito …» antes de imprimir; la plantilla Bourbon conserva el número preimpreso fuera del overlay.

## 14. Pantalla simple de plantilla

«Plantilla actual» muestra el formulario grande y el papel, con cuatro acciones: ajustar ubicación de textos, probar impresión, cambiar formulario y ajustar impresora. No hay tabla de revisiones ni JSON como primera experiencia. La configuración sigue restringida a ADMIN.

## 15. Editor visual

El papel ocupa el área principal y el panel de selección es secundario. Entrar en ajuste desplaza la pantalla al editor. Se conservan datos de ejemplo exclusivamente administrativos y la posibilidad de usar un remito guardado. Los nuevos cambios se guardan como DRAFT y no se publican automáticamente.

## 16. Drag y Productos

Click selecciona un texto y destaca su único recuadro. Arrastrar convierte el desplazamiento de pantalla a mm usando las dimensiones visibles del papel; no agrega un renderer React. Flechas y teclado siguen disponibles. Productos puede moverse y redimensionarse desde su zona; los anchos de columna y altura de fila permanecen en el ajuste preciso. El editor ADMIN conserva el único envelope de caída por texto, con colores verde/naranja/rojo según la evaluación del servidor. La vista normal no tiene guías ni SVG de selección.

## 17. Ajuste preciso

X, Y, ancho, alto, tamaño de letra, interlineado, máximo de líneas, padding y alineación vertical quedan en un `<details>` inicialmente cerrado. El panel principal tiene flechas, tamaño de letra y alineación. Se mantienen las unidades y el modelo internos.

## 18. Nombres humanos

Bindings se presentan como Cliente, Dirección, Día, Mes, Año, Paciente, N.º afiliado, Producto, Cantidad, Lote, Vencimiento y Serie. Los mensajes operativos usan esos nombres; WARNING pide revisión visual y los errores explican qué dato no entra. Los errores locales de validación de configuración tampoco presentan el JSON de Zod.

## 19. JSON

Está únicamente dentro de «Opciones técnicas» de ADMIN. Nunca es necesario para mover un texto o cambiar el fondo.

## 20. Revisiones y cambio de fondo

El historial se encuentra en «Historial de cambios». «Cambiar formulario» carga un PNG y crea inmediatamente una revisión DRAFT con los campos existentes. El nuevo fondo se muestra en el editor, conservando la versión publicada y su historial. Las medidas Bourbon 203 × 271 mm son predeterminadas al preparar el primer formulario; pueden cambiarse expresamente cuando cambia el papel. Se probó que la revisión fuente publicada permanece idéntica y que editar la plantilla no cambia el estado físico.

## 21. Impresora

«Ajustar impresora» explica el desplazamiento global y ofrece flechas. X/Y y datos adicionales del equipo quedan en «Ajuste preciso». Se conserva la persistencia versionada de PrinterCalibration y la selección de perfiles para imprimir. No se alteró la lógica de tolerancias X ±4 / Y ±3 de la plantilla Bourbon.

## 22. Tests agregados

- DOM: fondo sin guardar, actualización del estado local completo, debounce, respuesta vieja ignorada, cancelación, errores recuperables y ausencia de fallback a DRAFT.
- DOM/editor: nombres humanos, click, drag exacto en mm, un recuadro de selección, coordenadas dentro de ajuste preciso y ausencia de JSON/bindings en el editor habitual.
- HTTP/PDF real: vacío sin texto, cliente y domicilio autoritativos, cambios de fecha, paciente, afiliado, producto, lote, vencimiento y serie.
- Acceso: OPERATOR, solicitudes estrictas, falta de sesión y aislamiento entre organizaciones.
- Persistencia: comparación de remitos, clientes, productos, ledger/balances, artifacts, auditorías y archivos privados.
- Revisión: nuevo fondo en una nueva revisión, fuente publicada intacta y stock intacto.
- BFF real: Next compilado → API → PostgreSQL/storage → PDF privado; incluye preview efímera vacía y con datos.
- Regresiones existentes: Inventory, OUTBOUND, idempotencia, inmutabilidad publicada, calibraciones, artifacts, overlay y reimpresión.

Los tests DOM sustituyen el componente de canvas para verificar interacciones; los PDFs y sus textos se verifican por separado con el renderer y PDF.js reales.

## 23. Resultados

| Verificación                                        | Resultado                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm lint`                                         | Correcto.                                                                         |
| `pnpm format:check`                                 | Correcto.                                                                         |
| `pnpm typecheck`                                    | Correcto.                                                                         |
| `pnpm test`                                         | 77 API + 14 web, cero fallas.                                                     |
| `pnpm test:database` con `MAXBIO_PRINT_BFF_SMOKE=1` | 1 prueba de base + 143 API correctas; 1 aceptación opcional omitida, cero fallas. |
| `pnpm build`                                        | Correcto, producción con Turbopack.                                               |
| Suite específica de preview efímera                 | Correcta.                                                                         |
| `git diff --check`                                  | Sin errores.                                                                      |

Las fallas iniciales de derivación Zod y fixtures de integración fueron corregidas. Un intento de typecheck coincidió con otra generación de Prisma y falló por acceso concurrente al directorio generado; la verificación final se ejecutó secuencialmente y pasó. La aceptación opcional omitida requiere un archivo comercial externo y no corresponde a este incremento.

## 24. Smoke visual

No ejecutado: el inventario de Computer Use no encontró navegadores y la apertura de IAB respondió «Browser is not available: iab». No hay capturas desktop/móvil ni prueba manual real de impresión. El smoke HTTP de producción sí se ejecutó y pasó; no se presenta como smoke visual.

## 25. Limitaciones

- Queda pendiente observar desktop/móvil con un navegador disponible y validar legibilidad con usuarios.
- La colocación física, alimentación del papel, año y CUIT de la plantilla Bourbon provisional requieren la prueba física ya prevista.
- Si no hay plantilla activa publicada, el sistema muestra el mensaje correspondiente; no se activó ni publicó ninguna plantilla real como parte del trabajo.
- La preview no certifica disponibilidad futura ni reserva mercadería. Confirmación conserva sus validaciones autoritativas.
- El debounce evita solicitudes innecesarias; una cancelación del navegador no promete interrumpir un PDF que el servidor ya comenzó a renderizar, pero su respuesta no reemplaza la versión actual.

## 26. Alcance

Corrección de UX e integración del flujo actual de Remitos + Plantilla + Preview. No hay migraciones ni cambios en `postDeliveryNote`, Inventory, cálculo de tolerancias o persistencia de artifacts. No se implementaron GS1 enriquecido, facturación, ARCA, ANMAT, COT, devoluciones, reservas ni otra etapa. No se hizo commit ni push.

# Remitos: papel grande, drag local y numeración automática

Fecha: 22 de octubre de 2026. Cambios locales, sin commit ni push.

## Punto de partida y diagnóstico

HEAD inicial: `96b797fa3936733d5b6bbd517d589b8b73901c1d`, commit `plantilla remito 2`. Árbol limpio al comenzar. Se revisaron el último incremento, Remitos, LiveDeliveryPreview, PdfPreview, GeometryEditor, TemplateManager, DeliveryNotesService, contratos, Prisma y pruebas.

La carga y el papel repartían casi por igual un contenedor con márgenes de CRUD. El panel agregaba 28 px de padding y el canvas otros 8 px a cada lado. Durante el drag, cada movimiento cambiaba la definición persistible; el debounce podía vencer mientras seguía el gesto, generar PDFs y deshabilitar el overlay cuando dejaba de estar current. Prefijo y número pertenecían al payload editable y tenían que escribirse cada vez.

## Tamaño antes/después y layout

El cambio se limita a las páginas que contienen el workspace del remito o el editor de geometría. No modifica el layout de todos los CRUD.

| Aspecto                      | Antes                                      | Ahora                                                        |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------ |
| Carga / papel                | Prácticamente 50/50                        | Fracciones 0,9 / 1,6; alrededor de 36/64 cuando hay espacio. |
| Padding lateral de la página | 48 px normalmente                          | 20 px, solo en estos workspaces.                             |
| Padding del panel de vista   | 28 px                                      | 12 px.                                                       |
| Padding interior del canvas  | 8 px                                       | 0 en la operación y editor.                                  |
| Papel operativo              | Depende de una mitad reducida              | Aprovecha el panel hasta 780 px sin deformarse.              |
| Editor de geometría          | Papel restante junto a 290 px de controles | Fracciones 2,6 / 1 y controles secundarios.                  |
| Sticky                       | Sin límite de altura propio                | Alto máximo `100dvh - 32px`, con scroll interno.             |
| Móvil                        | Una columna                                | Se conserva una columna a 950 px o menos.                    |

Con sidebar de 248 px, la regla nueva deja aproximadamente 635–650 px de papel a 1366 px de viewport, 680–700 px a 1440 px y hasta 780 px a 1600 px. Son estimaciones a partir de las reglas CSS, no mediciones de un navegador. La proporción del papel se conserva y el scroll permite inspeccionar un formulario alto sin reducirlo a una miniatura. Los tamaños de fuente, coordenadas y medidas físicas del PDF no se cambiaron.

## Vista ampliada y mensajes

«Ampliar» abre un dialog nativo modal, centrado, con backdrop oscuro y casi todo el alto disponible. El papel puede crecer hasta 1040 px de ancho y se recorre verticalmente. Tiene botón grande «Cerrar vista ampliada», cierre con Escape, foco modal, restauración del foco y bloqueo temporal del scroll de la página.

Las advertencias se agrupan en «Hay N datos para revisar visualmente. Ver detalles», inicialmente plegado. Los impedimentos para confirmar o imprimir siguen visibles como alerta. Los detalles usan nombres humanos. No se agregaron controles técnicos a la operación diaria.

## Drag local y sincronización

- Pointerdown conserva pointerId, región, SVG, dimensiones visibles, coordenadas iniciales y definición inicial.
- Pointermove actualiza las coordenadas transitorias y programa como máximo un cambio visual por requestAnimationFrame.
- La caja se desplaza localmente en el SVG. El texto permanece en el último PDF autoritativo mientras se mueve el recuadro; no se inventa una composición tipográfica en React.
- Durante el gesto no cambia la definición persistible y el efecto de rendering está suspendido. También se cancelan el timer y las solicitudes obsoletas.
- Pointerup convierte el desplazamiento a mm, aplica clamp y hace un único commit de la definición si hubo cambios. Luego hay una reevaluación tras 300 ms.
- Pointercancel, Escape, pérdida de capture, cambio de campo y desmontaje cancelan el gesto y liberan capture/RAF sin conservar geometría parcial.
- El overlay permanece interactivo durante la actualización; guardar requiere validación actual.
- Flechas, botones y controles numéricos comparten el debounce de 300 ms. Las flechas usan actualizaciones funcionales para conservar pulsaciones rápidas.
- Productos usa el mismo mecanismo para movimiento y resize, preservando columnas, altura de fila y bordes de página.

**Solicitudes durante el test de drag continuo de 120 movimientos: 0. Solicitudes después del commit con cambios: 1.** Cancelar sin modificar la definición validada no solicita otro PDF.

Cada evaluación usa AbortController y secuencia monotónica. Una respuesta abortada o de una generación anterior se ignora. PdfPreview dibuja el nuevo documento en un canvas separado y copia el resultado al visible solo al terminar; conserva la imagen anterior durante el trabajo. El editor cambia su base de envelopes cuando el canvas está listo.

Los envelopes siguen calculándose en el backend con el mismo layout, fuente, calibración y tolerancia. Para evitar cajas duplicadas, el PDF de geometry-preview no las lleva dibujadas: el SVG muestra una sola caja por texto a partir de esos envelopes autoritativos, con color de estado y selección resaltada. No se cambió el renderer tipográfico ni el cálculo geométrico.

## Numeración

Modelo nuevo `DeliveryNoteNumbering`, separado de Printing y relacionado con Organization:

- organizationId como clave primaria: una configuración activa por organización.
- prefix, nextNumber BigInt, numberWidth y version.
- createdAt y updatedAt.
- Constraint de valores: prefijo de hasta 12 dígitos, anchura entre 1 y 12, versión positiva y límite numérico explícito. Hay un valor terminal para indicar agotamiento sin producir números de 13 dígitos.

`GET /api/v1/delivery-notes/numbering` devuelve configuración y sugerencia; el BFF expone `/api/delivery-notes/numbering`. La lectura usa transacción READ ONLY y no reserva ni consume números. Si no hay configuración ni históricos devuelve `configured: false`, sin inventar prefijo.

`PUT` sobre esa ruta permite a ADMIN establecer prefijo y próximo número. Usa expectedVersion, lock y auditoría con valores anteriores/nuevos. En el mismo prefijo no permite retroceder el contador. OPERATOR no modifica la configuración. La interfaz está en Remitos → Numeración de remitos → Cambiar numeración, como sección administrativa secundaria.

### Históricos y migración

Nueva migración aditiva `20261022120000_delivery_note_numbering`. No se editaron migraciones previas ni se usó db push.

Al migrar, el remito numerado creado más recientemente determina el prefijo. Dentro de ese prefijo se calcula el máximo **numérico**, incluyendo todos los estados, y se conserva la mayor anchura observada para mantener ceros. El próximo es máximo + 1. Los registros históricos permanecen intactos. Las organizaciones sin remitos numerados no reciben un prefijo inventado.

La misma derivación existe para una organización que tenga históricos pero aún no tenga configuración: la consulta solo la calcula; la primera creación la persiste bajo el lock. Un borrador histórico sin número recibe uno al guardar, sin cambiar números ya asignados.

En la base local, al aplicar la migración, quedó:

- Prefijo: **0002**.
- Próximo número: **00002223**.
- Anchura: **8 dígitos**.
- Versión inicial: **1**.

Estos valores se leyeron de la base local; no se crearon remitos reales de prueba ni se consumieron números en ella.

### Asignación, concurrencia e idempotencia

CREATE y UPDATE normales ya no aceptan prefijo ni número. La preview efímera sí puede mostrar la sugerencia, sin usarla como autoridad de persistencia.

Al crear, primero se adquiere el lock del ID estable y se comprueba creationHash. Si el documento ya existe con el mismo contenido y actor se devuelve el mismo número. El hash contiene los datos enviados por el cliente, sin campos server-owned.

Después se adquiere un advisory transaction lock por organización, que protege su único prefijo activo y serializa también cambios de prefijo e inicialización. Es más amplio que un lock por prefijo y evita que un cambio de talonario compita con una asignación. La asignación, avance del contador, documento, líneas y auditoría pertenecen a la misma transacción. Un error revierte también el avance.

Se busca el primer número libre desde el contador mediante comparación bigint; se omiten números existentes en DRAFT, CONFIRMED y CANCELLED, incluso variantes históricas con ceros distintos. La anchura se conserva con padStart y puede crecer si el incremento cruza su longitud. Se conserva el unique existente `organizationId + documentPrefix + documentNumber` como defensa SQL.

Las pruebas crearon 24 documentos simultáneos con números diferentes y consecutivos. Seis reintentos del mismo create ID devolvieron el mismo documento sin segundo avance. Un contenido distinto para ese ID fue rechazado. También se verificó rollback del contador ante creación inválida.

### UX diaria

Cliente, fecha, datos opcionales, productos y existencias físicas mantienen su flujo. Los dos inputs de numeración se reemplazan por «Remito físico 0002-…» y «MaxBio asigna el número automáticamente». Antes de guardar se aclara que es el número probable; al guardar, la respuesta del servidor reemplaza inmediatamente la sugerencia por el número real, aunque otro empleado haya tomado el anterior. No hay error por una sugerencia stale.

El papel en pantalla sigue usando el renderer existente; agrandar la vista no cambia sus 203 × 271 mm. Confirmar salida continúa siendo la única operación que genera OUTBOUND. Numeración, preview, plantilla y guardado de borrador no reservan ni descuentan stock.

## Archivos

| Archivo                                                                                    | Cambio                                                              |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `packages/database/prisma/schema.prisma`                                                   | Modelo y relación de numeración.                                    |
| `packages/database/prisma/migrations/20261022120000_delivery_note_numbering/migration.sql` | Tabla, checks, FK e inicialización histórica aditiva.               |
| `packages/contracts/src/delivery-notes.ts`                                                 | Numeración, rutas y contratos server-owned.                         |
| `packages/contracts/src/printing.ts`                                                       | Conserva números opcionales exclusivamente para preview.            |
| `apps/api/src/modules/delivery-notes/application/numbering.ts`                             | Derivación, formato, búsqueda libre y asignación.                   |
| `apps/api/src/modules/delivery-notes/application/delivery-notes.service.ts`                | Locks, asignación transaccional y configuración ADMIN.              |
| `apps/api/src/modules/delivery-notes/api/delivery-notes.controller.ts`                     | GET/PUT de numeración.                                              |
| `apps/api/src/modules/audit/audit.service.ts`                                              | Metadata acotada para cambios explícitos.                           |
| `apps/api/src/modules/printing/application/printing.service.ts`                            | Envelopes del editor sin duplicarlos dentro del PDF.                |
| `apps/web/src/app/api/delivery-notes/[...path]/route.ts`                                   | Transporte PUT del contrato explícito.                              |
| `apps/web/src/components/delivery-notes/editor.tsx`                                        | Tarjeta automática y sugerencia sin inputs cotidianos.              |
| `apps/web/src/components/delivery-notes/list.tsx`                                          | Acceso administrativo a numeración.                                 |
| `apps/web/src/components/delivery-notes/numbering-settings.tsx`                            | Configuración única y cambios explícitos.                           |
| `apps/web/src/components/printing/live-delivery-preview.tsx`                               | Dialog ampliado y mensajes agrupados.                               |
| `apps/web/src/components/printing/print-issues.tsx`                                        | Advertencias plegadas e impedimentos visibles.                      |
| `apps/web/src/components/printing/pdf-preview.tsx`                                         | Canvas separado y reemplazo completo.                               |
| `apps/web/src/components/printing/geometry-editor.tsx`                                     | Interacción local, cancelación, latest-wins y commit final.         |
| `apps/web/src/components/printing/geometry-controls.ts`                                    | Helpers de caja y resize limitado.                                  |
| `apps/web/src/app/globals.css`                                                             | Workspace específico, papel grande, sticky, modal y responsive.     |
| `apps/api/test/delivery-notes.test.ts`                                                     | Contratos estrictos sin numeración editable.                        |
| `apps/api/test/delivery-notes.integration.ts`                                              | Numeración, concurrencia, retries, estados y regresión.             |
| `apps/api/test/printing.integration.ts`                                                    | Fixtures adaptados a asignación del servidor.                       |
| `apps/api/test/numbering-migration.integration.ts`                                         | Upgrade desde HEAD, vacío, status, drift e históricos intactos.     |
| `apps/web/test/printing-live.test.tsx`                                                     | Stress, cancelación, resize, teclado, stale, ampliación y mensajes. |
| `README.md` y este reporte                                                                 | Uso y evidencia.                                                    |

## Verificación

| Comando / suite                                     | Resultado                                                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                                         | Correcto, sin errores ni warnings finales.                                                               |
| `pnpm format:check`                                 | Correcto.                                                                                                |
| `pnpm typecheck`                                    | Correcto.                                                                                                |
| `pnpm test`                                         | 77 API y 18 web correctas, cero fallas.                                                                  |
| `pnpm build`                                        | Correcto, producción con Turbopack.                                                                      |
| `pnpm test:database` con `MAXBIO_PRINT_BFF_SMOKE=1` | 1 prueba de base + 147 API correctas; 1 aceptación opcional omitida, cero fallas. Incluye BFF HTTP real. |
| Suite específica de numeración                      | Correcta: históricos, ceros, salto, concurrencia y retries.                                              |
| Suite de migración de numeración                    | Correcta: HEAD, from-zero, migrate status y drift.                                                       |
| Stress DOM de drag                                  | Correcto: 120 movimientos, 0 requests durante el gesto, 1 al finalizar.                                  |
| `git diff --check`                                  | Sin errores.                                                                                             |

Los tests DOM sustituyen el canvas para comprobar interacción y transporte; el renderer y los textos/medidas de PDF se prueban por separado con las suites reales. El test Bourbon existente conserva la comprobación 203 × 271 mm, fuente/posiciones y ausencia del número preimpreso en el overlay.

## Smoke y limitaciones

No se ejecutó smoke visual desktop/móvil: Computer Use devolvió inventario vacío de navegadores. Tampoco había un screenshot adjunto con esta consigna; la comparación antes/después se hizo sobre el CSS existente. No se afirma una medición de FPS ni legibilidad observada en pantalla real. Queda pendiente esa inspección con navegador y la prueba física de impresora ya prevista.

El movimiento local anticipa la posición de la caja; el texto tipográfico se actualiza después de la validación del servidor. Una cancelación del navegador no garantiza detener un PDF que el servidor ya estaba procesando, pero su resultado obsoleto no se aplica. Las restricciones de ancho y la relación física no se alteran al ampliar.

La sugerencia puede cambiar entre abrir y guardar. El número devuelto al guardar es definitivo. Los números tienen un límite de 12 dígitos y el agotamiento exige configurar otro talonario. Una organización sin históricos necesita preparación inicial de ADMIN. Las pruebas de negocio se ejecutaron en bases aisladas.

No hay cambios en `postDeliveryNote` ni en Inventory. Se preservan renderer, layoutDocument, fuente, tolerancias, calibraciones, revisiones, artifacts y reimpresión. No se implementaron nuevas plantillas, GS1 enriquecido, facturación, ARCA, ANMAT, COT, Word, reservas, devoluciones, IA ni ninguna etapa posterior. Sin commit ni push.

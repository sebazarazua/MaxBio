# Remitos y salida de stock

Incremento documental original sobre HEAD `080d57afb1cf84b2f753e2c0d71d54452f40d266`, 8 de octubre de 2026. La extensión de representación del 19 de octubre se documenta en [impresión y verificación](delivery-note-printing.md).

## Dominio y límites

`DeliveryNote` es el documento comercial estructurado. `InventoryMovement` es el hecho físico. El módulo Printing consume los datos del documento sin controlar stock: agrega plantillas, preview, PDF overlay y calibración. No hay Word runtime, facturación, ARCA, ANMAT, presupuestos, devoluciones ni reservas.

Ortopedia Bourbon trabaja frecuentemente contra pedido: puede conseguir un producto y emitir su remito sin haberlo ingresado antes a MaxBio. Inventory es opcional para remitos. Product es obligatorio; InventoryBalance, allocations y ProductInventoryPolicy no son requisitos para documentar una salida sin stock vinculado.

DeliveryNote puede confirmarse sin InventoryMovement. Si existen allocations válidas, se genera como máximo un OUTBOUND por la cantidad vinculada a Inventory. Una allocation representa solo la parte de la cantidad documental vinculada a existencia física registrada. Se admite `0 <= sum(allocations) <= line.quantity`; superar la cantidad documental siempre se rechaza.

Ejemplos: cantidad documental 5 sin allocations confirma con `movementId: null`, sin movimientos ni cambios de balance; allocation 2 confirma por 5 y genera OUTBOUND -2; allocation 5 conserva OUTBOUND -5. No se crean balances negativos, lotes, ubicaciones, ajustes ni movimientos vacíos para completar el remanente. Stage 5 permite capturar trazabilidad documental manual o GS1, sin crear Inventory.

El borrador tiene cliente, fecha documental, número opcional, paciente/afiliado opcionales, observaciones y hasta 50 líneas. Se guarda explícitamente. Puede retomarse y editarse entre operadores de la misma organización; no hay restricción de autor como en los ingresos. Todo cambio exige `expectedVersion`. La API reemplaza cabecera y líneas en una sola transacción para evitar un guardado parcial.

## Modelo Prisma

| Entidad                | Datos y relaciones                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DeliveryNote           | UUID técnico, organizationId, Customer con FK compuesta, status, version, documentDate DATE, documentPrefix/documentNumber varchar(12), patientName varchar(160), affiliateNumber varchar(80), notes varchar(1000), customerSnapshot JSON tipado por contrato, createdAt/updatedAt/confirmedAt timestamptz(3), confirmador Membership/User con FK compuesta, creationHash, confirmationOperationId/requestHash; relación inversa única a InventoryMovement. |
| DeliveryNoteLine       | UUID, organizationId, DeliveryNote y Product mediante FKs compuestas, ordinal, cantidad NUMERIC(20,6), snapshots mínimos de nombre/presentación/unidad/GTIN al confirmar. No existe unique por producto: puede repetirse.                                                                                                                                                                                                                                   |
| DeliveryNoteAllocation | UUID, organizationId, productId, lineId, positionId, cantidad NUMERIC(20,6). FK compuesta a línea y a InventoryBalance que exige el mismo producto y tenant. Una posición aparece una vez por línea; distintas líneas pueden usarla, sumando su demanda.                                                                                                                                                                                                    |
| InventoryMovement      | Nuevo tipo OUTBOUND y deliveryNoteId con FK tenant-scoped y unique. Conserva actor/session/timestamps/sellado del Inventory actual.                                                                                                                                                                                                                                                                                                                         |
| InventoryMovementLine  | deliveryAllocationId con FK tenant/product-scoped y unique. El trigger también comprueba remito, ubicación, lote, serie, condición y delta contra la allocation.                                                                                                                                                                                                                                                                                            |

La posición referenciada identifica de forma inequívoca ubicación, lote real, serie real y condición. `InventoryStockScope` sigue siendo el ancla producto/ubicación existente: no representa un lote. Se deriva y revalida desde la posición; no se duplica una estructura de scopes/lotes/series. Una posición referenciada conserva su identidad, aunque su cantidad cambie o llegue a cero. El rebuild existente conserva estos IDs mediante UPSERT por dimensión.

## Estados y número

`DRAFT → CONFIRMED` o `DRAFT → CANCELLED`. Un confirmado no se modifica, borra, reabre ni cancela. Cancelación lógica del borrador solo ADMIN; conserva líneas y número para evitar reciclados accidentales. No hay estados de entrega o facturación especulativos.

El número es `documentPrefix + '-' + documentNumber`, ambos strings de 1–12 dígitos. Conserva ceros: `00001-00003897`. Deben estar ambos presentes o ambos ausentes. La numeración automática vigente asigna el número al guardar y lo exige al confirmar, sin semántica fiscal. Unique por organización y ambas partes desde que se guardan; cancelar conserva el número asignado. El de un confirmado nunca se libera.

`documentDate` es fecha de calendario declarada del documento. No retrodata Inventory. `createdAt` es creación técnica y `confirmedAt` instante de confirmación; Inventory fija sus propios occurredAt/recordedAt después de adquirir los locks.

## Confirmación y única escritura de stock

1. Leer la versión y productos del documento, autorizar dentro de la transacción.
2. Advisory lock de confirmationOperationId, buscar replay antes de exigir versión actual.
3. Locks Product por UUID ordenado (FOR UPDATE para productos con allocations; FOR SHARE para estabilizar snapshots de catálogo sin vincular stock), Customer y luego DeliveryNote.
4. Releer el documento y comprobar tanto expectedVersion como la versión de la lectura previa. Una edición concurrente, incluso con una versión futura adivinada, no puede introducir productos que quedaron sin lock.
5. Exigir borrador, número completo y líneas; revalidar Customer/Product activos.
6. Si hay una plantilla activa, Printing valida la geometría nominal de los datos actuales y rechaza BLOCKED antes del posting; no genera PDF ni escribe archivos en esta transacción. `InventoryService.postDeliveryNote(tx, context, id)` valida política vigente, unidad, cantidades, allocations no superiores a la cantidad documental, posición, ubicación activa, condición USABLE, vencimiento, series y disponibilidad agregada. Rechaza scopes en conteo.
7. Sellar snapshots de líneas; usar **el mismo `InventoryService.applyMovement`** que ingresos/conteos/ajustes para crear OUTBOUND solo si hay allocations, aplicar deltas negativos a balances, insertar ledger y sellarlo. Incrementar versiones de scopes afectados.
8. Guardar snapshot de cliente, confirmador, operación/hash, fecha, estado y versión del remito. Auditar `DELIVERY_NOTE_CONFIRMED` en esa misma transacción.
9. Commit con triggers diferidos que exigen ambas direcciones del vínculo y correspondencia exacta entre cada allocation seleccionada y su línea negativa del movimiento; se exige movimiento si y solo si hay allocations.

Un error de stock, constraint, sesión o auditoría revierte todo. El módulo DeliveryNotes no escribe InventoryBalance ni construye un ledger alternativo. Crear/editar/leer/previsualizar/cancelar borrador y resolver un scan generan **cero movimientos y cero cambios de balance**. Un remito confirmado genera **cero o un OUTBOUND**; cada allocation produce una línea negativa trazable.

## Lock order y concurrencia

Orden compatible con Inventory: operación advisory cuando corresponda → Product IDs únicos ordenados → Customer → DeliveryNote → posiciones/scopes del producto bajo esos locks → posting/auditoría. Los locks exclusivos por producto con allocations son los existentes y serializan también ingresos, ajustes, conteos y rebuild. Sin allocations se estabiliza Product con FOR SHARE para congelar el catálogo, sin bloquear posiciones ni scopes de Inventory. No se toma primero el documento para después esperar un producto. Las ediciones bloquean los nuevos productos y el cliente antes del documento; la cancelación solo necesita el documento. Triggers de hijos bloquean el padre e impiden mutaciones tardías.

Las cantidades se suman por positionId **entre todas las líneas** antes de descontar. Dos remitos no pueden consumir la última unidad ni la misma serie. Unique de número resuelve la carrera documental y unique de movement.deliveryNoteId impide doble salida. DRAFT no es una reserva: una baja entre abrir y confirmar produce conflicto humano, no stock negativo.

Se conserva el timeout transaccional de Inventory (10 s/maxWait 5 s) y sus límites de conexión. No hay retry ciego de una carga modificada. En escenarios de mayor volumen hay que medir contención y latencia; no se agregaron servicios ni cachés.

## Cantidades, lotes, series y FEFO

Se reutilizan `amount`, `quantity`, `validQuantity` y `businessDate`: BigInt a escala 1.000.000, JSON decimal como string. UNIT/PAIR enteros; otras unidades hasta seis decimales. No se deducen conversiones desde presentation. Máximo 100 allocations por línea, 500 por remito y límite por cantidad compatible con la captura existente.

Solo sale stock USABLE no vencido. La fecha de vencimiento es inclusiva según el día de Buenos Aires del servidor; una fecha anterior bloquea la salida aunque documentDate sea anterior. DAMAGED/QUARANTINE y vencidos permanecen consultables. No se crean lotes ni series al escanear o seleccionar. Desde GS1 Stage 4, el campo “Escanear producto” consulta `inventory/products/:id/physical-match` y propone vincular la existencia exacta (serie) o elegir entre existencias compatibles (lote/vencimiento); si la unidad falta, no está disponible o contradice Stock, el producto se agrega igualmente sin vincular, por acción explícita, y los datos físicos válidos pueden guardarse como trazabilidad declarada (ver [GS1 V1 §10](gs1-verification.md)). Política ausente bloquea solo las líneas con allocations; lotRequired/expirationRequired/serialRequired se revalidan con la política existente.

Cada serie seleccionada requiere cantidad 1 y una posición disponible. Repetir una serie en cualquier línea del remito se rechaza. La protección existente de series del ledger y de balances continúa vigente.

La selección usa la consulta paginada de stock existente, ordenada por expirationDate asc, nulls last y UUID estable. Entre las posiciones elegibles ese orden es FEFO. Se muestra sugerencia cuando hay una posición elegible en la primera página, pero nunca se selecciona automáticamente. El usuario puede elegir otro lote válido. Un remito puede dividir una línea entre varios lotes o separar varias líneas del mismo producto.

## Snapshots, sensibilidad y trazabilidad

Cliente vivo en DRAFT. Al confirmar se copian solamente id/nombre/tipo/razón social/CUIT/condición fiscal/domicilio/localidad/provincia/código postal. No se copian contactos ni notas del Customer. Se congelan nombre, presentación, unidad y primer GTIN activo de Product en todas las líneas, incluso sin allocations ni movimiento. Cambios o archivados posteriores no alteran estos textos documentales.

Lote/vencimiento/serie se congelan en DeliveryNoteLineTrace al confirmar; las trazas vinculadas a Inventory conservan además su relación a la allocation y los mismos snapshots que InventoryMovementLine. No se duplica el ledger en JSON. El nombre de ubicación y el nombre visible del confirmador se resuelven desde sus relaciones actuales; los IDs históricos se conservan.

Un único patientName y affiliateNumber opcionales por remito. Sin Patient/Affiliate/Prescription/MedicalRecord ni datos clínicos estructurados. Las observaciones son del documento, no una ficha clínica. No se copian valores personales a Audit metadata, excepciones o logs. La búsqueda de la UI usa `POST /search` con términos en el cuerpo, evitando incluir paciente/afiliado en URLs de navegador/proxy; el listado no devuelve esos campos. No se persisten formularios personales en localStorage/sessionStorage.

Navegación: remito → Customer/Product y movimiento en historial de stock; historial OUTBOUND → remito. Relaciones consultables: Customer → DeliveryNote → Line → Allocation → MovementLine → Lot/Serial/Product; el mismo ledger enlaza los ingresos con Supplier. No se construye una segunda historia de stock.

## API, permisos e idempotencia

Nest `/api/v1/delivery-notes`, BFF `/api/delivery-notes` con allowlist, CSRF, cookie acotada, no-store, límites de cuerpo y validación de respuestas. Contratos Zod strict; actor, organización, estado, snapshots y fechas técnicas nunca provienen del formulario.

| Método / ruta relativa | Función                                                  | Permiso          |
| ---------------------- | -------------------------------------------------------- | ---------------- |
| GET /                  | Listado paginado; filtros q/includeArchived/page/limit   | ADMIN y OPERATOR |
| POST /search           | Mismo listado, búsqueda privada en cuerpo                | ADMIN y OPERATOR |
| POST /                 | Crear DRAFT con UUID estable                             | ADMIN y OPERATOR |
| GET /:id               | Documento y relaciones para revisión                     | ADMIN y OPERATOR |
| PATCH /:id             | Reemplazo atómico de campos y líneas con expectedVersion | ADMIN y OPERATOR |
| POST /:id/confirm      | Confirmación con operationId estable y expectedVersion   | ADMIN y OPERATOR |
| POST /:id/cancel       | Cancelar solamente DRAFT                                 | ADMIN            |

Creación: advisory por UUID y creationHash de payload canónico/actor. Replay idéntico devuelve el documento actual sin otro evento, incluso si luego cambió; carga/actor incompatibles generan 409. UUID de otro tenant no revela su documento.

Confirmación: advisory por tenant/operationId, hash de id/version/operationId/actor y unique tenant/operationId. Replay idéntico devuelve la confirmación anterior antes de validar estado o versión; otra carga/actor da 409. Otra clave sobre un documento confirmado también da 409. DB impide más de un OUTBOUND por remito.

La UI usa un ref síncrono contra doble submit y conserva la carga exacta del intento incierto en memoria. Bloquea edición y ofrece reintentar el mismo envío o comprobar resultado. Recargar después de un 409 descarta el formulario local incluso si la versión del servidor no cambió. Al recargar la página se recupera el estado persistido del documento; no hay cola offline ni reenvío automático. Las ediciones se protegen por versión; un retry de edición ya aplicado exige recargar, no duplica el efecto.

Búsqueda server-side por tokens sobre número completo/partes, cliente/CUIT, paciente/afiliado, producto, lote y serie. Incluye snapshots históricos de nombre/CUIT y nombre de producto. Case-insensitive y escape de comodines LIKE; no se agregó índice con información sensible duplicada ni motor de búsqueda externo. Los filtros de texto no prometen equivalencia de tildes en todos los campos documentales; para CUIT usar sus once dígitos. Índices tenant/fecha/id, tenant/cliente, tenant/status/createdAt/id y relaciones de línea/posición limitan consultas para el volumen inicial.

Eventos CREATED, UPDATED, CONFIRMED y CANCELLED mediante AuditService.success, resourceType DeliveryNote, metadata vacía, dentro de la transacción de cada cambio. Las lecturas y previews no auditan negocio. ADMIN/OPERATOR se revalidan junto con la sesión y pertenencia en todas las escrituras; cancelar exige ADMIN también en application.

## Evolución posterior

Printing ya agrega PrintTemplate con definition JSON tipado, PNG privado, dimensiones/coordenadas mm, tipografía, PrinterCalibration y PrintArtifact. No cambia los datos de DeliveryNote ni provoca movimientos al generar o reimprimir. La UI permite preview del borrador guardado; el overlay operativo exige CONFIRMED. Ver [arquitectura de impresión](delivery-note-printing.md).

Facturación V1 (interna, sin ARCA) se relaciona con remitos CONFIRMED y sus líneas mediante `InvoiceDeliveryNote`/`InvoiceLine`, sin billingStatus en el Remito: pendiente = confirmado sin factura. Ver [invoicing.md](invoicing.md). Devoluciones/reversiones deberán crear nuevos movimientos y vínculos al original; nunca reabrir ni reescribir el OUTBOUND.

## Migración de Inventory opcional (26 de octubre de 2026)

`20261026120000_delivery_optional_inventory` reemplaza únicamente `maxbio_delivery_complete`: los triggers diferidos anteriores exigían movimiento y cobertura total aun cuando el modelo ya admitía relaciones vacías. La nueva función exige movimiento si y solo si hay allocations, snapshots completos y trazabilidad exacta por allocation, manteniendo FKs, unicidad y guards de inmutabilidad. No modifica tablas ni datos ni migraciones históricas. Aplicar con `pnpm db:migrate`; nunca `db push`.

Lista, búsqueda por número/cliente/producto y detalle parten de DeliveryNote y no dependen de movementId. Inventory history muestra solo la cantidad descontada; el documento conserva toda su cantidad. La UI identifica el vínculo de stock como opcional y no muestra error cuando un confirmado carece de movimiento. Una allocation que pierde disponibilidad sigue bloqueando: el operador debe quitarla o reducirla antes de confirmar.

## GS1 Stage 5: datos físicos documentales sin Stock

`DeliveryNoteLineTrace` representa una porción de cantidad documental, no existencia, movimiento ni reserva. Tiene org/documento/Product/lineId/ordinal, cantidad Decimal(20,6), lote/vencimiento DATE/serie nullable, allocation nullable, origin INVENTORY/DECLARED, captureMethod MANUAL/GS1/LEGACY, scannedGtinSnapshot nullable, preserveOnUnlink y reviewedPriorTraceIds. La línea y allocation se enlazan con FKs compuestas que incluyen tenant/Product/línea/documento según corresponda. Una allocation tiene una sola trace; la serie es única por tenant/documento/Product, sin prohibición histórica entre Remitos distintos.

`sum(traces.quantity) <= line.quantity`; cada allocation tiene una INVENTORY de idéntica cantidad. El resto se documenta sin datos físicos. Cantidad 5 con allocation 2 y DECLARED 3 descuenta solo 2. Serie exige cantidad 1 y unidad UNIT/PAIR. DECLARED no exige InventoryPolicy, ni siquiera serialRequired; tampoco crea lotes, series, balances, ubicaciones, receipts, adjustments o movimientos.

POST/PATCH admiten `lines[].physicalTraces` para propuestas DECLARED (id/cantidad/lote/fecha/serie, GTIN previamente observado y scanValue efímero si corresponde). El browser no controla origin/captureMethod. Las allocations admiten traceId/sourceTraceId para conservar procedencia al vincular y preserveOnUnlink para documentar la intención. El backend deriva los valores físicos INVENTORY desde Stock, valida cantidad y pertenencia y mantiene las dos partes en una sola transacción. physicalTraces omitido en PATCH conserva declaraciones existentes; array vacío las elimina expresamente.

La UI muestra “Vinculado a Stock” y “Registrado solo en el Remito”, acepta ingreso manual y captura GS1, e informa los subtotales y el total. Al elegir una porción declarada en el selector de Stock, resta exactamente la cantidad vinculada; no duplica cobertura. Desvincular conserva como declaración lo capturado explícitamente; una selección de Stock sin captura/documentación previa desaparece. Las modificaciones solo son locales hasta Guardar borrador y siempre requieren expectedVersion. Datos físicos contradictorios requieren revisión; continuar sin Stock conserva la declaración y no corrige Inventory.

`POST /delivery-notes/trace-history` consulta, en cuerpo privado, Product + lote/serie exactos, scoped al tenant y confirmados; responde hasta 100 antecedentes, número/cliente snapshot/fecha/traceId/cantidad, con truncated explícito. Se agregaron índices org+Product+lote y org+Product+serie. El listado también encuentra texto de traces documentales.

Al confirmar series, locks advisory ordenados por org/Product/serie serializan las revisiones. El servidor relee antecedentes y exige la unión exacta de reviewedPriorTraceIds; si apareció uno nuevo devuelve 409. La UI muestra el Remito/cliente anterior y exige revisión expresa. Se guarda el acuse mínimo en cada trace. No se afirma validez o disponibilidad por tener una declaración.

La confirmación sigue siendo única y atómica: revisión de antecedentes/GTIN, guard de Printing, posting real si hay allocations, copia de snapshots desde sus líneas de ledger, cierre del Remito y Audit. El hash conserva compatibilidad de replays sin el nuevo campo opcional. No se crea operationId por trace. Un fallo revierte todo. Confirmados/cancelados rechazan INSERT tardío, UPDATE y DELETE de traces.

Migración `20261026190000_delivery_documentary_trace`: tablas/enums/índices/FKs/checks, guard de hijos existente y una función de constraints diferidos para cobertura, correspondencia allocation/trace, unidad y snapshot físico/GTIN. El backfill confirmado usa InventoryMovementLine.deliveryAllocationId y sus snapshots, no maestros vivos. DRAFT/CANCELLED con allocations se inicializan desde posiciones, LEGACY; sin allocations no se inventa trace. scannedGtinSnapshot queda null y revisión vacía en históricos. Inconsistencia histórica detiene la migración. No se reescribieron migraciones anteriores ni se usó db push.

La trace es base documental interna; no implementa ANMAT ni devoluciones ni certifica autenticidad del GS1. La consulta de solo lectura **Operaciones → Trazabilidad** se describe en [traceability.md](traceability.md). Ver implementación, pruebas y límites en [GS1 V1 §10](gs1-verification.md).

# Inventory de MaxBio — diseño de dominio

Fecha: 6 de octubre de 2026. Estado: **propuesta para una implementación posterior**.

Esta entrega contiene exclusivamente diseño. No implementa Inventory ni modifica Prisma, migraciones, contratos, endpoints o pantallas. Los nombres de entidades y rutas que siguen son propuestas, no capacidades existentes.

**Recomendación:** un ledger de movimientos confirmados, encabezado y líneas, acompañado por saldos reconstruibles actualizados en la misma transacción. Ingresos y conteos tienen documentos operativos propios. El stock pertenece a producto, ubicación y dimensiones físicas; los lotes, las series y la condición explican qué unidades existen. La disponibilidad también depende de la fecha y de haber terminado el inventario inicial.

## A. Estado actual relevante

### Inspección y fuentes del repositorio

Se revisaron README, schema Prisma, documentación de arquitectura completa y los caminos de ejecución relevantes de Catalog, identificación, importación, autenticación, auditoría, contratos y UI. Referencias para contrastar este diseño:

| Fuente                                                                                                                                                                                                         | Evidencia relevante                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Schema actual](../../packages/database/prisma/schema.prisma)                                                                                                                                                  | Product, identificadores, proveedores, referencias, identidad, auditoría y recibo de identificación; ninguna entidad de Inventory.         |
| [Overview](overview.md), [decisiones](decisions.md)                                                                                                                                                            | Monolito modular; PostgreSQL compartido; stock derivado de movimientos; snapshots en documentos; integraciones mediante adaptadores.       |
| [Autenticación](authentication.md), [AccessGuard](../../apps/api/src/common/auth/access.guard.ts), [RequestActorContext](../../apps/api/src/common/auth/request-context.ts)                                    | Organización y rol desde sesión/pertenencia; guard cerrado por defecto; CSRF; contexto explícito.                                          |
| [Catalog](catalog.md), [CatalogService](../../apps/api/src/modules/catalog/application/catalog.service.ts)                                                                                                     | ADMIN para CRUD, OPERATOR para consulta; locks Product → Supplier, expectedVersion, FK compuestas, archivado e identificadores históricos. |
| [Supplier Catalog](supplier-catalog.md), [servicio](../../apps/api/src/modules/catalog/application/supplier-catalog.service.ts)                                                                                | Staging → revisión → confirmación; transacción y auditoría; una importación no representa mercadería recibida.                             |
| [Product Identification](product-identification.md), [servicio](../../apps/api/src/modules/catalog/application/identification.service.ts), [parser](../../apps/api/src/modules/catalog/domain/catalog-scan.ts) | Resolver no escribe negocio; confirmar usa operationId, hash, locks y recibo durable. Workflow explícito ADMIN/OPERATOR.                   |
| [Contratos de catálogo](../../packages/contracts/src/catalog.ts), [identificación](../../packages/contracts/src/identification.ts)                                                                             | Zod strict, DTO independientes de Prisma, namespaces y respuestas discriminadas.                                                           |
| [AuditService](../../apps/api/src/modules/audit/audit.service.ts)                                                                                                                                              | Éxito y cambio en la misma transacción; metadata allowlisted; no ledger de cantidades.                                                     |
| [UI de identificación](../../apps/web/src/components/catalog/identification.tsx), [workspace](../../apps/web/src/components/workspace.tsx)                                                                     | HID local, Enter, foco, guard síncrono contra doble submit; contexto visual del tenant y desmontaje al cambiar organización.               |
| [Proxy comercial](../../apps/web/src/app/api/catalog/[...path]/route.ts), [cliente DB](../../packages/database/src/index.ts)                                                                                   | Whitelist HTTP, 32 KiB JSON, timeout upstream 15 s; pool 5, statement timeout 2 s y query timeout 2,5 s.                                   |
| [Verificación histórica](verification.md), [tests de identificación](../../apps/api/test/identification.integration.ts), [tests de catálogo](../../apps/api/test/catalog.integration.ts)                       | Casos reales de aislamiento, concurrencia, rollback, idempotencia y teclado simulando HID. No equivalen a pruebas de Inventory.            |

Hay documentación histórica que dice «scanner diferido»: la sección posterior de Product Identification la reemplaza. Se toma el código actual y ese último incremento como estado vigente. La evidencia histórica documenta 33 pruebas sin DB, 70 de integración API y una de database; **no se ejecutaron esas suites para este documento**.

### Qué reutilizar y qué cambiar en la implementación futura

- Reutilizar Identity, RequestActorContext, CSRF, roles, AuditService transaccional, contratos estrictos, búsquedas de Product y resolución de identificadores.
- Reutilizar el patrón de confirmación humana, versiones e idempotencia de identificación. Inventory necesitará sus propios registros de confirmación; `CatalogIdentification` no es una tabla genérica de operaciones.
- Conservar `SupplierCatalogItem → SupplierProduct → Product`. Ninguna de esas relaciones demuestra recepción ni cantidad.
- `Product.unitOfMeasure` existe; `presentation` es texto. Hoy Catalog permite cambiar la unidad y archivar Product sin consultar stock: ambos casos necesitarán nuevas reglas al implementar Inventory.
- No reutilizar el límite de 10.000 filas de importación como tamaño de una recepción, ni su staging temporal de 30 minutos como persistencia de un conteo de depósito.
- No duplicar `parseScan`, ni suponer que ya extrae lote, vencimiento o serie: los GS1 compuestos detectables devuelven `UNSUPPORTED`.

## B. Problema de dominio

Catalog responde qué artículo es y cómo lo ofrece un proveedor. Inventory debe explicar la existencia física **registrada** y qué parte puede entregarse. La exactitud respecto del depósito depende también de que se registren todas las entradas y salidas físicas.

Una declaración comercial, una lectura de scanner, un borrador y una confirmación son hechos diferentes. Solo una operación de stock confirmada produce líneas del ledger. Antes del conteo inicial, una suma contable puede existir, pero no prueba que se haya contado toda la mercadería anterior.

El dominio requiere identidad física, operaciones atómicas, historia y una puesta en marcha gradual. No requiere optimización de depósitos, logística multinivel ni una plataforma de eventos distribuida.

## C. Principios e invariantes

1. Importar listas, crear Product, identificarlo, resolver un scan y guardar un borrador crean **cero stock**.
2. Toda variación de cantidad tiene líneas de movimiento confirmado, actor, instante, unidad y causa. No existe `Product.stock` editable.
3. Ledger confirmado inmutable. Corregir agrega hechos vinculados; no modifica cantidades anteriores.
4. Saldo y ledger se confirman juntos. El saldo se reconstruye del ledger; no es una segunda autoridad editable.
5. Una cantidad pertenece a una unidad base estable. No se suma una caja a cien unidades ni se interpreta `presentation` como fórmula.
6. Producto, lote, serie, ubicación, documento y actor son del tenant correcto. El cliente no decide `organizationId`.
7. Ninguna posición física queda negativa, incluidos ajustes ADMIN. Una discrepancia no autoriza inventar existencia negativa.
8. Dañado, cuarentena y vencido siguen físicamente presentes. Reclasificar condición conserva cantidad física; destruir o perder reduce cantidad.
9. Una serie identificada representa una unidad indivisible y tiene a lo sumo una posición positiva en toda la organización para su Product.
10. Lote y serie no se identifican por proveedor de ingreso. El proveedor pertenece a la procedencia de la operación.
11. Un conteo inicial confirmado cubre todo el Product en una ubicación, incluyendo todos sus lotes, series y condiciones. Un conteo parcial no certifica cobertura completa.
12. Reintentar la misma confirmación conserva resultado e historia; una clave reutilizada con otra intención se rechaza.
13. Caducar por fecha no genera movimientos. La disponibilidad se evalúa con fecha de negocio del servidor.
14. Las reglas también se aplican en los casos de uso internos: un futuro Remito no puede saltarse Inventory por no pasar por HTTP.

## D. Modelo propuesto

### Entidades V1

Todos los registros nuevos tienen UUID y `organizationId`, incluso hijos e históricos. Las siguientes son responsabilidades conceptuales, no definiciones Prisma.

| Entidad                  | Responsabilidad y datos principales                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InventoryLocation`      | Ubicación plana: id, código estable, nombre, baja. V1 crea una por organización: «Depósito principal».                                                                                |
| `ProductInventoryPolicy` | Una por Product: revisión/configuración, lotRequired, expirationRequired, serialRequired, versión y actor. No guarda cantidad.                                                        |
| `InventoryLot`           | Grupo físico: Product, número de lote opcional, número normalizado, expirationStatus, expirationDate, versión y procedencia de creación. UUID estable.                                |
| `InventoryLotRevision`   | Corrección inmutable de metadatos: lote, versión anterior/nueva, campos anteriores/nuevos acotados, motivo, actor, recordedAt y operationId.                                          |
| `InventorySerial`        | Product, número de serie y normalizado, revisión operativa, creación. Identidad individual; lote derivado de asignaciones físicas, sin stock editable.                                |
| `InventoryStockScope`    | Una fila Product/Location: versión operativa, referencia al conteo inicial confirmado y toma de conteo activa. Es ancla de coordinación, no saldo.                                    |
| `InventoryBalance`       | Proyección por Product/Location/Lot?/Serial?/Condition: quantity exacta, revisión. Reconstruible; no API de edición.                                                                  |
| `InventoryReceipt`       | Ingreso operativo: proveedor, ubicación, autor, DRAFT/CONFIRMED/CANCELLED, versión, fechas, confirmación idempotente y notas.                                                         |
| `InventoryReceiptLine`   | Propuesta física: Product, cantidad base, lote/fecha/series declarados, condición, unidad y captura de empaque opcional. Se congela al confirmar.                                     |
| `InventoryCountSession`  | Sesión pequeña de conteo INITIAL o RECOUNT; autor, estado, versión, fechas y confirmación idempotente.                                                                                |
| `InventoryCountScope`    | Product/Location incluido en una sesión: versión esperada, instante de inicio, cobertura completa declarada, confirmación. Evita confundir una categoría con una identidad de conteo. |
| `InventoryCountLine`     | Observación física por dimensiones: cantidad esperada, observada y diferencia calculada, identidad declarada y resultado resuelto. Conserva también ceros.                            |
| `InventoryMovement`      | Encabezado exclusivamente confirmado: tipo, motivo, actor/pertenencia/sesión, occurredAt, recordedAt, relaciones de origen y corrección.                                              |
| `InventoryMovementLine`  | Hecho inmutable: Product/Location/Lot?/Serial?/Condition, quantityDelta, unidad y snapshots físicos/descriptivos; vínculo a línea de origen/corrección cuando corresponda.            |

No hay entidad genérica `Inventory` con cantidad propia. El dominio es el conjunto de estas responsabilidades. Las tablas de ingreso y conteo se justifican por borradores recuperables y observaciones de negocio diferentes del delta; no se agregan órdenes de compra, picking, tareas de depósito ni aprobaciones.

### Ubicación mínima

Recomiendo incluir `InventoryLocation` plana en V1 y ocultar su selector cuando hay una sola. Toda cantidad tiene ubicación real y no nullable. Evita convertir una fila sin ubicación en «stock global» cuando aparezca un segundo depósito. No hay zonas, bins, pasillos, jerarquía ni traslados V1.

El nombre puede cambiar; el id no. Una ubicación con existencia o conteo activo no se archiva. Una segunda ubicación y los traslados requieren habilitación posterior; incluir la FK ahora no promete esa funcionalidad.

## E. Diagrama textual completo

```text
Organization
 ├─ Membership ── User
 │    └─ contexto confiable de actor + Session
 ├─ Product ── ProductIdentifier (GTIN / códigos internos)
 │    ├─ ProductInventoryPolicy [0..1; obligatoria revisada para operar]
 │    ├─ InventoryLot [0..N] ── InventoryLotRevision [0..N]
 │    ├─ InventorySerial [0..N] ── lote opcional por asignación física
 │    └─ InventoryStockScope [uno por Location]
 │          ├─ conteo inicial confirmado ── InventoryCountScope [0..1]
 │          └─ sesión de conteo activa ── InventoryCountSession [0..1]
 ├─ Supplier
 │    ├─ SupplierCatalogItem ── SupplierProduct ── Product
 │    └─ InventoryReceipt [DRAFT / CONFIRMED / CANCELLED]
 │          └─ InventoryReceiptLine [1..N al confirmar] ── Product
 ├─ InventoryCountSession [INITIAL / RECOUNT]
 │    └─ InventoryCountScope [1..N] ── Product + InventoryLocation
 │          └─ InventoryCountLine [0..N + declaración explícita de cero]
 ├─ InventoryMovement [solo confirmado]
 │    ├─ origen: Receipt [0..1] O CountSession [0..1] O ajuste directo
 │    ├─ corrección: InventoryMovement anterior [0..1]
 │    └─ InventoryMovementLine [1..N]
 │          ├─ Product + InventoryLocation + Condition
 │          ├─ InventoryLot [0..1] + InventorySerial [0..1]
 │          ├─ ReceiptLine O CountLine [0..1, según origen]
 │          └─ línea corregida anterior [0..1]
 ├─ InventoryBalance [proyección de SUM(quantityDelta) por dimensiones]
 └─ AuditEvent [ejecución de casos de uso; no cantidades autoritativas]

Inventario inicial con diferencia cero:
 CountSession + CountScope + CountLine confirmados; ningún Movement vacío.

Futuro, sin entidades nuevas en V1:
 Remito confirmado ── relación tipada ── InventoryMovement OUTBOUND
 Reserva ── asignaciones sobre posiciones elegibles
 Trazabilidad ── consulta de identidades, documentos y movimientos
```

Las cardinalidades son de negocio. Las FK incluirán tenant y, cuando corresponda, Product; no basta con que lote y serie pertenezcan a la misma organización si representan Products distintos.

## F. Fronteras entre Product y Inventory

**Product** conserva nombre, marca, categoría, modelo, fabricante textual, identificadores, presentación y unidad base. **SupplierProduct** conserva oferta/código del proveedor. **Inventory** conserva hechos físicos, política de seguimiento y operaciones.

`ProductInventoryPolicy` pertenece a Inventory y referencia Product. Define requisitos de captura, no una supuesta clasificación regulatoria. No hace falta ensanchar Product con lotes, saldos, ubicaciones o `minStock`.

La unidad base será el `Product.unitOfMeasure` existente, revisado antes de habilitar stock. No se duplica una segunda unidad mutable en Policy. Cada línea histórica guarda su snapshot de unidad. Una vez que existe historia confirmada, Catalog debe impedir cambiar esa unidad por PATCH, incluso si el saldo volvió a cero. Una transformación posterior requiere diseño de conversión/migración explícito; V1 puede crear otro Product con identidad correcta, sin reasignar códigos reservados silenciosamente.

Cambiar texto de presentación no convierte stock. Cambiar requisitos de seguimiento con historia exige revisión ADMIN de las existencias y borradores; no convierte veinte unidades anónimas en veinte series ficticias. V1 bloquea cambios de política incompatibles hasta completar esa regularización.

Archivar Product con saldo físico positivo o conteo activo se bloquea en V1. Las consultas de historia y stock no deben ocultar registros por joins que filtran automáticamente Product/Lot/Supplier archivados. Archivar un proveedor no elimina la procedencia de una recepción ya confirmada.

## G. Lote / Batch

### Identidad recomendada

Identidad técnica: **UUID estable**. Clave de negocio cuando existe número impreso: **organizationId + productId + lotNumber normalizado**. El vencimiento y el proveedor no forman parte de esa clave.

Normalización conservadora: trim exterior, longitud acotada, rechazo de controles; conservar ceros, puntuación y mayúsculas/minúsculas. No convertir lotes a números ni fusionar por similitud. Búsqueda tolerante a case no implica igualdad de identidad.

| Situación                                                               | Decisión                                                                                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lote ABC en Products diferentes                                         | Lotes diferentes.                                                                                                                                               |
| ABC del mismo Product en dos recepciones                                | Mismo lote, distintos movimientos y fechas de recepción.                                                                                                        |
| ABC comprado a distintos proveedores                                    | Mismo lote si la identidad física coincide; procedencias separadas en recepciones.                                                                              |
| ABC con vencimientos distintos declarados                               | Conflicto para revisión; no crear automáticamente un segundo ABC agregando la fecha a la unique.                                                                |
| Lote sin vencimiento aplicable                                          | Estado explícito NONE y fecha null.                                                                                                                             |
| Corrección de fecha                                                     | Conserva UUID y número; revisión de metadatos con motivo.                                                                                                       |
| Dos lotes físicamente distintos reutilizan ABC dentro del mismo Product | Excepción real que debe resolverse antes de mezclarlos: revisar granularidad de Product y evidencia del fabricante. No inferir identidad por proveedor o fecha. |

El supuesto V1 es que un Product representa un artículo suficientemente específico para interpretar su número de lote. `manufacturerName` es texto mutable: no sirve como clave estable de fabricante. Si aparecen colisiones reales, se podrá agregar un emisor/fabricante estructurado y un discriminador comprobable, conservando UUID y relaciones históricas. No se inventa ese maestro ahora.

### Vencimiento sin número de lote y datos faltantes

`InventoryLot` también representa un **grupo físico interno** cuando hay vencimiento pero no número de lote legible/aplicable. `lotNumber = null`, UUID propio, fecha y estado explícitos. La UI dice «Grupo sin número de lote», nunca presenta el UUID como lote del fabricante.

Estos grupos no se fusionan automáticamente por Product + fecha: pueden tener procedencia distinta. Se reutiliza un grupo solo mediante selección explícita y comprobación física. El producto completamente no trazado y sin vencimiento puede tener `lotId = null`, sin fabricar un lote para cada ingreso.

Si lotRequired y falta número, solo se permite registrar en QUARANTINE con motivo «identidad incompleta». Regularizar luego mueve cantidad desde la posición desconocida al lote identificado mediante reclasificación ADMIN. No se inventa `SIN_LOTE` como número compartido universal.

### Correcciones

Una fecha o número mal transcrito se corrige mediante caso de uso ADMIN, expectedVersion y `InventoryLotRevision`, con antes/después, actor, fecha y motivo. Solo procede si sigue siendo el mismo lote físico y no colisiona con otro. La historia mantiene los snapshots originalmente registrados y permite ver la corrección.

Si en realidad se mezclaron dos lotes, no se renombra el lote completo: se reclasifican las cantidades identificadas al lote correcto. Fusiones masivas y alias históricos para búsquedas quedan diferidos; la búsqueda histórica debe encontrar los valores presentes en revisiones.

## H. Vencimiento

El vencimiento es dato del grupo físico, no de Product ni del proveedor. Las series que lo tienen lo heredan de su lote/grupo; no se mantiene otra fecha editable contradictoria en Serial.

Estados acotados de `expirationStatus`:

- `KNOWN`: fecha presente y válida.
- `NONE`: se confirmó que no aplica vencimiento; fecha null. Incompatible con expirationRequired.
- `UNKNOWN`: falta confirmar el dato; fecha null. Stock en cuarentena, sin disponibilidad.

Esto evita que null signifique simultáneamente «no vence» y «no sabemos». Un Product sin seguimiento de vencimiento y sin lote puede tener lotId null; al registrar un lote, se declara su estado de vencimiento.

`expirationDate` es **fecha calendario**, no timestamp UTC. Recomendación operativa inicial: se considera vigente durante esa fecha y vencido desde el día siguiente en `America/Argentina/Buenos_Aires`. Es una convención propuesta que debe validarse con etiquetas y operación reales, no una interpretación regulatoria. El servidor fija la fecha de evaluación y la devuelve como `asOf`; no usa el reloj del navegador. La zona se configura por organización cuando se habilita Inventory, con ese valor inicial.

Una etiqueta con solo mes/año no se transforma silenciosamente en un día supuesto. V1 requiere fecha exacta respaldada o deja UNKNOWN/cuarentena; si esos rótulos son habituales, incluir precisión de fecha y su regla documentada antes de habilitar esos productos.

Vencer no cambia physical y sí reduce available. No hay baja, cron de movimientos ni modificación de todas las filas a medianoche. Consultas calculan la elegibilidad con la fecha actual. Una pantalla abierta revalida al recuperar foco y al cambiar la fecha de negocio; un futuro despacho vuelve a comprobarla al confirmar.

Una corrección de fecha que libera mercadería exige ADMIN y razón. Cambia revisión y disponibilidad, sin delta ficticio. Preservar revisiones permite distinguir «lo que se sabía al registrar» de «la información corregida»; un reporte bitemporal completo queda diferido.

## I. Series

La política indica si la captura individual es obligatoria. Recomendación V1: `serialRequired` booleano, sin motor de reglas. Default propuesto para revisión es false; no inferirlo por categoría, GTIN, nombre ni supuesto requisito ANMAT. Antes del primer ingreso un ADMIN confirma la política del Product; puede revisar grupos de artículos conocidos con la misma configuración.

Los defaults propuestos de lotRequired y expirationRequired también son false **pendientes de revisión**, no autorizaciones automáticas para omitir datos. La ausencia de Policy o su estado sin revisar bloquea la confirmación de stock. La captura explícita de lote/fecha sigue permitida aunque no sea obligatoria.

Una serie existe cuando se registra explícitamente una identidad individual, incluso si la política no la exige. `InventorySerial` referencia Product. Su relación opcional con Lot se registra en las asignaciones de MovementLine y se proyecta en su posición de Balance; no se duplica un lotId editable en Serial. Unique histórica **organizationId + productId + serialNumber normalizado**; no por lote ni por proveedor. Igual número en Products distintos puede ser válido. Si el negocio requiere unicidad entre Products, esa evidencia permitirá ampliar el namespace posteriormente.

El número es texto conservador, con ceros y case. Una serie identificada admite solo cantidades +1/-1 por línea, y saldo total 0 o 1 entre todas las ubicaciones/condiciones. Un retorno futuro reutiliza su identidad con saldo previo cero; no crea otra Serial. Dos ingresos simultáneos de la misma serie no pueden producir saldo 2.

Una línea de captura puede presentar varias series y cantidad N; el ledger expande a N unidades. No se guarda «cantidad 20» vinculada a una sola serie. Series duplicadas dentro de una recepción se detectan antes y durante confirmación. Una operación normal conserva la asignación de lote de la serie. FK comprueba que lote y serie son del mismo Product/tenant; la transacción comprueba que no cambió su asignación, incluyendo el caso sin lote.

Corregir una asignación equivocada de lote requiere reclasificación ADMIN: -1 en la asignación anterior y +1 en la correcta, misma serie, con vínculo y motivo. Las líneas viejas conservan su lote original. Una revisión monotónica de Serial, incrementada una vez por movimiento que la afecta y guardada en sus líneas, ordena esas asignaciones sin depender del reloj. Si la serie ya salió, su último lote conocido se obtiene de esa historia y se valida al retornar; V1 no ofrece reasignación silenciosa de una serie fuera del depósito.

En V1 la serialización individual se limita a bases indivisibles UNIT o PAIR. Una serie identifica una unidad del Product, que puede ser un par completo. Un rollo serializado del que se descuentan metros necesita distinguir identidad del contenedor de cantidad de contenido; no se lo fuerza al modelo de serie con saldo 0/1. Esa combinación requiere el incremento de piezas/contenedores descrito en J.

Para unidades físicamente presentes con serie obligatoria ilegible, se permite un **saldo anónimo en QUARANTINE**, cantidad entera y motivo de identidad incompleta. Es una excepción explícita de registro físico, no una serie válida ni stock entregable. ADMIN identifica luego unidades reales: -N anónimas, +1 por cada Serial, conservando cantidad. No se crean números ficticios para terminar un conteo.

Número/Product de Serial quedan estables tras su primer movimiento. V1 corrige una identidad equivocada mediante reclasificación vinculada a la identidad correcta; no ofrece edición libre o reasignación silenciosa. Debe mostrarse la relación de corrección en ambas historias.

## J. Cantidades, unidades y presentaciones

### Unidad base y precisión

Una sola unidad base por Product. Recomendación de almacenamiento: decimal exacto `NUMERIC(20,6)`; contrato HTTP como string decimal canónica, nunca float JavaScript como autoridad. UNIT y PAIR aceptan solo enteros. Unidades de longitud, volumen y masa aceptan hasta seis decimales; rechazar exceso, overflow y valores no finitos, sin redondeo silencioso. El límite comercial por operación será menor que el máximo técnico y deberá medirse con datos reales.

No se permiten fracciones de una serie, de un par ni de una caja indivisible. Elegir unidad y granularidad antes del primer movimiento es parte de habilitar el producto.

| Caso                                              | Unidad base recomendada        | Registro                                                                                                       |
| ------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| A. Se recibe una caja x100 y se entregan unidades | UNIT = una unidad individual   | Entrada +100. «1 caja ×100 unidades» es captura de recepción, no saldo 1.                                      |
| B. Solo se maneja por caja completa               | UNIT = una caja de ese Product | Entrada +1; nombre/presentación deben decir caja. No hay apertura ni conversión a unidades individuales en V1. |
| C. Rollo de 3 m con consumo parcial futuro        | METER                          | Entrada +3; un futuro consumo de 0,5 deja 2,5. No exige identificar cada rollo si solo importa longitud total. |
| D. Artículo manejado por par                      | PAIR                           | Entrada +1 par. No convertir automáticamente a dos UNIT ni permitir medio par.                                 |

Para B, UNIT significa unidad indivisible del artículo «caja»; la revisión debe mostrar claramente «Se cuenta cada caja como 1». El texto de presentación por sí solo no decide si A o B aplica. Si más adelante se venden cajas y piezas, se debe definir packaging antes de cambiar esa interpretación.

Si importa distinguir dos rollos parcialmente usados, o garantizar un corte continuo de 2 m frente a varios retazos, el saldo por metros no alcanza: esa necesidad de contenedores/piezas individuales se difiere y debe relevarse. No prometer picking por rollo con este modelo.

### Conversión mínima V1

La entrada principal siempre muestra cantidad en unidad base. Se puede ofrecer una calculadora explícita: cantidad de empaques enteros × contenido en unidad base. El usuario confirma el resultado visible. Se conservan en la línea confirmada `enteredPackageCount`, `baseUnitsPerPackage`, etiqueta descriptiva acotada y cantidad base resultante. El servidor recalcula el producto exacto y rechaza discrepancias. Sin calculadora, la captura es directamente en base.

El factor se declara y confirma por operación; no se aprende del texto importado ni se reutiliza automáticamente tras otro scan. No es una tabla universal de conversiones. Un ingreso mixto, por ejemplo una caja y cinco piezas, se captura en líneas separadas que pueden consolidarse en la consulta.

Para artículos serializados se verifica además que el total convertido coincide con el número de series individuales; para PAIR el contenido se expresa en pares. No hay conversión METER ↔ CENTIMETER, PAIR ↔ UNIT ni entre Products en V1: se ingresa en la base elegida.

Packaging persistido pasa a ser necesario si se repiten presentaciones, si un GTIN distingue niveles de empaque o si se compra/vende consistentemente en unidades diferentes. En esa etapa, `ProductPackaging` tendrá factor positivo, vigencia/versionado y vínculo tipado con identificador cuando exista evidencia. Un SupplierProduct por proveedor/Product hoy no modela varias presentaciones; no usarlo como tabla de factores. No asumir que todos los GTIN de un Product representan igual cantidad.

## K. Movement y MovementLine

### Elección y alternativas

Recomiendo **encabezado + líneas**: comparten actor, tiempo, causa, origen, atomicidad y correlación. Una fila independiente por unidad/movimiento pierde agrupación; un único balance mutable pierde explicación. Un ledger sin encabezado terminaría repitiendo esas relaciones. Event sourcing de todo el sistema no aporta valor aquí.

Usar Movement en estado DRAFT sería posible, pero mezclaría captura editable y verdad contable, obligando a filtrar estado en cada cálculo. Se elige Movement exclusivamente confirmado y Receipt separado: recupera borradores, identifica quién recibió qué de quién y congela la captura revisada. ReceiptLine y MovementLine no son dos stocks: solo la segunda participa en las sumas. Una ReceiptLine puede producir varias MovementLine por series.

Campos comunes del encabezado: id, organizationId, type, reasonCode cuando aplica, notes acotadas, actorUserId, membershipId, sessionId, occurredAt, recordedAt y enlaces tipados. `recordedAt` lo asigna servidor y determina el registro; `occurredAt` describe el hecho físico. V1 no permite retroactividad que cambie saldos ya confirmados: una fecha anterior es informativa, queda visible y requiere razón; no evade vencimiento ni reglas actuales. No se admiten fechas futuras de hecho.

Línea: id, organizationId, movementId, productId, locationId, lotId?, serialId?, condition, quantityDelta, baseUnit snapshot, snapshot de nombre/código identificado/lote/fecha/serie, revisión física observada, revisión de serie cuando aplica y versión del scope al registrar. Los snapshots son campos definidos y acotados, no el DTO entero. El GTIN se conserva si fue comprobado/seleccionado; no se inventa uno a partir del GTIN declarado en una lista.

### Signo, tipo y motivo

La cantidad del ledger es **signed**. No se almacena otra dirección modificable que pueda contradecir el signo. Una reclasificación tiene signos opuestos dentro del mismo movimiento; no tiene una dirección única.

| Tipo V1          | Regla                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| RECEIPT          | Todas las líneas positivas. Origen Receipt obligatorio.                                                        |
| INITIAL_COUNT    | Diferencias observadas - registradas, positivas o negativas; origen CountSession INITIAL.                      |
| ADJUSTMENT       | Variación justificada; COUNT, ADMIN_ERROR, LOSS, DAMAGE_DISPOSAL u OTHER.                                      |
| RECLASSIFICATION | Pares de salida/entrada que conservan cantidad por Product/unidad, por cambio de condición o identidad física. |
| CORRECTION       | Delta correctivo vinculado a movimiento/líneas anteriores; motivo obligatorio y reglas propias.                |

No hay líneas con delta cero. Un conteo sin diferencia se confirma como documento de conteo y no crea un movimiento vacío. Los movimientos no contienen `updatedAt` como permiso implícito de edición ni un DELETE de negocio.

Tipo será un conjunto cerrado y pequeño validado en contratos y DB. Extenderlo mediante una migración futura es razonable; no hace falta un catálogo de tipos configurables que permita inventar semánticas de stock. Motivo es un conjunto separado; OTHER exige explicación. No codificar una enum con todas las combinaciones de dirección, documento, condición y motivo.

V2 podrá agregar OUTBOUND, RETURN_IN y RETURN_OUT con casos de uso propios. Inbound/outbound se deriva para lecturas; una devolución comercial no se registra como corrección de un error administrativo.

## L. Cálculo y proyección de stock

Para cada posición `p = tenant + Product + Location + Lot? + Serial? + Condition`:

```text
balance(p) = suma de quantityDelta de líneas confirmadas de p
physical(Product, Location) = suma de balance(p) de todas sus posiciones
```

`InventoryBalance.quantity` materializa exactamente esa primera suma. Se actualiza sincrónicamente junto con líneas y AuditEvent, en una transacción. No se alimenta con un job eventual ni se permite corregirla directamente desde la UI. No se guarda otro total en Product.

El saldo se agrupa por posiciones; conservar filas en cero simplifica identidad/locks/historia. Unique de dimensiones debe tratar los null como una misma dimensión vacía, no permitir varios saldos idénticos sin lote o serie. PostgreSQL 17 admite `NULLS NOT DISTINCT`; su representación concreta en migraciones deberá revisarse al implementar. Una FK nullable no valida por sí sola todas las combinaciones de columnas nulas. [Documentación PostgreSQL 17: constraints](https://www.postgresql.org/docs/17/ddl-constraints.html).

V1 incluye una comprobación técnica ledger ↔ balances por scope y reconstrucción controlada bajo los mismos locks. Una diferencia se investiga y reconstruye desde el ledger; nunca se inventa un movimiento para encubrir corrupción de la proyección. El mantenimiento registra evidencia técnica sin cambiar hechos comerciales. No hay endpoint general de «set balance».

Camino de escala: índices y proyección desde V1; consultas normales no suman toda la historia. Ante necesidad medida, reconstrucción por scope, snapshots técnicos o particiones conservando el ledger. No purgar movimientos porque el balance ya esté calculado. Lecturas paginadas y detalle evitan devolver millones de series.

## M. Físico, reservado, no disponible y disponible

Condiciones físicas mutuamente excluyentes V1: **USABLE, QUARANTINE, DAMAGED**. «Vencido» es una propiedad temporal del lote, no otra condición almacenada. Una unidad puede estar dañada y vencida sin contarse dos veces como no disponible.

Para scopes inicializados:

```text
physical    = todas las unidades registradas físicamente presentes
unavailable = unión de posiciones dañadas, en cuarentena,
              vencidas o con identidad/vencimiento pendiente
eligible    = physical - unavailable
reserved    = 0 en V1
available   = eligible - reserved
```

`unavailable` es una unión por posición, no suma de reportes que se superponen. Una cantidad parcial dañada se representa separándola en otra posición, no agregando un flag a todo el lote. No se aplica max(0, saldo) para esconder inconsistencias.

Ejemplo: physical 20; 3 dañadas (de ellas 2 vencidas) y otras 4 utilizables vencidas. unavailable = 7, available = 13. Reclasificar 2 utilizables a cuarentena deja physical 20 y available 11. Desechar después una unidad dañada deja physical 19; available sigue 11.

Antes del inventario inicial, las sumas son **registradas parciales**, no una medición completa. La API informa `initializationStatus` y cantidades registradas; la UI dice «Pendiente de conteo inicial». No publica un available confiable para prometer entregas; puede devolverlo null y mostrar el subtotal registrado aparte. Una suma entre ubicaciones/productos con scopes pendientes lleva cobertura incompleta, nunca oculta esa condición como cero real.

No crear tablas ni columnas de reservas V1. En V2, `reserved` de la fórmula debe representar unidades elegibles efectivamente asignadas; una asignación que vence o entra en cuarentena pasa a estar bloqueada y exige reasignación. No restar la misma unidad como reservada y no disponible. La demanda pendiente y las asignaciones bloqueadas serán conceptos separados. Las reservas futuras usarán los mismos locks y versiones de Inventory.

## N. Ingreso de mercadería

### Documento operativo y confirmación

`InventoryReceipt` responde «qué recepción preparó/confirmó esta persona, de qué proveedor, con qué captura». `InventoryMovement` responde «qué cambió físicamente por esa recepción». La primera puede estar incompleta y recuperarse; el segundo nace completo e inmutable. No se duplican estados comerciales de compras/facturación.

1. Elegir proveedor activo y abrir un borrador recuperable en servidor. Ubicación implícita: Depósito principal.
2. Escanear o buscar Product mediante Catalog. Revalidar que esté activo y tenga política revisada.
3. Capturar cantidad base o calculadora de empaque, lote, vencimiento, condición y series si corresponden. Mostrar solo campos necesarios, con acceso a detalles físicos opcionales.
4. Agregar a la lista. Se guarda la propuesta; no se incrementa Balance ni se crean MovementLine. Los números de lote/serie nuevos son datos de borrador, no identidades físicas confirmadas todavía.
5. Continuar con otros scans. Mismo Product con distinto lote/condición es otra línea. Agregar dos veces el mismo Product no demuestra duplicación: mostrar advertencia y cantidades acumuladas, permitir revisión explícita. Serie repetida sí es error.
6. Revisar proveedor, unidad, cantidades, lotes, vencimientos y totales por Product. Una sola confirmación crea todos los efectos o ninguno.
7. La transacción resuelve/crea Lot y Serial, valida reglas, crea Movement y líneas, actualiza balances, congela Receipt/Line y audita. Devuelve ids estables y resumen confirmado.

Un proveedor en la recepción acredita procedencia; no exige que todo Product tenga previamente SupplierProduct con él. El código externo sí requiere su proveedor de namespace. Reconocer por GTIN puede ingresar un Product ya existente comprado a un proveedor nuevo sin crear un vínculo comercial de forma silenciosa. SupplierProduct puede capturarse como referencia opcional comprobada, sin ser propietario del stock.

No aceptar metadata contradictoria sobre un lote ya existente como una actualización de recepción. Se detiene esa línea para revisión/corrección explícita. No se aplica «último ingreso gana» sobre fecha o número.

Se admite registrar mercadería vencida o dañada realmente recibida: debe quedar visible la advertencia y su disponibilidad cero. Si corresponde rechazarla comercialmente, la empresa decide no recibirla; el sistema no finge que desapareció. Faltantes de identidad obligatoria entran exclusivamente en cuarentena.

### Borradores y límites

Borradores privados al autor dentro del tenant, recuperables tras reconexión/relogin; ADMIN puede recuperar o cancelar uno abandonado mediante acción auditada. Una sesión de login vieja no debe hacer perder un conteo. Cada modificación requiere expectedVersion del documento y cada línea tiene un id estable generado al crearla, para que reintentar Agregar no duplique filas.

Propuesta inicial de límites a validar: 50 líneas de captura por recepción, 500 unidades serializadas en total y como máximo 1.000 líneas de ledger al expandir/reclasificar. Guardar líneas en requests acotados, con páginas para series; confirmación envía id/versión/operationId/hash de revisión, no vuelve a subir todo el depósito. Los límites se ajustarán con mediciones dentro de los timeouts actuales; no ampliar límites generales por inercia.

Los borradores pueden cancelarse; los confirmados solo corregirse. No expiran a los 30 minutos por copiar SupplierCatalogUpload. Política de limpieza de borradores cancelados se define por separado; nunca elimina documentos confirmados ni recibos de idempotencia.

## O. Inventario inicial gradual

### Unidad de cierre

Elegir **múltiples sesiones pequeñas**. Una sesión contiene uno o varios scopes completos **Product + Location**, con todos sus lotes/series/condiciones. Una categoría sirve para organizar la lista pendiente; no define identidad ni autoriza volver a contar lo mismo. En V1 no se cuentan dos estantes independientes del mismo Product como dos inventarios iniciales aditivos.

Recomendación: hasta diez Products por sesión, preferentemente uno cuando hay muchas series o dispersión física. Se confirma ese bloque y se abre otro; el resto del depósito sigue trabajando. No hay un evento gigante ni un cierre global del negocio. Si un solo Product supera los límites de captura/tiempo, se releva ese caso antes de habilitarlo: se puede guardar captura por partes, pero no certificar un scope parcialmente contado.

`InventoryStockScope` pasa de pendiente a inicializado cuando existe un `InventoryCountScope` INITIAL confirmado para él, incluso si la cantidad observada es cero. La referencia inicial queda estable. Una corrección posterior no lo convierte en «nunca contado» ni habilita otro saldo de apertura. Product no recibe `verified` ni un estado comercial de inventario global.

### Protocolo viable con actividad diaria

1. Elegir Products pendientes, localizar físicamente todas sus unidades y guardar la sesión.
2. Al iniciar el conteo de cada scope, tomarlo para esa sesión bajo lock breve. Registrar versión e instante; impedir otra sesión activa sobre el mismo scope.
3. Acordar una **pausa operativa breve de movimientos de esos artículos**. La UI muestra «En conteo por …». Un lock de DB no impide que alguien mueva una caja: hace falta esta disciplina física.
4. Contar todos los lotes, series, dañados y cuarentena del scope. Nuevas entregas de ese Product esperan separadas fuera del conteo y sin confirmar ingreso. Otros Products operan normalmente.
5. Presentar cada posición conocida y las nuevas: esperado registrado, observado y diferencia. Las posiciones conocidas omitidas se muestran como pendientes; convertirlas a cero exige declaración explícita. «No escaneado» no equivale automáticamente a cero.
6. Revisar y confirmar toda la sesión pequeña. Revalidar dueño/toma vigente, cobertura, versiones de scopes, políticas, lotes y series. Calcular deltas en servidor.
7. Persistir observaciones, movimiento si hay diferencias, balances, inicialización y auditoría en la misma transacción. Liberar la toma. Retomar operaciones físicas.

La toma de conteo es un estado persistido, **no una transacción abierta durante horas**. No expira liberando stock silenciosamente. Autor puede cancelarla; ADMIN puede liberarla con motivo. Liberarla invalida la captura para confirmar y obliga a recuento de ese scope. Un navegador cerrado deja trabajo recuperable y una toma visible, no un lock PostgreSQL abierto.

El esperado de cada posición se captura al tomar el scope, bajo su lock. La versión esperada corresponde al estado después de registrar esa toma. Guardar observaciones del borrador cambia la versión del documento, no el saldo ni su revisión física. Completar la captura no libera la toma antes del commit. Una consulta concurrente sigue pudiendo mostrar existencia, con aviso «En conteo»; una futura salida no puede confirmarse mientras dure la toma.

No retener diez Products por toda una jornada si se pueden confirmar de a uno. Si la empresa no puede pausar ni un artículo unos minutos, se necesita un protocolo de cortes físicos más complejo con movimientos capturados durante el conteo; queda fuera del default V1. No prometer consistencia solo por timestamps.

### Recepciones antes de inicializar y prevención de duplicados

Se permiten ingresos registrados antes del conteo inicial, marcando saldo provisional. El conteo **reconcilia**, no suma ciegamente:

```text
Registrado por ingresos previos: 5
Existencia total observada, incluidas esas 5 unidades: 17
INITIAL_COUNT: +12
Saldo posterior: 17, no 22
```

Si lo observado fuera 3, INITIAL_COUNT genera -2 con evidencia del conteo, quedando 3. Se permite a OPERATOR solo para el primer cierre del scope. Después de inicializar, una diferencia exige recuento/ajuste ADMIN. No es un permiso general para ajustar Products ya inicializados.

La diferencia se calcula **por posición**, no solo por Product: esperado 5 de lote A y observado 5 de B requieren -5 A y +5 B, aunque el total sea igual. Seriales se reconcilian por identidad. Un Product contado sin existencias exige «Confirmo que revisé este producto y hay cero».

Unique de scope y referencia al conteo inicial impiden dos aperturas aunque tengan operationId distintos. La misma sesión confirmada devuelve su resultado al reintentar. Un nuevo intento INITIAL sobre scope inicializado se rechaza; se propone el caso de recuento autorizado.

Si falla la conexión después de confirmar, consultar/reintentar esa sesión antes de abrir otra. Si hubo movimiento físico fuera de protocolo, invalidar y repetir el conteo afectado. No calcular una diferencia contra un saldo nuevo usando una observación vieja.

### Límite operativo de una V1 sin salidas comerciales

El usuario pidió diferir salidas y Remitos. Por tanto, **ingresos + inventario inicial no mantienen stock real si las entregas diarias quedan fuera del sistema**. No ocultar este límite.

Recomendación: desplegar primero un piloto de esos flujos; antes de usar available para prometer mercadería, incorporar la salida básica del siguiente incremento, aunque todavía no haya Remitos. Durante el piloto, Products con egresos físicos no registrados requieren recuento y no se presentan como stock continuamente confiable. No usar OTHER/ajustes de pérdida para disfrazar ventas o entregas normales. Si se requiere operación integral desde el primer despliegue, la salida básica debe adelantarse a V1 por una decisión de alcance explícita.

## P. Ajustes y correcciones

### Ajustes

ADMIN registra cantidad delta o un recuento completo. La UI puede decir «Esperábamos 7; contaste 10; se registrará +3», pero nunca ejecuta un set stock. El snapshot esperado tiene versión; si cambia, se exige revisión/recuento, no reaplicar automáticamente el delta calculado contra otra realidad.

| Motivo visible       | Efecto                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Conteo físico        | Observado menos esperado, con evidencia de posiciones, incluyendo cero.                                               |
| Error administrativo | Delta o corrección vinculada si se conoce el movimiento incorrecto.                                                   |
| Daño                 | Si sigue en depósito: reclasificación USABLE → DAMAGED. Si se desecha: baja física separada y motivo DAMAGE_DISPOSAL. |
| Pérdida              | Baja física sobre cantidad registrada, motivo LOSS.                                                                   |
| Otro                 | Delta permitido con explicación obligatoria; no puerta trasera para saltarse reglas.                                  |

OPERATOR puede apartar cantidad existente hacia QUARANTINE o DAMAGED, con motivo y alcance explícito. Eso reduce disponibilidad y conserva existencia. ADMIN libera cuarentena, regulariza identidades, desecha y ajusta cantidades. No hay aprobación multinivel.

### Corrección vinculada por diferencia

Default V1: **CORRECTION con deltas vinculados a las líneas erróneas**. Ejemplo:

```text
Ingreso M1/L1: +10
Corrección M2/L2, corrige M1/L1, motivo: se cargaron dos unidades de más: -2
Efecto neto documentado del ingreso: +8
```

El original sigue +10. El visor muestra cadena, actor y neto corregido. No reescribir ReceiptLine confirmada a 8: conserva captura original y muestra su corrección.

La UI propone un resultado corregido sobre el efecto vigente de esa línea/cadena. Si ya se corrigió a 8, volver a pedir 8 produce «sin cambios», no otro -2. La revisión de correcciones y el saldo se bloquean/revalidan; dos administradores con la misma revisión no pueden aplicar dos rectificaciones obsoletas. Un error de la corrección se corrige mediante una nueva vinculada a ella, sin ciclos ni referencias a hechos futuros.

Cambiar lote/condición/Product mal capturado requiere salida de la posición equivocada y entrada de la correcta en el mismo movimiento, con validación de unidades e identidades. V1 permite reclasificar dentro del mismo Product; cambiar Product requiere revisión especial ADMIN con equivalencia comprobada y queda fuera del atajo de corrección de cantidad. No convertir entre unidades diferentes por accidente.

**Reversión total** es un caso particular generado por servidor: inversa exacta de un movimiento sin correcciones previas, con una única reversión total admisible y stock suficiente. Se puede diferir su botón hasta después de la corrección parcial; no es necesario un segundo motor. No permitir revertir dos veces el original ni revertir ignorando consumos posteriores.

Si se recibieron 10 y luego salieron 9, corregir ese ingreso a 8 dejaría -1 y se rechaza. ADMIN debe investigar las operaciones posteriores y registrar los hechos comprobables en orden válido. No insertar un ingreso ficticio para desbloquear la reversión. Un comentario de discrepancia puede conservarse sin generar stock imposible.

### Regla de stock negativo V1

**No se permite saldo físico negativo en ninguna posición, para ningún rol.** Una futura salida normal exige cantidad disponible suficiente de sus posiciones elegidas. No compensa un lote negativo con otro positivo.

Los ajustes negativos pueden consumir cantidad no disponible si la causa es pérdida/desecho real, pero nunca más de lo físicamente registrado allí. Un conteo real cero contra saldo 7 produce -7, no una deuda de -3 porque «faltaban diez». Faltantes comerciales o entregas no registradas son otra discrepancia a investigar; no se representan como unidades físicas negativas.

## Q. Salidas y Remitos futuros

Remitos será dueño del documento y su ciclo de vida. Inventory será dueño de validar disponibilidad y producir el movimiento. El caso de uso futuro de confirmar Remito coordinará **una transacción PostgreSQL** que confirme ambos, reutilizando Inventory con el mismo contexto y cliente transaccional; no dos commits HTTP independientes.

Al implementar Remitos se agregará una FK/relación tipada entre Remito y Movement, con unicidad para una contabilización por confirmación. Sus líneas tendrán asignaciones a MovementLine, porque una línea comercial puede salir de varios lotes/series. No se crea hoy esa tabla ni un `sourceId` UUID sin FK.

V1 usa relaciones reales: Movement.receiptId o Movement.countSessionId, exclusivas según tipo; ajustes directos tienen actor/motivo y posible correctedMovementId. Se conserva la relación tipada de línea de origen. El campo type explica semántica y **no sustituye integridad referencial**. Notas o un número de documento externo pueden ser informativos, jamás una autoridad de enlace.

Una salida básica futura sin Remito también será un caso de uso explícito y auditable. Cuando haya Remitos, no se deducen salidas a partir de PDF/impresión: confirmar el documento produce el hecho, imprimirlo no.

RETURN_IN futuro es entrada física con condición de recepción; default cuarentena hasta verificar utilizabilidad e identidad, conservando vínculo tipado a la salida cuando se conozca. RETURN_OUT es salida física hacia proveedor y puede usar cantidad dañada/cuarentena si esa es la devolución real; no exige available comercial, sí physical suficiente. No toda devolución necesita deshacer el movimiento comercial original.

Sin reservas V1. Remitos en borrador no descuentan stock; si se necesita prometer antes de entregar, se diseñará Reservation explícita. No usar movimientos negativos provisionales como reserva.

## R. Scanner e identificación

El scanner sigue siendo teclado HID sobre un input local. Ingreso llama al `POST /api/v1/catalog-scans/resolve` existente; no crea otro parser de GTIN ni consulta directamente tablas desde la web.

| Resultado actual     | Comportamiento en ingreso                                                              |
| -------------------- | -------------------------------------------------------------------------------------- |
| KNOWN                | Abrir captura física del Product. La lectura no agrega cantidad por sí sola.           |
| UNKNOWN / CANDIDATES | Guardar borrador y abrir identificación existente. Requiere confirmación humana allí.  |
| AMBIGUOUS            | Pedir contexto de proveedor del código; no elegir un Product por coincidencia parcial. |
| ARCHIVED             | Bloquear nuevo ingreso y ofrecer revisión administrativa.                              |
| INVALID              | Corregir lectura; no reinterpretar GTIN inválido como otro namespace.                  |
| UNSUPPORTED          | Usar GTIN visible/manual y capturar lote/fecha/serie en sus campos.                    |

Volver desde identificación con un enlace interno permitido y receiptId del mismo tenant/autor; reconsultar el Product reconocido y revalidar borrador. No confiar en productId de la URL como autorización ni en un resultado antiguo. No permitir redirect externo arbitrario. El estado persistido evita perder las líneas al navegar.

Confirmar identificación sigue produciendo cero stock. El usuario vuelve al ingreso, completa datos físicos, agrega y confirma la recepción. Inventory no crea Product silenciosamente, y un Product nuevo todavía requiere revisión de su política de inventario.

Preservar guard síncrono contra Enter/click repetidos y operationId estable de confirmación. Cambiar código, namespace o proveedor invalida la resolución anterior. Enter en cantidad/lote no debe activar otro scan o confirmar toda la recepción. El foco vuelve a scanner después de Agregar, con confirmación accesible.

GS1 completo queda para un incremento que extienda el parser compartido con salida tipada de identidad y datos físicos sugeridos. Inventory validará esos datos contra lote/serie existentes; leer un AI no equivale a confirmar stock. No inferir factor de empaque desde GTIN sin modelo y evidencia.

## S. Trazabilidad futura

Este diseño conserva Product estable, identificadores observados y su namespace, GTIN cuando existe, lote/grupo físico, serie, vencimiento y revisiones; además de cantidades/unidades, condición, ubicación, origen por recepción, actor, momento físico declarado y momento de registro. Mantiene causas y correcciones sin borrar movimientos originales.

Un futuro destino se vinculará mediante el documento real de salida y su contraparte, sin inventar hoy Client, Remito o un registro ANMAT. Un adaptador futuro podrá construir mensajes desde estos hechos; las respuestas/intentos de una integración no serán el ledger de stock.

**Preparación para trazabilidad no significa cumplimiento ANMAT/SNT.** No se decide aquí qué artículos están alcanzados, qué identificadores exige una norma, plazos, eventos reportables, habilitaciones o formatos. Eso requiere productos y actividad reales, requisitos oficiales vigentes y validación especializada en la etapa de integración. No se agregan campos regulatorios supuestos.

Límite deliberado: en cantidad no serializada, unidades fungibles del mismo lote recibidas de dos proveedores comparten posición. Se conocen ambas entradas y todas las salidas del lote, pero no se puede atribuir cada unidad saliente a una recepción exacta. Si el requisito real exige esa granularidad, se agregan asignaciones a capas de recepción o identidad individual. No afirmar trazabilidad unitaria por tener lotes.

## T. Permisos V1

| Caso de uso                                             | OPERATOR                            | ADMIN                               |
| ------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| Consultar stock, lotes, series e historia del tenant    | Sí                                  | Sí                                  |
| Resolver/identificar mediante workflow existente        | Sí                                  | Sí                                  |
| Preparar/confirmar ingreso de Products habilitados      | Sí, borrador propio                 | Sí                                  |
| Preparar/confirmar primer inventario del scope          | Sí, sesión propia y scope pendiente | Sí                                  |
| Apartar existencia a cuarentena/dañado                  | Sí, cantidad existente y motivo     | Sí                                  |
| Liberar cuarentena/dañado a utilizable                  | No                                  | Sí, validando identidad y condición |
| Recuento posterior, ajuste de cantidad, pérdida/desecho | No                                  | Sí, motivo obligatorio              |
| Corregir movimiento, lote/fecha/identidad               | No                                  | Sí, caso de uso específico          |
| Configurar política/unidad inicial                      | No                                  | Sí                                  |
| Recuperar/cancelar toma o borrador de otro actor        | No                                  | Sí, acción explícita auditada       |

No se agregan roles, permisos configurables por campo ni aprobaciones encadenadas. Cada caso se autoriza en controller y application, siguiendo identificación. Se revalida pertenencia, sesión y rol al confirmar, también en replay antes de devolver datos.

El alta básica OPERATOR de Product sigue dentro de identificación; no concede permiso para elegir unilateralmente políticas sensibles o corregir el catálogo general.

## U. Concurrencia e idempotencia

### Estrategia V1

No alcanza sumar movimientos y luego insertar una salida: dos requests pueden leer el mismo saldo. Se elige **ledger + proyección transaccional + locks**. READ COMMITTED con protocolo de escritura compartido es suficiente para esta propuesta; subir aislamiento no sustituye el protocolo ni las constraints.

PostgreSQL retiene locks de fila hasta fin de transacción; escritores concurrentes de esa fila esperan y vuelven a trabajar sobre su estado vigente. Los locks de filas existentes no crean por sí solos una fila ausente. Orden uniforme reduce deadlocks, que todavía deben manejarse como transacciones abortadas. [PostgreSQL 17: bloqueo explícito](https://www.postgresql.org/docs/17/explicit-locking.html).

Protocolo propuesto para todos los escritores de Inventory:

1. Validar forma/tamaño y preparar propuesta fuera de la transacción. No parsear archivos ni esperar al usuario dentro de ella.
2. Dentro, revalidar identidad y tomar advisory lock transaccional de `tenant + caso de uso + operationId`. Consultar confirmación previa antes de evaluar versiones que ese mismo commit ya cambió.
3. Bloquear **todos los Product involucrados ordenados por UUID**. V1 serializa escrituras físicas del mismo Product incluso entre ubicaciones: es una decisión conservadora compatible con la escala actual y con Catalog.
4. Bloquear Supplier si aplica, documento operativo, scopes ordenados, lotes y series ordenados y balances. Orden global: Product → Supplier → documento → scope → lote → serie → balance. No adquirir Products adicionales tarde dentro de la transacción.
5. Releer documento y versión: si sus Products cambiaron desde la preparación, rechazar; no continuar con una lista de locks incompleta. Draft updates que solo editan propuestas no toman locks físicos ni los adquieren después de bloquear el documento.
6. Crear scopes/posiciones faltantes bajo ese lock de Product y sus unique. Validar que ningún scope esté tomado por otro conteo, que identidad/política/lote sigan vigentes y que los saldos resultantes sean válidos.
7. Consolidar deltas por posición, validar su resultado y seriales globalmente por Product. Aplicar disminuciones antes de incrementos, siempre dentro de la misma transacción, para que reclasificar una serie no viole transitoriamente la unique de posición positiva. Actualizar balances mediante incrementos atómicos con condiciones, registrar revisiones de serie/scope, insertar historia, confirmar origen/idempotencia y auditoría. Commit único.

No se incrementa Product.version por cada ingreso: se mantiene una versión operativa separada en StockScope. El lock Product se comparte para coordinar política/unidad/archivado y series, no para convertir Product en saldo. Una futura optimización puede reemplazar ese lock grueso por scopes y locks de seriales, cuando pruebas y métricas justifiquen mayor concurrencia.

Una recepción aditiva no exige que el saldo siga siendo el mostrado al abrir el formulario: otra recepción válida puede haberlo aumentado. Sí exige que borrador, política e identidades sigan siendo compatibles. Conteos, correcciones y ajustes revisados contra un esperado requieren la versión de saldo/efecto correspondiente. No convertir toda lectura de stock de la UI en un conflicto innecesario.

La corrección de lote también bloquea su Product y actualiza las revisiones de scopes afectados; así invalida conteos/revisiones sensibles. Toda ruta que modifica stock, clasificación o identidad debe participar. El protocolo debe revisarse junto con locks existentes Product → Supplier y Supplier → Import antes de implementarse.

No mantener una transacción abierta durante escaneo. Los locks son breves al confirmar. Si el pool/timeouts se agotan, rollback y error recuperable, sin parciales. Deadlock/serialization failure admiten retry acotado con la misma intención; conflicto de versión requiere revisión humana. No traducir todos los errores SQL a «stock insuficiente» o 409 indiscriminadamente.

### Constraints y alcance de la protección

- Unicidad de scope, posición, lote numerado y serie, siempre tenant-scoped.
- Balance.quantity >= 0. Si serialId está presente, saldo 0 o 1; índice único parcial por tenant/serial sobre posiciones positivas impide dos ubicaciones/condiciones activas.
- Línea serializada con delta +1/-1; lote/serie/Product coherentes. Anónimo con serial obligatorio solo en QUARANTINE y con razón.
- FK compuestas, unique de contabilización del documento y estado/fecha de confirmación coherentes.
- No UPDATE/DELETE del ledger en casos de uso; al implementar, protección DB de inmutabilidad de Movement/Line y documentos confirmados, con mecanismo de inserción atómica y cierre del encabezado. Insertar líneas posteriormente también debe prohibirse. La protección concreta requiere constraints/triggers revisados; no se promete que Prisma o FK Restrict por sí solos lo hagan.

Las sumas entre filas, conservación de reclasificaciones y reglas de política no son CHECKs de una sola fila. Se validan en la transacción central de contabilización, con defensas DB adicionales donde corresponda. No confiar en una unique nullable convencional para balances ni en una FK que omite validación por columnas null. El dueño de DB sigue siendo privilegiado; estas defensas no equivalen a almacenamiento inviolable.

### Idempotencia durable

Se reutiliza el **patrón**, no la entidad `CatalogIdentification`. Cada confirmación guarda operationId, hash canónico del comando revisado, actor y resultado estable:

| Operación                                 | Registro durable y unicidad adicional                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmar ingreso                         | Receipt guarda confirmationOperationId/hash/actor. Unique tenant/operationId de ese caso; Movement.receiptId único.                   |
| Confirmar conteo                          | CountSession guarda confirmationOperationId/hash/actor, incluso si hubo diferencia cero. Movement.countSessionId único cuando existe. |
| Ajuste/reclasificación/corrección directa | Movement guarda operationId/hash/actor; unique tenant/operationId para comandos directos. Tipo forma parte del hash.                  |
| Corregir metadatos de lote                | LotRevision guarda operationId/hash/actor y unique del caso, además de versión del lote.                                              |

El namespace de clave es **tenant + familia de caso de uso + UUID**, documentado en contratos. No se comparte accidentalmente la tabla de recibos de Catalog. Un mismo documento no puede contabilizarse otra vez aunque el cliente genere una clave nueva: la unicidad del origen y su estado confirmado lo impiden.

Hash canónico incluye versión de contrato, operación, id/versión de borrador, digest del contenido revisado, condiciones, cantidades decimales normalizadas, identidades y versiones relevantes. Canonizar orden de claves/decimales y usar ids estables de línea. Reordenar visualmente líneas no debería cambiar la intención; cambiar una cantidad sí. El servidor calcula/verifica el digest, no confía en un hash suministrado como autorización.

Misma clave, actor e intención devuelve mismos ids y snapshots confirmados, sin otro movimiento ni evento. Otra carga/actor con esa clave da 409. El autor puede reintentar con una nueva sesión autenticada del mismo tenant; la sesión original queda como procedencia. Un administrador distinto consulta el resultado por documento, no se hace pasar por replay del autor.

La UI conserva clave y comando mientras el resultado es incierto. Tras timeout consulta el estado o reintenta exactamente igual; no genera otra UUID automáticamente. Si se modifica un borrador tras un fallo de validación conocido, nueva revisión y nueva clave. Una respuesta de replay muestra el hecho confirmado, **no el saldo actual como si fuera el original**; el saldo actual se consulta aparte. Los recibos confirmados no se borran por TTL.

Ejemplo de concurrencia futura: saldo utilizable 5, dos salidas de 4. Una confirma y deja 1; la otra, después del lock, rechaza. Dos recepciones válidas de +4 se serializan y ambas suman. Dos conteos INITIAL del mismo scope no pueden confirmarse, incluso con claves distintas.

## V. Auditoría y multi-tenancy

El ledger y los documentos físicos explican cantidades, causas y correcciones. `AuditEvent` explica la ejecución del caso de uso. El stock nunca se reconstruye de metadata de auditoría.

Eventos propuestos: INVENTORY_RECEIPT_CONFIRMED, INVENTORY_INITIAL_COUNT_CONFIRMED, INVENTORY_RECOUNT_CONFIRMED, INVENTORY_ADJUSTED, INVENTORY_RECLASSIFIED, INVENTORY_CORRECTED, INVENTORY_LOT_CORRECTED, INVENTORY_POLICY_CONFIGURED y recuperación/cancelación de toma ajena. Guardar recurso, contexto y resultado mediante AuditService con TransactionClient. Metadata inicial vacía o conteos/ids expresamente allowlisted; no scan bruto, DTO, lista de series ni texto completo del formulario.

Un conteo confirmado sin deltas sí genera su evento de ejecución y documento histórico. Consultar/escaneo sin cambio de negocio no requiere inventar movimientos o eventos de recepción. Fallo de auditoría revierte toda confirmación. No afirmar auditoría exitosa cuando falló DB; logs técnicos sanitizados cumplen otra función.

Organization viene exclusivamente de RequestActorContext. Inputs y queries rechazan organización/actor/rol/cantidades calculadas como autoridad. UUID de otro tenant responde 404 uniforme. Drafts, líneas, lotes, series, revisiones, scopes y saldos se filtran explícitamente por organización.

FK `(organizationId, productId)` → Product; ubicaciones y documentos con la misma defensa. Lote y serie agregan Product en claves de soporte cuando valida coherencia. Receipt → Supplier scoped; líneas → documento scoped; origen/corrección → registros del tenant. Actor usa pertenencia `(organizationId,membershipId,actorUserId)` y sesión `(sessionId,actorUserId)` como identificación existente. Un cambio posterior de organización activa en la sesión no cambia la procedencia histórica.

Conservar Restrict para relaciones históricas. No cascada destructiva desde Product, Supplier, Location o User. RLS sigue una decisión de plataforma pendiente, no se asume por agregar organizationId.

## W. Búsquedas, consultas y modelos de lectura

PostgreSQL y DTO explícitos; sin Elasticsearch, Redis ni infraestructura CQRS. Una consulta especializada no exige un servicio separado.

| Consulta                       | Fuente y resultado                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stock por Product              | Balances + política/scopes + fecha: registrado físico, cobertura, disponible, no disponible y unidad. Buscar con los criterios actuales de Catalog.          |
| Detalle de Product             | Posiciones agrupadas por lote/condición/ubicación, vencimiento, unidades y acceso paginado a series.                                                         |
| Stock por lote                 | Lot + balances positivos; Products explícitos para distinguir números iguales.                                                                               |
| Vencimientos                   | Lotes con fecha conocida y saldo físico >0; vencidos y horizonte consultado, condición como filtro independiente.                                            |
| Buscar lote                    | Número conservador, Product opcional, tenant obligatorio implícito; opción de ver historial con saldo cero y números corregidos.                             |
| Buscar serie                   | Número + Product/contexto; identidad, posición actual o «sin existencia», movimientos y correcciones.                                                        |
| Historia de Product/lote/serie | MovementLine + Movement + origen tipado; snapshots y enlaces de corrección; conteos sin diferencia y revisiones de metadatos visibles como hechos distintos. |
| Recepciones y conteos          | Documentos por fecha/actor/estado, resultados originales y vínculo al movimiento si existe.                                                                  |
| Inicialización                 | Scopes pendientes/en conteo/inicializados, no porcentajes ficticios sobre un catálogo que todavía puede estar incompleto.                                    |

Índices candidatos, siempre empezando por tenant y evaluados con consultas reales:

- Unique de scopes, posiciones, lotes numerados, series y confirmaciones.
- Balance por Product/Location; acceso por lotId y serialId; índices parciales para quantity > 0 si el plan lo justifica.
- Lot por Product/número y expirationDate/id; la búsqueda de vencimientos cruza solo posiciones con existencia.
- Movement por recordedAt/id; MovementLine por Product/movementId/id, lotId/movementId e identidad individual. Añadir recordedAt denormalizado a línea solo si una medición justifica ese contrato de consistencia.
- Receipt por proveedor/fecha/id; CountSession por estado/autor/fecha/id; scopes por estado inicial y toma activa.

Stock general puede conservar paginación acotada del catálogo. Historia usa cursor estable recordedAt/id y filtros de rango; detallar líneas por movimiento evita grupos cortados arbitrariamente. Totales y página se leen sobre una vista consistente. La versión operativa de scope ordena hechos concurrentes de ese Product/Location; el UUID no prueba orden de negocio.

Histórico «al momento de registro» suma ledger hasta su corte; `occurredAt` anterior no reordena silenciosamente decisiones tomadas. Consultas retrospectivas de disponibilidad necesitan fecha y revisiones de metadatos: no usar solamente el vencimiento actual para afirmar qué se sabía entonces. Ese reporte avanzado se difiere, conservando los hechos que lo harán posible.

Para búsqueda exacta de códigos/GTIN reutilizar normalización de Catalog. Números de lote/serie siguen sus propias reglas conservadoras. ILIKE de texto no implica que un B-tree acelere `%texto%`; trigram/full-text solo tras medir.

### FEFO y alertas futuras

FEFO puede ordenar posiciones elegibles por fecha de vencimiento ascendente, desempate estable por primer ingreso registrado y lote/id. Sin vencimiento confirmado va después de fechas conocidas; desconocido no es elegible. Excluir dañados/cuarentena, saldos cero y futuros reservados efectivos. La sugerencia nunca sustituye validación de disponibilidad al confirmar salida.

Datos para alertas de vencimiento ya existen: fecha, saldo, condición y cobertura. «Próximo a vencer» es un horizonte de consulta configurable, no un estado persistido del lote. No hay notificaciones V1.

`minStock` no pertenece a Product como propiedad universal. Cuando se requiera reposición, será una política de Inventory por Product y, si aplica, Location, expresada en unidad base y con semántica definida sobre available. Puede evolucionar desde ProductInventoryPolicy a una política por ubicación. No se agrega el campo ni se calcula una alerta sobre stock no inicializado en V1.

## X. UX propuesta

```text
Inicio
¿Qué querés hacer?
[Ingresar productos] [Consultar stock] [Inventario inicial]

Ingresar productos
Proveedor: __________             [Borrador guardado]
Escaneá producto
[ Esperando scanner ________________________ ]

Producto reconocido: Guantes ...
Cantidad en unidades: ___         [Calcular por cajas]
Lote: _______   Vencimiento: _______ / No aplica
Series: solo cuando corresponde
Condición: Utilizable             [Cambiar]
[Agregar]

Producto | Cantidad y unidad | Lote | Vencimiento | Condición
... líneas revisables antes de confirmar ...
[Seguir escaneando] [Revisar ingreso]
Revisión → [Confirmar ingreso]
```

La condición default es utilizable solo con datos compatibles. Desconocido/dañado/vencido tiene texto claro y cantidad no disponible; no depender únicamente de color. Una fecha omitida no selecciona «No aplica» silenciosamente.

Consulta: buscador por producto/código/GTIN/lote/serie. Lista con Product, disponible, unidad y aviso de conteo pendiente; detalle con físico, no disponible, lotes/vencimientos e historia. Reserved no ocupa espacio V1 porque siempre es cero. Mostrar «Sin conteo inicial» separado de «Contado: 0».

Inventario inicial explica «Contá todo este producto en el depósito, incluyendo dañado». Muestra quién está contando, scopes incluidos, guardado y revisión de diferencias. Agrupar por categoría ayuda a organizar el trabajo; no sugiere que contar solo la parte visible certifica el Product entero.

Controles de 44–48 px, etiquetas visibles, foco marcado, teclado y feedback aria-live; conservar los patrones del frontend existente. Texto grande y acciones principales cortas para usuarios de 22–70 años. Evitar tablas densas, campos técnicos, estados con siglas o exponer MovementLine/operationId/locks al usuario.

Mensajes concretos: «Este producto lo está contando Ana», «La serie ya está en el depósito», «El lote tiene otra fecha registrada», «No sabemos si se confirmó; comprobá el resultado o reintentá». Un error no vacía el borrador. Al cambiar tenant se desmonta la UI y se vuelven a cargar solo borradores autorizados de esa organización.

El sonido de un lector confirma que leyó un código, no que se guardó stock. La pantalla debe distinguir reconocimiento, línea agregada y recepción confirmada. No hay captura global de teclas, cámara ni modo offline transaccional en V1.

## Y. Cambios de schema que la implementación requerirá

**Inventario conceptual de cambios futuros; no se crean en esta entrega.**

1. Incorporar las catorce entidades de D, con relaciones y uniques tenant-scoped. Policy y StockScope pueden no existir hasta habilitar/usar el Product; su ausencia nunca significa conteo inicial cero.
2. Incorporar tipos cerrados pequeños de condición, estado de documentos, tipo/motivo de movimiento, modalidad de conteo y estado de vencimiento. No agregar enums regulatorias o valores de Remito sin implementación.
3. Usar decimales exactos en cantidades/factores y fecha calendario en expiración; timestamps de operación en UTC. Propuesta de zona de negocio como configuración de Inventory por organización, inicialmente un campo validado IANA, sin crear un motor de calendarios.
4. Receipt/CountSession con versión y resultado durable de confirmación; líneas de captura con identificadores estables. Series declaradas en la captura pueden almacenarse en una colección JSON **acotada y tipada**, solo como propuesta/snapshot; las identidades confirmadas y ledger son relacionales. Si el volumen exige consultas sobre captura individual, normalizar esa colección; no convertir el ledger a JSON.
5. CountScope guarda cobertura, revisión esperada y confirmada. StockScope referencia su primera certificación de conteo y toma activa. Esas relaciones validan Product/Location/tenant; un scope de otro artículo no puede inicializarlo.
6. Movement con enlaces exclusivos Receipt/CountSession y corrección; Line con origen de línea tipado. Unique de un movimiento por documento confirmado cuando haya diferencias. Conteo de cero conserva confirmación aunque no exista Movement.
7. Movement/Line conservan snapshots acotados, revisión, actor/contexto y unidad histórica. ReceiptLine y CountLine confirmadas se congelan. LotRevision preserva correcciones de metadatos.
8. Balance tiene unique con semántica explícita para nulls, cantidades no negativas e índice único de serie positiva. Los requisitos de conservación/coherencia entre filas necesitan validación transaccional y, donde corresponda, triggers/constraints diferidos.
9. Un mecanismo DB de cierre de contabilización debe impedir editar/borrar un ledger cerrado o agregarle líneas posteriormente, sin impedir insertar encabezado y líneas en una misma transacción. No se publica un estado DRAFT de Movement al usuario ni se incluyen encabezados incompletos en consultas.
10. No agregar Product.stock, Product.available, Product.lot ni SupplierCatalogItem.quantity. Product.unitOfMeasure sigue siendo la base; se agregan relaciones inversas que Prisma requiera, sin otra fuente de cantidad.
11. Cambios futuros de casos de uso Catalog: congelar unidad con historia, condicionar archivado de Product a ausencia de stock/tomas y validar política en operaciones de Inventory. No modificar el comportamiento de importar o identificar para generar existencia.

Antes de generar una migración se revisarán la capacidad concreta de Prisma para representar índices/constraints y el SQL resultante. Esa revisión pertenece a implementación; este documento no incluye DDL ejecutable.

## Z. Endpoints que la implementación requerirá

Rutas propuestas bajo `/api/v1/inventory`; proxy web explícito `/api/inventory`, con los mismos controles de identidad, CSRF, no-store, contratos y whitelist. Los nombres pueden ajustarse a las convenciones finales sin cambiar casos de uso. **No existen todavía.**

| Método y ruta relativa                                 | Caso de uso                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| GET `/stock`                                           | Buscar stock/cobertura por Product con filtros acotados.                             |
| GET `/stock/products/:productId`                       | Resumen y posiciones paginadas de un Product.                                        |
| GET `/lots`, `/lots/:id`                               | Buscar lote/grupo y consultar existencia/datos actuales.                             |
| GET `/serials`, `/serials/:id`                         | Buscar identidad individual y posición/historia.                                     |
| GET `/movements`, `/movements/:id`                     | Historia filtrada por Product/lote/serie y detalle con origen/correcciones.          |
| GET/POST `/receipts`                                   | Listar ingresos/borradores autorizados; abrir borrador con id estable.               |
| GET/PATCH `/receipts/:id`                              | Recuperar/editar encabezado DRAFT con expectedVersion.                               |
| PUT `/receipts/:id/lines/:lineId`                      | Agregar/editar propuesta por id estable y expectedVersion; retry sin fila duplicada. |
| DELETE `/receipts/:id/lines/:lineId`                   | Quitar únicamente una línea DRAFT; jamás una línea del ledger.                       |
| POST `/receipts/:id/confirm`                           | operationId + expectedVersion + digest de revisión; confirmación atómica.            |
| POST `/receipts/:id/cancel`                            | Cancelar borrador, sin afectar stock.                                                |
| GET/POST `/counts` y GET `/counts/:id`                 | Crear/retomar/listar sesiones INITIAL o RECOUNT autorizadas.                         |
| POST `/counts/:id/scopes`                              | Agregar Product/Location y tomarlo para conteo, con identidad estable de scope.      |
| PUT/DELETE `/counts/:id/scopes/:scopeId/lines/:lineId` | Capturar/corregir observaciones solo de borrador, con versión.                       |
| POST `/counts/:id/scopes/:scopeId/complete`            | Declarar cobertura completa, incluidos ceros; aún no modifica stock.                 |
| POST `/counts/:id/confirm`                             | Confirmar sesión pequeña; calcula delta y certifica inventario.                      |
| POST `/counts/:id/cancel`                              | Cancelar captura y liberar tomas propias; recuperación ajena solo ADMIN con motivo.  |
| POST `/adjustments`                                    | ADMIN, delta explícito y motivo; observed-count usa el workflow RECOUNT.             |
| POST `/reclassifications`                              | Apartar cantidad; liberación/identidad corregida solo ADMIN.                         |
| POST `/movements/:id/corrections`                      | ADMIN, revisión del efecto vigente + motivo + operationId.                           |
| POST `/lots/:id/corrections`                           | ADMIN, corrección de metadatos con versión y motivo.                                 |
| GET/PUT `/products/:productId/policy`                  | Consultar/configurar política revisada; escritura ADMIN con versión.                 |

Reutilizar `POST /api/v1/catalog-scans/resolve` y workflow de identificación existentes; no agregar `/inventory/parse-barcode`. Si es útil consultar confirmación por operationId tras desconexión, exponer lookup restringido por familia de caso y actor, no un explorador genérico de claves de otros usuarios. Receipt/Count se recuperan también por su id estable.

Los comandos calculan sign/delta/disponibilidad en servidor. Los DTO de ajuste permiten delta porque es su intención explícita, pero revalidan saldo y permisos. Ningún endpoint acepta physical/available como valor final a guardar. Respuestas de cantidad son strings exactas; incluyen unidad, cobertura, asOf y versiones pertinentes.

No agregar rutas de Remito, reserva, FEFO automático o devoluciones V1. Conflictos 409 tienen razón tipada y mensaje humano; autorización 401/403, recursos ajenos 404, entrada inválida 400 y errores técnicos sanitizados 500/503 siguen el patrón actual. Límites de cuerpos, series y documentos se validan en Next y Nest antes de abrir transacciones.

## AA. Pruebas que la implementación debe incluir

### Reglas puras y contratos

- Exactitud decimal, integridad UNIT/PAIR, límites y overflow; 1 caja ×100 = 100, rollo 3 -0,5 = 2,5; factores cero/negativos y payload discordante rechazados.
- No inferir empaque de presentation, reportedGtin o código; series coinciden con cantidad convertida.
- Normalización conservadora de lotes/series; mismo lote en Products distintos; mismo lote con dos proveedores; fecha contradictoria exige revisión.
- Fecha exacta, NONE/UNKNOWN, expirado/próximo; frontera de medianoche de negocio y diferencias con UTC/navegador.
- Unavailable como unión: dañado y vencido se descuenta una sola vez. Vencer conserva physical y no crea movimiento.
- Tipos y motivos coherentes con signos; conservación de reclasificación; no aceptar unidad/política incompatible.
- Inputs estrictos sin organizationId/actor/rol arbitrarios, proxy por ruta/método, límites de líneas/series y decimales como strings.

### Integración PostgreSQL y seguridad

- Confirmar recepción multilínea crea documento/ledger/balance/auditoría; escanear/agregar/cancelar no crea stock. Fallo en la última línea o AuditEvent revierte todo.
- Same operationId simultáneo/retry tras respuesta perdida: resultado único. Misma clave con distinta carga/actor: conflicto. Documento ya confirmado con nueva clave: cero efectos nuevos.
- Dos ingresos sobre posición ausente: una posición con suma correcta. Dos salidas futuras concurrentes: una rechaza si el disponible no alcanza; incluir desde V1 el test del primitivo interno de reducción con ajuste/reclasificación.
- Serie duplicada en mismo ingreso, dos ingresos, dos condiciones y futuras ubicaciones; retorno a saldo cero reutiliza Serial; nunca fracciones, dos posiciones positivas ni lote incompatible.
- Reclasificar una serie al lote correcto conserva su identidad, su historial anterior y una sola posición positiva; la operación normal no puede hacer esa reasignación. El último lote conocido sigue consultable después de la salida.
- Quarantine anónima por identidad incompleta y regularización conservan physical; OPERATOR no puede liberar ni crear series ficticias.
- Constraints reales de scope, nulls en balances, FK cross-tenant/Product, saldo no negativo y confirmación única. No limitarse a mocks de Prisma.
- Cada rol por caso de uso; membership/sesión revocada entre revisión y confirmación; replay con acceso perdido no expone datos.
- Ledger cerrado rechaza UPDATE/DELETE y append tardío; documento confirmado también. Correcciones conservan original, detectan revisión obsoleta y rechazan negativo.
- Cambiar unidad/archivar Product con stock y cambiar política con datos incompatibles se rechaza; renombrarlo no cambia snapshots.

### Conteo inicial y proyección

- Ingresos previos 5, observado total 17 → +12; observado 3 → -2; observado cero queda inicializado y no inventa línea delta cero.
- Mismo total con otro lote/serie produce diferencias por identidad. Posiciones omitidas no se interpretan como cero sin revisión.
- Dos sesiones iniciales para un scope, incluso distintas claves: una sola toma/certificación. Una categoría superpuesta no elude esa regla.
- Ingreso/reclasificación/corrección durante conteo bloqueados; recuperación administrativa invalida captura vieja. Un cambio fuera del protocolo detectado por versión obliga a recuento.
- Sesiones en Products distintos siguen operando; un fallo atómico de sesión multilínea no inicializa parcialmente scopes.
- Conteo posterior exige ADMIN; referencia al primer conteo permanece. Stock pendiente se muestra incompleto, no cero confiable.
- Ledger agregado = Balance después de ingresos, ajustes, daños y correcciones; reconstrucción por scope bajo concurrencia conserva los hechos. Inyectar una diferencia de proyección en fixture y comprobar detección.

### Recorrido de usuario y capacidad

Navegador → proxy → API → DB: HID simulado, desconocido → identificación → regreso al borrador, captura múltiple, revisión, confirmación, consulta e historia. Doble Enter/click, reconexión tras timeout, relogin, cambio de tenant y dos pestañas. Probar lectores físicos reales por separado: las pruebas existentes solo simulan teclado.

Verificar móvil/tablet/escritorio, foco, teclado, etiquetas y mensajes, especialmente «conteo pendiente» y «no disponible». Probar documentos cercanos al límite propuesto y contención con el pool/timeouts existentes. Una prueba de importación de 10.000 referencias no demuestra capacidad de recibir 10.000 series. Las mediciones deben fijar los límites definitivos antes del despliegue.

## AB. Funciones explícitamente diferidas

Reservas, salidas comerciales y Remitos completos, devoluciones comerciales, FEFO de picking, mínimos/notificaciones, compras/costos/valuación, multiubicación operativa y traslados, jerarquías de depósito, kits/ensambles, serialización universal, packaging persistido y conversiones entre Products/unidades, conteo sin pausa física, parser GS1 completo, cámara, offline transaccional, impresión de etiquetas, integración ANMAT/SNT y reportes regulatorios, reportes bitemporales, capas de recepción para fungibles, RBAC configurable, aprobaciones multinivel y event sourcing del sistema.

No se agregan microservicios, Kafka, RabbitMQ, Redis o jobs de vencimiento. Una reversión total asistida puede venir después de la corrección vinculada V1, porque la corrección ya cubre el error +10 versus +8.

## AC. Riesgos, decisiones abiertas y self-review

### Datos reales pendientes y recomendación por defecto

| Dato pendiente                                           | Default propuesto                                                                           | Cómo cambiar después                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Qué Products representan caja frente a pieza             | Revisar unidad/presentación antes del primer stock; una base explícita por Product.         | Packaging versionado o Product distinto; nunca reinterpretar ledger viejo.          |
| GTIN de caja y unidad del mismo artículo                 | No autoconvertir; captura explícita y revisión de identidad.                                | Vincular identificador al packaging comprobado.                                     |
| Requisitos reales de lote/serie/vencimiento              | Policy revisada por ADMIN, sin inferencia regulatoria; faltantes obligatorios a cuarentena. | Cambios versionados con regularización de existencias y borradores.                 |
| Reutilización real de número de lote dentro de Product   | Clave Product/número; conflicto visible.                                                    | Emisor/discriminador comprobado manteniendo UUID.                                   |
| Fechas solo mes/año                                      | No inventar día; cuarentena hasta resolver.                                                 | Precisión explícita antes de operar esos artículos habitualmente.                   |
| Necesidad de distinguir rollos/retazos                   | Saldo en metros, sin prometer continuidad de pieza.                                         | Identidad de pieza/contenedor y asignaciones específicas.                           |
| Procedencia exacta por recepción de cada unidad fungible | Historia por lote y entradas conocidas; sin atribución individual.                          | Capas de recepción/asignaciones si un requisito real lo exige.                      |
| Volumen de series/líneas y duración de conteo            | Sesiones pequeñas, límites de N; pausa por Product.                                         | Medir y ampliar captura sin perder cierre completo por scope.                       |
| Capacidad de pausar un Product durante conteo            | Toma visible y pausa breve; resto del depósito activo.                                      | Protocolo de corte físico más avanzado si se demuestra necesario.                   |
| Registro de las entregas diarias durante adopción        | Piloto hasta tener salida básica; no afirmar stock continuamente confiable.                 | Adelantar salida simple al alcance V1 si el despliegue debe ser operativo integral. |
| Segunda ubicación y reposición                           | Una ubicación plana; sin mínimos.                                                           | Habilitar traslados/política por ubicación en incremento separado.                  |
| Política de retención y requisitos regulatorios          | Preservar historia confirmada; no alegar cumplimiento.                                      | Validar alcance real y diseñar adaptador/retención antes de integración.            |

La captura manual de factor de empaque puede equivocarse aunque la aritmética sea correcta. Mostrar unidad/resultados y exigir confirmación reduce el riesgo; packaging fijo será prioritario si se repite. La necesidad de revisión ADMIN inicial no debe convertirse en un cuello de botella: preparar políticas de los Products del piloto antes de los conteos, sin inferirlas desde nombres.

### Self-review del diseño

| Riesgo buscado                                             | Resultado de revisión / control propuesto                                                                                                                               |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stock mutable incorrecto                                   | Ningún campo Product.stock ni endpoint set stock. Todo cambio físico deriva de MovementLine.                                                                            |
| Duplicación ledger/balance                                 | Balance es proyección transaccional reconstruible; sin edición independiente; prueba de igualdad y mantenimiento controlado. Receipt/Count no participan en sumas.      |
| Lote mal identificado                                      | UUID estable + clave tenant/Product/número conocido; fecha/proveedor fuera de identidad. Colisión real es conflicto, no fusión automática.                              |
| Seriales imposibles                                        | ±1, saldo 0/1, una posición positiva, pertenencia a Product/lote, identidad histórica reutilizable en retorno. Anónimos incompletos solo cuarentena.                    |
| Conversión sobrecomplicada                                 | Una unidad base y multiplicación explícita con snapshot; ningún grafo de conversiones.                                                                                  |
| Stock negativo                                             | Prohibido incluso ADMIN, por posición. Corrección que excede saldo requiere investigación.                                                                              |
| Historia editable                                          | Documentos y ledger cerrados; deltas vinculados y revisiones de metadatos. Falta implementar protección DB y probarla, no se presume existente.                         |
| Vencimiento confundido con baja                            | Cambio de elegibilidad temporal; physical constante, sin movimiento automático.                                                                                         |
| Doble descuento de unavailable/reserved                    | Unión de exclusiones; reserved cero V1. Futuro reservado efectivo separado de asignación bloqueada.                                                                     |
| Conteos duplicados con ingresos previos                    | Reconciliación observado - registrado por posición, cobertura única, toma y versiones. No sumar observado como otra recepción.                                          |
| Conteo concurrente con movimiento físico                   | Pausa por artículo explícita; DB solo protege operaciones digitales. Incumplimiento invalida/repite conteo.                                                             |
| Doble confirmación/red interrumpida                        | Clave durable + hash/actor + unique del documento; replay del resultado confirmado.                                                                                     |
| Remitos difíciles de integrar                              | Un solo caso de contabilización transaccional y futura FK tipada; no enlaces libres sin integridad.                                                                     |
| Trazabilidad insuficiente presentada como ANMAT            | Se preservan hechos, se explicitan límites de fungibles y se difiere cualquier afirmación/regla regulatoria.                                                            |
| Complejidad prematura                                      | Un módulo, una DB y ubicación plana. Entidades de documentos responden a captura recuperable e inicialización; sin órdenes, picking, reservas o integración adelantada. |
| Disponible que se vuelve obsoleto por no registrar egresos | Riesgo explícito de despliegue. Exigir salida básica antes de usar el sistema para comprometer stock.                                                                   |

## AD. Secuencia recomendada de implementación

1. **Validar muestras reales y alcance operativo:** caja/unidad/par/rollo, rótulos con lote/serie/fecha, Products del piloto, posibilidad de pausa por artículo y cómo se registrarán egresos durante adopción. No se necesita resolver todos los futuros distribuidores.
2. **Fundación de Inventory:** ubicación única, configuración de zona/política, reglas de unidad, cantidades exactas, Lot/Serial y restricciones de Catalog necesarias. Sin cargar stock por seed de catálogo.
3. **Contabilización central:** Movement/Line, Balance y StockScope, locks, inmutabilidad, idempotencia, auditoría y verificación/reconstrucción. Probar atomicidad/negativos/aislamiento antes de exponer captura al usuario.
4. **Consultas mínimas:** stock con cobertura, detalle por lote/serie e historia. No esperar a un dashboard para poder verificar cada operación.
5. **Ingreso recuperable:** Receipt, líneas, reutilización de scanner, datos físicos, revisión/confirmación y retorno desde identificación. Pruebas de punta a punta y reconexión.
6. **Inicialización gradual:** sesiones y scopes, tomas operativas, diferencias por posición, certificación de cero, recuperación y prevención de duplicados. Piloto con pocos Products reales.
7. **Ajustes y condición:** recuento ADMIN, cuarentena/daño, regularización, correcciones vinculadas y corrección de metadatos con historia. No desplegar captura sin un camino seguro para corregir errores.
8. **Cierre de Inventory V1:** regresión completa, pruebas físicas con scanner y usuarios, concurrencia real y límites medidos. Revisar cobertura del depósito y registrar pendientes; no declarar inicializada toda la empresa porque se confirmó la primera sesión.
9. **Siguiente incremento prioritario:** salida básica y posteriormente relación con Remitos. Habilitar promesas de disponibilidad continua solo cuando todas las variaciones físicas se registren. Incorporar devoluciones y luego FEFO/reservas según necesidad comprobada.

### Qué implementaría en Inventory V1

- Un módulo Inventory dentro del monolito, tenant-scoped; ubicación única «Depósito principal».
- Unidad base revisada y estable, decimales exactos y calculadora explícita de empaque con snapshot.
- Política mínima por Product; lotes/grupos físicos, vencimiento conocido/no aplicable/desconocido y series opcionales u obligatorias.
- Ledger inmutable con encabezado/líneas; saldos transaccionales reconstruibles y sin negativos.
- Recepciones multilínea con borrador recuperable, scanner existente, revisión y confirmación idempotente.
- Inventario inicial por sesiones pequeñas/scopes completos, conteo de cero, tomas y reconciliación de ingresos ya registrados.
- Físico/disponible, cuarentena/dañado, vencimiento calculado, ajustes ADMIN, correcciones vinculadas y revisiones de lote.
- Consultas/historia, permisos explícitos, auditoría, aislamiento, pruebas de concurrencia e integridad y herramientas técnicas de comprobación del saldo.

### Qué dejaría para V2

- **Primero:** salida operativa básica y Remitos con enlace tipado, después devoluciones. La salida básica debe adelantarse si V1 se despliega como stock operativo integral en un depósito que sigue entregando.
- Reservas cuando haya compromiso de entrega antes de la salida; FEFO sugerido y selección de lotes.
- Packaging persistido, GTIN por presentación y conversiones justificadas; piezas/rollos individuales si se necesitan.
- Multiubicación operativa/traslados, mínimo por ubicación y alertas/notificaciones.
- Parser GS1 ampliado y trazabilidad/integración ANMAT/SNT solo después de relevar alcance real y requisitos aplicables.

V2 expresa evolución posible, no obligación de implementar todo junto. El modelo V1 conserva las relaciones y hechos necesarios sin construir hoy esos workflows.

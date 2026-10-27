# Trazabilidad

Fecha: 26 de octubre de 2026. Base: HEAD `78762bd39771ea10263170d61d5c4d260eb15dc7` (`stage5`, `main`), árbol limpio. Sin migración, sin cambios de schema, sin dependencias nuevas. Sin commit ni push.

## Qué es

**Operaciones → Trazabilidad** (`/trazabilidad`) es una consulta de solo lectura sobre los datos físicos que MaxBio ya guarda en los Remitos confirmados. Responde a quién se entregó una serie, en qué Remitos salió un lote, qué clientes recibieron unidades, cuándo, si la salida estuvo vinculada a Stock y si el Remito tenía paciente/afiliado.

No es un nuevo sistema de trazabilidad: no agrega tablas, no duplica datos y no cambia `DeliveryNoteLineTrace`. **No es trazabilidad ANMAT**: no consulta servicios externos, no informa estados regulatorios y no certifica autenticidad.

## Fuente de datos

Un resultado existe porque existe una `DeliveryNoteLineTrace` de un Remito `CONFIRMED`. Una `DeliveryNoteLine` sin datos físicos no aparece: la pantalla no es un listado de ventas ni de Remitos.

| Dato                               | Origen                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Lote, vencimiento, serie, cantidad | `DeliveryNoteLineTrace` (snapshot documental congelado al confirmar)                   |
| Producto, presentación, unidad     | `DeliveryNoteLine.*Snapshot` del Remito confirmado                                     |
| Cliente                            | `DeliveryNote.customerSnapshot` (id + nombre documentados)                             |
| Número y fecha                     | `documentPrefix-documentNumber`, `documentDate`                                        |
| Paciente/afiliado                  | `DeliveryNote.patientName` / `affiliateNumber`, solo en el detalle                     |
| Ubicación y movimiento (Stock)     | `InventoryMovementLine` de la allocation (`deliveryAllocationId`), solo para INVENTORY |

Los cambios posteriores de Product, Customer o Inventory no reescriben lo mostrado: un Producto o Cliente renombrado sigue apareciendo con el nombre documentado (verificado en tests). InventoryMovement no es fuente documental; solo complementa una trace INVENTORY con su movimiento OUTBOUND y la ubicación de salida. La ubicación se identifica por el ID histórico del ledger; su nombre visible es el actual de esa ubicación (no existe snapshot de nombre de ubicación, igual que en el Remito).

## Documental vs. Stock

| `origin` en DB | `source` en API | UI                                                                                                                                                                    |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVENTORY`    | `STOCK`         | **Vinculado a Stock**: corresponde a una allocation real                                                                                                              |
| `DECLARED`     | `DOCUMENTARY`   | **Solo documental**; en el detalle, **Registrado solo en el Remito**: “Estos datos fueron documentados en el Remito y no representan una salida registrada en Stock.” |

`captureMethod` (GS1/MANUAL/LEGACY) no es el origen: solo se muestra en el detalle a ADMIN como “Origen de captura: Escaneado / Manual / Histórico”. Para OPERATOR la API devuelve `null`.

## API

Módulo de lectura `apps/api/src/modules/traceability` (controller → `TraceabilityService` → dominio puro `traceability-search.ts`). Es un read model propio porque cruza Remitos, Catálogo, Clientes e Inventory; no escribe nada y no depende de los servicios de escritura.

| Método / ruta                  | Función                        | Permiso          |
| ------------------------------ | ------------------------------ | ---------------- |
| `GET /api/v1/traceability`     | Búsqueda paginada              | ADMIN y OPERATOR |
| `GET /api/v1/traceability/:id` | Detalle de una trace (UUID v4) | ADMIN y OPERATOR |

Mismo acceso que la lectura de Remitos (sin permiso nuevo). Organización siempre desde `RequestActorContext`; nunca por query ni body. Query estricta (`traceabilityQuerySchema`): `search` (≤128, sin controles), `productId`, `customerId`, `source` (`STOCK`/`DOCUMENTARY`), `dateFrom`, `dateTo` (`YYYY-MM-DD`, inclusivas, desde ≤ hasta), `page` (1), `limit` (25, máximo 100). Cualquier otro parámetro (organizationId, raw, etc.) → 400.

Respuesta (`traceabilityListSchema`, strict): `items[]` con traceId, deliveryNote {id, number, documentDate}, product {id, name, presentation, unitOfMeasure}, customer {id, name}, quantity, lotNumber, expirationDate, serialNumber, source, `patientLinked` (booleano, sin valores); `total`, `page`, `limit`, `match` (`EXACT`/`TEXT`/null) y `filters` {product, customer} con los nombres para mostrar filtros abiertos desde URL. El detalle (`traceabilityDetailSchema`) agrega confirmedAt, cantidad documental de la línea, paciente/afiliado, `stock` {movementId, location} o null, `scannedGtin` y `captureMethod` (solo ADMIN). No se exponen organizationId, lineId/allocationId, reviewedPriorTraceIds, preserveOnUnlink, raw GS1 ni detalles de DB.

BFF `/api/traceability` y `/api/traceability/:id` (`traceability-proxy.ts`): rutas explícitas por `traceabilityRouteContract`, solo GET (otro método → 404/405), query validada antes de reenviar, claves duplicadas rechazadas, solo la cookie de sesión, `no-store` y respuesta validada (un campo extra → 503).

## Búsqueda

Pragmática y en dos pasos, siempre dentro del tenant, de Remitos confirmados y de los filtros:

1. **Exacta** (prioridad): `serialNumber = término` (exacta, sensible a mayúsculas, igual que la revisión de antecedentes de Stage 5; nunca contains), `lotNumber = término`, número de Remito y GTIN. Si hay al menos una coincidencia exacta se devuelven solo esas (`match: EXACT`).
2. **Texto controlado** (solo si no hubo exacta, `match: TEXT`): por cada palabra (máximo 8), lote contiene; nombre de producto del snapshot o `Product.searchText` (búsqueda actual del Catálogo); nombre del cliente del snapshot o `Customer.searchText` (búsqueda actual de Clientes). Escape de comodines LIKE, sin fuzzy. Nunca busca paciente/afiliado ni serie por contains.

Número de Remito: `00001-00004122`, `1-4122` y `4122` encuentran `00001-00004122`; se generan como máximo 12 variantes de ceros por parte, comparadas por igualdad. GTIN: solo 8/12/13/14 dígitos con dígito verificador válido, canónico a 14; coincide con `scannedGtinSnapshot`, el GTIN snapshot de la línea o un identificador GTIN del Product del tenant.

Filtros por Producto y Cliente: la UI los elige con la búsqueda existente del Catálogo (`products?q=`) y de Clientes (`customers?q=`), incluidos archivados; la consulta de trazabilidad recibe solo el ID. Un ID de otra organización responde 404 sin revelar nada. Fecha: `documentDate` del Remito (no createdAt). Origen: Todos / Vinculado a Stock / Solo documental.

Orden estable: fecha del Remito desc → confirmedAt desc → Remito → ordinal de línea → ordinal de trace → id. Paginación con `count` real sobre el mismo filtro.

## Estados

- **DRAFT**: excluido. Un borrador no es una entrega.
- **CANCELLED**: excluido. En MaxBio solo se cancela un borrador; un confirmado no se cancela, reabre ni modifica, así que un cancelado nunca representó una salida.
- Una serie puede figurar en más de un Remito confirmado (Stage 5 lo permite con revisión expresa): se muestran todos los antecedentes, sin elegir uno “correcto”.

## Pantalla

Título, subtexto, un campo grande con botón **Buscar** (búsqueda por submit, sin request por tecla), **Más filtros** plegable (Producto, Cliente, fechas, Origen) y **Limpiar filtros**. Sin criterios muestra “Registros más recientes”. Resumen “N registros encontrados” y si la coincidencia fue exacta o por texto. Tabla en el contenedor desplazable existente: Fecha, Producto, Lote y vencimiento (`DD/MM/YYYY`), Serie, Cantidad (cadena exacta + unidad), Cliente (con “Paciente/Afiliado asociado” si corresponde), Remito (link por número, nunca UUID), Origen, **Ver detalle**. Vacío: “No encontramos trazabilidad con estos filtros.” con sugerencias. Carga y error con `Feedback`/`Pagination` existentes; sin estilos globales nuevos.

El detalle muestra producto, cantidad trazada y documental, lote, vencimiento, serie, Remito, fecha, confirmación, cliente, paciente/afiliado si existen, GTIN escaneado si existe, el bloque de origen (Stock: ubicación de salida y **Ver movimiento de stock**; documental: aviso explícito) y **Ver Remito** / **Ver producto**. No duplica el Remito.

URL: `search`, `productId`, `customerId`, `source`, `dateFrom`, `dateTo`, `page` se reflejan con `history.replaceState` para volver atrás y para abrir desde otras pantallas; valores inválidos se descartan. Nunca raw GS1, paciente ni el detalle seleccionado.

Accesos: barra lateral (después de Stock), **Ver trazabilidad** en la ficha de Producto (`/trazabilidad?productId=…`) y **Ver en Trazabilidad** en un Remito confirmado con datos físicos (`?search=número`). El Remito confirmado ya distinguía “Vinculado a Stock” / “Registrado solo en el Remito”; solo se cambió su vencimiento a `DD/MM/YYYY`.

## Privacidad y observabilidad

El listado no incluye paciente ni afiliado, solo `patientLinked`. El detalle los muestra a los mismos roles que ya los ven en el Remito. La búsqueda no consulta esos campos y los términos de búsqueda viajan en la query del GET (serie/lote/número/cliente/producto, igual que el patrón de URL pedido); paciente/afiliado nunca van en URL. No se agregó logging: la API no registra términos, series, lotes ni pacientes (el filtro de errores existente solo registra requestId y status). No hay audit por búsqueda.

## Rendimiento e índices

Una consulta de página con `select` anidado (trace → línea → Remito) más un `count`, y una búsqueda exacta previa con `findFirst`: la cantidad de operaciones es constante con el tamaño de página (test con contador de operaciones Prisma: 1 y 25 resultados ejecutan lo mismo). Transacción `RepeatableRead` + `SET TRANSACTION READ ONLY`.

Índices existentes usados: trace `(org, product, lot)`, `(org, product, serial)`, `(org, lineId, ordinal)`; Remito `(org, documentDate, id)`, `(org, customerId)` y unique `(org, prefix, number)`; trigram GIN de `Product.searchText` y `Customer.searchText`. Limitación conocida: la serie o el lote sin filtro de Producto usan el índice compuesto solo por el prefijo de organización (PostgreSQL 17 no tiene skip scan), y el texto de lote/snapshot por contains recorre las traces del tenant. Es razonable para el volumen inicial de una organización; si el volumen crece, la mejora natural sería un índice `(organizationId, serialNumber)` / `(organizationId, lotNumber)` en `DeliveryNoteLineTrace`, que **no se creó** porque no hay un problema demostrado.

## Pruebas

- `apps/api/test/traceability.integration.ts` (base desechable, flujos reales de Remito/Inventory): serie exacta con dos antecedentes (Stock y documental), case-sensitive y sin contains; lote en tres Remitos/clientes/orígenes y fallback de texto; DRAFT/CANCELLED/línea sin trace excluidos; filtros Producto, Cliente, fechas inclusivas, origen y combinados; número de Remito con y sin ceros; GTIN observado y del Producto (13/14 dígitos); texto por producto/cliente con snapshots tras renombrar y nuevo ingreso de stock; detalle documental/Stock con movimiento y ubicación, paciente solo en detalle; paginación y orden estable; aislamiento tenant (resultados, Product, Customer, detalle); contrato estricto, cero efectos laterales y ADMIN/OPERATOR; operaciones constantes (sin N+1).
- `apps/api/test/traceability.test.ts`: candidatos de número, GTIN exacto, contrato y rutas.
- `apps/web/test/traceability.test.tsx` (React + JSDOM): pantalla inicial, búsqueda por submit, URL, etiquetas Vinculado a Stock / Solo documental, serie, lote, vencimiento, cliente, link al Remito, filtros, cliente por búsqueda existente, vacío, limpiar, paginación, error, detalle documental/Stock, captureMethod solo ADMIN, query params y BFF.

Para montar la pantalla en el harness NodeNext, los imports compartidos (`catalog/common`, `workspace`, `navigation`, `identity-screen`, `connection-status`) usan rutas relativas con extensión, como el editor de trazas de Stage 5; el test resuelve `next/link`/`next/navigation` con un hook y los simula. `quantityLabels` se movió a `@maxbio/contracts` (Inventory lo reexporta).

## Limitaciones

- Solo Remitos: devoluciones, facturación y otros eventos no existen todavía; el read model puede sumarlos después como nuevas fuentes.
- Sin exportación Excel/PDF/CSV.
- Serie exacta y sensible a mayúsculas: una serie mal tipeada no se encuentra (no hay búsqueda aproximada de series).
- La coincidencia exacta tiene prioridad: si un término coincide exactamente con un lote, no se agregan lotes que solo lo contienen.
- El nombre de la ubicación de salida es el actual de esa ubicación histórica.
- Sin vistas móviles específicas: la tabla usa el contenedor desplazable existente.
- Sin hardware ni datos reales verificados.

# GS1 V1: implementación y verificación (Stages 1–5)

Fecha: 26 de octubre de 2026. Base: HEAD `c34f8ff8ff2c3f8215348507c850b02b24bcd9a8` (`main`), árbol limpio salvo el diseño sin versionar. Diseño fuente: [gs1-design.md](gs1-design.md). Sin commit ni push.

Implementado: **Stage 1** (parser puro + tests), **Stage 2** (Catalog / Product Identification) y **Stage 3** (Ingresar productos e Inventario inicial). **Stage 4** (Remitos + matching físico exacto) se agregó después; ver §9. **Stage 5** agrega trazabilidad documental independiente de Inventory y Printing con snapshots; ver §10. Los Stages 1–4 no requirieron migración; Stage 5 agrega una, sin dependencias nuevas.

## 1. Arquitectura

| Archivo                                                              | Responsabilidad                                                                                                                                                       |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/common/domain/scanning/gtin.ts`                        | Check digit mod-10 y canonical14 compartidos. `normalizeIdentifier` (Catalog) y AI 01 usan la misma función; mensajes de Catalog sin cambios.                         |
| `apps/api/src/common/domain/scanning/gs1-types.ts`                   | Reason codes estables, límites (`MAX_SCAN_LENGTH = 512`, 32 elementos, 16 issues) y tipos `Gs1ParseResult`.                                                           |
| `apps/api/src/common/domain/scanning/gs1.ts`                         | `parseGs1(raw, { referenceYear })`: clasificación, encuadre, tokenización por cursor y validación de 01/10/17/21. Sin Nest, Prisma, Zod, reloj, red ni efectos.       |
| `apps/api/src/modules/catalog/domain/catalog-scan.ts`                | `classifyScan`: decide GS1 antes de los namespaces legacy y arma la vista de transporte (sin raw, offsets, elements ni valores de AIs desconocidos).                  |
| `apps/api/src/modules/catalog/application/identification.service.ts` | Resolve compone interpretación + resolución comercial existente; `referenceYear` = año de `businessDate()` (Buenos Aires). Confirm reinterpreta y persiste solo GTIN. |
| `packages/contracts/src/identification.ts`                           | `scanInterpretationSchema` estricto, `scan` opcional en KNOWN/ARCHIVED/UNKNOWN/CANDIDATES, `reasonCode`/`scan` opcionales en INVALID/UNSUPPORTED, mensajes humanos.   |
| `apps/web/src/lib/gs1-capture.ts`                                    | Lógica pura de captura: plan de precarga según policy, ítems de revisión, grupo de series, duplicados, pegado multilínea.                                             |
| `apps/web/src/components/catalog/scan-details.tsx`                   | Presentación de Lote/Vence/Serie y revisión, sin AIs, AIM, offsets ni YYMMDD.                                                                                         |
| `apps/web/src/components/catalog/identification.tsx`                 | Resultado “✓ Producto reconocido” o “Producto reconocido; revisá estos datos”; modo embebido para continuidad desde Ingreso/Conteo.                                   |
| `apps/web/src/components/inventory/operations.tsx`                   | `OperationEditor` existente de Receipt y Count: precarga, revisión, grupo de series, captura pendiente protegida, identificación embebida, respuestas tardías.        |

Un solo intérprete: Receipt, Count y Product Identification consumen el resultado del backend; el browser no parsea GS1 ni envía datos físicos interpretados como autoridad.

## 2. Comportamiento del parser

- **Formatos:** GTIN legacy (sin cambios), HRI `(01)…(17)…(10)…(21)…`, element string con U+001D real, con o sin AIM `]d2` (GS1 DataMatrix), `]C1` (GS1-128), `]Q3` (GS1 QR). El AIM se conserva como metadata y nunca entra en los datos. Prefijos encadenados o AIM + HRI → `MIXED_FORMAT`.
- **AIM genéricos/desconocidos** (`]d1`, `]Q1`, `]C0`, otros): sin evidencia GS1 siguen la clasificación legacy con el texto completo; con evidencia GS1 → `FORMAT_CONFLICT` / `UNSUPPORTED_SYMBOLOGY`.
- **Encuadre:** se quitan espacios ASCII iniciales y un único terminador final (CRLF, CR, LF o TAB). Sin `trim()` general, sin NFKC, sin uppercase, sin decodificar URL, sin tocar ceros ni guiones, sin truncar. Controles (excepto GS en element string) → `INVALID_CONTROL`; no ASCII o sustitutos aislados → `INVALID_CHARACTER`.
- **GS/FNC1:** solo U+001D es separador. `<GS>`, `{GS}`, `|`, `~`, `^`, `␝` y el texto `\x1D` son datos (o error), nunca separadores. GS inicial, doble o final → `UNEXPECTED_SEPARATOR`.
- **Tokenización:** AIs solo en fronteras; 01 consume 14 dígitos, 17 seis, 10/21 hasta GS o fin (1–20 caracteres del set 82). Un lote `ABC1017XYZ` queda entero; un GS perdido que deja un lote válido no se puede detectar y no se reconstruye. Variable > 20 sin frontera → `MISSING_SEPARATOR`. AI raw desconocido → se detiene (`UNSUPPORTED_AI`, `complete=false`) sin resincronizar. AI 11 solo como descriptor estructural de 6 dígitos (`UNSUPPORTED_AI`, REVIEW; no se expone fecha de producción).
- **Vencimiento:** YYMMDD con ventana GS1 `[Y−49, Y+50]` sobre `referenceYear` inyectado; calendario validado aritméticamente (bisiestos incluidos, sin rollover de `Date`). Día 00 → último día del mes, `precision: 'MONTH'` y `EXPIRATION_DAY_UNSPECIFIED` (REVIEW); la UI no lo aplica como fecha exacta.
- **Duplicados:** nunca first/last-wins. AI 01 repetido impide resolver; 10/17/21 repetidos dejan el campo vacío y bloquean su aplicación automática.
- **Resultado:** `NOT_GS1` | `REJECTED` (status INVALID/UNSUPPORTED + reasonCode) | `GS1` (VALID/PARTIAL/INVALID, syntax, symbology, fields, issues, `canResolveIdentity`, `canApplyPhysicalData`).
- **Digital Link:** URI con `/01/` o `id.gs1.org` → `UNSUPPORTED_FORMAT`, sin red ni persistencia.

## 3. Adaptaciones al diseño

Detalles resueltos durante la implementación, sin cambiar el alcance:

1. Un element string sin marcas que cumple la gramática se interpreta antes del rechazo por marcadores HRI incrustados, para respetar el fixture §17 #37 (`ES + 10ABC(17)XYZ` es un lote literal). Texto no GS1 con `(01)`, `(10)`, `(17)` o `(21)` incrustado sigue rechazado (`MIXED_FORMAT`), como protegía el detector anterior.
2. Un GS después de un elemento de longitud predefinida se tolera si le sigue otro AI.
3. Variable vacía al final de un element string → `TRUNCATED_ELEMENT` (estructural); variable vacía delimitada o en HRI → `INVALID_FIELD_LENGTH` (PARTIAL si el GTIN es inequívoco). Variable > 20: `MISSING_SEPARATOR` en element string, `INVALID_FIELD_LENGTH` en HRI.
4. INVALID/UNSUPPORTED pueden llevar `scan` para revisión efímera; KNOWN/UNKNOWN/CANDIDATES/ARCHIVED lo llevan cuando la lectura es GS1. AMBIGUOUS no cambia.
5. Continuidad de producto desconocido: en Ingreso/Conteo la identificación se abre **dentro de la operación** (`ProductIdentification` embebido) y la captura queda en memoria; al confirmar, la misma lectura se vuelve a resolver en backend para el borrador vigente. Recargar pierde solo la captura efímera. Remitos usa el mismo panel embebido desde Stage 4 (§9).
6. Editor de Remitos (Stages 1–3): solo un mensaje que informaba que lote/vencimiento/serie leídos no se guardan ni imprimen (§11.2). Stage 4 lo reemplazó por el flujo de §9.
7. Conflicto lote/vencimiento con un lote existente: lo detecta el backend actual al confirmar (409, sin sobrescribir). No se agregó consulta anticipada porque requeriría la consulta exacta de Stage 4.
8. Perfil Tab como terminador: no implementado (no hay perfil HID homologado). Enter sigue siendo el terminador.

## 4. Gate de colisiones de detección bare

Antes de activar la detección sin marcas (`01` + ≥16 caracteres, `17` + 6 dígitos + `01`), se hizo un análisis **read-only** (`BEGIN READ ONLY … ROLLBACK`) sobre la base local de desarrollo:

| Consulta                                                     | Resultado |
| ------------------------------------------------------------ | --------- |
| SupplierScanIdentifier con `^01` y longitud ≥ 16             | 0         |
| SupplierScanIdentifier con `^17[0-9]{6}`                     | 0         |
| ProductIdentifier no GTIN con `^01` y longitud ≥ 16 / `^17…` | 0         |
| SupplierCatalogItem.supplierCode con `^01` y longitud ≥ 16   | 0         |

Sin colisiones en este entorno, por eso la detección bare quedó activa. **Cada entorno (en particular producción) debe repetir la consulta antes del despliegue**; si aparecen filas, no desplegar la detección bare para ese entorno hasta resolverlas (no migrar ni reasignar datos automáticamente):

```sql
BEGIN READ ONLY;
SELECT count(*) FROM "SupplierScanIdentifier" WHERE "normalizedValue" ~ '^01' AND length("normalizedValue") >= 16;
SELECT count(*) FROM "SupplierScanIdentifier" WHERE "normalizedValue" ~ '^17[0-9]{6}01';
SELECT "kind", count(*) FROM "ProductIdentifier" WHERE "kind" <> 'GTIN' AND ("normalizedValue" ~ '^17[0-9]{6}01' OR ("normalizedValue" ~ '^01' AND length("normalizedValue") >= 16)) GROUP BY "kind";
ROLLBACK;
```

## 5. Ingreso e Inventario inicial

Flujo: lectura → resolve → Product + datos físicos → policy → precarga → revisión → **Agregar** → borrador → confirmar. El scan nunca agrega líneas, confirma ni genera movimientos.

| Caso                                    | Comportamiento                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Solo AI 01                              | Igual que GTIN legacy.                                                                                                                 |
| Obligatorio ausente                     | Aviso “Este producto requiere …” y campo obligatorio; nada inventado.                                                                  |
| Lote/vencimiento no exigidos            | Se precargan y conservan.                                                                                                              |
| Serie con `serialRequired`              | Se agrega a la lista; la cantidad deriva de las series (una serie → 1).                                                                |
| Serie con `serialRequired=false`        | Revisión ámbar: ADMIN puede revisar la policy; si no, “Descartar la serie para este ingreso”. Nunca se envía ni se pierde en silencio. |
| Sin policy                              | Identidad válida; datos leídos visibles; configuración ADMIN existente antes de ingresar.                                              |
| Día 00 / fecha inválida / dato repetido | Revisión: el operador ingresa el dato desde la etiqueta o lo descarta (solo si la policy no lo exige). Agregar queda bloqueado.        |
| AI no soportado                         | Revisión “Revisé la etiqueta”.                                                                                                         |
| Vencido                                 | Aviso ámbar; se registra físico no disponible (regla actual).                                                                          |

Series: lecturas del mismo grupo Product/lote/vencimiento se acumulan en la captura; una serie repetida en la captura o en el borrador muestra “Esta serie ya está en la operación.” (el backend sigue siendo la defensa). Otro Product u otro lote/fecha con captura sin agregar no la borra: se pide agregarla o descartarla, y si se agrega, la nueva lectura se carga después. Inventario inicial usa el mismo mapeo y conserva claims, scopes, cobertura, `expectedVersion` y cero explícito. Respuestas tardías se descartan por número de intento y `AbortController`. Enter durante composición IME no envía; pegar varias líneas se rechaza.

## 6. Tests

- `apps/api/test/gs1.test.ts`: matriz §17 #1–#51, 24 permutaciones de los cuatro AIs (element string con cada AIM y HRI), corpus adversarial determinista de 5000 entradas (sin excepciones, límites, case conservado, determinismo), transporte JSON de U+001D y benchmark de 10000 lecturas de hasta 512 caracteres (umbral holgado, no flaky).
- `apps/api/test/identification.test.ts`: actualizado; GS1 compuesto resuelve solo identidad GTIN.
- `apps/api/test/gs1.integration.ts` (base desechable): GS1 conocido = EAN-13 legacy; PARTIAL; INVALID_GTIN sin rescate; formatos no soportados; INTERNAL_CODE; UNKNOWN/CANDIDATES/ARCHIVED; confirmación que persiste solo GTIN, sin lote/serie/raw en Audit, CatalogIdentification ni identificadores, retry idempotente; tenant isolation; regresiones legacy; Receipt con prefill, serie/cantidad, borrador sin stock, confirmación, serie repetida y conflicto de lote; serie con policy false; sin policy; Initial Count con scope/cobertura/cero; cero efectos laterales de resolve.
- `apps/api/test/identification.integration.ts`: la expectativa `UNSUPPORTED` para GS1 compuesto se reemplazó por UNKNOWN + GTIN + scan.
- `apps/web/test/gs1-capture.test.tsx`: plan por policy, revisión, grupos, duplicados, pegado, input JSDOM con U+001D y BFF real reenviando el GS intacto con contrato estricto.

## 7. QA ejecutada (26/10/2026)

| Comando              | Resultado                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`          | OK                                                                                                               |
| `pnpm format:check`  | OK                                                                                                               |
| `pnpm typecheck`     | OK                                                                                                               |
| `pnpm test`          | API 104/104, web 28/28                                                                                           |
| `pnpm test:database` | 163 tests: 161 OK, 0 fallos, 2 skipped opt-in preexistentes (Printing BFF real, aceptación con archivo original) |
| `pnpm build`         | OK                                                                                                               |

`packages/database` (schema y migraciones) sin cambios; no se ejecutó `db push`.

## 8. Limitaciones

- **Hardware no verificado.** No se probó ningún lector físico, layout de teclado, AIM ni transmisión de GS. La implementación procesa correctamente la cadena que llega; si el lector pierde el GS y el resultado sigue siendo un lote válido, no hay forma segura de detectarlo (el operador revisa los datos mostrados). Homologar lectores de Bourbon antes de habilitar operación.
- El parser cubre solo 01/10/17/21; no es un validador GS1 completo ni certifica etiquetas, asignación de GTIN, autenticidad o cumplimiento sanitario.
- La limitación de conservar datos sin allocation quedó resuelta por Stage 5 (§10).
- Gate de colisiones: verificado solo en la base local.

## 9. Stage 4: Remitos + matching físico exacto

Fecha: 26 de octubre de 2026. Base: HEAD `fdbe3de8fc2279124f83ebbd6ac9528445a1a1ff` (`stage 123`), árbol limpio. Sin migración, sin cambios de schema, sin dependencias nuevas. Sin commit ni push.

Principio que no cambia: **el Remito no depende de Inventory**. Cero, parte o todas las unidades pueden quedar vinculadas a Stock; sin allocations no hay movimiento. Stage 4 solo ayuda a proponer allocations reales (`DeliveryNoteAllocation`) a partir de una lectura.

### 9.1 Caso de uso `physical-match`

`POST /api/v1/inventory/products/:productId/physical-match` (BFF `/api/inventory/products/:id/physical-match`, alta explícita en `inventoryRouteContract`; POST solo porque los criterios viajan en un body estricto). Lectura pura: transacción `RepeatableRead` + `SET TRANSACTION READ ONLY`, sin locks, sin audit, sin crear lotes/series/balances/movimientos/scopes ni reservas. Mismos roles que la consulta de Stock (ADMIN y OPERATOR).

- **Entrada** (`inventoryPhysicalMatchInputSchema`, strict): `lotNumber?`, `expirationDate?`, `serialNumber?`, `locationId?`, `page` (1), `limit` (20, máx. 100); al menos un criterio físico. No acepta organizationId, productId en body, GTIN, raw ni flags de confianza. Texto con la misma regla física de Inventory (trim, 1–128, sin controles).
- **Scope:** `RequestActorContext.organizationId` + `productId` del path. Product o ubicación ajenos → 404. Serie/lote de otro Product u organización → `MISSING` dentro del scope pedido, sin revelar que existen en otro lado.
- **Lookups exactos** sobre las claves normalizadas de Inventory (`normalizedSerialNumber`, `normalizedLotNumber`, únicas por org+Product): sin contains, sin case-insensitive, sin fuzzy. Fecha comparada como DATE de negocio (`YYYY-MM-DD`). Usa los índices existentes; no hizo falta ninguno nuevo.
- **Serie:** desconocida → `MISSING SERIAL_NOT_FOUND`; sin saldo → `MISSING SERIAL_NOT_IN_STOCK`; lote o vencimiento escaneados distintos de los registrados → `CONFLICT SERIAL_LOT_CONFLICT` / `SERIAL_EXPIRATION_CONFLICT`; elegible → `EXACT` (cantidad 1).
- **Lote sin serie:** inexistente → `MISSING LOT_NOT_FOUND`; sin saldo → `LOT_NOT_IN_STOCK`; vencimiento escaneado distinto del lote (incluido lote sin fecha) → `CONFLICT LOT_EXPIRATION_CONFLICT`; con existencias → `CHOICES` (nunca autovínculo, aunque haya una sola posición).
- **Solo vencimiento:** filtra posiciones por fecha → `CHOICES` o `MISSING NO_MATCHING_STOCK`; nunca identifica una posición ni aplica FEFO.
- **Elegibilidad:** la regla de posición se extrajo a `inventory/domain/outbound.ts` (`positionOutboundBlock`) y la usan tanto `postDeliveryNote` (autoridad, mismos mensajes y orden) como el match. Producto archivado, sin policy, ubicación archivada, DAMAGED, QUARANTINE, vencido, policy incompatible, conteo activo o scope faltante → posición no elegible; si ninguna es elegible → `UNAVAILABLE` con los motivos.
- **Respuesta** (`inventoryPhysicalMatchSchema`, strict): `status`, `reasonCodes`, `businessDate`, `policy`, `availableQuantity` exacta (suma de posiciones elegibles), `positions` (positionId, quantity, location, lote, vencimiento, serie, condición, `eligible`, `unavailableReason`), `total`, `page`, `limit`. Se evalúan todas las posiciones coincidentes (máximo 2000, error explícito si se supera) y se ordenan elegibles primero antes de paginar: una posición en otra página nunca se informa como inexistente.

### 9.2 Editor de Remitos

El campo “Escanear producto” existente pasa a usar el flujo GS1 completo, sin parser propio: `catalog-scans/resolve` → Product + `scan`. Lectura HID, manual o pegada; Enter; sin listener global ni requests por carácter; Enter durante IME no envía; pegar varias líneas se rechaza.

| Resultado                        | UI                                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Solo GTIN (o vencimiento día 00) | Igual que antes: agrega la línea; el selector de Stock sigue siendo opcional. Un vencimiento sin día no se usa como criterio exacto.                               |
| EXACT                            | “Encontramos esta unidad en Stock.” + datos registrados + **Vincular al Remito** (línea cantidad 1 con su allocation).                                             |
| CHOICES                          | “Encontramos N existencias compatibles”, ubicación/lote/vencimiento/cantidad, paginado; series por casilla, lotes con cantidad editable hasta lo disponible.       |
| MISSING                          | “El producto fue reconocido, pero esta unidad no está registrada en Stock de MaxBio.” + **Agregar igualmente al Remito**.                                          |
| UNAVAILABLE                      | “La unidad está registrada, pero no está disponible para salida.” + motivo humano + **Agregar sin vincular Stock**.                                                |
| CONFLICT                         | “Los datos escaneados no coinciden con los registrados en Stock.” + datos registrados; no se corrige nada; **Agregar sin vincular Stock** o **Descartar lectura**. |
| UNKNOWN / CANDIDATES             | **Identificar producto** abre la identificación embebida; el Remito (aunque no esté guardado) queda montado; al confirmar se vuelve a resolver la misma lectura.   |
| INVALID / UNSUPPORTED / PARTIAL  | Mensaje humano y revisión con `ScanDetails`.                                                                                                                       |

Siempre que no se vincula, la UI dice que “los datos físicos escaneados no se guardarán en este Remito mientras no estén vinculados a Stock”: **sin allocation no se persiste lote, vencimiento ni serie** (eso es Stage 5). Agregar sin Stock es siempre una acción explícita. Mientras una lectura con match está pendiente, otra lectura no la reemplaza: se pide vincularla, agregarla sin Stock o descartarla. Tras agregar, la captura se limpia y el foco vuelve al campo. Cada lectura agrega una línea nueva, como el editor actual (las líneas pueden repetirse); la cantidad documental se puede subir después y la allocation queda parcial. La disponibilidad mostrada descuenta lo ya vinculado en el propio borrador, y una serie ya vinculada no se vuelve a proponer. Respuestas tardías se descartan por número de intento.

### 9.3 Confirmación y concurrencia

Sin cambios de semántica: `postDeliveryNote` revalida tenant, Product, policy, ubicación, condición, vencimiento, series únicas, saldo agregado y conteo activo; crea como máximo un OUTBOUND, nunca negativos, idempotente y atómico. Un match no reserva stock: si otro Remito consumió la serie, la confirmación falla con 409 y el borrador conserva su allocation; nunca se convierte en salida sin Stock automáticamente.

### 9.4 Tests Stage 4

- `apps/api/test/physical-match.integration.ts` (base desechable): GS1 → resolve → EXACT → vinculación → MISSING (`SERIAL_NOT_IN_STOCK`), serie desconocida, case-sensitive, conflictos de lote y vencimiento; lote CHOICES paginado con elegibles primero, `locationId`, inexistente, conflicto de fecha, fecha sola, cantidad decimal exacta; UNAVAILABLE por DAMAGED, QUARANTINE, vencido, conteo activo, ubicación archivada y sin policy (el Remito documental igual confirma); aislamiento tenant/Product y 404; contrato estricto (400); OPERATOR y ADMIN; cero efectos laterales; Remito parcial, completo y sin stock; serie duplicada en borrador (400) y match obsoleto (409 sin degradar).
- `apps/api/test/physical-match.test.ts`: orden de la regla de salida compartida y contrato/ruta.
- `apps/web/test/delivery-match.test.tsx`: criterios desde el scan, aritmética exacta, disponible descontando el borrador, selección parcial/serie única, y BFF de Inventory real (allowlist, cuerpo estricto, CSRF, respuesta validada).

Ubicaciones adicionales, ubicación archivada y stock sin policy se crean como fixtures directos en la base desechable porque V1 no tiene flujo multi-depósito ni permite archivar productos con stock.

### 9.5 Limitaciones Stage 4

- El editor de Remitos no se monta en tests de componente: el harness web compila sin el alias `@/` que usa ese editor. Su lógica está en helpers puros testeados y los flujos completos se verifican por API.
- Hardware sin verificar, igual que en Stages 1–3.
- Esta limitación de Stage 4 quedó resuelta por Stage 5 (§10).

### 9.6 QA Stage 4 (26/10/2026)

| Comando              | Resultado                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm lint`          | OK                                                                                          |
| `pnpm format:check`  | OK                                                                                          |
| `pnpm typecheck`     | OK                                                                                          |
| `pnpm test`          | API 106/106, web 32/32                                                                      |
| `pnpm test:database` | 170 tests: 168 OK, 0 fallos, 2 skipped opt-in preexistentes (Printing BFF real, aceptación) |
| `pnpm build`         | OK                                                                                          |

`packages/database` (schema y migraciones) y los módulos de Printing sin cambios; no se ejecutó `db push`.

## 10. Stage 5: trazabilidad física documental sin Inventory

Base inicial: `edd5de57e88dc65286c6a704bb96ff7995b59e53`, `main`, working tree limpio y sincronizado con origin/main según referencias locales. Commits revisados: Stage 4 `edd5de5`, Stages 1–3 `fdbe3de`, incremento opcional Inventory `c34f8ff`. No se hizo commit ni push.

### 10.1 Modelo y migración

Una migración nueva: `20261026190000_delivery_documentary_trace`. Prisma agrega DeliveryNoteLineTrace con origin INVENTORY/DECLARED, captureMethod MANUAL/GS1/LEGACY, cantidades exactas, lote/fecha/serie nullable, GTIN observado nullable, allocation nullable, ordinal y acuse mínimo de antecedentes. deliveryNoteId permite unique por org/documento/Product/serie. preserveOnUnlink guarda la intención de conservar los datos capturados expresamente. No se crean entidades Inventory para una declaración; fecha es DATE, no timestamp.

FK compuesta a Line incluye org/documento/Product/lineId; la FK a allocation incluye org/Product/lineId/allocationId. Unique de allocationId impide dos traces para la misma selección. Unique por documento no impide repetir la serie en otro remito histórico. Check de texto conserva case/ceros/puntuación, trim y límite 128 de Inventory. Serial exige cantidad 1 y UNIT/PAIR; todas las cantidades usan helpers BigInt, no float. Cobertura total de traces no puede exceder línea. Una INVENTORY debe igualar cantidad y datos físicos de su allocation, sin doble conteo.

Se reutiliza el guard de hijos que bloquea el Remito padre y rechaza toda modificación a documento cerrado. Una función de constraint diferido controla cobertura/correspondencia/unidad/snapshots en los commits de línea, allocation, trace y documento; no debilita el guard OUTBOUND opcional existente. La migración copia los confirmados desde InventoryMovementLine.deliveryAllocationId y sus snapshots, con LEGACY/GTIN null/revisión vacía. DRAFT y CANCELLED con allocation se inicializan desde posición actual; sin allocation no hay backfill inventado. Históricos inconsistentes abortan con error explícito. No se tocaron migraciones históricas ni se usó db push.

### 10.2 Escrituras, concurrencia y privacidad

El PATCH completo existente es la unidad atómica de edición (expectedVersion, Product/Customer/document locks existentes). physicalTraces de entrada contiene propuestas DECLARED; el backend genera las INVENTORY desde Stock. sourceTraceId/traceId conservan procedencia al vincular y permiten split exacto. Unlink conserva las capturas documentadas expresamente; selección derivada solo de Stock se quita. El editor deja guardar/confirmar cantidades sin ningún dato físico nuevo obligatorio ni policy.

El servidor deriva captureMethod: scanValue viaja solo en comando DRAFT, se reinterpreta con el parser central y nunca se persiste. Datos idénticos a GS1 válido son GS1; editados son MANUAL. El GTIN se toma de lectura o snapshot previo y se valida contra identifiers activos del mismo tenant/Product, tanto al guardar como al confirmar. No se puede afirmar GS1 ni INVENTORY mediante enums del browser. Solo GTIN, sin dato físico y sin allocation, no crea trace automática.

La revisión de antecedentes usa `POST /delivery-notes/trace-history` con Product+lote/serie exactos en body privado. Devuelve número, cliente snapshot, fecha, cantidad e IDs; índices org/Product/lote y org/Product/serie. No hay pantalla analítica nueva. Antes de confirmar, la UI pide revisión expresa si encuentra serie anterior. Backend toma advisory locks estables y ordenados por tenant/Product/serie y relee: un antecedente concurrente nuevo produce 409; no acepta solo el check de UI. El comando lleva la unión exacta de IDs revisados (máximo 500), y se guarda solo el subconjunto pertinente a cada trace (máximo 100 por serie). Superar límites requiere revisión administrativa; no una omisión silenciosa de advertencias.

Confirmación conserva operationId y hash/replay existentes; el campo nuevo es opcional para no cambiar replays antiguos. Ningún operationId por trace. Antecedentes, validación, snapshots documentales, OUTBOUND real si corresponde y Audit integran la misma transacción. Falla de audit/stock/conflicto revierte todo. DECLARED no crea lot/serial/balance/location/receipt/adjustment/movement ni reserva. No hay raw GS1 en filas, audit, URLs, archivos, logs o storage del navegador.

### 10.3 UI y Printing

Se reutiliza ProductCapture de Stage 4. Agregar sin Stock conserva los datos GS1 físicos válidos y muestra que solo documentan el Remito. Captura manual de lote/vencimiento/serie por porción de cantidad; subtotales de Stock vinculado/documentado y total; selector de porción ya declarada para vincular total o parcialmente. Al editar GS1 se marca manual; serie sigue siendo una unidad. Revisión de antecedentes visible, con número/cliente y enlace al remito anterior. No se exige InventoryPolicy para DECLARED, aun si serialRequired=false o hay conflicto con Stock.

PrintDocument usa exclusivamente physicalTraces para filas. Confirmado y detalle de allocations devuelven snapshots documentales; DRAFT/live preview proyecta declaraciones y posiciones validadas sin escritura. Guard geométrico y renderer comparten esa proyección. Preview, print-test y PRINT_OVERLAY conservan lote/fecha/serie, remanente vacío y overflow BLOCKED. Binding opcional scannedGtin imprime GTIN observado si una plantilla lo pide, sin agregar columna a Bourbon ni modificar geometría 203×271, editor, tolerancias, numeración o calibración. Reprint sigue con los mismos bytes/hash/asset original. La hoja de calibración conserva su propósito técnico separado.

### 10.4 Cobertura agregada

- `documentary-trace-migration.integration.ts`: upgrade, from-zero, status/drift, deploy repetido idempotente, fuente ledger histórica deliberadamente distinta del master, borrador inicializado, histórico sin allocation sin trace, y corrupción histórica que detiene migración. Bases descartables propias.
- `physical-match.integration.ts`: GS1 sin stock/policy y GTIN observado entre varios identificadores; DECLARED persistida y cero efectos Inventory; edición MANUAL, rechazo de GTIN inventado; parcial/split/link/unlink, expectedVersion obsoleta; cantidades/serie/unidad/duplicados; antecedentes históricos y confirmación concurrente con revisión/retry; SQL de inmutabilidad/cobertura/tenant/Product. Se mantiene la regresión Stage 4; el rechazo de serie duplicada pasa a ocurrir al guardar el borrador, antes de confirmar, conservando la comprobación de rechazo.
- `printing.integration.ts`: DECLARED sin stock en preview efímera, preview guardada, prueba/overlay, remanente, snapshots ante cambio de Product y reprint idéntico. Se conserva la suite anterior, incluido calibración y no efectos Inventory.
- `printing.test.ts`: mismas assertions de cantidades/overflow/serie ahora sobre la proyección documental; GTIN observado opcional. Samples/fixtures explícitamente incorporan traces, sin fallback del renderer a allocations.
- Web: captura GS1 válida/solo GTIN/PARTIAL, split exacto incluso microcantidades, contratos/origin protegido; montaje React de editor manual (agregar/editar/quitar) y de antecedentes (revisión obligatoria antes de confirmar).
- QA visual PDF: dos overlays sintéticos del motor real, 203×271, renderizados a PNG e inspeccionados: DECLARED con serie y combinación de Stock 2 + declaración 3 + remanente 1. Sin fondo ni marcas técnicas, sin solapamiento ni datos recortados. WARNING nominal conserva la evaluación existente. Artefactos/logs en `artifacts/stage5/`, ignorados por Git.

### 10.5 Resultados finales

Todos los comandos siguientes se ejecutaron sobre esta entrega; logs ignorados en `artifacts/stage5/*-qa.log`.

| Comando / comprobación                                                                      | Resultado                                                                     |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm lint`                                                                                 | OK, exit 0                                                                    |
| `pnpm format:check`                                                                         | OK, exit 0                                                                    |
| `pnpm typecheck`                                                                            | OK, exit 0                                                                    |
| `pnpm test`                                                                                 | API 107/107 y web 36/36; 0 fallos, 0 skipped                                  |
| `pnpm test:database`                                                                        | database 1/1; API 177 aprobados de 178, 0 fallos, 1 skipped                   |
| `pnpm build`                                                                                | OK; build aislado `.next/gs1-stage5-build`, incluye Remitos/Printing          |
| `pnpm db:migrate`                                                                           | Nueva migración aplicada en desarrollo local; 20 migraciones                  |
| Prisma `migrate status`                                                                     | Database schema is up to date                                                 |
| Prisma `migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | No difference detected, exit 0                                                |
| Migración Stage 5 específica                                                                | Upgrade, from-zero, backfill, error controlado y drift: aprobado              |
| BFF real de Printing                                                                        | Habilitado con MAXBIO_PRINT_BFF_SMOKE=1, MAXBIO_PRINT_BFF_PORT=3405; aprobado |
| Salud web/API/DB                                                                            | localhost:3000 y API /health responden status=ok, database=ok                 |

Total de la pasada completa: **321 aprobados, 0 fallos, 1 skipped** (107 API unitarios + 36 web + 177 API integración + 1 database). No se suman rechecks. La única omisión es aceptación optativa de Catalog con archivo comercial original no provisto (`MAXBIO_CATALOG_ACCEPTANCE_FILE`); el smoke Printing sí se ejecutó. La regresión de 500 detalles documentales con body mayor a 100 KiB pasó sin crear Inventory (aprox. 2 segundos para guardar en el entorno local).

El servidor de desarrollo permaneció disponible; el smoke de Next compilado usa otro puerto y su base descartable. No se ejecutaron fixtures ni resets sobre datos operativos. Solo se aplicó la migración additive y su backfill legítimo local. El nuevo caso de Printing falló inicialmente por enviar el id de línea a una preview cuyo contrato lo omite; se corrigió el fixture, sin flexibilizar el contrato. Su verificación final pasó dentro de la suite completa.

Revisión final: diff sin errores de whitespace, enlaces relativos revisados, migraciones históricas y lockfile sin cambios, HEAD sin cambios. La edición tardía de un mensaje aclaratorio de UI se recompiló también en el build final. No commit/no push.

### 10.6 Límites

No lector físico, impresora ni homologación de layout HID; el DOM se prueba con JSDOM y el flujo HTTP con bases descartables. El editor completo conserva el harness de Stage 4 (helpers/API); los dos controles nuevos sí se montan en tests React. JSON acotado a 1 MiB únicamente para Remitos y su preview; el límite anterior de 100 KiB podía rechazar capturas grandes legítimas. Máximo 500 detalles por remito, 100 antecedentes por serie y 500 IDs de revisión por confirmación; al excederlos se pide revisión, sin ignorar datos. Trazabilidad documental es declaración interna, no existencia ni certificación GS1/ANMAT. No se implementan devoluciones, ANMAT/SNT-PM, facturación/ARCA, reservas, transfers/FEFO nuevo, cámara/SDK, Digital Link, analytics o IA.

### 10.7 Operación de migración y rollback conceptual

Migración aditiva: no elimina ni reescribe líneas, allocations, ledger o snapshots comerciales históricos. Si hay histórico sin fuente confiable o un borrador preexistente con serie duplicada, se detiene en vez de deduplicar o inventar datos; resolver la inconsistencia con una revisión controlada antes de desplegar. Conservar respaldo de DB y artifacts antes de cambios de versión. No hay downgrade automático que borre declaraciones: un rollback de aplicación debe preservar/exportar los datos documentales nuevos y tratar expresamente los guards de traces, porque el código Stage 4 no las escribe. La vuelta completa de schema requiere una operación de mantenimiento planificada, nunca db push/reset ni eliminación silenciosa de traces.

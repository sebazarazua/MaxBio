# GS1 V1: implementación y verificación (Stages 1–3)

Fecha: 26 de octubre de 2026. Base: HEAD `c34f8ff8ff2c3f8215348507c850b02b24bcd9a8` (`main`), árbol limpio salvo el diseño sin versionar. Diseño fuente: [gs1-design.md](gs1-design.md). Sin commit ni push.

Implementado: **Stage 1** (parser puro + tests), **Stage 2** (Catalog / Product Identification) y **Stage 3** (Ingresar productos e Inventario inicial). **No implementado:** Stage 4 (scanner/matching en Remitos, `physical-match`) ni Stage 5 (DeliveryNoteLineTrace, migración, backfill, Printing con `physicalTraces`). Sin migraciones, sin cambios de schema y sin dependencias nuevas.

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
5. Continuidad de producto desconocido: en Ingreso/Conteo la identificación se abre **dentro de la operación** (`ProductIdentification` embebido) y la captura queda en memoria; al confirmar, la misma lectura se vuelve a resolver en backend para el borrador vigente. Recargar pierde solo la captura efímera. Remitos conserva su enlace actual a `/identificar`.
6. Editor de Remitos: único cambio, un mensaje que informa que lote/vencimiento/serie leídos no se guardan ni imprimen (§11.2). No se agregó scanner nuevo ni se tocaron líneas, allocations ni Printing.
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
- Remitos no conserva lote/serie escaneados sin allocation hasta Stage 5.
- Gate de colisiones: verificado solo en la base local.

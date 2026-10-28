# Facturación V1 — modelo interno

Actualización V3 (28/10/2026): [WSFEv1 de homologación](invoicing-v3-wsfev1.md)
agrega autorización CAE, rechazos, consulta y reconciliación con intentos persistidos y
reserva durable de secuencia. DRAFT/READY siguen siendo estados comerciales; el estado
fiscal es independiente. El resto de este documento describe la base histórica V1;
las reglas vigentes de emisión y sus límites están en el documento V3.

Actualización V2 (27/10/2026): se implementaron [perfil fiscal, credenciales y WSAA de homologación](arca.md) en un módulo separado. [Configuración y pasos humanos WSASS](arca-homologation-setup.md). No cambia el dominio V1 descrito debajo ni sus reglas DRAFT/READY; completar ARCA no es requisito para crear/editar/marcar READY. V2 no emite comprobantes, no obtiene CAE y no implementa WSFEv1, punto de venta, numeración fiscal, PDF ni producción. La verificación real WSAA queda pendiente de certificado y autorización.

Fecha: 27 de octubre de 2026. Base: HEAD `b992acb509a757ec8acb12b31b7bae78b72260a0` (`main`, Trazabilidad), árbol limpio. Migración nueva `20261027120000_invoicing_v1`. Sin dependencias nuevas. Sin commit ni push.

## Qué es y qué no es

MaxBio distingue tres cosas:

| Concepto              | En V1                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| **Remito**            | Documento operativo de salida (ya existía). No cambia.                              |
| **Factura interna**   | Documento comercial preparado por MaxBio: líneas, precios, IVA, totales. **Nuevo.** |
| **Autorización ARCA** | **No existe.** Sin WSAA, WSFEv1, CAE, certificados, SOAP ni numeración fiscal.      |

Una factura **Lista para autorizar** (`READY`) está validada internamente y lista para enviarse a un proveedor fiscal futuro. **No** está autorizada por ARCA, no tiene CAE y no tiene validez fiscal; la UI lo dice explícitamente (“Integración ARCA pendiente”) y nunca usa “Facturada”, “Autorizada” ni “CAE”. No hay PDF ni impresión de factura.

## Modelo

`Invoice` → `InvoiceDeliveryNote` (1..20 Remitos) → `InvoiceLine` (una por línea de Remito).

| Entidad               | Datos                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invoice`             | UUID del cliente (idempotencia), org, Customer (FK compuesta), status DRAFT/READY, version, invoiceType nullable, issueDate DATE, currency `ARS`, exchangeRate `1`, net/vat/total NUMERIC(18,2), notes, customerSnapshot (solo READY), creationHash, lastOperationId/Hash, readyAt/readyBy (Membership con FK compuesta), timestamps.                                                                                            |
| `InvoiceDeliveryNote` | org, invoiceId, customerId, deliveryNoteId, ordinal, createdAt. FKs `(org, invoiceId, customerId)` → Invoice y `(org, deliveryNoteId, customerId)` → DeliveryNote: **el mismo Customer queda garantizado por la base**. Unique `(org, deliveryNoteId)`: **un Remito, como máximo una factura**.                                                                                                                                  |
| `InvoiceLine`         | org, invoice, link `(org, invoiceId, deliveryNoteId)`, línea de Remito `(org, deliveryNoteId, productId, deliveryNoteLineId)` (misma FK de alcance de trazas), Product, ordinal, descripción comercial editable, snapshots `productNameSnapshot`/`presentationSnapshot`/`unitOfMeasure`, quantity NUMERIC(20,6), unitPrice NUMERIC(18,2) nullable, vatRate nullable, net/vat/total nullable. Unique `(org, deliveryNoteLineId)`. |

Se agregó solo el índice único `delivery_note_customer_scope (org, id, customerId)` en DeliveryNote para la FK compuesta; DeliveryNote, sus líneas, allocations y traces no cambian. No hay estado “facturado” en el Remito: **pendiente = CONFIRMED sin `InvoiceDeliveryNote`** (una sola fuente de verdad).

Campos no creados a propósito (se agregarán con la integración, con sus reglas reales): `pointOfSale`, `documentNumber`, `cae`, `caeExpiration`, `arcaStatus`, `authorizationRequestId`, `otherTaxesAmount`. Estados `AUTHORIZED`/`REJECTED` tampoco existen: no se simula una autorización.

## Decisiones V1

- **Remito completo.** Cada línea del Remito genera exactamente una línea de factura; un trigger diferido exige cobertura total de los Remitos vinculados. No hay facturación parcial, líneas manuales, borrado de líneas ni descuentos.
- **Sin agrupación.** Productos repetidos en varios Remitos quedan en líneas separadas, cada una enlazada a su línea de Remito: no se pierde el origen. Agrupar queda para cuando exista una necesidad real.
- **Cantidad, producto y unidad bloqueados**, copiados del Remito confirmado (sus snapshots, nunca el Product vivo). Editables en DRAFT: descripción comercial, precio unitario, IVA, tipo, fecha y observaciones.
- **Sin precios inventados.** El precio arranca vacío; no se usan listas de proveedores ni márgenes.
- **Tipo A/B/C elegido por la persona.** Customer solo tiene `taxConditionText` libre y la organización no tiene perfil fiscal, así que MaxBio no decide el tipo ni la condición IVA. Reglas mínimas al pasar a READY: tipo obligatorio, **A exige CUIT del cliente**, **C no discrimina IVA** (IVA total 0).
- **Sin perfil fiscal de la organización.** No hace falta para V1 (no hay emisión, numeración ni impresión). Razón social, CUIT, condición IVA y punto de venta del emisor son requisitos de V2/V3.
- **Descartar borrador**: un DRAFT nunca tuvo valor fiscal; descartarlo (ADMIN) borra sus líneas y vínculos y devuelve los Remitos a Pendientes. Una factura READY no se puede borrar.
- **Volver a borrador** (READY → DRAFT) existe solo porque todavía no hay autorización fiscal.

## Dinero, IVA y redondeo

Sin float. Cantidad escala 6 (la de Inventory/Remitos), dinero escala 2 (`NUMERIC(18,2)`), aritmética `bigint` en `packages/contracts/src/invoicing.ts` (`invoiceLineAmounts`, `invoiceTotals`) usada por la API (autoridad) y por la vista previa del browser.

Política única, replicada en el `CHECK invoice_line_values` de la migración:

1. neto línea = `round(cantidad × precio unitario, 2)`
2. IVA línea = `round(neto × alícuota, 2)`
3. total línea = neto + IVA
4. totales de factura = suma exacta de las líneas (trigger diferido)

Redondeo mitad hacia arriba (todos los valores son ≥ 0; coincide con `round()` de PostgreSQL). Alícuotas internas `InvoiceVatRate`: `VAT_0`, `VAT_10_5`, `VAT_21`, `VAT_27`, `EXEMPT`, `NOT_TAXED` (las tres últimas sin IVA). Los códigos de ARCA no están en el dominio: se mapearán en la integración. Pendiente de validar en homologación: WSFEv1 informa IVA agregado por alícuota; MaxBio redondea por línea y suma. La regla está centralizada para poder revisarla antes de emitir comprobantes reales.

El browser nunca envía montos ni snapshots: el contrato strict rechaza `netAmount`, `totalAmount`, `customerSnapshot`, `organizationId`, etc. La API recalcula al guardar y vuelve a recalcular y comparar al pasar a READY.

## Snapshots

- **Cliente:** DRAFT muestra el Customer vivo. Al pasar a READY se congela `customerSnapshot` (mismo formato que el Remito: nombre, tipo, razón social, CUIT, condición fiscal, domicilio, localidad, provincia, CP). Cambios posteriores del Customer no reescriben la factura (test). Volver a borrador lo libera; el siguiente READY vuelve a congelar.
- **Producto:** copiado desde el Remito confirmado al crear la factura y nunca leído del Product vivo (test con renombre). La descripción comercial queda congelada con READY.

## Estados, concurrencia e idempotencia

`DRAFT → READY → DRAFT`. Ediciones con `expectedVersion`. Crear: UUID estable del cliente + `creationHash` bajo advisory lock (doble clic o reintento devuelve el mismo borrador; otro contenido con el mismo UUID → 409). READY y Volver a borrador: `operationId` + `expectedVersion`; un reintento de la misma operación se reproduce sin repetir la transición.

Crear es atómico: lock `FOR NO KEY UPDATE` de los Remitos en orden de UUID → validación (existencia en el tenant, CONFIRMED, mismo cliente, sin factura) → Customer `FOR SHARE` → factura, vínculos, líneas y audit en una transacción. Dos facturas para el mismo Remito se serializan en ese lock: gana una y la otra recibe “Este Remito ya fue incluido en otra factura.” (409); el unique de la base es la última defensa (test con 3 intentos simultáneos).

Defensa en base (migración): CHECKs de moneda ARS/cotización 1, montos ≥ 0, total = neto + IVA, coherencia READY/readyAt/snapshot/tipo, precio ≥ 0 y montos de línea según la fórmula; triggers que solo admiten Remitos CONFIRMED, impiden tocar vínculos/líneas fuera de DRAFT, mantienen la línea idéntica a la del Remito, congelan READY (solo se permite volver a DRAFT sin cambiar montos), impiden cambiar el cliente y borrar READY; trigger diferido de totales, al menos un Remito, cobertura completa, READY con todas las líneas valuadas y C sin IVA.

## API, BFF y permisos

| Método / ruta                          | Función                                              | Permiso          |
| -------------------------------------- | ---------------------------------------------------- | ---------------- |
| `GET /invoices`                        | Facturas: status, customerId, fechas, búsqueda       | ADMIN y OPERATOR |
| `GET /invoices/pending-delivery-notes` | Pendientes: customerId, fechas, número/cliente       | ADMIN y OPERATOR |
| `GET /invoices/:id`                    | Detalle con Remitos, líneas, montos e historial      | ADMIN y OPERATOR |
| `POST /invoices`                       | Crear DRAFT desde 1–20 Remitos                       | ADMIN            |
| `PATCH /invoices/:id`                  | Tipo, fecha, notas, descripción/precio/IVA por línea | ADMIN            |
| `POST /invoices/:id/ready`             | Marcar lista para autorizar                          | ADMIN            |
| `POST /invoices/:id/reopen`            | Volver a borrador                                    | ADMIN            |
| `POST /invoices/:id/discard`           | Descartar borrador                                   | ADMIN            |

Sin permiso nuevo: la factura es un documento comercial/fiscal, así que las escrituras son de ADMIN (como Clientes); OPERATOR consulta. Las escrituras revalidan membresía ADMIN y sesión dentro de la transacción. Organización siempre desde `RequestActorContext`; Remitos, Customers o facturas de otro tenant responden 404. BFF `/api/invoices` con allowlist `invoiceRouteContract`, CSRF y Origin en escrituras, cuerpo ≤ 256 KiB validado, query estricta, cookie de sesión acotada, `no-store` y respuesta validada (un campo extra como `cae` → 503).

Audit en la misma transacción: `INVOICE_CREATED` (metadata solo `count` de Remitos), `INVOICE_UPDATED`, `INVOICE_MARKED_READY`, `INVOICE_RETURNED_TO_DRAFT`, `INVOICE_DRAFT_DISCARDED`. Sin precios, clientes ni pacientes en metadata. El detalle muestra el historial básico (acción, fecha, persona). Las lecturas no auditan.

Facturación no lee ni escribe InventoryBalance, InventoryMovement, allocations ni `DeliveryNoteLineTrace`, y no modifica Remitos (test de efectos laterales). Trazabilidad no usa facturas como fuente.

## UI

**Operaciones → Facturación** (`/facturacion`): aviso “no tienen CAE ni validez fiscal”, pestañas **Pendientes de facturar** y **Facturas**.

- Pendientes: búsqueda por número de Remito o cliente, filtros de cliente (búsqueda existente) y fechas; fecha, número (link al Remito), cliente, “Paciente/Afiliado asociado” (sin valores) y cantidad de líneas. Selección múltiple: al elegir un Remito, los de otros clientes quedan deshabilitados. **Crear factura** (ADMIN) abre el borrador. Vacío: “No hay Remitos pendientes de facturar.”
- Facturas: estado (Borrador / Lista para autorizar), cliente, fechas y búsqueda; fecha, cliente, Remitos, tipo, estado, total (y “Faltan precios o IVA”). Vacío: “Todavía no hay facturas.”
- Factura (`/facturacion/:id`): “Borrador de factura” o “Factura lista para autorizar” con referencia interna (nunca un número fiscal), cliente, Remitos con **Ver Remito**, tipo, fecha, observaciones, **IVA para todas las líneas**, tabla con descripción, cantidad, precio (acepta `1.234,56`), IVA, neto, IVA $ y total, resumen Neto/IVA/Total en vivo, **Guardar borrador**, **Marcar lista para autorizar** (guarda antes si hay cambios), **Descartar borrador**, **Volver a borrador** e historial. Errores humanos: “Completá el precio unitario…”, “Revisá el IVA…”, “Los Remitos seleccionados pertenecen a clientes distintos.”, “Este Remito ya fue incluido en otra factura.”

## Pruebas

- `apps/api/test/invoicing.test.ts`: cantidad × precio, 0/10,5/21/27 %, exento/no gravado, redondeo, suma exacta, cero, inválidos, límites de NUMERIC(18,2) y contratos strict.
- `apps/api/test/invoicing.integration.ts` (base desechable, Remitos reales): pendientes y filtros; un Remito; varios del mismo cliente; clientes distintos, borrador, cancelado, ya facturado y ajeno rechazados; reintento/doble clic; concurrencia (3 intentos, gana 1); cálculo y rechazo de montos del browser; READY con validaciones, recálculo, replay y congelamiento; snapshots tras renombrar Cliente/Producto; volver a borrador y descartar; lista con filtros; multi-tenant; defensa directa en base; cero efectos en Inventory/traces/Remitos.
- `apps/web/test/invoicing.test.tsx` (React + JSDOM): helpers de dinero/selección, pendientes, búsqueda, selección múltiple y bloqueo de otro cliente, crear (misma clave en reintento), error 409, operador, listas y vacíos, editor con precio/IVA/totales/validación, READY sin rótulos fiscales, volver a borrador, error, historial y BFF.

`documentary-trace-migration.integration.ts` asumía que Stage 5 era la última migración; ahora aplica solo las anteriores antes de cargar el histórico y después Stage 5 más todas las posteriores (incluida esta), comparando con el schema completo.

## Limitaciones

- Sin integración fiscal: un READY no es un comprobante.
- Remito completo y sin agrupación de líneas; sin líneas manuales, descuentos, percepciones ni otros impuestos.
- Tipo A/B/C manual; sin condición IVA estructurada de Customer ni perfil fiscal de la organización.
- Solo ARS; `currency`/`exchangeRate` fijos por constraint.
- Precio unitario con 2 decimales.
- Redondeo por línea pendiente de validar contra WSFEv1 en homologación.
- El Remito no muestra todavía en qué factura quedó (se ve desde Facturación).
- Sin PDF/impresión de factura.

## Versiones fiscales

- **V2 implementada:** perfil fiscal del emisor, credenciales y autenticación WSAA de homologación; smoke real pendiente de certificado/autorización WSASS.
- **V3 implementada:** WSFEv1 de homologación, POS desde ARCA, numeración consultada,
  CAE/rechazos, incertidumbre y reconciliación. Ver diseño, QA y pruebas reales en
  [Facturación V3](invoicing-v3-wsfev1.md).
- **V4:** PDF/comprobante fiscal.
- **V5:** producción y hardening.

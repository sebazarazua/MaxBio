# Catálogo de referencia de proveedores

Implementado el 6 de octubre de 2026 dentro del módulo Catalog existente. Evidencia de esta notebook en [verification.md](verification.md), separada de la histórica.

## Invariante y alcance

**SupplierCatalogItem ≠ Product ≠ Inventory.** Una lista declara qué ofrece/identifica el proveedor. Importar escribe referencias, procedencia, observaciones y AuditEvent. No busca Products por similitud ni por GTIN; no crea/modifica Product, ProductIdentifier o SupplierProduct. Una referencia con nombre/código igual al de un producto o vínculo existente sigue sin asociar. No hay tablas nuevas de inventario.

El segundo incremento agrega la relación nullable con SupplierProduct y un recibo durable mediante [identificación explícita](product-identification.md). Product se deriva del vínculo; importar conserva esa relación. No se agregan Product.status ni productVerified.

## Entidades y procedencia

| Entidad                  | Responsabilidad                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SupplierCatalogItem      | Referencia estable por organización/proveedor/código; descripción, marca/presentación declaradas, GTIN informado/normalizado, versión, fechas, archivado y ausencia de última lista completa.        |
| SupplierCatalogImport    | PREVIEW inmutable o COMMITTED; actor/pertenencia/sesión, proveedor, nombre seguro, SHA-256 del contenido, formato/hoja/encabezado, columnas, modalidad, resumen, hashes, vencimiento y confirmación. |
| SupplierCatalogImportRow | Número original de fila, resultado, itemId cuando corresponde, código válido acotado, snapshot de cinco campos elegidos/GTIN normalizado y mensajes.                                                 |
| SupplierCatalogUpload    | Inspección temporal: celdas de texto acotadas para cambiar hoja/columnas sin reenviar el archivo. Nunca se persiste el binario original.                                                             |

Columnas desconocidas existen solamente en el staging temporal; no pasan al historial confirmado ni a auditoría. No se importan precios, costo, IVA, moneda, stock ni condiciones. Snapshots pequeños permiten explicar una fila aunque cambie la referencia. Se conserva el snapshot de duplicados para mostrar qué se ignoró; no se copia la fila completa. Errores con campos inválidos conservan número, código si cabe y mensajes, sin textos excesivos. No hay event sourcing.

## Integridad y tenant

`organizationId` deriva exclusivamente de RequestActorContext. Contratos estrictos rechazan organización/campos extra en body/query/multipart. IDs ajenos/inexistentes dan 404 uniforme. Previews/inspecciones pertenecen al actor y sesión que los prepararon; la historia confirmada se consulta dentro del tenant.

Migración nueva `20261006120000_supplier_catalog`: SQL generado con Prisma Migrate diff contra DB temporal con las tres migraciones previas, revisado y aplicado con migrate deploy. Las migraciones previas no cambian; no se usa db push. `migrate dev --create-only` fue intentado y rechazado por no ser una sesión interactiva.

- Unique `(organizationId,supplierId,supplierCode)` incluye archivados. Case/puntuación significativos; un código no se libera al archivar.
- Unique `(organizationId,supplierId,id)` en items/imports permite FKs de filas con tenant **y proveedor**.
- Items/uploads/imports: FK compuesta a Supplier, FK a Organization, Restrict en actualización/borrado.
- Uploads/imports: FK `(organizationId,membershipId,actorUserId)` a Membership y `(sessionId,actorUserId)` a Session. Se agregan uniques de soporte que incluyen la PK de esos modelos, sin cambiar su identidad empresarial.
- Rows: FK compuesta a import y a item; unique `(organizationId,importId,rowNumber)`.
- CHECKs: código no vacío/trim/sin controles, descripción no vacía/sin controles, versión positiva, GTIN normalizado consistente con checksum SQL existente, formato/hashes/encabezados, status/committedAt y forma básica de JSON/número de fila.

Índices: items por tenant/proveedor/archivo/código/id y GTIN normalizado; imports por tenant/proveedor/fecha/id y tenant/status/vencimiento; uploads por tenant/actor/vencimiento y vencimiento; rows por tenant/import/outcome/fila y tenant/proveedor/item. Uniques también aportan índices. Búsqueda PostgreSQL contains/ILIKE paginada; no se afirma que B-tree acelere `%texto%`. No se agrega Elasticsearch, trigram, full-text, Redis ni infraestructura distribuida. RLS sigue diferido; el owner de DB conserva acceso privilegiado.

## Archivo → preview → confirmación

ADMIN elige archivo; inspect autoriza y valida proveedor, parsea sin transacción comercial, conserva celdas temporales y devuelve hojas, veinte primeras filas, encabezado detectado y sugerencias corregibles. Se elige hoja, encabezado (1–20), cinco columnas diferentes y modalidad. Preview valida/compara fuera de transacción y persiste plan/filas en una transacción breve de staging. No modifica referencias.

UI muestra proveedor, archivo, hoja, columnas, cantidades y filas paginadas. Commit acepta solamente `previewHash` y `excludeInvalidRows`; no acepta archivo ni nuevas filas. Hash canónico (claves ordenadas, estable ante JSONB) incluye proveedor/archivo/hoja/columnas/modalidad, fingerprint del catálogo, resumen y observaciones. Se revalidan datos/hashes antes de abrir la transacción.

Commit revalida ADMIN, usuario, organización, pertenencia y sesión; bloquea Supplier → Import; compara fingerprint de referencias/versiones/indicadores y versión del proveedor. Cualquier cambio desde preview exige nueva revisión (409). Escribe referencias en bloques de 500 mediante SQL parametrizado sobre la unique, verificando id esperado y cantidad aplicada; nunca reasigna un código. Vincula observaciones por IDs en bloques de 500, aplica completitud segura, confirma import y AuditEvent, y elimina staging. **Todo commit o todo rollback.** Parseo no ocurre dentro de la transacción.

Se conservan statement timeout 2 s/query timeout 2,5 s generales; transacción de commit 10 s. Pruebas de 5.000/10.000 detectaron joins lentos por estadísticas aún obsoletas en tablas recién cargadas. Se sustituyeron por claves únicas/IDs resueltos y lotes; no se relajaron límites globales.

Dos imports del mismo proveedor se serializan con lock de Supplier. El segundo preview obsoleto da 409 y la unique sigue defendiendo ante concurrencia. Reconfirmar el mismo preview devuelve su resultado original con un solo evento. No hay retry automático de un plan obsoleto.

## Filas y reimportación

| Situación                           | Resultado                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fila vacía                          | EMPTY, ignorada y contabilizada. XLSX conserva vacías finales explícitas y números reales.           |
| Sin código/descripción              | ERROR humano.                                                                                        |
| Texto excesivo/controles            | ERROR, sin truncar.                                                                                  |
| Código/datos idénticos              | Primera referencia aplicable; siguientes DUPLICATE.                                                  |
| Código/datos contradictorios        | Todas las observaciones del grupo CONFLICT, incluso una variante incompleta; nunca última fila gana. |
| Código archivado                    | CONFLICT; no se restaura/reutiliza automáticamente.                                                  |
| Nueva/existente modificada/idéntica | CREATED / UPDATED / UNCHANGED. Conserva id; cambia versión solo al cambiar datos/indicadores.        |

Código: trim externo, preserva texto, case, puntuación y ceros; nunca Number. Límites: código 128, descripción 1000, marca 160, presentación 200, GTIN 128 caracteres. Opcional no mapeado conserva dato anterior; celda vacía de columna elegida lo borra. Product y asociaciones permanecen intactos.

PARTIAL, default «Actualizar artículos incluidos»: ausentes e indicadores anteriores no cambian. COMPLETE, «Esta es la lista completa»: activos ausentes reciben `missingFromLatestCompleteListAt`, presentes recuperan null. No cambia archivedAt ni elimina historia. Ya ausentes conservan fecha de inicio; cambios del indicador incrementan versión. El resumen informa cuántas quedan ausentes.

Errores/conflictos requieren corregir o excluir explícitamente con `excludeInvalidRows=true`. Una lista completa con cualquiera de esos problemas suprime **todos** los cambios de completitud, también limpiar indicadores, evitando falsas ausencias. Sin referencias válidas no se puede confirmar ni marcar todo ausente.

GTIN: conserva texto trimmeado; normaliza a 14 si cumple longitud/checksum existentes. Inválido conserva reportedGtin, normalizedReportedGtin=null y advertencia. No confirma asignación GS1 ni ProductIdentifier, y nunca reasigna identidad.

## CSV/XLSX y límites

CSV UTF-8 con/sin BOM, comas/punto y coma/tabulación sugeridos por primera línea, comillas estándar, columnas variables y filas vacías; sin casts numéricos. Listas con títulos que utilizan otro separador deben guardarse como CSV uniforme. UTF-16/Windows-1252 no se admiten inicialmente; error pide UTF-8.

XLSX: firma ZIP/OOXML, múltiples hojas elegibles, lexemas numéricos como strings sin IEEE-754. Para ceros iniciales los códigos deben venir almacenados como **Texto** en Excel, como indica la UI: no se reconstruye formato visual/precisión ya perdida por Excel. Fechas son texto ISO sin inferencias comerciales.

ZIP preflight secuencial yauzl valida tamaños declarados/reales, entradas duplicadas/protegidas y paths. SAX decodifica atributos antes de validar coordenadas/dimensiones/filas: también rechaza `A&#49;000000`, prefijos de fórmula y TargetMode externo codificado. DTD, entidades externas, fórmulas, hyperlinks, macros, binarios incrustados/externalLinks se rechazan; no se ejecutan ni se sigue ninguna URL.

| Límite                                     | Valor                                    |
| ------------------------------------------ | ---------------------------------------- |
| Archivo / artículos / columnas             | 10 MiB / 10.000 / 100                    |
| Hojas / encabezado                         | 20 / primeras 20 filas                   |
| Expansión ZIP total / entrada              | 40 MiB / 20 MiB                          |
| Entradas ZIP / profundidad XML / nodos XML | 1000 / 64 / 2.000.000                    |
| Celda antes de mapear / texto total        | 4.000 caracteres / 10.485.760 caracteres |
| Uploads pendientes por actor/tenant / TTL  | 5 / 30 minutos                           |
| Página                                     | 20 default, máximo 100                   |

Proxy JSON sigue en 32 KiB. Upload dedicado `/api/supplier-catalog-upload/:supplierId` POST: auth/ADMIN previo, Origin exacto/header CSRF, query/campos extra rechazados, lectura acotada a 10 MiB + 64 KiB de multipart. Nest vuelve a validar sesión/tenant/CSRF y exige un archivo sin otros campos. No hay proxy genérico. Timeout upload upstream 30 s/cliente 40 s. Errores sin paths/stack/Prisma.

No hay exportación. Cualquier exportación futura deberá escribir texto explícito y neutralizar valores interpretables como fórmula (`=`, `+`, `-`, `@`, controles) antes de habilitarla. Texto/JSON almacenado no ejecuta fórmulas.

## Retención y mantenimiento

Uploads se eliminan al confirmar; vencidos se limpian al inspeccionar otro archivo en el tenant. Previews vencidos se eliminan con filas; confirmados se conservan. `pnpm catalog:cleanup` limpia revisiones vencidas de todas las organizaciones como mantenimiento técnico, sin DELETE HTTP/job/Redis. Ejecutarlo regularmente en el despliegue; TTL invalida acceso aunque falte limpieza física. Se conserva nombre seguro sin path y hash, nunca el binario original.

## Permisos, auditoría, API y UI

ADMIN inspecciona/revisa/confirma importaciones y consulta. OPERATOR busca/abre referencias y consulta historia confirmada. Guard y application exigen ADMIN para importar; commit revalida acceso dentro de la transacción. El workflow separado de identificación admite ambos roles sin ampliar permisos de importación o CRUD general.

AuditService existente: SUPPLIER_CATALOG_IMPORTED, recurso SupplierCatalogImport, actor/session/organization/requestId. Allowlist: supplierId, importId, mode, created, updated, unchanged, ignored, errors, conflicts, missing. No archivo/filas/DTO/texto arbitrario. Fallo de auditoría revierte referencia, ausencias, filas y confirmación.

API bajo `/api/v1`, JSON web con whitelist `/api/catalog`:

| Método | Ruta                                                               |
| ------ | ------------------------------------------------------------------ |
| GET    | /suppliers/:id/catalog-items                                       |
| GET    | /supplier-catalog-items y /supplier-catalog-items/:id              |
| POST   | /suppliers/:id/catalog-imports/inspect (ADMIN, multipart)          |
| POST   | /suppliers/:id/catalog-imports/preview (ADMIN)                     |
| POST   | /supplier-catalog-imports/:id/commit (ADMIN)                       |
| GET    | /supplier-catalog-imports/:id y /supplier-catalog-imports/:id/rows |
| GET    | /suppliers/:id/catalog-imports (historia confirmada)               |

Contratos Zod estrictos en packages/contracts; frontend no comparte Prisma. Rows paginadas con filtro outcome/código. Inspecciones/previews privados al actor/sesión; historia confirmada legible por tenant.

Ficha con Datos/Catálogo, Importar lista solo ADMIN/proveedor activo, búsqueda e historia paginadas. Archivo → Columnas → Revisar/Confirmar → Resultado. `/referencias` busca transversalmente, `/referencias/:id` abre referencia, `/referencias/importaciones/:id` explica resultados. Proveedor/código/descripción y «Sin asociar» o «Asociado · Producto · Ver producto», con filtros Todos/Sin asociar/Asociados globales y por proveedor, sin stock ni propiedad física sugerida. Controles etiquetados, encabezados de tabla, feedback y scroll horizontal local en móvil.

## Dependencias y decisiones diferidas

Revisados registro npm, documentación primaria, mantenimiento, engines/licencia/peso y audit. Cuatro dependencias MIT solamente en API, sin framework de importación:

| Dependencia            | Necesidad y evidencia npm al 6/10/2026                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| read-excel-file 9.3.10 | Lector XLSX especializado; no calcula fórmulas (además se rechazan). Node >=18, 2.474.410 bytes unpacked, actualizado 10/8/2026.                    |
| csv-parse 7.0.3        | CSV real/comillas/BOM/max_record_size. 1.610.302 bytes unpacked, actualizado 25/9/2026, probado Node 22.18.                                         |
| yauzl 3.4.0            | ZIP secuencial/validateEntrySizes antes del lector. Node >=12, 109.901 bytes, actualizado 7/6/2026.                                                 |
| saxen 11.2.0           | Validación XML y atributos decodificados; ya transitoria del lector, declarada por uso directo. Node >=20.12, 163.579 bytes, actualizado 21/9/2026. |

Tipos dev @types/multer 2.3.0 y @types/yauzl 3.4.0; saxen sin tipos publicados requiere declarar la superficie usada en src/types/saxen.d.ts. Pesos unpacked no son bundle web. Audit informó avisos preexistentes de Prisma (deepmerge-ts/mysql2), sin nuevos en parsers; se documentan sin actualizar Prisma fuera de alcance.

Fuentes primarias: [read-excel-file](https://github.com/catamphetamine/read-excel-file), [csv-parse](https://csv.js.org/parse/options/), [yauzl](https://github.com/thejoshwolfe/yauzl), [saxen](https://github.com/nikku/saxen).

Asociación explícita, HID y Product básico desde identificación están implementados en el segundo incremento. Diferidos parser GS1 completo, namespace universal EXTERNAL_BARCODE, Inventory/Stock/Lot/Series/movimientos, documentos y economía. Siguiente paso: probar listas y lectores reales; no se inicia Inventory.

## Asociación confirmada

El menú visible usa **Listas de proveedores**. Búsqueda incluye presentationText. supplierProductId nullable vincula la referencia al Product derivado; FK organización/proveedor/vínculo impide cruces. Reimportar solo cambia declaraciones y conserva esa FK; asociar incrementa versión e invalida previews obsoletos. Estado asociado se conserva aunque vínculo/producto se archive. [Identificación física](product-identification.md) explica el caso de uso ADMIN/OPERATOR y sus reservas/idempotencia.

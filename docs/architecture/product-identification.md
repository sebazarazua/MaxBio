# Identificación física de productos

Segundo incremento de Catalog, 6 de octubre de 2026. **Supplier Catalog → Product Identification → Inventory futuro**. Importar listas escribe declaraciones; identificar confirma identidad comercial. Reconocer un producto no registra entradas ni stock.

## Modelo e integridad

`SupplierCatalogItem.supplierProductId` es nullable. Product se deriva de **SupplierCatalogItem → SupplierProduct → Product**, sin productId duplicado en la referencia. FK PostgreSQL `(organizationId, supplierId, supplierProductId)` contra unique `(organizationId, supplierId, id)` impide cruces de tenant y proveedor. Este workflow no reasigna referencias asociadas.

Migración `20261006180000_catalog_identification`: vínculo, índices, SupplierScanIdentifier y CatalogIdentification. Conserva las cuatro migraciones anteriores, Product y ProductIdentifier, sin estados de verificación ni entidades de inventario.

SupplierProduct conserva unique histórica organización/proveedor/producto. Primer vínculo usa código/descripción de la referencia; uno existente se reutiliza sin reemplazar su código principal. Un vínculo archivado requiere revisión administrativa. Reimportar conserva asociación e identificadores; nunca crea Products ni reconcilia identidad automáticamente. Asociar incrementa reference.version e invalida previews anteriores.

## Namespaces y resolución

| Lectura                  | Tratamiento                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GTIN numérico 8/12/13/14 | Checksum existente obligatorio, canonical14, ProductIdentifier GTIN.                                                                         |
| MB-                      | ProductIdentifier INTERNAL_BARCODE, validación/case existentes.                                                                              |
| Código interno manual    | Namespace INTERNAL_CODE elegido explícitamente, case/puntuación/ceros preservados; no inferido de supplierCode.                              |
| Otro barcode externo     | SupplierScanIdentifier, proveedor explícito, máximo 128 caracteres, trim externo y comparación exacta. Producto derivado de SupplierProduct. |
| GS1 compuesto detectable | UNSUPPORTED; ingresar solo el GTIN visible. No se persiste la lectura compuesta.                                                             |

AUTO nunca convierte un checksum GTIN inválido en código externo. PostgreSQL también rechaza GTIN/MB- dentro de SupplierScanIdentifier, controles y compuestos detectables. INTERNAL_CODE es declaración manual de un namespace propio; no se usa automáticamente para rescatar barcodes inválidos.

No hay evidencia de un namespace universal EXTERNAL_BARCODE: unique histórica externa es organización/proveedor/valor. Dos proveedores pueden usar el mismo texto para Products diferentes. Sin proveedor, código externo registrado devuelve AMBIGUOUS y pide contexto, incluso si hoy coincide en uno solo. Código nuevo sin contexto devuelve UNKNOWN pero no permite confirmar. Reserva archivada de identificador/vínculo/proveedor/producto no se recicla.

Detección GS1 acotada: AIs parentizados 01/10/17/21, prefijos AIM `]C1`, `]d2`, `]Q3`, ASCII 29 y patrón 01 + GTIN14 + AI 10/17/21. No parser GS1 completo, validación de asignación oficial ni inferencia de empaque. Parser de identidad separado permite incorporar datos físicos en un futuro dominio Inventory.

## Endpoints y contratos

Sesión, organización activa, CSRF y Zod strict compartidos. API bajo `/api/v1`; web bajo `/api/catalog`.

| Endpoint                                    | Contrato/comportamiento                                                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /catalog-scans/resolve                 | value, namespace AUTO/INTERNAL_CODE (default AUTO), supplierId opcional. Sin escrituras comerciales ni auditoría de negocio.                                         |
| POST /catalog-identifications/confirm       | operationId UUID, scan, referenceId/expectedReferenceVersion, target EXISTING (productId/expectedProductVersion) o NEW (nombre/unidad/presentación/marca/categoría). |
| GET /products/:id/supplier-scan-identifiers | Códigos externos, proveedor, archivos, búsqueda y paginación.                                                                                                        |
| GET /supplier-catalog-items                 | Código/descripción/marca/presentación/GTIN/proveedor; association ALL/UNASSOCIATED/ASSOCIATED, supplierId y paginación.                                              |
| GET /suppliers/:id/catalog-items            | Los mismos filtros dentro de un proveedor.                                                                                                                           |

Resolve distingue **KNOWN, UNKNOWN, CANDIDATES, ARCHIVED, AMBIGUOUS, INVALID, UNSUPPORTED** mediante respuestas 200 tipadas. Parámetros inválidos 400, supplierId ajeno 404, sesión/CSRF 401/403. KNOWN muestra Product; ARCHIVED informa reserva y bloquea reutilización. Coincidencia exacta normalizedReportedGtin sugiere hasta 20 candidatos y total; la búsqueda paginada permite continuar. supplierCode externo exacto sugiere dentro del proveedor. Candidato sigue siendo declaración y requiere confirmación humana.

Comparación usa endpoints de Products existentes: nombre, marca, modelo, presentación, códigos internos y primeros diez identificadores; ficha completa paginada. Product manual usa el mismo modelo y puede adquirir después identifier/vínculo/referencia.

## Permisos, atomicidad y concurrencia

ADMIN y OPERATOR ejecutan este workflow. CRUD general conserva @Roles ADMIN: edición/archivo/alta general de Product, proveedores, marcas/categorías, identificadores generales e importaciones. NEW admite solo formulario básico; brandText ayuda a elegir Brand existente, sin altas automáticas. UNIT es default visible/editable; descripción de más de 200 caracteres requiere nombre humano, sin truncamiento.

Confirmación revalida usuario/organización/pertenencia/rol/sesión dentro de transacción; clasificaciones activas del tenant. Referencia asociada a P solo admite EXISTING con P. Locks: operación → namespace/identificador → Product existente (o clasificaciones NEW) → Supplier → referencia → SupplierProduct. Compatible con Product → Supplier del CRUD y Supplier → Import de listas. Se revalidan versiones/archivados después del lock; Product version también aumenta para proteger formularios generales.

Una transacción persiste Product nuevo cuando corresponda, identificador, SupplierProduct creado/reutilizado, referencia, auditoría y recibo. Un conflicto/constraint/carrera da 409 humano; falla de auditoría revierte todo, sin Products huérfanos. Unique/FK son defensa final. Otros errores conservan sanitización global.

CatalogIdentification: operationId única por organización, hash SHA-256 del comando validado, actor/pertenencia/sesión y referencia/vínculo con FKs scoped. No guarda DTO ni código leído. Igual clave/actor/payload retorna el mismo confirmationId sin repetir efectos/eventos, incluso con versiones ahora modificadas. Otra carga/actor con esa clave da 409. Replay devuelve ficha actual del Product vinculado, sin snapshot descriptivo histórico. Recibos no expiran automáticamente: eliminarlos permitiría repetir efectos. Cambiar datos requiere clave nueva; UI conserva clave para retry tras respuesta incierta.

Eventos aplicables: **PRODUCT_CREATED_FROM_IDENTIFICATION**, **PRODUCT_IDENTIFIER_ADDED_FROM_IDENTIFICATION**, **CATALOG_REFERENCE_ASSOCIATED**. Contexto confiable fija actor/tenant/sesión/requestId/recurso; metadata vacía allowlisted, sin DTO, lecturas ni texto externo. Externos usan resourceType SupplierScanIdentifier. Reutilizar registros no emite falsas creaciones.

## Uso HID y verificación manual

Abrir **Identificar producto**. USB/Bluetooth keyboard wedge escribe sobre input enfocado y termina con Enter; ingreso manual equivalente. AUTO para scanner, INTERNAL_CODE para código propio manual. No SDK, cámara ni captura global de teclado.

Código conocido: resultado inmediato e input seleccionado para siguiente BEEP. Desconocido: conservar lectura, buscar referencia, comparar Products, elegir uno o **Es un producto nuevo**, revisar y confirmar explícitamente. Referencia asociada muestra P y permite agregar identidad a P. Se vuelve al foco al terminar. **Siguiente lectura** descarta selección pendiente y se bloquea durante confirmación.

Cambiar lectura/namespace/proveedor invalida resultado anterior. Durante asociación, lectura readOnly y opciones bloqueadas. Ref síncrono evita doble submit antes del rerender. Enter en búsqueda no dispara scanner. Controles nativos, foco local, aria-live, viewport móvil sin overflow de página. Listas muestran Sin asociar o Asociado · Producto · Ver producto, conservando asociación histórica de vínculos archivados, con filtros globales y por proveedor.

Procedimiento: ADMIN importa CSV DL2115 y comprueba cero Products nuevos. OPERATOR ingresa GTIN desconocido + Enter, busca DL2115, compara, crea Product con unidad elegida, revisa y confirma. Repetir código: KNOWN. Verificar lista ASSOCIATED y Product/Identifier/SupplierProduct/eventos. GTIN informado sigue siendo declaración: si difiere del leído, la UI pide verificar que sea el mismo producto antes de confirmar.

## Límites y siguiente paso

Prueba actual: teclado simulando HID, sin hardware físico. Validar layout, terminador/prefijos y velocidad con lectores reales de Theo/Nutria. Diferidos cámara, parser GS1 completo, impresión/administración de códigos externos, liberación/reasignación especial y matching difuso automático. Reservas externas archivadas requieren un incremento administrativo explícito; no se reciclan.

No Inventory/Stock/movimientos/lotes/series/vencimientos/ubicaciones/reservas/FEFO ni Remitos. Próximo paso recomendado: probar usuarios/lectores/referencias reales y acordar unidades/conversiones y recepción/movimientos para un incremento separado. Esta entrega se detiene en identificación.

# Catálogo V1

Extensión del 6 de octubre de 2026: [Catálogo de referencia de proveedores](supplier-catalog.md). Las listas importadas crean referencias independientes; no Products, identificadores ni SupplierProducts.

Implementación: 5 de octubre de 2026. Primer flujo comercial del monolito existente. Catálogo responde «qué producto es» y cómo lo ofrecen los proveedores. No contiene existencias, movimientos ni una fuente de verdad económica.

## Modelo

Las seis entidades tienen UUID v4, organizationId y fechas UTC createdAt/updatedAt/archivedAt. Product, Supplier, SupplierProduct, Brand y Category tienen version positiva, inicial 1. ProductIdentifier utiliza la versión del producto como agregado.

| Entidad           | Datos y responsabilidad                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product           | name (200), description opcional (4000), presentation opcional (200), unitOfMeasure obligatorio, model/manufacturerName opcionales (160), brandId/categoryId opcionales |
| ProductIdentifier | productId, kind, value y normalizedValue (128); múltiples por producto; sin cambio de titular ni edición de valor en V1                                                 |
| Supplier          | name (200), legalName (200), contactName (160), email (254), phone (50); datos complementarios opcionales                                                               |
| SupplierProduct   | productId, supplierId, supplierCode opcional (128), supplierDescription opcional (1000); representa una oferta/identificación comercial                                 |
| Brand             | name/normalizedName (160); clasificación plana propia de la organización                                                                                                |
| Category          | name/normalizedName (160); clasificación plana, sin árbol ni atributos dinámicos                                                                                        |

El nombre no identifica al producto ni es único. Código interno vive únicamente en ProductIdentifier; el resumen público muestra hasta tres códigos internos activos, y el endpoint paginado muestra todos. No se duplican columnas Product.internalCode.

unitOfMeasure: UNIT, PAIR, METER, CENTIMETER, LITER, MILLILITER, KILOGRAM, GRAM. presentation es texto comercial, por ejemplo «Caja x 100 unidades» o «Rollo de 3 metros». No se infieren cantidades ni conversiones entre empaque y medida. Esa política se define con Inventory/Purchases. manufacturerName es texto, sin entidad Manufacturer prematura.

## Tenant y permisos

Cada caso de uso recibe RequestActorContext. organizationId proviene exclusivamente de la sesión/pertenencia activa. No se acepta en cuerpos, filtros ni headers como autoridad; los contratos rechazan campos extra. Las consultas, escrituras y locks expresan el scope. Recursos ajenos/inexistentes dan 404, incluso asociaciones.

Los guards globales existentes validan sesión y tenant. Todas las mutaciones usan Roles(ADMIN); la aplicación también exige ADMIN y revalida acceso/sesión dentro de la transacción. OPERATOR consulta las seis entidades, sin mutaciones estructurales. La web centraliza la política mediante useWorkspace y oculta las acciones. Un 401/403 comercial dispara revalidación de identidad; el contenido de tenant se desmonta cuando se pierde acceso o cambia organización.

## Identificadores y normalización

Las reglas son funciones puras en domain/identifiers.ts, independientes de Nest/Prisma.

| Tipo             | Entrada y representación                                                                                                                                                                   | Comparación                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| GTIN             | Solo 8, 12, 13 o 14 dígitos ASCII. Valida dígito de control módulo 10, alternando pesos 3/1 desde la derecha del cuerpo. Conserva longitud/ceros de value; sin quitar separadores internos | normalizedValue agrega ceros a la izquierda hasta 14 dígitos. UPC/EAN equivalentes resuelven el mismo producto |
| INTERNAL_CODE    | Trim externo; conserva case, ceros, espacios internos y puntuación; no acepta controles ni vacío                                                                                           | Exacta, sensible a mayúsculas                                                                                  |
| INTERNAL_BARCODE | Namespace explícito MB-, seguido de 1–61 caracteres ASCII permitidos. Primer carácter alfanumérico; restantes A–Z, 0–9, punto, guion, guion bajo                                           | Exacta; no convierte a mayúsculas ni genera/imprime etiquetas                                                  |

Unicidad (organizationId, kind, normalizedValue) incluye archivados. Archivar producto/identificador nunca libera el código ni lo reasigna. Restaurar recupera la asociación original. Una corrección de titular futura necesitaría un caso de uso específico y auditado; no existe ahora. La resolución tipada acepta kind/value manuales, sin scanner, cámara ni parser GS1.

Referencia primaria de normalización: [GS1 sobre representación GTIN de 14 dígitos](https://support.gs1.org/support/solutions/articles/43000734355-what-is-the-required-format-of-gtin-in-gs1-edi-standards-) y [cálculo del dígito de control](https://www.gs1.org/services/how-calculate-check-digit-manually). Esta validación comprueba formato/checksum, no consulta registro de asignaciones GS1.

Brand/Category trimmean y colapsan espacios; comparan nombre normalizado en minúsculas conservando tildes. «Marca Médica» y «marca médica» son el mismo nombre, pero «Médica» y «Medica» siguen distintos. Los nombres archivados también quedan reservados.

## Integridad, migración e índices

Migración real nueva: 20261005185022_catalog. Las dos anteriores permanecen intactas. Se generó con migrate dev --create-only, se revisó SQL y se incorporaron CHECKs antes de aplicarla. No se utilizó db push ni se editaron migraciones aplicadas. Se aplicó a la base existente y se verificó la cadena completa en una base temporal vacía.

- Cada tabla comercial referencia Organization con Restrict.
- Unique (organizationId,id) en Product, Supplier, Brand y Category permite FKs compuestas.
- Product → Brand/Category, Identifier → Product, SupplierProduct → Product/Supplier usan (organizationId, recursoId); PostgreSQL rechaza referencias entre tenants.
- Unique (organizationId,supplierId,productId) conserva un solo vínculo histórico. Para volver a asociar se restaura el vínculo.
- Unique (organizationId,supplierId,supplierCode) reserva un código por proveedor incluyendo vínculos archivados. NULL permite múltiples ofertas sin código. Código trimmeado, comparación exacta; proveedores distintos pueden usar el mismo código.
- 12 CHECKs: nombres básicos no vacíos, versiones positivas, códigos no vacíos/trim, nombres auxiliares normalizados y reglas de identificadores. Función SQL immutable maxbio_valid_gtin refuerza checksum y representación normalizada.
- Restrict en update/delete de relaciones conserva referencias. No hay DELETE comercial. El owner de DB conserva capacidad de bypass mediante cambios directos; no se afirma RLS ni auditoría automática de SQL externo.

Índices de listados: (organizationId,archivedAt,name,id) para Product/Supplier/Brand/Category. Product incorpora índices (organizationId,brandId) y (organizationId,categoryId). Identifier incorpora (organizationId,productId,archivedAt), además de unique de resolución. SupplierProduct incorpora (organizationId,productId,archivedAt) y (organizationId,supplierCode), además de sus unique. Son índices de scope/relación/orden y resolución exacta; no aceleran arbitrariamente ILIKE '%texto%'. No se agregan trigram/full-text antes de medir volumen real.

## Concurrencia, transacciones e historia

PATCH, archive y restore exigen expectedVersion. Las entidades existentes se leen con scope y lock FOR UPDATE; se verifica la versión y se incrementa con el cambio. Dos ediciones de la misma versión tienen un único ganador; la otra devuelve 409 humano y conserva los datos guardados. Los locks de vínculos siguen Product → Supplier, para serializar cambios con archivado de padres.

Agregar/archivar/restaurar identificadores y crear vínculos exige la versión del producto. Editar/archivar/restaurar vínculos exige su propia versión y también incrementa la del producto. No se renumeran registros por simple lectura. Repetir una transición al estado actual con versión vigente no crea un nuevo evento. Una transición con versión vieja sí es conflicto.

Product y sus identificadores iniciales se crean en una sola transacción. Código inválido/duplicado o fallo de auditoría revierte producto, identificadores y eventos. La UI no divide el alta en requests susceptibles a dejar un producto parcial.

Archivar padres no modifica en cascada los hijos: se conserva su estado explícito. Vínculos activos se muestran por defecto solo si ambos padres están activos. Restaurar padres vuelve a mostrar los vínculos que no fueron archivados explícitamente. Marcas/categorías archivadas permanecen en productos existentes; se pueden conservar al editar otros campos, pero no asignarlas a otro producto. No hay borrado ni liberación implícita de unique.

Remitos, compras y facturas futuros deberán guardar productId y snapshots relevantes (nombre, código, descripción/presentación cuando corresponda) en sus líneas. Cambiar el catálogo no debe alterar el texto de un documento histórico. No se crean esas tablas ahora.

## Auditoría

AuditService existente recibe RequestActorContext y TransactionClient. Éxito comercial y evento se confirman juntos. Metadata comercial es {}, allowlist deliberadamente vacía: recurso/acción/actor/sesión/tenant/requestId bastan para V1. No se copia DTO, contactos ni códigos a metadata.

Eventos: PRODUCT_CREATED/UPDATED/ARCHIVED/RESTORED; PRODUCT_IDENTIFIER_ADDED/ARCHIVED/RESTORED; SUPPLIER_CREATED/UPDATED/ARCHIVED/RESTORED; SUPPLIER_PRODUCT_LINKED/UPDATED/ARCHIVED/RESTORED; BRAND_CREATED/UPDATED/ARCHIVED/RESTORED; CATEGORY_CREATED/UPDATED/ARCHIVED/RESTORED. Auditoría es semántica, sin endpoint de edición/borrado ni visor nuevo.

## API y contratos

Prefijo Nest: /api/v1. Proxy del mismo origen: /api/catalog. Contratos Zod estrictos compartidos para entradas, filtros, resultados y errores; respuestas sin organizationId ni modelos de persistencia.

| Rutas relativas                                                 | Métodos                                                                       |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| products, suppliers                                             | GET listado, POST alta                                                        |
| products/:id, suppliers/:id                                     | GET ficha, PATCH modificación                                                 |
| products/:id/archive o restore; suppliers/:id/archive o restore | POST con expectedVersion                                                      |
| brands, categories                                              | GET listado, POST alta                                                        |
| brands/:id, categories/:id                                      | PATCH nombre                                                                  |
| brands/:id/archive o restore; categories/:id/archive o restore  | POST con expectedVersion                                                      |
| products/:id/identifiers                                        | GET paginado, POST alta con expectedVersion del producto                      |
| products/:id/identifiers/:identifierId/archive o restore        | POST con expectedVersion del producto                                         |
| product-identifiers/resolve                                     | GET con kind/value; resuelve solo identificador y producto activos del tenant |
| products/:id/supplier-products                                  | GET paginado, POST asociación con supplierId y expectedVersion del producto   |
| suppliers/:id/supplier-products                                 | GET paginado                                                                  |
| supplier-products/:id                                           | PATCH datos de oferta con expectedVersion del vínculo                         |
| supplier-products/:id/archive o restore                         | POST con expectedVersion del vínculo                                          |

Listados: q (hasta 128), page (1–10000, default 1), limit (1–100, default 20), includeArchived ('true'/'false', default false). Products agrega brandId/categoryId/supplierId UUID. Respuesta items,total,page,limit. Orden estable nombre/id; asociaciones por fecha/id. Lectura de filas y total bajo RepeatableRead.

Búsqueda PostgreSQL ILIKE por nombre/modelo/fabricante/marca, identificadores, códigos de proveedor; además GTIN válido se compara canónicamente. La búsqueda es tolerante a case; la resolución de internos es exacta. q no es un selector de tenant. No hay catálogo ilimitado ni includes de asociaciones ilimitadas.

El proxy limita rutas y métodos explícitos, rechaza query duplicada/extra, valida cuerpos de máximo 32 KiB, exige Origin exacto/header CSRF y usa timeout/no-store. Solo transporta la cookie de sesión, nunca headers de identidad del cliente. La URL privada queda en servidor Next. Errores 400/401/403/404/409/500/503 son sanitizados. No es un proxy genérico.

## Pantallas y alcance

Inicio, productos/listado/alta/ficha/edición y proveedores/listado/alta/ficha/edición. Navegación solo a módulos reales. Marcas/categorías tienen alta dentro de Product y administración secundaria en /catalogo. Las fichas permiten paginar, agregar, archivar y restaurar identificadores/asociaciones; editar códigos/descripciones de proveedor. Los proveedores muestran productos y enlace a la ficha donde se administra la relación.

Formularios cortos con detalles progresivos, etiquetas, controles de 44–48 px, foco visible y estados vacíos/carga/reintento. Búsqueda con debounce de 300 ms y cancelación de requests obsoletos. Selectores paginados con búsqueda, sin descargar catálogos completos. Archivado pide confirmación visible. En un conflicto de formulario existente, la recarga es explícita y descarta el borrador; nunca se reintenta una versión vieja automáticamente.

Sin nuevas dependencias de aplicación. Se reutilizan Next/React, Nest, Prisma/PostgreSQL, Zod, Audit e Identity. El navegador de verificación se ejecutó desde caché npm fuera del proyecto.

Diferidos: inventario y conversiones, scanner/GS1, documentos, datos fiscales/CUIT/cuentas bancarias, Manufacturer estructurado, costos/precios/compras, jerarquías de categoría, atributos dinámicos, reasignación especial de identificadores, visor de auditoría, RLS y despliegue productivo. No se incorporan tablas ni placeholders de esos dominios.

## Validación y límites

Pruebas nuevas: 6 sin DB y 24 de integración HTTP/PostgreSQL, más regresión Identity/seguridad. Cubren normalización, contratos, whitelist del proxy, tenant, roles, FK/CHECK/unique, archivado, reserva de códigos, paginación, concurrencia simultánea y rollback por fallo de auditoría. Resultados y evidencia real de navegador en [verification.md](verification.md).

La UI usa offsets, no cursores; páginas pueden variar entre requests si se modifica el catálogo. ILIKE no elimina tildes y no tiene búsqueda difusa. Namespace MB- requiere carga manual y no genera etiquetas. Los contactos son V1, sin validación telefónica/fiscal específica. Auditoría identifica cambios pero no guarda versiones completas de cada campo. Las revisiones responsive/teclado son básicas, sin afirmar WCAG completo o carga productiva.

Prisma/adapter-pg emite una advertencia de deprecación de queries concurrentes con relaciones durante las pruebas; pg actual sigue soportándolas y los tests pasan. No se modifica ni actualiza el driver en esta entrega. Los listados ejecutan filas y total secuencialmente dentro de la misma transacción.

Los skills Prisma en packages/database/.agents son la fuente; .claude/skills y .windsurf/skills contienen junctions Windows hacia esa misma fuente, no copias independientes. Se conservaron. No se recomienda borrar la fuente como limpieza de duplicados; cualquier retiro de aliases de herramientas que ya no se usen pertenece a otra tarea. No se realizaron commits/push. Próximo paso: validar el flujo con usuarios y un catálogo real; definir unidades/movimientos antes de comenzar Inventory en una tarea posterior.

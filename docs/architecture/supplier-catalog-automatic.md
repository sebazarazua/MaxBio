# Importador automático y códigos propios de referencias

Implementación vigente sobre `c761333` (Importador V2), revisada el 7/10/2026. El [reporte de verificación](supplier-catalog-automatic-verification.md) registra comandos, aceptación local y límites. Los documentos V1/V2 anteriores conservan la explicación histórica del mapper y de los precios de mayor precisión.

El incremento de pulido sobre `ac41a006` amplía encabezados equivalentes, compacta la previa y corrige el orden después de Z; su [reporte](supplier-catalog-polish-verification.md) registra la verificación actual.

## Flujo y modelo fijo

Proveedor → Importar lista → archivo CSV/XLSX → Analizar → vista previa normalizada → Confirmar. ADMIN importa; OPERATOR consulta. El formulario no pide columnas, hoja, encabezado, separadores, campos ignorados, confirmación de ARS ni guardado de perfiles. La previa es obligatoria. «Detalles de análisis» es información ADMIN de solo lectura. «Opciones de lista» permite cambiar moneda por defecto o modalidad parcial/completa y volver a revisar la previa.

| Campo                                                   | Significado y ausencia                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------ |
| internalReferenceCode                                   | Código propio; «Nueva referencia» en previa y obligatorio al persistir         |
| supplierId / supplier                                   | Proveedor y catálogo lógico, obligatorios                                      |
| supplierCode / alternateSupplierCode                    | Códigos declarados externos, nullable; case, ceros y puntuación significativos |
| description                                             | Descripción declarada, nullable                                                |
| brandText / manufacturerText / modelText / categoryText | Marca, fabricante/laboratorio, modelo y categoría declarados, nullable         |
| presentationText / unitText                             | Presentación y unidad declaradas como texto, nullable                          |
| reportedGtin / normalizedReportedGtin                   | Texto original y GTIN válido normalizado a 14 dígitos, nullable                |
| price                                                   | Precio comercial no negativo, techo a dos decimales, nullable                  |
| currency                                                | Declaración explícita o default operacional ARS                                |
| vatRate                                                 | Tasa declarada entre 0 y 100, nullable                                         |
| priceIncludesVat                                        | YES / NO / UNKNOWN; default UNKNOWN                                            |

La UI muestra «—» para datos no informados. No inventa descripciones, marcas ni IVA del 21%. `unitText` no determina Product.unitOfMeasure. Se conservan versión, archivado, ausencias, historia y el vínculo opcional con SupplierProduct.

La tabla principal tiene ocho columnas fijas: fila, código MaxBio, código proveedor, descripción, marca, precio, IVA y resultado. «Ver detalles» por fila conserva código alternativo, fabricante, modelo, categoría, presentación, unidad, GTIN original/normalizado, moneda e inclusión de IVA. Los mensajes permanecen fuera del desplegable; errores/conflictos muestran detalles abiertos. Se aplica también al historial/resultado confirmado.

Una fila necesita descripción, código del proveedor o GTIN válido. Admite descripción sin código y código sin descripción cuando el encabezado identifica el campo. Precio solo no es un artículo. Encabezados repetidos, totales y notas comerciales explícitas se ignoran con constancia; las filas inválidas conservan errores.

## Detección y perfiles

Se mantiene SupplierCatalogExtractor → IntermediateTable, con lectores CSV/XLSX acotados y analizadores separados del dominio. No hay PDF, OCR, LLM ni dependencia de Mercado Médico. Los aliases son genéricos: CODIGO/SKU/ART/REF; DESCRIPCION/PRODUCTO/NOMBRE; FABRICANTE/LABORATORIO/MANUFACTURER; MODELO/MODEL; CATEGORIA/RUBRO/FAMILIA; UNIDAD/U.M./UNIDAD DE MEDIDA y campos comerciales.

Los aliases exactos existentes se conservan. Encabezados largos se interpretan por palabras completas, tildes/puntuación/espacios normalizados, artículos DE/DEL/LA/EL y abreviaturas controladas COD/ART/REF/NRO/NUM. Una gramática limitada reconoce conceptos y calificadores de producto, proveedor, lista, unitario, medida e IVA. No acepta calificadores desconocidos, substrings ni similitud. Columnas numeradas también compiten por el mismo campo; ninguna se elige arbitrariamente. Fingerprint v3 y comparación contra detección fresca siguen vigentes.

Se analizan todas las hojas y hasta veinte encabezados posibles, datos posteriores y estructuras competidoras. Un encabezado explícito y único identifica la columna; celdas inválidas se validan por fila, especialmente precios negativos. Campos ambiguos quedan sin informar y generan advertencias. Sugerencias basadas solamente en contenido permanecen REVIEW y no se importan automáticamente. Se exige evidencia HIGH de código, descripción o GTIN. Hojas/tablas competidoras sin elección inequívoca producen «No pudimos interpretar esta lista con suficiente seguridad.»

Perfiles limitados y aislados por tenant/proveedor se guardan automáticamente al confirmar. El fingerprint v3 contempla orden, nombres normalizados y ancho del encabezado. El perfil debe coincidir también con el mapeo nuevamente detectado; no impone una interpretación vieja. V3 evita reutilizar formatos V2 aprendidos mediante configuración manual. El endpoint de reset ADMIN permanece disponible para mantenimiento; no es parte del trabajo cotidiano.

`POST suppliers/:id/catalog-imports/analyze` conserva análisis ADMIN con sheet/headerRow explícitos como diagnóstico técnico de solo lectura. No genera el commit ni es dependencia de la UX: el flujo operativo usa inspect → preview automático → commit.

## Código propio, secuencia y concurrencia

Cada catálogo tiene un prefijo reservado dentro del tenant: A…Z, AA…AZ, BA… y sucesivos. Se asigna al confirmar la primera referencia, sin configuración. catalogNextSequence empieza en 1, pertenece al Supplier y continúa entre archivos. El código concatena prefijo y seis dígitos: A000001, A000002, M000143.

La primera asignación de prefijo usa lock de Organization; los catálogos establecidos serializan sus secuencias independientemente con Supplier. Luego se bloquea Import. Asignación, escritura por lotes, vínculos de filas, perfiles, auditoría y confirmación comparten transacción. Un rollback no consume números ni prefijos. Dos previas concurrentes del mismo catálogo tienen un ganador; la otra recibe 409 por obsolescencia y debe revisarse de nuevo. Doble submit del mismo import es idempotente.

El código permanece estable aunque cambien precio, descripción o código externo. Archivados conservan códigos y prefijos. El límite explícito es 999.999 referencias por catálogo; agotarlo da error de negocio antes de escribir. No se implementó personalización administrativa del prefijo.

internalReferenceCode no es Product UUID, ProductIdentifier, GTIN, código del proveedor ni barcode MB-. Buscarlo permite seleccionar la referencia; importar nunca lo registra como identificador físico.

## Matching, historia y completitud

Se prueban en orden: código externo exacto, GTIN válido normalizado exacto, alternativo exacto y huella descriptiva exacta restringida. La huella incluye descripción, marca, fabricante, modelo, categoría, presentación y unidad; exige descripción de al menos ocho caracteres y ambas referencias sin código externo. No hay similitud ni unificación difusa de nombres.

Los índices conservan todos los candidatos. Múltiples candidatos, evidencias fuertes que apuntan a referencias distintas, GTIN válido distinto del previamente declarado, archivados o variantes contradictorias producen CONFLICT. Un GTIN/alternativo inequívoco permite actualizar el código externo conservando identidad y asociación. Sin evidencia para unir, se crea una referencia independiente.

Duplicados idénticos se contabilizan y enlazan a la misma referencia. Los opcionales no reconocidos conservan el dato anterior cuando se encuentra una referencia inequívoca; una celda vacía en columna reconocida declara null. PARTIAL conserva ausentes; COMPLETE marca ausencia por IDs persistentes, no por códigos externos nullable. Errores/conflictos suprimen todos los cambios de completitud. No se archiva ni elimina automáticamente.

## Precios, moneda e IVA

La normalización conserva strings del lector. ceilingPrice usa enteros BigInt de centavos y los dígitos descartados. No usa Number/Float/Math.ceil sobre dinero. 100 → 100.00; 100.1 → 100.10; 100.101 → 100.11; 100.119 → 100.12; 218505.11669999998 → 218505.12. Negativos y valores fuera del rango son errores. Persistencia Decimal(17,2); contratos/snapshots con exactamente dos decimales. La UI formatea strings: `$ 100,00`, `$ 218.505,12`, sin convertir dinero a Float.

La moneda explícita de columna o prefijo ARS/USD/EUR/US$ prevalece sobre el default; también se detectan declaraciones inequívocas en encabezado/preambulo. Sin declaración, ARS se aplica sin confirmación. La opción ADMIN cambia el default, no una moneda explícita por fila. No hay conversión de monedas.

IVA se interpreta únicamente si está declarado. XLSX porcentual convierte fracción a tasa mediante strings. «Con IVA»/«sin IVA» claros determinan YES/NO; ausencia o contradicción mantiene UNKNOWN. No se completa una tasa ni se exige responder sobre inclusión.

## Migraciones y restricciones

Se agregan 20261007170000_catalog_automatic_references, 20261007171000_catalog_search_indexes y 20261007172000_catalog_reference_prefix_index. No se modifican V2 ni migraciones previas; aplicación con Prisma Migrate, sin db push. La última ajusta la clase del índice a varchar_pattern_ops; Prisma no introspecta las clases B-tree y el SQL de la migración conserva ese detalle.

El pulido agrega `20261007220000_catalog_prefix_order`: `Supplier.catalogPrefixLength`, derivado de char_length(catalogPrefix), backfill, trigger, CHECK e índice tenant/longitud/prefijo. El dato permanece privado y no modifica identidad ni asignación. Se evaluó ordenar por expresión SQL sin persistirlo; Prisma orderBy no permite esa expresión. Un entero derivado por proveedor permite mantener intactos los filtros ORM, búsqueda y paginación, en vez de duplicarlos en una consulta SQL especial o ordenar referencias descargadas.

El backfill reserva prefijos ordenando proveedores con referencias por createdAt/id dentro del tenant; numera referencias por createdAt/id dentro del catálogo, incluidos archivados. Conserva UUIDs, relaciones e historia. Precios actuales/históricos usan ceil(numeric*100)/100 antes de reducir precisión. Snapshots reciben opcionales nullable y, cuando están enlazados, el código propio. Previews antiguos vencen porque cambió su interpretación firmada; imports confirmados mantienen procedencia/vínculo.

Uniques: tenant/prefijo, tenant/código propio, tenant/proveedor/secuencia y la existente tenant/proveedor/código externo. PostgreSQL admite múltiples códigos externos null y protege los no null, incluidos archivados. CHECKs imponen secuencia positiva/rango/formato y evidencia de artículo. Triggers protegen identidad, coherencia prefijo/secuencia/código y contador que no retrocede. FKs compuestas y CHECKs comerciales/textuales existentes siguen vigentes.

## Búsquedas, índices y cliente

La auditoría encontró frases continuas OR por campos en Products, Suppliers, referencias, Stock y vínculos. Fallaban para «corta walker» y para palabras repartidas entre campos. useResource ocultaba datos al cambiar query.

Ahora cada token coincide en algún campo (AND de tokens, OR de campos), sin exigir orden. PostgreSQL filtra/pagina; no se descargan miles de filas para filtrar en JavaScript. Products conserva identificadores/GTIN/códigos de proveedor y agrega nombre, fabricante, modelo, presentación, marca, categoría y proveedor. Stock mantiene producto, identificador, lote y serie. Referencias incluyen todos los textos canónicos, ambos códigos externos, GTIN y proveedor. Selectores y vínculos reutilizan las reglas.

unaccent genera documentos de búsqueda en escrituras de Supplier/Product/SupplierCatalogItem. Triggers refrescan referencias al renombrar Supplier y Products al renombrar Brand/Category; los documentos no se devuelven en contratos públicos. pg_trgm agrega GIN para LIKE/ILIKE, sin usar similitud para unir referencias. Ambas extensiones se crean mediante migración, sin configurar diccionarios globales. Documentación oficial: [unaccent](https://www.postgresql.org/docs/17/unaccent.html), [pg_trgm](https://www.postgresql.org/docs/17/pgtrgm.html).

Código propio tiene unique tenant/code y B-tree varchar_pattern_ops para prefijos. Búsquedas reconocen exacto/prefijo con startsWith y conservan otras coincidencias del documento. Sort tiene allowlist CODE/SUPPLIER/DESCRIPTION/PRICE y asc/desc, con desempates estables; default global por código y dentro del proveedor por secuencia. Nulls de precio/descripción al final. El filtro global ofrece Todos/proveedor mediante selector buscable/paginado.

CODE global ordena en DB por longitud de prefijo, prefijo y referenceSequence, con ID como desempate: A…Z, AA…AB. Descendente invierte esos tres criterios. PRICE/DESCRIPTION/SUPPLIER usan el mismo orden lógico ascendente para desempatar. Dentro del proveedor se conserva orden por secuencia. No se cambia ni reasigna ningún código.

useSearch mantiene debounce de 300 ms y reinicia página al cambiar consulta/filtro. useResource aborta anteriores y rechaza respuestas obsoletas; conserva datos solo dentro del mismo recurso mientras actualiza filtros/páginas, sin mostrarlos al cambiar de ficha. Workspace remonta por tenant. Actualización discreta, sin botón Buscar obligatorio.

## Seguridad y dominios

Se conservan límites de archivo/ZIP/filas/columnas/celdas/hojas/profundidad XML/TTL; preflight ZIP, rechazo de macros, binarios embebidos, DTD y XXE; validación de paths y resultados de fórmulas guardados. Nunca se calculan fórmulas ni se siguen enlaces. Columnas no reconocidas existen solamente en staging temporal; no se guarda/versiona el original.

ADMIN se revalida en application/transacción; OPERATOR consulta. CSRF, sesión, actor, tenant, hashes, atomicidad, auditoría e idempotencia se preservan. Importar escribe cero Products, ProductIdentifiers, SupplierProducts, InventoryMovements e InventoryBalances. Identificación física exige selección y confirmación explícita; Inventory conserva ledger, unidades y políticas. No se agregan módulos comerciales ni servicios externos.

## Pruebas y límites

Unitarias: layouts fijos, nulabilidad, aliases, precios, monedas, IVA, perfiles, matching, fórmulas y seguridad. Integración: listas masivas, namespaces, secuencias/concurrencia/archivados, contratos, búsquedas/tildes, backfill desde V2 con Prisma Migrate, asociaciones conservadas y cero producto/stock.

El Excel original se usa como aceptación local mediante MAXBIO_CATALOG_ACCEPTANCE_FILE, en previa temporal y sin confirmarlo. El reporte distingue evidencia HTTP y navegación visual. Formatos ambiguos se rechazan; futuros aliases se amplían con fixtures sin reintroducir mapper operacional. PDF/OCR/LLM y personalización del prefijo quedan fuera de este incremento.

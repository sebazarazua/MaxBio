# Verificación del importador V2

Fecha: 7 de octubre de 2026. Entorno local Windows, Node 22.18.0, pnpm 11.9.0 y PostgreSQL 17.9 en Docker. Cambios sin commit/push. Arquitectura y límites en [supplier-catalog-v2.md](supplier-catalog-v2.md).

## Evidencia reproducible

| Comando                                                                                   | Resultado                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| pnpm lint                                                                                 | PASS                                                                                             |
| pnpm format:check                                                                         | PASS                                                                                             |
| pnpm typecheck                                                                            | PASS, contratos/database/API/web                                                                 |
| pnpm test                                                                                 | PASS, 47 pruebas, cero fallos                                                                    |
| pnpm test:database                                                                        | PASS, 1 database + 95 API, incluida aceptación del archivo original; cero fallos y cero omitidas |
| pnpm build                                                                                | PASS, database/contracts/API y Next.js con 14 páginas estáticas generadas                        |
| pnpm db:migrate                                                                           | PASS, nueva migración aplicada al PostgreSQL local                                               |
| prisma migrate status                                                                     | 8 migraciones; schema actualizado                                                                |
| prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code | PASS, No difference detected                                                                     |
| Migración desde cero                                                                      | PASS en la base desechable creada por la suite Inventory; aplica todas las migraciones           |

Los logs locales están en `artifacts/v2-*.log` (ignorados por Git). No se modificaron migraciones previas ni se ejecutó db push. Los avisos existentes de pg sobre consultas concurrentes se mantienen; no produjeron fallos en la suite.

La suite conserva todas las pruebas de Catalog, Identity, Product Identification, scanner, Inventory, Receipt, Initial Inventory, Stock, tenant y auditoría. V2 agrega cobertura de alias/columnas reordenadas/extra, fila 5, varias hojas y selección ambigua, contenido desconocido para revisión, formato estable/cambiado, precio exacto, IVA 0/10.5/21/null, moneda explícita/desconocida, alternativo, semántica UNKNOWN, snapshots/reimportación, filas vacías/encabezado repetido/totales/notas/exclusión manual, coma/punto y coma/tab, fórmulas ignoradas/con resultado/sin resultado/error, porcentaje XLSX, enlaces no solicitados, DTD/XML malformado/path traversal/rangos excesivos y regresión ZIP bomb existente.

En integración HTTP/PostgreSQL se prueba abril=100 y mayo=120.12345678901234: el item conserva mayo y la fila de abril conserva 100. El perfil solo se crea al confirmar; se propone en el siguiente formato compatible y no para otro proveedor/tenant o formato nuevo. OPERATOR no puede analizar/importar/manejar perfiles. Contadores de Product, ProductIdentifier, SupplierProduct, InventoryMovement e InventoryBalance permanecen iguales al importar. Las suites existentes verifican rollback de auditoría, reintentos, concurrencia, versión, FK compuestas y mantenimiento de asociaciones.

## Archivo comercial original

Se encontró y utilizó exactamente `Lista de Precios - Mercado Medico - 27 04 26.xlsx` en Descargas. No se editó, no se copió al repositorio ni se versionó. SHA-256 del contenido probado: `3c01a2c5b709102dde83ee88a31702339a0c7e392fa36804f702b072764f27dc`.

Resultado de la inspección y preview:

| Aspecto                        | Resultado real                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Hoja                           | Lista de precios (el nombre fuente tiene un espacio final)                          |
| Encabezado                     | Fila 16                                                                             |
| supplierCode                   | CODIGO                                                                              |
| alternateSupplierCode          | COD_EXT                                                                             |
| description                    | DESCRIPCION                                                                         |
| price                          | PRECIO                                                                              |
| vatRate                        | T.IVA                                                                               |
| Marca/presentación/GTIN/moneda | No encontrados; no inventados                                                       |
| Precio incluye IVA             | UNKNOWN                                                                             |
| Moneda del preview             | ARS, seleccionada explícitamente para la prueba; no derivada del archivo            |
| Referencias válidas propuestas | 2.924                                                                               |
| Pie de total                   | 1 fila EMPTY con advertencia                                                        |
| Errores/conflictos             | 0 / 0                                                                               |
| Fórmulas anotadas              | 5.849 celdas; columnas SUBTOTAL y TOTAL ignoradas de forma segura                   |
| Advertencias de archivo        | Resultados guardados potencialmente desactualizados y vínculos externos no abiertos |
| Confirmación comercial real    | No realizada                                                                        |

La extracción y planificación puras demoraron aproximadamente 0,4–0,6 s en esta notebook. La prueba completa mediante web → proxy dedicado de upload → API → staging/preview → proxy de filas demoró alrededor de 2 s, sin commit. Son mediciones locales puntuales, no un SLA.

Se usó una organización/proveedor/sesión temporal independiente, se verificaron cero referencias comerciales persistidas, cero Products/identificadores/movimientos/balances, y se limpiaron sus uploads/previews y fixtures al terminar. Los proxies validaron todas las respuestas con los contratos actuales. El script local está en `artifacts/catalog-v2-http-acceptance.mjs`, excluido de Git porque la verificación utiliza datos comerciales locales.

Se extrajeron independientemente del ZIP/XML fuente muestras de las filas 17, 1000, 2000 y 2940 y se compararon contra las filas paginadas del preview: código, alternativo, descripción, precio e IVA. El código usa el lexema original; se preserva la precisión y no se reconstruye una cifra desde el formato visual de Excel.

La prueba de aceptación HTTP de Nest también es reproducible mediante la suite, sin incluir el archivo en Git:

```powershell
$env:MAXBIO_CATALOG_ACCEPTANCE_FILE = 'C:/ruta/al/archivo-original.xlsx'
try { pnpm test:database }
finally { Remove-Item Env:MAXBIO_CATALOG_ACCEPTANCE_FILE }
```

Ese test se omite cuando no se proporciona el archivo. Solo inspecciona y genera preview con proveedor de fixtures; nunca confirma el documento comercial.

## Límite de verificación visual

La superficie de navegador de esta sesión devolvió inventario vacío y `Browser is not available: iab`. No se realizó inspección visual del navegador ni de Excel y no se afirma que se haya hecho. Se verificaron compilación y flujo HTTP completo, y las muestras contra el XML fuente; queda pendiente QA visual de desktop/móvil y comparación con el Excel abierto. No se instalaron herramientas ni se modificó el navegador del usuario para sortear esa limitación.

## Self-review y diferencias con V1

| Riesgo revisado                             | Resultado                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Parser específico de proveedor              | Ninguno: alias/detector/perfiles son genéricos; el archivo real es únicamente evidencia de aceptación                    |
| Fila 1/nombres exactos obligatorios         | No: primeras 20 filas, alias y propuestas por contenido, overrides manuales                                              |
| Fórmulas/macros/requests externos           | No hay evaluación ni motor Excel; Buffer local; macros rechazadas; servidor centinela confirma cero requests externos    |
| Debilitamiento ZIP/XML                      | Preflight y límites conservados; se distingue fórmula/enlace inerte de contenido peligroso para parser                   |
| Precio en Product/Float                     | Solo SupplierCatalogItem/snapshot; NUMERIC y strings exactos                                                             |
| Pérdida de historia                         | Snapshots previos no se sobrescriben; test abril/mayo en DB                                                              |
| Perfil viejo sobre formato nuevo            | Firma estructural exige coincidencia; cambio de columnas/encabezados vuelve a detectar                                   |
| Datos inventados/ambigüedad confirmada sola | Propuesta revisable, UNKNOWN/null; códigos ambiguos no elegidos; importes ambiguos bloquean; confirmación siempre humana |
| Cross-tenant                                | Contexto confiable, scopes y FK compuestas; tests ADMIN/OPERATOR y tenants                                               |
| Import crea Product/identidad/stock         | Cero nuevos efectos fuera de referencias comerciales; contadores y regresión Inventory                                   |
| Complejidad fuera de alcance                | Sin PDF/OCR/LLM/precios de venta/conversión/analytics; dependencias existentes                                           |

V1 rechazaba globalmente fórmulas/hyperlinks/externalLinks, sugería cinco campos y usaba la primera hoja en la UI. V2 diferencia celdas, propone hoja/encabezado/campos con confianza, permite ignorar filas/campos, conserva comerciales exactos y reutiliza formatos confirmados. Se mantienen commit, idempotencia, asociaciones, PARTIAL/COMPLETE y límites originales.

Para conectar `PdfSupplierCatalogExtractor`, ver la interfaz exacta y reutilización de pipeline en [arquitectura V2](supplier-catalog-v2.md#conectar-pdf-y-próximo-incremento). Próximo incremento: probar extracción del PDF original de Massuar con tablas neutrales y revisión humana, sin construir un motor universal.

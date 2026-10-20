# Impresión de remitos sobre formularios preimpresos

Implementación sobre HEAD `1a1be33a406da33cb96b7b6bb73341ccc40691ad`. La representación consume el remito existente. No reemplaza DeliveryNote, sus snapshots, Inventory ni OUTBOUND.

## Estado y materiales de Bourbon

No se recibieron el PDF escaneado ni el DOCX reconstruido. No conocemos el tamaño físico del talonario, sus espacios libres ni su capacidad de renglones. **No hay plantilla Bourbon ni tamaño de papel predeterminado instalado.** Los fixtures de pruebas usan 180 × 240 mm exclusivamente como ejemplo sintético; no son una medición de Bourbon.

Para preparar la plantilla real: medir ancho/alto del papel alimentado (incluyendo talón si entra), orientación, borde de alimentación, cajas en blanco, columnas y altura de renglón. Registrar impresora, equipo, driver, bandeja y si hay copias/autocopiativo. Contrastar PDF/Word con el papel: el tamaño del escaneo puede ser el de la cama del escáner. El Word se usa como referencia, nunca en runtime.

## Responsabilidades y persistencia

| Pieza                            | Responsabilidad                                                                                                                               |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| DeliveryNote / Line / Allocation | Documento, cantidades y asignaciones existentes. Sin coordenadas nuevas.                                                                      |
| PrintTemplate                    | Revisión con nombre, organización, familia, número de revisión, DRAFT/PUBLISHED, dimensiones/tolerancias mm, fondo privado y definition JSON. |
| PrintConfiguration               | Una revisión publicada activa por organización. La activación no modifica la revisión.                                                        |
| PrinterCalibration               | Revisión inmutable compatible con una revisión exacta de plantilla. Nombre, impresora/bandeja opcionales, offset X/Y. Sin escala.             |
| PrintAsset                       | Archivo privado, hash SHA-256, tamaño y tipo. Dimensiones en píxeles solo para validar el PNG; no son geometría física.                       |
| PrintArtifact                    | Generación de overlay: remito/versión, plantilla, calibración, archivo/hash, actor, fecha y generación original si es reimpresión.            |

Crear una copia de plantilla o calibración agrega una revisión. No hay edición destructiva ni eliminación de revisiones. V1 tiene estados mínimos DRAFT/PUBLISHED; no incorpora archivado ni editor visual universal. La UI lista las últimas 100 revisiones/calibraciones/generaciones y permite activar otra revisión publicada.

PostgreSQL protege las revisiones publicadas y las calibraciones/assets/artifacts contra UPDATE/DELETE. Las FKs compuestas protegen organización y compatibilidad de calibración. Los artifacts exigen un remito CONFIRMED, su versión, plantilla PUBLISHED y un asset PDF con hash coincidente.

Migraciones nuevas: `20261019190000_delivery_note_printing` y `20261019191000_printing_constraints`. La segunda cierra explícitamente los casos NULL de CHECK SQL. No modifica migraciones históricas ni guards de Inventory.

## Contrato geométrico

Fuente de verdad: milímetros, origen arriba a la izquierda; X derecha, Y abajo. PDF usa puntos: `mm × 72 / 25.4`; el renderer convierte la coordenada vertical y la línea base. Dimensiones de página, tolerancias y offsets admiten tres decimales, sin redondeo silencioso de entrada. Tamaños permitidos: 40–1000 mm por dimensión; no se interpreta ningún estándar.

`definition.schemaVersion = 1`. Campos y columnas son objetos strict. Los bindings, la fuente y los formatters son enumeraciones. No se ejecuta JavaScript, HTML ni expresiones del administrador.

Bindings de cabecera: `document.number`, `document.date`, `customer.name`, `customer.legalName`, `customer.cuit`, `customer.taxCondition`, `customer.address`, `patient.name`, `patient.affiliateNumber`, `notes`. El domicilio combina dirección/localidad/provincia/código postal disponibles. Valores opcionales ausentes no dibujan texto. El número mantiene ceros; si está preimpreso, **no agregar ese binding al overlay**. Se muestra de todos modos prominentemente en la UI.

Tipografía V1: Noto Sans Latin regular embebida desde el paquete `@fontsource/noto-sans` (licencia OFL incluida en esa dependencia). `fontSizePt` e `lineHeightPt` están en puntos; cajas/padding están en mm. Caracteres fuera de la fuente generan BLOCKED, sin sustituciones silenciosas. No hay fuentes remotas ni dependencia de las fuentes del equipo.

Los campos tienen ID, binding, x/y/width/height, fuente, tamaño/interlineado, alineación horizontal/vertical, máximo de líneas, formatter, padding y `overflow: BLOCK`. Los formatos date/quantity/cuit se restringen al tipo de binding correspondiente. Las fechas documentales se formatean como calendario, sin convertirlas de zona horaria; las cantidades reutilizan la aritmética decimal exacta de Inventory y se representan con coma decimal.

Ejemplo **sintético y parcial de definition**, a adaptar y completar según las medidas reales; no copiarlo como formulario Bourbon:

```json
{
  "schemaVersion": 1,
  "fields": [
    {
      "id": "customer",
      "binding": "customer.name",
      "xMm": 10,
      "yMm": 20,
      "widthMm": 150,
      "heightMm": 12,
      "font": "NotoSans",
      "fontSizePt": 9,
      "lineHeightPt": 13,
      "align": "left",
      "verticalAlign": "top",
      "maxLines": 2,
      "formatter": "text",
      "overflow": "BLOCK",
      "paddingMm": 0.5
    }
  ],
  "productRegion": {
    "xMm": 10,
    "yMm": 65,
    "widthMm": 150,
    "heightMm": 144,
    "rowHeightMm": 24,
    "columns": [
      {
        "binding": "quantity",
        "widthMm": 18,
        "fontSizePt": 9,
        "lineHeightPt": 13,
        "formatter": "quantity"
      },
      {
        "binding": "productName",
        "widthMm": 54,
        "fontSizePt": 9,
        "lineHeightPt": 13,
        "maxLines": 2
      },
      {
        "binding": "lotNumber",
        "widthMm": 25,
        "fontSizePt": 9,
        "lineHeightPt": 13
      },
      {
        "binding": "expirationDate",
        "widthMm": 28,
        "fontSizePt": 9,
        "lineHeightPt": 13,
        "formatter": "date"
      },
      {
        "binding": "serialNumber",
        "widthMm": 25,
        "fontSizePt": 9,
        "lineHeightPt": 13
      }
    ]
  }
}
```

El contrato completa defaults declarados (NotoSans, izquierda/arriba, una línea, texto, BLOCK, padding 0,5 mm). Página, tolerancias y fondo se cargan en la cabecera del formulario de configuración, fuera de definition. Nunca se completan dimensiones del papel automáticamente.

## Productos y overflow

La región repetible usa x/y/width/height/rowHeight en mm. Sus columnas consecutivas tienen anchos y tipografía propios, bindings únicos y deben incluir quantity/productName. La suma de anchos no puede superar la región. `floor(height / rowHeight)` determina la capacidad; no se persiste una cantidad de filas contradictoria.

Bindings de fila: quantity, unit, productName, presentation, lotNumber, expirationDate, serialNumber. Si se imprimen datos físicos, cada allocation genera una fila con su cantidad. Cantidad 4 distribuida en A=2/B=2 produce dos filas, sin fusionar lotes. Se reconcilia la suma exacta de allocations con la cantidad documental. Series requieren una unidad. Si hay lote/vencimiento/serie real y falta su columna, se bloquea en vez de omitirlo. No hay consolidación automática de líneas repetidas.

No se trunca ni se achica la página. Desbordar filas, líneas de texto, columnas, márgenes o fuente produce un diagnóstico. Hay que corregir el borrador o preparar documentos separados antes de confirmar. No hay segunda página automática. Una preview BLOCKED sirve para diagnóstico y puede mostrar contenido fuera de su caja; no habilita overlay definitivo.

## Zonas seguras y tolerancia

Cada caja configurada debe representar **espacio físicamente libre de líneas y texto preimpreso**. MaxBio no detecta las líneas del PNG. Una caja mal medida no puede corregirse automáticamente.

La zona útil se obtiene retirando tolerancia X/Y y padding de cada borde. El motor mide y distribuye texto con la misma fuente embebida del PDF. Evalúa la caja de texto trasladada por calibración, expandida por ±tolerancia, contra la caja disponible y la página.

- SAFE: contenido y envolvente caben, con margen suficiente.
- WARNING: caben pero la holgura es menor a 0,4 mm, el alto ocupa más del 90 % o el ancho más del 95 % del espacio útil.
- BLOCKED: excede espacio/filas/líneas, falta trazabilidad representable o hay caracteres no soportados.

La tolerancia es por lado, en mm. El renderer no promete compensar papel invertido, rotación, alimentación diagonal, deformación del fondo ni posición arbitraria. Correcciones muy grandes pueden dejar contenido fuera de la zona segura y se bloquean.

## Preview y PDF overlay

PREVIEW genera PDF de una página con PNG preparado + datos reales, y una banda visible de BORRADOR / VISTA PREVIA o VISTA PREVIA / NO IMPRIMIR EN TALONARIO. ADMIN también puede probar una revisión DRAFT de plantilla con un remito guardado; OPERATOR solo revisiones publicadas. Un remito DRAFT nunca produce overlay operativo.

PDF.js representa el PDF del backend en canvas, con worker local y zoom de pantalla. El zoom no viaja al backend ni se acepta en los contratos. Seleccionar posición nominal o una calibración permite comparar la traslación. Guías opcionales: caja disponible roja, zona útil verde y envolvente de tolerancia azul. Ninguna guía entra al overlay.

PRINT_OVERLAY requiere remito CONFIRMED, plantilla PUBLISHED y evaluación no BLOCKED. Genera una sola página de dimensiones exactas, texto vectorial negro y fuente embebida. Su rama de render nunca lee ni incorpora el fondo, aunque el caller lo proporcionara. Tampoco incluye la banda de preview. El PDF solicita PrintScaling=None; el operador debe verificar tamaño real/100 %, tamaño personalizado, bandeja y orientación en el visor/driver. No hay impresión silenciosa ni dependencia de HTML print.

## Calibración

Cada calibración corresponde a una revisión exacta de plantilla. Guardar ajustes crea una revisión nueva: los artifacts conservan la anterior. X positivo mueve a la derecha; Y positivo, abajo. Rango V1 ±20 mm; escala siempre 1. Descripción de impresora/equipo/bandeja ayuda a elegir el perfil, pero el navegador no detecta esos dispositivos.

Procedimiento: imprimir PDF de prueba sobre hoja del tamaño correcto al 100 %, medir cruces desde bordes, introducir correcciones X/Y, guardar revisión y repetir. Una desviación de +2 mm a la derecha requiere offset X −2 mm. Comparar varios puntos y varios ejemplares. Si cambia la distancia entre marcas, revisar escalado/tamaño antes de calibrar; si varía hoja a hoja, revisar alimentación. El PDF de prueba no declara éxito físico.

## Confirmación y reimpresión

Se conserva el caso de uso transaccional existente. Tras sus locks/versiones/validación del número y antes de postDeliveryNote, un guard consulta la revisión activa y evalúa geometría nominal de los datos actuales bajo los locks del cliente/productos/documento. BLOCKED devuelve conflicto antes de cualquier OUTBOUND. Sin plantilla activa, mantiene el comportamiento previo. Activación y guard usan el mismo advisory lock por organización. Replays existentes de confirmación se resuelven antes del guard; no se reconfirman.

Solo se ejecuta cálculo geométrico en esa transacción: **no hay generación de PDF, escritura en storage ni espera de impresora**. La UI también valida antes de habilitar Confirmar salida; fallas de la validación impiden habilitarla. La geometría no reemplaza las validaciones de stock existentes.

Después de confirmar se genera el overlay por otra operación. PrintArtifact guarda versiones, actor y hash. Un UUID de intento estable permite retry concurrente sin otro artifact/evento. La UI conserva ese intento en memoria ante una respuesta incierta; no hay cola offline ni persistencia de datos personales en localStorage.

Reimprimir crea otro registro vinculado al original y reutiliza **exactamente el asset PDF almacenado**, con idéntico hash, plantilla y calibración. Descargar un registro existente solo lo consulta; Registrar reimpresión exacta crea el nuevo intento. Ninguna de esas operaciones llama a confirm ni a Inventory. No hay boolean printed ni inferencia de éxito físico.

La UI exige verificar el número mostrado: «Colocá el remito 00001-00003897». No genera numeración ni detecta el papel. Si se arruina un formulario numerado después de confirmar, V1 no cambia el número del remito, no genera otro OUTBOUND y no resuelve su reemplazo: Bourbon debe acordar un procedimiento administrativo antes del piloto productivo.

## Storage privado

`PrivatePrintStorage` tiene put/read/remove y una implementación local. `PRINT_STORAGE_DIR` opcional fija un directorio privado absoluto; por defecto usa `.maxbio-private-print` relativo al directorio de ejecución de API (ignorado por Git). No usa public/, URLs permanentes ni nombres personales. Debe mantenerse el mismo directorio al reiniciar y respaldarse junto con la base. El despliegue con filesystem efímero requiere implementar un adapter persistente antes de usarlo.

Claves generadas `organizationUUID/fileUUID`, validación de ruta, creación exclusiva y lectura autorizada vía DB tenant-scoped. PNG hasta 4 MiB/16 megapíxeles y 8000 px por dimensión; se valida antes de descomprimir y se reencodea para descartar metadata. Proporción de fondo y papel debe coincidir dentro del 1 %; esto no prueba exactitud física. Se verifica SHA-256 al leer.

El archivo se escribe antes de registrar asset/artifact y auditoría en una transacción. Si falla la transacción, se elimina el archivo recién creado. Un crash entre ambas operaciones puede dejar un archivo huérfano: no hay GC automático en V1. No se borra un archivo histórico para liberar espacio.

## API, BFF y permisos

API `/api/v1/printing`; BFF `/api/printing`. Rutas/métodos explícitamente permitidos, contratos strict, sesión/organización y CSRF en POST, incluido preview. Respuestas binarias separadas de JSON: application/pdf o image/png, MIME/firma/tamaño comprobados, no-store privado, nosniff y nombres genéricos. El endpoint de PNG tiene un límite JSON propio; los demás conservan el parser habitual. El worker de PDF.js sirve únicamente código estático local y no contiene documentos.

| Ruta relativa                | Método   | Permiso / salida                                 |
| ---------------------------- | -------- | ------------------------------------------------ |
| config                       | GET      | ADMIN/OPERATOR; plantilla activa y calibraciones |
| templates                    | GET      | ADMIN/OPERATOR; últimas 100 revisiones           |
| templates                    | POST     | ADMIN; nueva revisión DRAFT                      |
| templates/:id/publish        | POST     | ADMIN; publicación y activación opcional         |
| assets                       | POST     | ADMIN; PNG privado                               |
| assets/:id                   | GET      | ADMIN/OPERATOR de la organización; PNG binario   |
| calibrations                 | POST     | ADMIN; nueva revisión inmutable                  |
| calibration-test             | POST     | ADMIN; PDF de prueba                             |
| delivery-notes/:id/evaluate  | POST     | ADMIN/OPERATOR; diagnóstico JSON                 |
| delivery-notes/:id/preview   | POST     | ADMIN/OPERATOR; PDF PREVIEW                      |
| delivery-notes/:id/artifacts | GET/POST | ADMIN/OPERATOR; historial/generación             |
| artifacts/:id/pdf            | GET      | ADMIN/OPERATOR; PDF registrado                   |
| artifacts/:id/reprint        | POST     | ADMIN/OPERATOR; nueva reimpresión exacta         |

Permisos administrativos y sesión se revalidan también dentro de las transacciones de escritura. Las revisiones/calibraciones/archivos de otro tenant no se pueden seleccionar ni recuperar.

Auditoría transaccional: PRINT_TEMPLATE_CREATED, PRINT_TEMPLATE_PUBLISHED, PRINT_TEMPLATE_ACTIVATED, PRINT_CALIBRATION_UPDATED y DELIVERY_NOTE_PRINT_ARTIFACT_GENERATED. Metadata vacía; no copia paciente, afiliado, texto documental ni PNG. Preview y zoom no generan eventos de negocio.

## Configuración y flujo cotidiano

ADMIN entra desde Remitos → Configurar impresión sobre talonario. Carga dimensiones medidas, tolerancias explícitas, PNG y definition; guarda un borrador, lo prueba con un remito guardado, publica/activa y calibra. La configuración JSON es para desktop y una preparación técnica inicial; la calibración cotidiana se hace con controles X/Y. No se publica automáticamente al guardar.

Empleado: preparar remito → seleccionar existencias → guardar → revisar formulario/diagnósticos → confirmar salida → verificar número y perfil → generar/descargar overlay → imprimir desde el visor al 100 %. La preview tiene scroll/zoom responsive; configurar plantillas prioriza notebook/desktop.

## Verificación y límites

Pruebas de geometría/PDF: mm→pt, cajas/tolerancia, SAFE/WARNING/BLOCKED, multiline/opcionales, fechas/cantidades, fuente, filas por allocations, lotes/series, reconciliación, overflow, página custom de una hoja, imagen solo en preview, extracción de texto y offsets de operadores PDF. Zoom no forma parte del contrato y no puede alterar el PDF.

Integración HTTP/PostgreSQL: roles/tenant, PNG, publicación, inmutabilidad SQL, revisiones, compatibilidad de calibración, DRAFT preview/CONFIRMED overlay, retry concurrente, reimpresión idéntica, auditoría/rollback/limpieza y comparación completa de documento/movimientos/balances antes/después. Migración: upgrade desde HEAD y from-zero, status y drift.

Ejecutar `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm test:database`, `pnpm build`, `pnpm db:generate`, `pnpm db:migrate` y Prisma migrate status/diff. Las suites de base crean bases descartables; requieren PostgreSQL local y permiso CREATE DATABASE. Nunca ejecutarlas contra producción.

Pendientes físicos: referencias PDF/Word, medidas exactas, fondo limpio, geometría real, filas disponibles, impresora/driver/bandeja, márgenes imprimibles, tolerancia aceptada y procedimiento de formularios dañados. Pruebas automatizadas y PDFs sintéticos no validan el transporte mecánico del papel.

Fuera de alcance: Word runtime, importador DOCX universal, editor gráfico, diseño digital/fiscal completo, facturación/ARCA/CAI/ANMAT, GS1 enriquecido, cámara, drivers/agente local, impresión directa silenciosa, segunda página automática, reservas y reversión de stock.

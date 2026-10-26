# Bourbon: plantilla provisional y editor de geometría

HEAD inicial: `037476db9efaaf4c4ffcd17171e3a036630d17e0`.

## Plantilla creada

Se implementaron los bindings faltantes, la base configurable y un editor visual ADMIN
que utiliza el motor PDF existente. No hay cambios de esquema, Customer, DeliveryNote,
Inventory ni OUTBOUND. No se hizo commit ni push.

**Bourbon Remito 203x271 - Provisional** está creada en la organización MaxBio. Revisión
actual **2 / DRAFT**, ID `d1627254-0858-4f6a-be5f-f4e464036ef4`. La revisión 1 se conserva
como borrador anterior de la misma familia. Ninguna se publicó ni activó. El asset privado
es `f84a6929-fd19-4028-9212-2ced28083049`.

Tamaño autoritativo: **203 × 271 mm**, vertical. Tolerancia provisional: **X ±4 / Y ±3 mm**.
Calibración inicial nominal **0 / 0**, mediante la opción existente sin calibración guardada.
No representa una medición de error real de impresora. No es una plantilla definitiva.

## Referencia y privacidad

Se recibió e inspeccionó `eac0a53a-9450-41ed-9d2f-692a32909234.png`, de 1091 × 1442 px.
Su proporción excedía apenas el límite existente. Con autorización expresa se agregaron
**7 px transparentes arriba y 8 abajo** para obtener 1091 × 1457 px, sin cambiar el motor
ni su control de proporción. Se verificó igualdad exacta de todos los píxeles originales:
sin recortar, redibujar ni deformar el formulario. No se dedujeron medidas físicas de la imagen.

SHA-256 original: `4b71e2e9dc2e212ed2246f684078a507a6599d1abcf1e0f88750d4561fe8424d`.
El fondo está en almacenamiento privado de API; referencia preparada, preview y comprobante
local están en `.maxbio-private-print/`, excluidos de Git. No hay imagen en `public/` ni
acceso público. Las rutas existentes autentican, aíslan por organización y usan no-store.

## Coordenadas iniciales revisadas

Posiciones aproximadas cotejadas visualmente; **precisión y calibración física pendientes**.
Son coordenadas de los espacios disponibles del modelo existente, desde arriba/izquierda,
en mm. El texto nominal se coloca dentro del área segura conforme al motor.

| Campo     | Binding                 |     X |    Y | Ancho | Alto |
| --------- | ----------------------- | ----: | ---: | ----: | ---: |
| Día       | document.dateDay        | 139.6 | 28.3 |  11.2 | 10.2 |
| Mes       | document.dateMonth      | 152.8 | 28.3 |  11.2 | 10.2 |
| Año       | document.dateYear       | 164.8 | 28.3 |  13.5 | 10.2 |
| Cliente   | customer.name           |    29 | 56.5 |   166 |  9.6 |
| Dirección | customer.addressLine    |    29 | 66.3 | 118.5 |  9.6 |
| Localidad | customer.locality       |   158 | 66.3 |    37 |  9.6 |
| CUIT      | customer.cuit           | 154.5 | 79.8 |  40.5 |   12 |
| Paciente  | patient.name            |     8 |  190 |   187 |   12 |
| Afiliado  | patient.affiliateNumber |     8 |  202 |   187 |   12 |

NotoSans, una línea y alineación vertical media. Fecha: 6 pt, interlineado 9 pt, padding
0,1 mm, centrada. Cliente/dirección/localidad: 7 pt, interlineado 10 pt, padding 0,1 mm.
CUIT/paciente/afiliado: 9 pt, interlineado 13 pt, padding 0,5 mm. CUIT usa su formatter existente.
Paciente y afiliado quedan dentro del área libre de descripción, antes del bloque de
cheques, firma y aclaración. No se agregan etiquetas estáticas ni concatenación de bindings.

`bourbonProvisionalTemplate(id, backgroundAssetId)` contiene esta base validada. El botón
**Preparar Bourbon Remito 203x271 - Provisional** sigue disponible para una instalación
futura con su PNG privado, sin publicar automáticamente.

## ProductRegion

X **8**, Y **106,8**, ancho **187**, alto **80 mm**; fila **16 mm**, máximo **5 filas físicas**.
Queda bajo CANT./DESCRIPCION y reserva espacio inferior para paciente/afiliado.

| Columna        | Ancho mm | Máximo de líneas |
| -------------- | -------: | ---------------: |
| quantity       |       34 |                1 |
| productName    |       65 |                2 |
| lotNumber      |       30 |                1 |
| expirationDate |       30 |                1 |
| serialNumber   |       28 |                1 |

Tipografía de productos: 9 pt, interlineado 13 pt, padding 0,5 mm; cantidad centrada.
Se mantienen allocations múltiples, cantidades exactas, lote, vencimiento, serie,
reconciliación y bloqueo por overflow. No se ocultan datos para hacerlos entrar. Una
allocation puede producir una fila; cinco filas no equivalen necesariamente a cinco
productos documentales. Los textos vacíos no dibujan recuadro.

## Bindings y preimpresos

- `document.dateDay`, `document.dateMonth`, `document.dateYear`: partes de documentDate
  ISO, sin conversión horaria ni nuevos valores persistidos. Conservan ceros iniciales.
- `customer.addressLine`, `customer.locality`: datos de la view/snapshot existente.
  En confirmados conservan el snapshot congelado. Opcionales vacíos imprimen vacío.
- `document.date` y `customer.address` mantienen compatibilidad.

La base Bourbon excluye `document.number`. Se muestra en la interfaz para identificar el
papel, pero no se imprime. Tampoco se agregan logo, nombre/datos del emisor, R, COD 91,
REMITO, CAI, vencimiento de CAI, datos de imprenta ni número preimpreso al overlay.

## Editor y datos reales o de prueba

Abrir **Configuración → Impresión sobre talonario**, elegir la revisión 2 y **Editar geometría**.
Priorizar un remito guardado, buscándolo por cliente/número. Al instalar no había ninguno
en MaxBio, por lo que se agregó **Usar datos de prueba para editar geometría**.

La muestra se construye en memoria con OSUTHGRA, AV. DE MAYO 930, CABA, CORIA, MILAGROS,
20-91552262-6/01 y un producto ficticio con dos allocations de cantidad 1: lotes ABC-001/002,
vencimiento y series DEMO-001/002. La UI la identifica como DATOS DE PRUEBA. No crea
DeliveryNote, Customer, Product, stock ni artifact. La instalación verificó que los
conteos de remitos/movimientos y la configuración activa permanecieran iguales.

Seleccionar un campo permite editar X/Y, ancho/alto, fuente, interlineado, maxLines,
padding y alineación. Drag y flechas mueven la posición nominal: 0,5 mm o Shift + flecha
0,1 mm. Los campos vacíos pueden seleccionarse desde la lista. Las filas repetidas
comparten región: arrastrar un texto de producto mueve toda la región; el ancho/estilo
de columna se aplica a todas las filas. No se inventan offsets por allocation.

Zoom 50 %, 100 %, 200 % y valores intermedios solo modifican pantalla:
`deltaMm = deltaPx × pageSizeMm / displayedPageSizePx`. El drag redondea a 0,1 mm y
limita la región a la página. Guardar crea otra revisión **DRAFT** de la misma familia,
con coordenadas nominales en mm; no persiste píxeles ni publica/activa.

## Autoridad backend y recuadro único

`POST /printing/delivery-notes/:id/geometry-preview` usa un remito guardado y su versión
esperada. `POST /printing/templates/:id/geometry-preview` usa la muestra en memoria.
Ambos son ADMIN y validan definición temporal, organización y calibración compatible.
La revisión guardada determina tamaño, tolerancias y fondo. El preview no guarda geometría.

El backend ejecuta **el mismo renderPdf() y layoutDocument()**, con NotoSans embebida y
pdfMetrics(). Devuelve ese PDF y envolventes de ese mismo layout. PDF.js dibuja el PDF;
React no mide ni reconstruye texto. Los objetivos SVG de interacción son transparentes,
sin borde. Se descartan respuestas fuera de orden y se requiere el preview vigente y
renderizado para guardar o iniciar una interacción.

`printingEnvelopes()` deriva una sola envolvente por región textual no vacía:

```text
left   = text.xMm - safeToleranceXmm
top    = text.yMm - safeToleranceYmm
width  = text.widthMm + 2 × safeToleranceXmm
height = text.heightMm + 2 × safeToleranceYmm
```

El bbox usa las mismas métricas tipográficas del renderer PDF. Para multiline es la unión
de las líneas, incluido interlineado; no es un análisis de píxeles de tinta. El texto
aparece nominalmente dentro de la única envolvente. outer/safe siguen como modelo interno,
sin dibujarse. El banner preexistente de preview no es una caja de texto.

**Fuente** modifica ancho y alto. **Contenido**, ancho disponible y padding modifican
anchos/wrapping. **Multiline/interlineado** modifican la altura total. **maxLines** vuelve
a evaluar y bloquea excesos sin recortar texto. **Tolerancia** agrega siempre 8 mm al ancho
y 6 al alto de Bourbon, independientemente de la fuente. **Calibración** desplaza texto y
envolvente una sola vez, sin escalarlos. Color verde SAFE, naranja WARNING o rojo BLOCKED,
con relleno semitransparente y un borde visible.

PRINT_OVERLAY conserva solo texto negro: nunca fondo, banner, guías ni cajas, aunque se
soliciten accidentalmente. El PDF físico sigue siendo exactamente **203 × 271 mm**.

## Límites reales y trabajo pendiente

El preview de muestra da **WARNING**, 2 filas y 19 envolventes. Los avisos geométricos
corresponden a fecha, cliente, dirección y localidad por su espacio útil reducido.

La inspección visual muestra un límite físico: con X ±4 mm la envolvente de cuatro dígitos
del año supera el ancho del casillero aun a 6 pt. Con Y ±3 mm la banda de CUIT es estrecha
para contener texto y tolerancia sin alcanzar líneas preimpresas. No se redujeron
tolerancias ni se ocultaron cajas. El editor advierte que **SAFE matemático no certifica
obstáculos del fondo**. Mover campos puede no resolver un casillero menor que su envolvente.
No está aprobada para impresión operativa.

La relación con líneas/títulos se valida visualmente por ADMIN: no hay computer vision.
Pendiente: remito real guardado cuando exista, nombres largos, múltiples allocations y
prueba física de alimentación. Imprimir en papel personalizado **203 × 271 mm**, tamaño
real **100 %**, sin fit-to-page, scale-to-fit ni ampliación a A4. Medir error real y
guardar calibración después de la medición. Repetir la configuración con el nuevo formulario.

Transporte PROPIO y «entregado por cuenta y orden de» quedan fuera de V0, sin lenguaje de
templates ni concatenación arbitraria. Factura y checkboxes fiscales están fuera de
alcance. Firma y aclaración se completan físicamente. No se avanzó a GS1, ARCA, ANMAT ni
ninguna otra etapa posterior.

## Verificación

Tests de fecha/domicilio y compatibilidad, bbox PDF, expansión ±4/±3, fuente, contenido,
wrapping, multiline/interlineado, maxLines, calibración, zoom y drag en mm, persistencia
DRAFT exacta, roles/tenant/versión, preview de muestra sin escrituras, un recuadro por región,
203 × 271 sin preimpresos/cajas en overlay y regresiones de Printing/DeliveryNotes/Inventory.

Se renderizó e inspeccionó el PDF con el PNG real mediante Poppler: una página de
575,433 × 768,189 pt (203 × 271 mm), texto legible, una envolvente por región y pacientes
antes del pie. No se verificó el drag en navegador interactivo: no hay navegador conectado.

Resultados finales ejecutados el 21/10/2026, con el PNG y la muestra sin remito:

| Comando                                 | Resultado                                                           |
| --------------------------------------- | ------------------------------------------------------------------- |
| `pnpm lint`                             | OK                                                                  |
| `pnpm format:check`                     | OK                                                                  |
| `pnpm typecheck`                        | OK                                                                  |
| `pnpm test`                             | OK: API 77/77, web 9/9                                              |
| `pnpm test:database`                    | OK: database 1/1; API 141 aprobadas, 2 optativas omitidas, 0 fallos |
| `pnpm build`                            | OK: paquetes, API y Next compilados                                 |
| Printing con `MAXBIO_PRINT_BFF_SMOKE=1` | OK: 10/10, incluido BFF real y muestra sin remito                   |
| `git diff --check`                      | OK                                                                  |

Las dos omisiones de la suite general son el BFF optativo (ejecutado y aprobado por
separado) y la aceptación de un archivo comercial original no disponible. El BFF verifica
Next compilado → API → PostgreSQL/storage → PDF privado, worker local, roles, preview
geométrico real/de muestra, guardado DRAFT, generación y reimpresión. No se afirman pruebas
de impresora ni de drag en navegador interactivo.

```text
TAMAÑO: 203 × 271 mm
TOLERANCIA: X ±4 mm / Y ±3 mm
RECUADROS VISUALES POR TEXTO: 1
CALIBRACIÓN FÍSICA: PENDIENTE
PLANTILLA DEFINITIVA: NO
PLANTILLA PROVISIONAL BOURBON: CREADA (revisión 2 / DRAFT / sin activar)
LISTO PARA REVISAR VISUALMENTE LA PLANTILLA: SÍ
```

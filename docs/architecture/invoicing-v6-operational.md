# Facturación V6: preparación automática y datos fiscales del cliente

## Base de trabajo

HEAD inicial: `5168f573f3abeaf539bf09efa5e9101c744446dd` (`facturacion v5`), rama `main`, working tree limpio. Trabajo local sin commit ni push.

El problema operativo era la separación visible de tareas técnicas: probar acceso, actualizar referencias y consultar numeración. El formulario de clientes tampoco exponía su IVA estructurado, y la edición fiscal desde factura sólo resolvía IVA. V6 conserva la arquitectura de autorización V3/V4/V5 y automatiza la preparación.

## Responsabilidad de cada dato

| Requisito                               | Resolución                                                              |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Credencial, certificado y perfil emisor | Configuración inicial y mantenimiento en Configuración                  |
| Recuperar/restaurar/renovar acceso      | Automático, con las reservas y esperas existentes                       |
| Referencias de ARCA                     | Automáticas, sólo al faltar, vencer o cambiar identidad                 |
| Punto de venta                          | Elección ADMIN explícita una vez; después se reutiliza                  |
| CUIT y condición frente al IVA          | Datos del cliente, conservados para facturas futuras                    |
| Tipo A/B/C                              | Preselección si hay una sola alternativa; decisión humana si hay varias |
| Importes                                | Cálculo y validación del servidor                                       |
| Numeración                              | Consulta automática previa y nueva comprobación al autorizar            |
| Solicitud de autorización               | Confirmación humana final obligatoria                                   |

## Preparación sin emisión

`POST /invoices/:id/fiscal/prepare` usa `prepareFiscalAuthorization`. Autoriza al actor y resuelve la factura dentro del tenant antes de compartir trabajo concurrente. No llama a `authorize` ni a `FECAESolicitar`.

La preparación de configuración es compartida por organización: `POST /fiscal/arca/invoicing/prepare`. Valida la credencial, recupera el acceso persistido mediante el servicio existente, autentica si corresponde y actualiza referencias vencidas. La lectura GET conserva su comportamiento de diagnóstico, sin iniciar consultas de negocio remotas.

El acceso mantiene el cifrado privado, la vinculación organization/CUIT/credential, el margen de expiración, single-flight y la reserva durable que impide repetir `loginCms` tras resultados inciertos. Una espera vigente no se elimina ni se salta. El mensaje operativo informa la fecha/hora de Buenos Aires; Configuración conserva el diagnóstico técnico.

Las referencias siguen vinculadas al CUIT y la credencial activa, con TTL de 15 minutos. Las referencias inválidas o vencidas no se ofrecen como opciones vigentes. El acceso se valida incluso cuando las referencias siguen en caché.

La consulta de puntos de venta admite el código 602 exclusivamente cuando no hay resultados y no aparecen otros errores. Las respuestas contradictorias, los errores mixtos y los errores de las restantes referencias siguen bloqueando. El [manual oficial de ARCA, v4, página 19](https://arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG-v4-0.pdf#page=19) define 602 como ausencia de datos. Nunca se inventa ni se registra un punto de venta en ARCA.

Una sola opción se propone con “Usar este punto de venta”. Varias opciones requieren elegir. La selección se valida contra ARCA y se persiste con control de versión. Una selección vigente queda plegada en Configuración bajo “Cambiar punto de venta”.

La factura valida emisor, receptor, compatibilidad de clase, líneas e importes, y bloqueos de la secuencia. Consulta automáticamente el último número y, si corresponde, el último comprobante para validar fecha. El resultado previo dura cinco minutos y se invalida al cambiar factura, perfil o configuración. El ámbito fiscal sigue siendo organización + homologación + punto + tipo; la caché adicional por factura permite validar también sus datos y fecha. No hay reserva ni MAX+1 local durante la preparación. `authorize` conserva su nueva consulta remota bajo la reserva y locks existentes.

Los errores de preparación tienen una pausa mínima de un minuto; las esperas de acceso pueden ser mayores. Se comparte el trabajo concurrente por organización y por factura/versión. React inicia una preparación al abrir la factura, cancela respuestas de pantallas anteriores y no depende de cada render. La numeración se actualiza al vencer su TTL mientras la pantalla sigue abierta. Los fallos programan como máximo un reintento automático por apertura; después queda “Reintentar”.

## Cliente y snapshot de factura

Customer expone `arcaVatConditionId` y `arcaVatConditionLabel`. El formulario muestra un selector con opciones oficiales. El servidor valida el ID y obtiene su descripción desde las referencias; no acepta una descripción inventada por el browser. `taxConditionText` permanece separado como “Condición fiscal / observación”, sin traducirse a un código ARCA.

READY copia los datos actuales del Customer, incluido el IVA estructurado. No reutiliza un valor anterior de la factura por delante del dato vigente del cliente. Una factura puede llegar a READY con CUIT pendiente, pero no puede autorizarse hasta completarlo.

“Completar datos fiscales del receptor” permite guardar CUIT e IVA desde una factura READY + NOT_SUBMITTED sin ningún intento fiscal. Comprueba versiones de factura y cliente, toma locks Customer → Invoice, actualiza ambos, incrementa ambas versiones y registra `CUSTOMER_UPDATED` e `INVOICE_ARCA_RECEIVER_CONFIGURED` dentro de la misma transacción. Si falla la auditoría se revierte todo. La UI ejecuta después una nueva preparación. Otras facturas ya preparadas no se sincronizan silenciosamente.

El atajo se rechaza ante cualquier intento previo, incluso ABORTED o NOT_FOUND, y para OPERATOR u otro tenant. Las correcciones posteriores siguen los mecanismos de reapertura/reconciliación ya existentes.

## Migración necesaria

`20261031193000_invoice_receiver_completion` modifica únicamente el guard de Invoice. No agrega tablas, columnas ni reescribe registros. Es necesaria porque V5 congelaba todo `customerSnapshot` en READY.

La excepción exige READY → READY, ambos estados fiscales NOT_SUBMITTED, versión +1, ausencia total de intentos, CUIT válido, cliente activo y coincidencia exacta de CUIT/IVA con Customer. Sólo permite variar `customerSnapshot.cuit` y la pareja IVA; todos los demás datos comerciales congelados conservan su protección. AUTHORIZED y los documentos con intentos permanecen protegidos. Las pruebas incluyen intentos SQL directos de modificar nombre o CUIT no coincidente y rollback de auditoría.

Se aplicó mediante `pnpm db:migrate`. Prisma informa 27 migraciones aplicadas y no detecta diferencias entre schema y base. Las pruebas de migración verifican instalación desde cero, actualización conservando datos existentes y restricciones; los triggers también tienen pruebas funcionales porque el diff declarativo de Prisma no los describe.

## Tipo de comprobante y pantalla

La propuesta usa el alcance del emisor que ya admitía el mapper V5, los tipos oficiales y `ClaseCmp` de la condición estructurada. No deduce IVA desde texto libre ni agrega tipos fuera de A/B/C. Si hay una única opción la preselecciona en el borrador, sin guardarlo silenciosamente; si hay varias mantiene la decisión explícita. Si las referencias completas no admiten ninguna opción, informa la incompatibilidad.

La pantalla READY muestra el resumen del cliente, CUIT, IVA, comprobante, punto e importes y “Autorizar en ARCA”. La checklist y la consulta manual de numeración quedan en “Diagnóstico fiscal”, cerrado inicialmente y sólo disponible para ADMIN. La confirmación muestra HOMOLOGACIÓN, ausencia de efecto fiscal real y el resumen completo. Sólo “Confirmar autorización de prueba” llama a la autorización.

Se conservaron los componentes y estilos del producto. Los cambios visuales se limitan al resumen fiscal, datos del cliente y configuración del punto de venta. El resumen fiscal mantiene dos columnas en teléfonos y coloca la acción principal antes del diagnóstico.

## Evidencia y límites de verificación

Playwright trabajó con una base desechable, sesión ADMIN de prueba y proveedor ARCA simulado. La ruta de autorización estuvo bloqueada adicionalmente en el navegador. Se comprobaron:

- Navegación Producto → Cliente → Remito → Factura.
- Remito confirmado preparado por API de prueba, seguido de creación de factura, precios, IVA, READY y apertura de confirmación desde la UI.
- Tipo A propuesto automáticamente y datos del cliente heredados en la nueva factura.
- CUIT faltante e IVA faltante completados inline, con persistencia verificada desde el editor del cliente.
- Diagnóstico plegado, ausencia de requests provocados por abrir/cerrar confirmación y layout sin desborde horizontal a 390 px.
- Resumen y confirmación en escritorio, y formulario de cliente en escritorio/teléfono.
- Apertura con acceso no disponible y referencias vencidas en la fixture: una sola adquisición y actualización automática, verificadas mediante contadores del proveedor.
- Espera retryAfter simulada en el transporte del navegador: autorización deshabilitada, mensaje humano y recuperación automática al vencer el plazo. El respeto real del bloqueo del backend se verifica por separado en integración.
- Respuestas con fecha de vencimiento repetida y anterior al reloj del browser: como máximo un refresco por esa fecha, sin ciclo de requests.

La doble ejecución inicial de effects de React en desarrollo puede enviar solicitudes abortadas adicionales; el single-flight del servidor evita repetir el trabajo externo. Las pruebas concurrentes comprueban una sola adquisición, refresh y consulta de numeración para la misma preparación.

Capturas locales: `artifacts/v6-ready-desktop.png`, `v6-ready-mobile.png`, `v6-confirmation-desktop.png`, `v6-inline-vat.png`, `v6-customer-desktop.png`, `v6-customer-mobile.png` y `v6-complete-flow.png`. La fixture terminó con cero envíos y su estado privado de sesión fue eliminado.

Las pruebas de integración cubren permisos, tenant, CSRF, cuerpo estricto, herencia en READY, actualización inline, auditoría, inmutabilidad, POS único/múltiple, reutilización, referencias vencidas, acceso recuperable, retryAfter, single-flight, consulta automática y nueva validación al autorizar. Los tests existentes de acceso cifrado cubren restauración tras restart, expiración y ausencia de nuevos loginCms innecesarios.

La verificación local real ejecutó únicamente preparación y consultas. El acceso figura AUTHENTICATED y las referencias se guardaron automáticamente. ARCA devolvió 602 sin puntos de venta para este emisor: por eso el sistema local todavía requiere configurar un punto habilitado en ARCA y confirmarlo una vez en MaxBio. No se alteraron reservas de acceso ni se solicitó CAE. La credencial permaneció ACTIVE y el número de intentos fiscales no cambió.

QA final ejecutado:

| Comprobación                                                                                | Resultado                                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm lint`                                                                                 | Exit 0, sin errores                                                               |
| `pnpm format:check`                                                                         | Exit 0                                                                            |
| `pnpm typecheck`                                                                            | Exit 0                                                                            |
| `pnpm test`                                                                                 | Exit 0: API 146 passed + 2 opt-in skipped; UI 84 passed                           |
| `pnpm test:database`                                                                        | Exit 0: paquete database 1 passed; API 231 passed + 3 opt-in skipped              |
| `pnpm build`                                                                                | Exit 0, API y Next compilados                                                     |
| Integración fiscal actualizada                                                              | 19 passed + fixture browser omitida en el run normal                              |
| Fixture Playwright opt-in                                                                   | Dos ejecuciones completadas, cero envíos; segunda con acceso/referencias vencidos |
| `prisma migrate status`                                                                     | 27 migraciones, base actualizada                                                  |
| `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | Exit 0, sin diferencias                                                           |
| `git diff --check`                                                                          | Sin errores                                                                       |

Los opt-in omitidos en las suites generales incluyen pruebas ajenas al cambio (PDF/BFF y archivo comercial externo) y las conexiones reales que requieren habilitación explícita. La fixture fiscal de browser se ejecutó por separado. La comprobación real de preparación y referencias sí se realizó; una emisión real permanece expresamente excluida.

## Pasos humanos restantes

1. Configurar/mantener emisor y certificado, y habilitar el punto de venta en ARCA cuando todavía no exista.
2. Elegir y confirmar una vez ese punto en MaxBio.
3. Informar una vez CUIT e IVA de cada cliente y decidir tipo sólo si hay varias alternativas válidas.
4. Revisar importes y confirmar explícitamente la autorización de prueba.

Producción continúa bloqueada. No se ejecutó FECAESolicitar real, commit ni push.

# Credenciales ARCA: ciclo de vida y cierre local

Alcance: homologación, credenciales y la prueba WSAA existente. No agrega WSFEv1, CAE,
producción, puntos de venta ni numeración fiscal.

## Inspección inicial

Repositorio limpio al comenzar, HEAD `c22ad49`. Se revisaron los diez commits anteriores,
modelo/migraciones Prisma, FiscalService, almacenamiento, OpenSSL, CSR, carga de certificado,
activación, readiness, WSAA, caché, BFF, UI y pruebas. No se mostraron claves privadas.

La organización local `179f5e71-0727-432f-b014-55cf129b9f07` tenía exactamente:

| Credencial                             | Alias               | Estado inicial       | Certificado                        |
| -------------------------------------- | ------------------- | -------------------- | ---------------------------------- |
| `e9f3ab1f-83f9-41f9-b58f-a95098286663` | MaxBio Homologacion | ACTIVE, versión 3    | CN=Computadores Test, O=AFIP, C=AR |
| `3d789d3b-1b7d-47a8-aadc-fded8430bb9a` | MaxBio Homologacion | CSR_READY, versión 1 | Ninguno                            |
| `e2bfc266-8443-46fe-b768-973c4c2de229` | MaxBioHomologacion  | REPLACED, versión 2  | Ninguno                            |

El certificado ACTIVE corresponde al CUIT 27-11024724-4 y vence el 27/10/2028.
La base registra una prueba exitosa para esa misma credencial el 28/10/2026 a las
15:29:47, hora de Buenos Aires (18:29:47 UTC). Ese antecedente no acredita una nueva llamada.

No hay relaciones de facturas, operaciones fiscales ni tickets persistidos que apunten a
ArcaCredential. AuditEvent conserva referencias históricas por recurso. Se verificaron
las relaciones SQL y todos los campos de referencias a archivos, no solo las fechas.
La solicitud pendiente no tiene certificado ni prueba exitosa asociada.

## Selección y rotación

Antes de este cambio, WSAA ya buscaba explícitamente `status=ACTIVE`, pero mediante
`findFirst`; readiness elegía la primera ACTIVE de los registros leídos. Los índices
parciales `arca_one_active` y `arca_one_pending` ya existían y se conservan.

Ahora la selección común verifica que haya como máximo una ACTIVE por organización y
ambiente. Más de una produce 409 por inconsistencia, sin firmar ni contactar WSAA.
Si no existe ninguna, la prueba responde 400: «No hay una credencial ARCA activa.»
Nunca se decide por fecha, último CSR o último archivo.

Generar B con ACTIVE A conserva A. Cargar el certificado de B solo instala en B.
La activación explícita valida otra vez certificado, CUIT, clave y versiones. Bajo el
mismo bloqueo asesor por organización y una transacción, A pasa a REPLACED y B a ACTIVE.
El commit publica ambos cambios juntos; un fallo de auditoría revierte ambos.
Después del commit se invalida el caché y se elimina el material de A ya retirada.
Una reserva WSAA en curso nunca se borra para provocar otra autenticación.

Una sustitución explícita de una solicitud pendiente descarta esa solicitud anterior;
no la confunde con una credencial que estuvo activa. Se conserva la idempotencia de
generación y se rechaza reutilizar una operación de una solicitud retirada.

## Descartar y limpiar

`POST /fiscal/arca/credentials/:id/discard` recibe únicamente `expectedVersion`.
Requiere ADMIN, sesión y pertenencia vigentes, tenant correcto y CSRF en HTTP/BFF.
Admite CSR_READY y CERTIFICATE_INSTALLED; nunca ACTIVE o REPLACED. Un retry sobre
DISCARDED reanuda el mismo descarte sin duplicar auditoría.

1. Transacción con el bloqueo fiscal: valida estado/versión y persiste DISCARDED,
   discardedAt, incremento de versión/configuración y ARCA_CREDENTIAL_DISCARDED.
2. Otra transacción verifica el estado terminal y que ningún otro registro use los
   archivos, incluyendo referencias cruzadas entre columnas. Elimina clave, CSR y,
   si existía, certificado no utilizado.
3. Solo después de eliminar todos los archivos registra secretsDeletedAt y
   ARCA_CREDENTIAL_SECRETS_REMOVED. La ausencia de un archivo en un retry es éxito.

Si falla el primer commit, no se elimina nada. Si falla la eliminación o su commit,
el registro ya es inutilizable y conserva las referencias necesarias para reintentar.
No se informa limpieza completada mientras falte el recibo persistido.
La respuesta ante un fallo de almacenamiento es 503 con un mensaje humano.

`POST /fiscal/arca/credentials/:id/cleanup`, cuerpo vacío, permite a ADMIN completar
la limpieza de DISCARDED o REPLACED y rechaza ACTIVE. La UI ofrece «Completar limpieza»
solo en historial pendiente. No se agrega un worker ni una tabla de tareas.

REPLACED mantiene alias, ambiente, CUIT, fechas, estado, replacedAt y metadata pública
del certificado si existió. Sus archivos dejan de ser necesarios para autenticación y
se eliminan después del retiro, con la misma lógica reintentable. Las referencias
opacas se conservan como recibos internos; no se envían al navegador. No hay descarga
de CSR ni reactivación de registros retirados.

La eliminación desvincula los archivos del almacenamiento privado activo. No promete
borrado físico de sectores, copias de OneDrive o backups preexistentes.

## Readiness, UI y tickets

La pantalla muestra primero ARCA: conexión, Homologación, CUIT, vencimiento y última
verificación exitosa. Debajo figura la credencial activa; solicitudes e historial y
acciones avanzadas quedan en secciones nativas colapsadas. El descarte requiere una
confirmación explícita dentro del producto. No se muestran UUIDs, claves de archivos
ni estados internos como contenido principal. Las fechas usan Buenos Aires.

«ARCA conectado» requiere una ACTIVE vigente, archivos/clave/certificado verificados,
perfil completo y evidencia de una prueba WSAA exitosa para esa misma credencial,
sin un error actual. La última verificación se obtiene del audit existente. No se
agregó una tabla ni se interpreta una CSR como evidencia de conexión.

Una prueba exitosa muestra «Conexión con ARCA verificada correctamente.» Los TA siguen
siendo secretos temporales del servidor, con caché por organización/ambiente/servicio/
credencial, margen de vencimiento y single-flight. Un TA expirado no genera credenciales.
Al reiniciar se pierde el TA de memoria, pero se conserva la reserva durable; la UI
informa hasta cuándo esperar y mantiene el antecedente real de la última verificación.

## Verificación

Las pruebas fiscales usan bases y almacenamiento temporales, certificados de fixture
y WSAA simulado; no generan ni reemplazan las credenciales de esta instalación.

Cobertura agregada: ACTIVE A con CSR B usa el certificado de A al firmar CMS; carga de
B conserva A; descarte ADMIN, 403 OPERATOR, 404 otro tenant, CSRF, versiones, audit,
fallo de audit previo a eliminación, eliminación parcial y retry idempotente; descarte
de certificado instalado elimina los tres archivos; referencias compartidas bloquean
el borrado; rotación revierte ante fallo y conserva una ACTIVE; carrera descarte/
activación; respuesta tardía de WSAA anterior a una rotación no altera la nueva ACTIVE;
corrupción con múltiples ACTIVE sin índice falla cerrada; migración desde
datos fiscales previos conserva la ACTIVE; vista principal, secciones colapsadas,
confirmación de descarte y contrato estricto BFF.

## Estado final de esta instalación

Se aplicó la migración y se llamó al mismo FiscalService que usa HTTP, con una sesión
ADMIN existente y revalidada. No se creó ninguna sesión ni se ejecutó SQL de descarte.

- ACTIVE `e9f3ab1f-83f9-41f9-b58f-a95098286663`: preservada, versión 3. Todos sus campos
  previos, incluidos updatedAt y referencias, coinciden con la inspección inicial;
  los SHA-256 de su clave, CSR y certificado también coinciden.
- CSR abandonada `3d789d3b-1b7d-47a8-aadc-fded8430bb9a`: DISCARDED, versión 2. Se eliminó
  su clave y CSR, y se comprobó la ausencia de ambos archivos en el almacenamiento
  activo. No tenía certificado, activación ni prueba exitosa asociada.
- REPLACED `e2bfc266-8443-46fe-b768-973c4c2de229`: sigue como historial, versión 2. Se
  conservó metadata, se completó replacedAt por migración y se eliminó clave/CSR con
  el mismo flujo de limpieza auditado. Nunca tuvo certificado.
- Hay exactamente una ACTIVE, ninguna solicitud pendiente, y certificateMatchesKey
  sigue siendo true. Se registraron el descarte y las dos limpiezas en audit.

No se ejecutó una nueva llamada real a WSAA. El readiness local devolvió WAITING y
canTest=false: existe una reserva durable hasta el 29/10/2026 a las 03:29:46 de Buenos
Aires (06:29:46.875 UTC). Se respetó ese bloqueo y se conservó el resultado SUCCESS
anterior. La última verificación real registrada permanece en 28/10/2026 15:29:47.
Los tests con WSAA simulado pasaron; no se presenta eso como una nueva conexión real.

El control automático de Computer Use bloqueó la inspección visual porque no pudo
determinar con suficiente certeza la URL de Chrome en Windows. No se intentó eludir
ese control. La UI se validó mediante los tests DOM automatizados, sin afirmar una
revisión visual en navegador.

## QA final

| Comando                       | Resultado                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------- |
| `pnpm lint`                   | OK, salida 0                                                                 |
| `pnpm format:check`           | OK, salida 0                                                                 |
| `pnpm typecheck`              | OK, salida 0                                                                 |
| `pnpm test`                   | OK: API 131 pasan / 2 omitidos; web 66 pasan                                 |
| `pnpm test:database`          | OK: database 1 pasa; API 210 pasan / 2 omitidos                              |
| `pnpm build`                  | OK, salida 0                                                                 |
| Fiscal HTTP y migraciones     | OK: 9 pruebas HTTP y 1 de migración; también incluidas en la batería general |
| Health web → API → PostgreSQL | OK                                                                           |
| Nueva conexión real ARCA      | NO PROBADA: reserva WSAA vigente, canTest=false                              |
| Revisión visual en navegador  | Bloqueada por el control automático; tests DOM pasan                         |

Los omitidos son pruebas opt-in del repositorio; no se contabilizan como ejecutadas.
Los logs de la batería final y las comprobaciones de preservación quedan en `artifacts/`
(ignorado por Git), sin contenido de claves privadas ni tickets. La inspección inicial
capturó solo metadata y hashes, no copias de los archivos secretos.

No se ejecutaron commit ni push. Todos los cambios quedan para revisión local.

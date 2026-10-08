# Clientes — primer incremento

Implementado sobre `475f909`, 8 de octubre de 2026. Customer representa una contraparte comercial tenant-scoped, separada de Supplier y Product. Evidencia en [customers-verification.md](customers-verification.md).

## Modelo

| Campo                                          | Persistencia                        | Regla                                                   |
| ---------------------------------------------- | ----------------------------------- | ------------------------------------------------------- |
| id / organizationId                            | UUID                                | Identidad estable; FK Restrict a Organization.          |
| name                                           | varchar(200), obligatorio           | Nombre habitual, trim, no vacío ni controles; no único. |
| kind                                           | CustomerKind, obligatorio           | HEALTH_INSURER / INSTITUTION / COMPANY / OTHER.         |
| legalName                                      | varchar(200), nullable              | Razón social declarada.                                 |
| cuit                                           | varchar(11), nullable               | Dígitos canónicos y checksum local.                     |
| taxConditionText                               | varchar(80), nullable               | Declarativo; no determina impuestos.                    |
| addressLine / locality / province / postalCode | varchar(250/120/100/20), nullable   | Domicilio sencillo, sin tablas auxiliares.              |
| contactName / phone / email                    | varchar(160/50/254), nullable       | Contacto opcional; teléfono texto, email validado.      |
| notes                                          | varchar(1000), nullable             | Notas comerciales multilínea; sin datos clínicos.       |
| version                                        | integer, inicial 1                  | Optimistic concurrency.                                 |
| createdAt / updatedAt / archivedAt             | timestamptz(3); archivedAt nullable | Baja lógica sin booleano active duplicado.              |
| searchText                                     | text, privado                       | Proyección PostgreSQL por trigger.                      |

No hay CustomerContact, Address, Patient ni Party. Los futuros documentos podrán usar `(organizationId, id)` como FK compuesta y copiar snapshots sin campos anticipados en este incremento.

## CUIT y base de datos

Los contratos aceptan once dígitos o `XX-XXXXXXXX-X`, con espacios alrededor de los guiones. Se guarda string canónico. Checksum módulo 11 con pesos `5,4,3,2,7,6,5,4,3,2`; rechaza resultado 10 y once ceros. No consulta ni afirma inscripción en ARCA, ni impone una lista fiscal rígida de prefijos.

`maxbio_valid_cuit` replica la validación en un CHECK. Unique `(organizationId, cuit)` incluye archivados; permite varios null y repetir entre tenants. No hay unicidad/fusión por nombre.

Migración nueva `20261008120000_customers`, sin modificar anteriores: enum/tabla, FK Organization Restrict, PK, uniques tenant/id y tenant/CUIT, índice tenant/archivedAt/name/id, GIN searchText gin_trgm_ops. CHECKs: nombre válido, version > 0, CUIT válido, archivedAt >= createdAt cuando existe. Función/trigger Customer de búsqueda reutiliza unaccent/pg_trgm existentes. No escribe catálogo/inventario.

## Búsqueda

Server-side, AND entre tokens, case/accent insensitive, palabras en cualquier orden. Reutiliza searchTokens/textContains de Catalog. searchText concatena name, legalName, cuit, contactName, phone y email; excluye notas/domicilio. Se recalcula en INSERT/UPDATE incluso si SQL intenta imponer searchText.

customerSearchTokens convierte únicamente patrones completos de CUIT con guiones; no modifica nombres/teléfonos ni códigos con letras. Se conservan escape LIKE, límite de tokens y q máximo 128. Listado bajo RepeatableRead, orden name/id, 20 por defecto, hasta 100. Activos por defecto; includeArchived muestra ambos con estado visible.

## API y autorización

Nest `/api/v1/customers`; Next `/api/customers`.

| Método | Ruta relativa               | Permiso          |
| ------ | --------------------------- | ---------------- |
| GET    | / y /:id                    | ADMIN / OPERATOR |
| POST   | /                           | ADMIN            |
| PATCH  | /:id                        | ADMIN            |
| POST   | /:id/archive y /:id/restore | ADMIN            |

Contratos customers.ts, Zod strict, UUID v4, límites explícitos y expectedVersion. Inputs no aceptan tenant, actores, fechas, archivedAt, searchText ni versión elegida. DTO construido explícitamente sin organizationId/searchText. No hay DELETE.

Cookie, CSRF, allowlist, cuerpo máximo 32 KiB, no-store y errores existentes. Queries y cambios scoped; IDs ajenos 404. Application exige ADMIN y revalida Membership/User/Organization/Session dentro de la transacción.

Cambios toman Customer FOR UPDATE y comparan expectedVersion. Cambio real incrementa versión; no-op con versión actual no escribe/audita. Versión obsoleta siempre 409. Archivados requieren restauración para editar y reservan CUIT. DB owner sigue privilegiado; no se afirma RLS ni protección absoluta frente a SQL administrativo.

## Idempotencia y auditoría

POST usa UUID estable y responde 200, también en replay, siguiendo el patrón de borradores existente. Advisory lock por UUID protege filas ausentes. Mismos campos canónicos en el tenant retorna el mismo cliente sin otro audit; otra carga 409, otro tenant 404. Sin infraestructura global de idempotencia.

Compara datos actuales: si el cliente fue editado y se reenvía la carga antigua, pide revisar la ficha. Nunca duplica la UUID. Un formulario nuevo es una nueva alta; no se deduplican nombres iguales.

CUSTOMER_CREATED/UPDATED/ARCHIVED/RESTORED, resourceType Customer, metadata vacía. AuditService.success y cambio comparten TransactionClient. Fallo revierte alta/edición/estado. Consultas no auditan; metadata no contiene contactos/notas.

## UX y límites

Clientes en navegación plana existente; encabezado Personas. Listado compacto con nombre, tipo español, CUIT/contacto y estado. Busca con debounce/cancelación y paginación existentes. Alta mínima nombre + tipo; secciones desplegables para datos comerciales/fiscales, domicilio, contacto y observaciones. ADMIN modifica; OPERATOR consulta.

Labels reales, foco visible, errores asociados, mensajes españoles y apertura/foco del campo inválido. Guard síncrono evita doble submit. Resultado incierto conserva UUID/carga en la pantalla, bloquea cambios y ofrece reintento/comprobar resultado. No persiste contactos en almacenamiento del navegador. 409 requiere recarga/revisión y remonta el formulario con datos actuales.

Customers no importa ni escribe Product, Supplier, SupplierCatalog o Inventory. No crea ubicación, saldo, movimiento, recepción ni conteo. No agrega Remitos, OUTBOUND, pacientes, facturación, impresión ni dependencias UI. Pruebas HTTP/PostgreSQL y navegador verifican cero efectos.

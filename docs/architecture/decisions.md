# Decisiones del bootstrap

Bootstrap: 1 de octubre de 2026. Fundación de seguridad: 4 de octubre de 2026. Catálogo: 5 de octubre de 2026. Estado: desarrollo local con Identity, Audit y Catalog. Las decisiones originales siguientes se conservan como historial; las secciones posteriores actualizan autenticación, proxies y dominio comercial.

| Decisión                                           | Motivo y consecuencia                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Next.js + NestJS + PostgreSQL + Prisma + pnpm      | Mantiene el stack pedido; separa UI y casos de uso sin dividir el dominio en servicios                                        |
| Monorepo con scripts pnpm                          | Cinco proyectos contando la raíz; no requiere Turborepo para este tamaño                                                      |
| Next.js 16.3.8 / React 19.3.0 / NestJS 12.1.2      | Versiones fijadas del framework verificadas en el registro npm                                                                |
| Prisma 7.10.0                                      | Rama estable; el tag latest consultado de Prisma 8 era un release candidate, descartado                                       |
| TypeScript 5.9.3, ESM y NodeNext para API/paquetes | Compilación compatible con decoradores Nest y cliente Prisma; se evita transpilar la API con herramientas que omitan metadata |
| ESLint 9.39.4 + Prettier                           | Configuración raíz coherente y reglas Next/React; los plugins actuales de Next no declaran compatibilidad con ESLint 10       |
| Node 22 >=22.18 y pnpm 11.9.0                      | Compatibles con el entorno existente; runtime y gestor explicitados en engines                                                |
| PostgreSQL 17.9 en Docker Compose                  | Única dependencia local, volumen persistente, publicación en loopback y health check                                          |
| UUID v4 en columnas uuid                           | Sin dependencia de extensiones del servidor ni IDs secuenciales públicos; UUID no reemplaza controles de acceso               |
| `User` global + `Membership` por organización      | Evita duplicar identidades y permite pertenecer a varias distribuidoras. El rol nunca es global                               |
| Email único global                                 | Implica reutilizar la identidad entre organizaciones; normalización y verificación de email se implementarán en Identity      |
| Organización compartida mediante `organizationId`  | Adecuado al inicio; implica disciplina de repositorios, claves compuestas y pruebas de aislamiento antes del primer módulo    |
| Fechas de baja + foreign keys Restrict             | Conserva relaciones; no ofrece una política universal de soft-delete ni sustituye la auditoría                                |
| Contratos HTTP separados                           | UI/API comparten validación de respuestas sin acoplarse a las tablas                                                          |
| API privada por defecto                            | Sin login implementado, ninguna ruta comercial queda accidentalmente abierta                                                  |
| Proxy web solo para health                         | Evita URL privada en el navegador y CORS; no es un proxy genérico de datos empresariales                                      |
| Health público sin datos empresariales             | Comprueba proceso y PostgreSQL por separado; 503 cuando falla la dependencia                                                  |
| UI sobria y navegación futura no accionable        | Sin métricas inventadas, módulos ficticios, gradientes ni librerías visuales innecesarias                                     |

## Costos y riesgos considerados antes de modelar negocio

- **Identidad global:** cambiar luego a usuarios independientes por organización requeriría migrar sesiones, unicidad y vínculos. Se eligió identidad global con pertenencias explícitas para el futuro SaaS. Identity V1 utiliza email/contraseña local y sesiones persistidas.
- **Base compartida:** separar físicamente cada tenant más adelante implicaría exportar relaciones, migrar datos y enrutar conexiones. La opción actual reduce infraestructura inicial; el alcance de tenant deberá formar parte de todos los modelos comerciales y operaciones desde su primera migración.
- **RLS diferido:** no se afirma aislamiento a nivel del motor. El guard actual solo cierra endpoints. Antes de producción multi-organización, evaluar RLS y uso de roles de DB no propietarios, además de los controles y tests de aplicación.
- **Históricos:** las fechas de baja impiden perder información por un borrado normal del caso de uso, pero Prisma aún permite deletes. Las APIs futuras no deberán exponer un borrado genérico; FK Restrict protege relaciones, no todos los datos.
- **Stock y documentos:** aún no se crearon tablas. Esto evita comprometerse prematuramente con cantidades, lotes, reservas, numeración, fiscalidad o trazabilidad que después requerirían migraciones costosas.
- **Readiness:** `SELECT 1` confirma conectividad, no verifica la versión del esquema. Aplicar migraciones forma parte obligatoria del inicio/despliegue.
- **Linting:** ESLint 9 figura deprecado en npm. Se conserva porque los plugins React, imports y accesibilidad incluidos en Next.js todavía declaran peers de ESLint 9. Actualizar a 10 cuando esos plugins admitan esa versión; no ignorar peers para forzarla.

## Decisiones deliberadamente diferidas

- Recuperación/cambio de contraseña, altas posteriores, verificación de email, proveedores externos, MFA/passkeys y administración global de identidades multi-organización. Login, sesiones, selección y autorización básica ya están implementados.
- Retención y acceso al historial; protección adicional contra modificación directa por administradores de DB. Auditoría persistida/transaccional y metadata limitada ya están implementadas.
- RLS, aislamiento de archivos y política productiva de secretos, TLS, backups y recuperación.
- Clientes y ampliaciones fiscales/económicas del catálogo. Product, identificadores, unidad/presentación y proveedores V1 ya están definidos en Catalog.
- Movimientos, reservas, disponibilidad, lotes, series, vencimientos y concurrencia.
- Ciclo de vida y numeración de remitos; formatos de impresión y relación con facturación.
- ARCA y ANMAT/SNT: alcance real, credenciales, certificados, ambientes y requisitos aplicables a validar en su etapa.
- Almacenamiento de archivos, email, mensajería, IA y herramientas autorizadas.
- Jobs, colas/outbox e infraestructura adicional únicamente ante una necesidad comprobada.
- Entorno productivo, CI/CD, observabilidad extendida y estrategia de despliegue.

Al terminar el bootstrap no existían módulos comerciales. Catalog se añadió el 5 de octubre; inventario, scanner, remitos, facturación, ARCA, ANMAT, presupuestos, WhatsApp, email, IA, analytics y microservicios siguen diferidos. No se hicieron commits ni pushes.

## Identity y Audit — 4 de octubre de 2026

| Decisión                                       | Motivo y consecuencia                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Email/contraseña sin proveedor externo         | Minimiza dependencias y mantiene control local de identidad                                                                          |
| Argon2id: 64 MiB, t=3, p=1                     | Hash moderno con salt y PHC mediante `argon2`; rehash en login cuando cambian parámetros                                             |
| Sesiones opacas server-side                    | Token aleatorio de 256 bits; solo SHA-256 del verificador en DB; revocación inmediata en siguientes requests                         |
| Cookie HttpOnly host-only persistente          | Sin localStorage; Secure y prefijo __Host- en producción, SameSite=Lax y Path=/                                                      |
| 180 días absolutos + 30 días de inactividad    | Reduce interrupciones operativas sin sesiones eternas; configuración central                                                         |
| Actividad condicional cada 15 minutos          | Evita write por request y nunca revive una sesión revocada/expirada                                                                  |
| Renovación sin rotación por request            | Evita carreras entre pestañas; cada login genera token nuevo; robo/replay requiere revocación o expiración                           |
| Pertenencia activa por sesión con FK compuesta | No permite pertenencia ajena; organización y rol se derivan de DB                                                                    |
| Tenant obligatorio por defecto                 | IdentityOnly es una excepción explícita de lifecycle; Roles exige rol del tenant activo                                              |
| Origin exacto + header obligatorio             | CSRF en Next y guard global Nest, incluido login; sin CORS abierto ni confianza en Host/forwarded headers                            |
| Limiter de memoria acotado                     | Una instancia, ventana de 15 min; 10/email, 30/IP de conexión, 4 hashes simultáneos; reinicios y distribución son límites explícitos |
| Sin IP/UA persistidos                          | DeviceName opcional; minimiza datos personales y no hace fingerprinting                                                              |
| AuditService con TransactionClient             | Cambio y éxito se confirman juntos; metadata semántica con allowlist; login fallido no almacena email ni actor supuesto              |
| Bootstrap CLI bloqueado e idempotente          | Variables temporales, contraseña leída sin eco; no credenciales conocidas ni sustitución de identidad existente                      |
| Admin empresarial no es admin global           | Administración application-only de identidades exclusivas del tenant; las compartidas requieren política futura                      |

Detalle y límites en [authentication.md](authentication.md). Se preserva la migración inicial y se añade `20261004120000_identity_sessions_audit`; no se usó db push.

## Catalog — 5 de octubre de 2026

| Decisión                                 | Motivo y consecuencia                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Catálogo tenant-scoped                   | Cada entidad pertenece a Organization; no existe un catálogo global compartido                                                    |
| Un módulo coherente Catalog              | Seis entidades en un flujo pequeño; controller REST, application service transaccional y reglas puras, sin repositorios genéricos |
| Scope explícito y FKs compuestas         | Lecturas/escrituras con RequestActorContext; PostgreSQL impide asociaciones cross-tenant                                          |
| Product sin stock ni precios             | La identidad descriptiva no sustituye inventario ni hechos económicos                                                             |
| UnitOfMeasure separado de presentation   | Enum pequeño de medidas; texto de empaque; conversiones diferidas                                                                 |
| Código propio como ProductIdentifier     | Un único lugar para códigos; GTIN con checksum/canonización a 14; internos conservadores                                          |
| Unicidad histórica de códigos y vínculos | Archivado conserva titulares; no hay reutilización/reasignación silenciosa                                                        |
| Brand/Category planas y normalizadas     | Evita duplicados triviales con unique/CHECK; altas inline y administración secundaria                                             |
| manufacturerName como texto              | No existe una necesidad inmediata de una entidad Manufacturer                                                                     |
| SupplierProduct sin costo                | Oferta/código del proveedor, no compra ni fuente económica                                                                        |
| expectedVersion + locks con scope        | Detecta ediciones obsoletas con 409; versión de producto también protege identificadores y altas de vínculos                      |
| Auditoría en la transacción              | Fallo de AuditService revierte el cambio; metadata comercial vacía, sin DTO/contactos                                             |
| ADMIN modifica, OPERATOR consulta        | Política conservadora sobre guards existentes, revalidada en application y centralizada en UI                                     |
| Paginación offset acotada                | 20 por defecto, máximo 100; relaciones y selectores paginados; búsquedas PostgreSQL sin infraestructura adicional                 |
| Proxy comercial restringido              | Whitelist concreta de rutas/métodos/contratos, CSRF, cookie de sesión, límites y timeout; URL privada en servidor                 |
| Snapshots en documentos futuros          | Nombre/código histórico no dependerán solo de Product actual; documentos todavía diferidos                                        |
| Sin dependencias nuevas                  | Se reutiliza infraestructura existente y no se limpia configuración de agentes                                                    |

Detalles, endpoints, constraints e índices en [catalog.md](catalog.md). No se implementan Inventory, Scanner, Remitos ni campos económicos.

## Referencias técnicas

- [Instalación de Next.js](https://nextjs.org/docs/app/getting-started/installation).
- [Cambios y requisitos de NestJS 12](https://docs.nestjs.com/migration-guide).
- [Generador Prisma Client de la rama 7](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators).
- [Autenticación y guards globales en NestJS](https://docs.nestjs.com/security/authentication).

Las versiones concretas se obtuvieron del registro npm y quedan resueltas en `pnpm-lock.yaml`; las páginas de documentación pueden describir versiones posteriores.

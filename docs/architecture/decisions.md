# Decisiones del bootstrap

Fecha: 1 de octubre de 2026. Estado: base inicial local, sin módulos comerciales.

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

- **Identidad global:** cambiar luego a usuarios independientes por organización requeriría migrar sesiones, unicidad y vínculos. Se eligió identidad global con pertenencias explícitas para el futuro SaaS. No se decidió todavía un proveedor de autenticación ni almacenamiento de contraseñas.
- **Base compartida:** separar físicamente cada tenant más adelante implicaría exportar relaciones, migrar datos y enrutar conexiones. La opción actual reduce infraestructura inicial; el alcance de tenant deberá formar parte de todos los modelos comerciales y operaciones desde su primera migración.
- **RLS diferido:** no se afirma aislamiento a nivel del motor. El guard actual solo cierra endpoints. Antes de producción multi-organización, evaluar RLS y uso de roles de DB no propietarios, además de los controles y tests de aplicación.
- **Históricos:** las fechas de baja impiden perder información por un borrado normal del caso de uso, pero Prisma aún permite deletes. Las APIs futuras no deberán exponer un borrado genérico; FK Restrict protege relaciones, no todos los datos.
- **Stock y documentos:** aún no se crearon tablas. Esto evita comprometerse prematuramente con cantidades, lotes, reservas, numeración, fiscalidad o trazabilidad que después requerirían migraciones costosas.
- **Readiness:** `SELECT 1` confirma conectividad, no verifica la versión del esquema. Aplicar migraciones forma parte obligatoria del inicio/despliegue.
- **Linting:** ESLint 9 figura deprecado en npm. Se conserva porque los plugins React, imports y accesibilidad incluidos en Next.js todavía declaran peers de ESLint 9. Actualizar a 10 cuando esos plugins admitan esa versión; no ignorar peers para forzarla.

## Decisiones deliberadamente diferidas

- Login, sesiones, recuperación, proveedor de identidad, selección de organización y permisos aplicados a casos de uso.
- Auditoría persistida y transaccional, retención, acceso al historial y redacción de datos sensibles.
- RLS, aislamiento de archivos y política productiva de secretos, TLS, backups y recuperación.
- Modelo de producto, identificadores, unidades, proveedores y clientes.
- Movimientos, reservas, disponibilidad, lotes, series, vencimientos y concurrencia.
- Ciclo de vida y numeración de remitos; formatos de impresión y relación con facturación.
- ARCA y ANMAT/SNT: alcance real, credenciales, certificados, ambientes y requisitos aplicables a validar en su etapa.
- Almacenamiento de archivos, email, mensajería, IA y herramientas autorizadas.
- Jobs, colas/outbox e infraestructura adicional únicamente ante una necesidad comprobada.
- Entorno productivo, CI/CD, observabilidad extendida y estrategia de despliegue.

No se implementaron catálogo, inventario, scanner, remitos, facturación, ARCA, ANMAT, presupuestos, WhatsApp, email, IA, analytics ni microservicios. No se hicieron commits ni pushes como parte del bootstrap.

## Referencias técnicas

- [Instalación de Next.js](https://nextjs.org/docs/app/getting-started/installation).
- [Cambios y requisitos de NestJS 12](https://docs.nestjs.com/migration-guide).
- [Generador Prisma Client de la rama 7](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators).
- [Autenticación y guards globales en NestJS](https://docs.nestjs.com/security/authentication).

Las versiones concretas se obtuvieron del registro npm y quedan resueltas en `pnpm-lock.yaml`; las páginas de documentación pueden describir versiones posteriores.

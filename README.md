# MaxBio

Base para el sistema de gestión de una distribuidora de productos médicos argentina. Este bootstrap incluye un shell web, una API REST y una base PostgreSQL. Los módulos de negocio se desarrollarán por separado.

## Requisitos

- Node.js 22, versión 22.18.0 o superior dentro de la rama 22.
- pnpm 11.9.0 (`npm install --global pnpm@11.9.0`).
- Docker con Compose v2, iniciado y usando contenedores Linux.
- Puertos locales 3000, 3001 y 15432 disponibles.

No se necesitan cuentas externas ni servicios pagos.

## Primer inicio

Desde la raíz del repositorio, en PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item apps/web/.env.example apps/web/.env.local
pnpm install --frozen-lockfile
pnpm db:up
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev
```

En macOS/Linux, reemplazar los dos comandos `Copy-Item` por `cp`. No sobrescribir archivos `.env` propios al actualizar una instalación.

Abrir <http://localhost:3000>. El inicio debe mostrar **El sistema está conectado**. El botón **Comprobar conexión** vuelve a consultar PostgreSQL a través de la API. No hay usuarios de prueba, login simulado ni información comercial ficticia. El seed es idempotente y crea únicamente la organización MaxBio.

Para trabajar con terminales separadas, después de preparar la base:

```powershell
pnpm dev:api
```

```powershell
pnpm dev:web
```

`pnpm dev` compila los paquetes compartidos antes de arrancar. La API recompila TypeScript y reinicia Node al cambiar sus archivos; Next.js tiene recarga automática. Si modificás `packages/contracts` o `packages/database`, reiniciá `pnpm dev` para recompilarlos. No se agregó un orquestador de monorepo.

## Estructura

```text
apps/
  web/                       Next.js App Router, shell y proxy de health
  api/
    src/common/              Acceso por defecto cerrado y errores HTTP
    src/config/              Validación de entorno
    src/infrastructure/      Ciclo de vida de conexión PostgreSQL
    src/modules/health/      Único módulo funcional inicial
    test/                    Pruebas HTTP del bootstrap
packages/
  contracts/                 Contratos HTTP con validación de runtime
  database/                  Prisma, migraciones y seed
docs/architecture/           Límites, decisiones y trabajo diferido
```

## Variables de entorno

| Archivo               | Variable                                            | Uso                                                                             |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `.env`                | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Creación de PostgreSQL local                                                    |
| `.env`                | `POSTGRES_PORT`                                     | Puerto publicado en loopback; predeterminado 15432 (5432 dentro del contenedor) |
| `.env`                | `DATABASE_URL`                                      | URL privada utilizada por API y Prisma CLI                                      |
| `.env`                | `API_HOST`, `API_PORT`                              | Escucha de la API; 127.0.0.1:3001 por defecto                                   |
| `.env`                | `NODE_ENV`                                          | development, test o production                                                  |
| `apps/web/.env.local` | `API_BASE_URL`                                      | Dirección privada de NestJS para el servidor Next.js                            |

Los archivos reales se excluyen de Git. Si cambiás usuario, contraseña, base o puerto, actualizá también `DATABASE_URL`. Si cambiás el puerto de la API, actualizá `API_BASE_URL` y reiniciá los servidores. Las credenciales iniciales son exclusivamente locales.

La imagen de PostgreSQL inicializa credenciales solo cuando el volumen está vacío. Modificar `.env` no cambia una base existente. `pnpm db:down` conserva el volumen; volver a levantarlo conserva la información.

## Endpoints y errores

- `GET http://127.0.0.1:3001/api/v1/health/live`: proceso disponible, sin consulta a la base.
- `GET http://127.0.0.1:3001/api/v1/health`: readiness, ejecuta `SELECT 1`; devuelve 200 o 503.
- `GET http://localhost:3000/api/system-status`: proxy web hacia readiness, timeout y validación del contrato.

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/v1/health
Invoke-RestMethod http://localhost:3000/api/system-status
```

Los errores de API comparten `statusCode`, `code`, `message`, `requestId`, `timestamp` y `path`, con `details` opcional para validación. `X-Request-Id` permite relacionar la respuesta con el log. No se envían stacks ni mensajes de drivers. Las respuestas de health no se cachean. La web usa el mismo origen; no necesita CORS abierto.

**La autenticación aún no está implementada.** El guard global deniega toda ruta sin `@Public()`. Las únicas rutas públicas de NestJS son los dos health checks. No existe una API de organizaciones, usuarios ni productos. `Membership` prepara la pertenencia y el rol, pero no constituye por sí sola un sistema completo de aislamiento. Ver las condiciones previas al primer módulo en [arquitectura](docs/architecture/overview.md).

## Calidad y build

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:database
pnpm build
```

`pnpm test` ejecuta pruebas HTTP con NestJS y el runner nativo de Node; no necesita PostgreSQL. `pnpm test:database` necesita la base migrada: comprueba pertenencias, unicidad y restricciones de claves foráneas usando fixtures identificados por UUID que elimina al terminar. Usar una base de desarrollo/pruebas.

La evidencia del bootstrap y sus límites están en [verification.md](docs/architecture/verification.md).

El build no requiere una base activa. Para probar las aplicaciones compiladas, ejecutar `pnpm --filter @maxbio/api start` y `pnpm --filter @maxbio/web start` en terminales separadas. En un despliegue futuro las variables se inyectarán desde el entorno; los archivos locales no son parte del build.

## Migraciones y convenciones

- IDs UUID v4 y fechas UTC en `timestamptz(3)`; presentación local en la UI cuando haya fechas de negocio.
- `Organization.archivedAt`, `User.disabledAt`, `Membership.revokedAt`; relaciones con `onDelete: Restrict`.
- El email global es único. El futuro caso de uso de identidad deberá normalizarlo antes de escribir.
- Cambios de esquema: `pnpm db:migrate:dev --name nombre_descriptivo`, revisar SQL y versionar la migración. Instalaciones existentes: `pnpm db:migrate`.
- No usar `db push` para sustituir migraciones ni editar una migración ya aplicada.
- Código y nombres de entidades en inglés; textos de usuario y documentación en español.
- Los módulos pertenecen a un dominio. Crear capas cuando exista código que las necesite; no carpetas vacías.
- ESLint impide importar Prisma, PostgreSQL y NestJS desde la web. Compartir contratos, no modelos de persistencia.

## Alcance y próximo paso

No se implementaron catálogo, inventario, scanner, remitos, facturación, ARCA, ANMAT, presupuestos, mensajería, IA, analytics ni microservicios. Tampoco login, administración de usuarios, auditoría persistida, RLS o despliegue productivo.

El siguiente paso recomendado es definir identidad, sesiones y selección segura de organización; comprobar aislamiento entre dos organizaciones antes de exponer el primer módulo. Luego analizar el catálogo real con los usuarios. Las decisiones de dominio de stock, documentos e integraciones están registradas en [decisiones](docs/architecture/decisions.md).

# MaxBio

Sistema de gestión de una distribuidora de productos médicos argentina. Incluye web, API REST, PostgreSQL, Identity, Audit y el primer módulo comercial: **Catálogo** (productos, identificadores, proveedores, marcas y categorías por organización).

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
# Crear el primer administrador siguiendo la sección siguiente.
pnpm dev
```

En macOS/Linux, reemplazar los dos comandos `Copy-Item` por `cp`. No sobrescribir archivos `.env` propios al actualizar una instalación.

Abrir <http://localhost:3000>. Iniciar sesión con el administrador propio. Las siguientes visitas entran directamente mientras la sesión siga vigente. Después del login aparecen **Productos**, **Proveedores**, el estado de conexión y **Cerrar sesión**. El seed sigue siendo idempotente y crea únicamente la organización MaxBio; no hay credenciales conocidas ni usuarios de prueba.

## Usar el catálogo

En la ficha de **Proveedores**, abrí **Catálogo**. ADMIN puede elegir **Importar lista**, cargar CSV/XLSX, elegir hoja/columnas, revisar y confirmar. OPERATOR consulta referencias e historia. La búsqueda transversal está en **Referencias de proveedores**. Importar una lista no crea Products, identificadores, asociaciones ni stock.

Detalles, límites y mantenimiento en [Supplier Catalog](docs/architecture/supplier-catalog.md). `pnpm catalog:cleanup` elimina solamente inspecciones/previews vencidos; preserva todas las importaciones confirmadas. Ejecutarlo regularmente al desplegar.

En **Productos → Nuevo producto**, completar nombre y unidad; código interno, marca, categoría y presentación son opcionales. Marca y categoría pueden crearse dentro del formulario. Los datos complementarios están en «Más datos». Guardar abre la ficha: permite editar, agregar identificadores y asociar/crear proveedores con su código comercial. La búsqueda encuentra nombre, códigos, GTIN, marca, fabricante y código de proveedor; los filtros son opcionales.

**Proveedores** permite buscar, consultar contactos, crear y editar. Sus fichas muestran productos asociados. **Productos → Administrar marcas y categorías** permite cambiar nombres y archivar/restaurar opciones. Todas las listas y selectores están paginados. **Incluir archivados** permite recuperar registros históricos; el archivado nunca libera identificadores para otro producto.

ADMIN puede modificar el catálogo. OPERATOR puede consultar y buscar; los controles de escritura están ocultos y la API rechaza mutaciones. Si otra persona modificó un registro, el formulario muestra el conflicto y permite cargar la información actual antes de guardar. Presentación (por ejemplo, «Caja x 100») y unidad (por ejemplo, «Unidad») son conceptos separados: no hay conversiones de cantidades.

Modelo, constraints, endpoints y decisiones en [catalog.md](docs/architecture/catalog.md).

## Crear el primer administrador

Después de migrar y ejecutar el seed, en PowerShell (contraseña de 15 a 128 caracteres; conviene una frase larga):

```powershell
$env:MAXBIO_BOOTSTRAP_EMAIL = Read-Host 'Email del administrador'
$env:MAXBIO_BOOTSTRAP_NAME = Read-Host 'Nombre'
$adminPassword = Read-Host 'Contraseña' -AsSecureString
try {
  $env:MAXBIO_BOOTSTRAP_PASSWORD = [System.Net.NetworkCredential]::new('', $adminPassword).Password
  pnpm admin:bootstrap
} finally {
  Remove-Item Env:MAXBIO_BOOTSTRAP_EMAIL, Env:MAXBIO_BOOTSTRAP_NAME, Env:MAXBIO_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue
  $adminPassword.Dispose()
}
```

Las variables son temporales; no escribirlas en `.env`, Git ni argumentos de CLI. El comando crea usuario, pertenencia ADMIN y auditoría en una transacción con bloqueo. Repetirlo para el mismo administrador es idempotente y no cambia su contraseña. Rechaza otro primer admin o una identidad preexistente; no es un mecanismo de recuperación ni de administración de usuarios. En macOS/Linux cargar las mismas tres variables mediante prompts privados y eliminarlas al terminar.

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
  web/                       Next.js App Router, login y proxies limitados
  api/
    src/common/              Acceso por defecto cerrado y errores HTTP
    src/config/              Validación de entorno
    src/infrastructure/      Ciclo de vida de conexión PostgreSQL
    src/modules/health/      Liveness/readiness
    src/modules/identity/    Login, sesiones, organización activa y bootstrap
    src/modules/audit/       Eventos persistidos y transaccionales
    test/                    Pruebas HTTP del bootstrap
packages/
  contracts/                 Contratos HTTP con validación de runtime
  database/                  Prisma, migraciones y seed
docs/architecture/           Límites, decisiones y trabajo diferido
```

## Variables de entorno

| Archivo               | Variable                                            | Uso                                                                                       |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `.env`                | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Creación de PostgreSQL local                                                              |
| `.env`                | `POSTGRES_PORT`                                     | Puerto publicado en loopback; predeterminado 15432 (5432 dentro del contenedor)           |
| `.env`                | `DATABASE_URL`                                      | URL privada utilizada por API y Prisma CLI                                                |
| `.env`                | `API_HOST`, `API_PORT`                              | Escucha de la API; 127.0.0.1:3001 por defecto                                             |
| `.env`                | `NODE_ENV`                                          | development, test o production                                                            |
| `apps/web/.env.local` | `API_BASE_URL`                                      | Dirección privada de NestJS para el servidor Next.js                                      |
| Ambos entornos        | `WEB_ORIGIN`                                        | Origen público exacto, por defecto `http://localhost:3000`; HTTPS explícito en producción |
| `.env`                | `SESSION_ABSOLUTE_DAYS`                             | Límite desde login, predeterminado 180 días                                               |
| `.env`                | `SESSION_IDLE_DAYS`                                 | Inactividad renovable, predeterminado 30 días                                             |
| `.env`                | `SESSION_ACTIVITY_MINUTES`                          | Intervalo mínimo de escritura por actividad, predeterminado 15 minutos                    |

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

El guard global autentica con sesiones server-side y exige una pertenencia/organización válida por defecto. Solo health y login son públicos. Las rutas de lifecycle con `@IdentityOnly()` permiten seleccionar organización cuando hay varias; las futuras rutas empresariales no deben usar esa excepción. `@Roles('ADMIN')` exige el rol de la pertenencia activa. No se confía en headers de usuario/tenant.

La contraseña usa Argon2id. La cookie HttpOnly contiene un token aleatorio de 256 bits; la base guarda únicamente SHA-256 del token. Cada login crea un dispositivo independiente. Hay renovación silenciosa por actividad, logout actual, listado/revocación de sesiones propias y cierre de todas. Nunca se supera el límite absoluto ni se renueva una sesión expirada. Ver [autenticación](docs/architecture/authentication.md) para CSRF, endpoints, revocación administrativa desde application layer y límites.

## Calidad y build

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:database
pnpm build
```

`pnpm test` ejecuta pruebas HTTP, contratos, reglas de identificadores y seguridad con el runner nativo de Node, sin PostgreSQL. `pnpm test:database` necesita la base migrada: prueba constraints, autenticación y catálogo HTTP real, roles, tenant, concurrencia, revocación y auditoría transaccional. Usa fixtures UUID que elimina al terminar. Usar una base de desarrollo/pruebas.

La evidencia del bootstrap y sus límites están en [verification.md](docs/architecture/verification.md).

El build no requiere una base activa. Para probar las aplicaciones compiladas, ejecutar `pnpm --filter @maxbio/api start` y `pnpm --filter @maxbio/web start` en terminales separadas. Para login HTTP local con la web compilada, definir también `WEB_ORIGIN=http://localhost:3000` en `apps/web/.env.local` y mantener la API en `NODE_ENV=development`. En producción ambos procesos deben tener configuración productiva y un origen HTTPS explícito. En un despliegue futuro las variables se inyectarán desde el entorno; los archivos locales no son parte del build.

## Migraciones y convenciones

- IDs UUID v4 y fechas UTC en `timestamptz(3)`; presentación local en la UI cuando haya fechas de negocio.
- `Organization.archivedAt`, `User.disabledAt`, `Membership.revokedAt`; relaciones con `onDelete: Restrict`.
- El email global es único. Identity y bootstrap lo normalizan a minúsculas. Usuarios anteriores sin `passwordHash` no pueden autenticarse; la migración no inventa credenciales.
- Cambios de esquema: `pnpm db:migrate:dev --name nombre_descriptivo`, revisar SQL y versionar la migración. Instalaciones existentes: `pnpm db:migrate`.
- No usar `db push` para sustituir migraciones ni editar una migración ya aplicada.
- Código y nombres de entidades en inglés; textos de usuario y documentación en español.
- Los módulos pertenecen a un dominio. Crear capas cuando exista código que las necesite; no carpetas vacías.
- ESLint impide importar Prisma, PostgreSQL y NestJS desde la web. Compartir contratos, no modelos de persistencia.

## Alcance y próximo paso

Catálogo está implementado. No se implementaron inventario, scanner, remitos, facturación, ARCA, ANMAT, presupuestos, mensajería, IA, analytics ni microservicios. Quedan diferidos panel administrativo de usuarios, recuperación/cambio de contraseña, RLS y despliegue productivo. El limiter es local a una instancia, no distribuido.

El siguiente paso recomendado es probar Catálogo con los usuarios y datos reales para ajustar vocabulario, códigos y búsquedas. Antes de Inventory, definir unidades/conversiones y el modelo de movimientos. Esta entrega se detiene en Catálogo. Las decisiones de dominio están registradas en [decisiones](docs/architecture/decisions.md).

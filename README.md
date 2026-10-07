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

En la ficha de **Proveedores**, abrí **Catálogo**. ADMIN puede elegir **Importar lista**, cargar CSV/XLSX, **Analizar**, revisar el modelo normalizado y confirmar. MaxBio interpreta hoja, encabezados y columnas automáticamente; datos no informados se muestran «—». Asigna códigos propios estables (A000001), aplica techo a centavos y ARS por defecto, y aprende formatos al confirmar. OPERATOR consulta referencias e historia. **Listas de proveedores** permite buscar por palabras en cualquier orden, sin tildes, filtrar proveedor y ordenar por código/nombre/proveedor/precio. Importar no crea Products, identificadores, asociaciones ni stock, y nunca ejecuta fórmulas/macros ni abre enlaces. Ver [importador automático](docs/architecture/supplier-catalog-automatic.md) y [verificación](docs/architecture/supplier-catalog-automatic-verification.md).

**Identificar producto** admite scanner HID USB/Bluetooth o código manual + Enter. ADMIN y OPERATOR pueden resolver, buscar una referencia, comparar productos existentes o crear uno básico y confirmar explícitamente. Guarda identificador y `SupplierCatalogItem → SupplierProduct → Product` en una transacción auditable e idempotente. El mismo código vuelve a reconocer el producto. GTIN exige checksum; externos necesitan proveedor explícito. Las listas tienen filtros de asociación. Ver [identificación/scanner](docs/architecture/product-identification.md).

Detalles, límites y mantenimiento en [Supplier Catalog](docs/architecture/supplier-catalog.md). `pnpm catalog:cleanup` elimina solamente inspecciones/previews vencidos; preserva todas las importaciones confirmadas. Ejecutarlo regularmente al desplegar.

En **Productos → Nuevo producto**, completar nombre y unidad; código interno, marca, categoría y presentación son opcionales. Marca y categoría pueden crearse dentro del formulario. Los datos complementarios están en «Más datos». Guardar abre la ficha: permite editar, agregar identificadores y asociar/crear proveedores con su código comercial. La búsqueda encuentra nombre, códigos, GTIN, marca, fabricante y código de proveedor; los filtros son opcionales.

**Proveedores** permite buscar, consultar contactos, crear y editar. Sus fichas muestran productos asociados. **Productos → Administrar marcas y categorías** permite cambiar nombres y archivar/restaurar opciones. Todas las listas y selectores están paginados. **Incluir archivados** permite recuperar registros históricos; el archivado nunca libera identificadores para otro producto.

ADMIN puede modificar el catálogo. OPERATOR consulta y busca; puede confirmar identificaciones desde el workflow operativo. El CRUD general sigue restringido a ADMIN. Si otra persona modificó un registro, el formulario muestra el conflicto y permite cargar la información actual antes de guardar. Presentación (por ejemplo, «Caja x 100») y unidad (por ejemplo, «Unidad») son conceptos separados: no hay conversiones de cantidades.

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
    src/modules/catalog/     Productos, proveedores, listas e identificación
    src/modules/inventory/   Ingresos, conteo inicial, ledger y balance
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

`pnpm test` ejecuta pruebas HTTP, contratos, cantidades, reglas de identificadores y seguridad con el runner nativo de Node, sin PostgreSQL. `pnpm test:database` necesita una base de desarrollo/pruebas migrada: verifica Identity, Catalog e Inventory HTTP real, constraints, roles, tenant, concurrencia y rollback. Inventory y el backfill del catálogo crean y eliminan bases propias para probar el ledger inmutable; el usuario PostgreSQL de pruebas necesita CREATE DATABASE. No ejecutar contra producción. Los fixtures anteriores se eliminan por UUID.

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

Catálogo, listas, identificación HID e Inventory V1 están implementados. No se implementaron salidas comerciales, reservas, transferencias, packaging, recuento avanzado, reversión completa, cámara, parser GS1 completo, remitos, facturación, ARCA, ANMAT, presupuestos, mensajería, IA, analytics ni microservicios. Quedan diferidos panel administrativo de usuarios, recuperación/cambio de contraseña, RLS y despliegue productivo. El limiter es local a una instancia, no distribuido.

El siguiente paso es probar Inventory con usuarios, lectores HID y datos reales, validar unidades/políticas y el procedimiento de conteo gradual; luego ampliar correcciones físicas y salidas/Remitos. Las decisiones están registradas en [decisiones](docs/architecture/decisions.md).

## Inventory V1

Inicio ofrece **Ingresar productos**, **Consultar stock** e **Inventario inicial**. ADMIN debe revisar primero los requisitos de lote/vencimiento/serie del Product desde su ficha de stock; OPERATOR puede recibir y contar. Las cantidades se ingresan en Product.unitOfMeasure: la presentación no convierte cajas en unidades.

Ingreso: proveedor → código + Enter → cantidad/datos físicos → Agregar → siguiente producto → Revisar → Confirmar. El borrador se conserva y genera cero stock. Confirmar registra un movimiento auditable y su balance en una transacción; un reintento no duplica existencia. Vencidos, dañados y cuarentena siguen físicamente presentes sin disponibilidad.

Inventario inicial: sesiones pequeñas, un producto completo por toma de conteo, sin historia previa de Inventory. Hacerlo antes de recibir nueva mercadería de un producto que ya tenía existencias. Se puede retomar/cancelar el borrador; cantidad cero confirma cobertura sin movimiento artificial. Un producto con historia requiere ajuste ADMIN o recuento futuro. ADMIN puede registrar diferencias observado/registrado sobre posiciones existentes con motivo y explicación, conservando el movimiento original.

Ver [implementación y reporte completo](docs/architecture/inventory.md), [diseño original](docs/architecture/inventory-design.md) y [verificación](docs/architecture/verification.md). Para comprobar la proyección: `pnpm inventory:verify`. Reconstrucción técnica por producto: `pnpm inventory:verify --organization UUID --product UUID --rebuild`; no usarla para corregir historia de negocio. Sin salidas comerciales, el saldo representa los movimientos registrados y la cobertura mostrada.

# Identity, sesiones y auditoría

Fecha: 4 de octubre de 2026. Fundación local de seguridad; sin módulos comerciales.

## Flujo y contraseña

Navegador → proxy limitado de Next.js `/api/auth/*` → NestJS `/api/v1/auth/*` → PostgreSQL. La API debe mantenerse privada o detrás de la web. No se abrió CORS ni se agregó proveedor externo.

Email global normalizado a minúsculas y contraseña. `argon2` implementa Argon2id con 64 MiB, 3 iteraciones, paralelismo 1 y salt aleatorio de la librería. El formato PHC incluye algoritmo, versión y parámetros; después de un login válido se aplica `needsRehash` sin migración destructiva. La contraseña del primer admin admite 15–128 caracteres sin reglas de composición. El login permite contraseñas anteriores de menor longitud, con máximo 128. No hay contraseñas en respuestas, logs ni auditoría. El bootstrap preserva usuarios anteriores mediante `passwordHash` nullable; una identidad sin hash no puede entrar.

Una identidad inexistente realiza una verificación contra un hash señuelo aleatorio. Usuario inexistente, contraseña incorrecta, identidad deshabilitada o ausencia de pertenencias activas producen el mismo mensaje de login. No se promete igualdad exacta de latencia de DB/red ni resistencia absoluta a enumeración.

## Sesión por dispositivo

Cada login genera 32 bytes criptográficos con `node:crypto.randomBytes`, nuevos incluso si el navegador envía otra cookie. No se adopta un token elegido por el cliente: evita fixation. PostgreSQL guarda SHA-256 del token de alta entropía; este hash rápido es adecuado para un secreto aleatorio, no para contraseñas. Lookup indexado, sin comparar contraseñas ni tokens mediante igualdad manual. El secreto sale solo mediante `Set-Cookie`, nunca en JSON.

La sesión contiene usuario, pertenencia activa opcional, creación, última actividad, vencimiento rolling y absoluto, revocación y nombre opcional del dispositivo. La FK `(activeMembershipId,userId)` referencia `(Membership.id,userId)`. Los índices cubren búsqueda por verificador, sesiones activas de usuario y expiración. Todas las relaciones históricas usan Restrict.

Cookie host-only, Path `/`, HttpOnly, SameSite=Lax, Expires y Max-Age persistentes. Producción agrega Secure y prefijo `__Host-`; requiere HTTPS. Desarrollo usa `maxbio-session`, sin Secure para localhost. Web y API deben coincidir en modo productivo. No hay secreto en JavaScript, localStorage ni sessionStorage. La cookie no identifica de manera infalible el hardware: borrar el perfil/cookie requiere otro login y crea otra sesión.

| Política                   | Valor inicial | Comportamiento                                                       |
| -------------------------- | ------------- | -------------------------------------------------------------------- |
| `SESSION_ABSOLUTE_DAYS`    | 180           | Fecha máxima fija desde login                                        |
| `SESSION_IDLE_DAYS`        | 30            | Vencimiento silenciosamente renovable por uso                        |
| `SESSION_ACTIVITY_MINUTES` | 15            | Escritura condicional de actividad como máximo una vez por intervalo |

Cada request verifica expiración, revocación y estado de usuario/tenant en DB, sin cache de autorización. Si corresponde, actualiza `lastUsedAt` y `expiresAt = min(now + idle, absolute)`. El update incluye condiciones de vigencia: no revive una sesión revocada/expirada en una carrera con logout. Reemitir la cookie con el vencimiento vigente no implica escribir en DB. No se renueva después de expirar y no hay extensión indefinida al superar 180 días. Cambiar variables afecta sesiones nuevas y renovaciones; no reescribe límites absolutos ya emitidos.

Se mantiene el mismo secreto durante la sesión: renovación de vencimiento, no rotación por request. Rotarlo sin coordinación provoca carreras entre pestañas y dispositivos; V1 conserva un token opaco con límite fijo, revocación y HTTPS. Cada nuevo login genera otro token. El robo de una cookie sigue permitiendo replay hasta revocación/expiración; rotación coordinada y detección de compromiso quedan para una amenaza concreta.

No se persisten IP ni User-Agent ni se realiza fingerprinting. `deviceName` es una etiqueta opcional de hasta 80 caracteres, sin autoridad de seguridad. Se utiliza la IP de conexión exclusivamente en el limiter temporal de memoria, no en auditoría persistida.

## Tenant y autorización

El guard obtiene Session → User habilitado → Membership no revocada → Organization no archivada. Construye `RequestActorContext {userId,organizationId,membershipId,role,sessionId,requestId}`; el `requestId` lo genera el servidor. Ignora `x-user-id` y `x-organization-id` del cliente. No hay rol global de usuario.

Un login con una pertenencia activa la elige automáticamente. Con varias, crea sesión autenticada sin tenant y devuelve opciones válidas; la UI ofrece selección simple. `POST organization` acepta **membershipId**, verifica dueño y vigencia en servidor y persiste la selección en esa sesión. Un organizationId arbitrario o una pertenencia ajena no otorgan acceso. Revocar la pertenencia activa rechaza la sesión; no cambia silenciosamente a otra organización.

Todas las rutas son privadas y requieren tenant por defecto. `@IdentityOnly()` está reservado a lifecycle de autenticación (me, selección y sesiones). `@Roles('ADMIN')` exige el rol de la organización activa; `/auth/admin-check` lo demuestra. OPERATOR no tiene acceso. Los casos de uso empresariales futuros deben recibir el contexto explícito y filtrar cada consulta por organización; esta fundación no sustituye esos filtros ni RLS.

## Revocación

Logout revoca solo la sesión actual. El usuario puede listar/revocar sus propios dispositivos y cerrar todas sus sesiones. `revokeAllSessions` serializa contra login mediante lock del usuario. Deshabilitar desde application layer guarda `disabledAt`, revoca todas las sesiones y audita en la misma transacción. Aunque alguien cambie solo el timestamp, el guard rechaza al usuario mientras esté deshabilitado.

`IdentityService.revokeUserSession`, `revokeUserSessions` y `disableUser` preparan administración sin panel/endpoint adicional. Revalidan ADMIN, pertenencia y sesión del actor, verifican el usuario objetivo y registran auditoría. Como la identidad es global, un admin de tenant solo puede administrar una identidad con pertenencias activas exclusivamente en su organización. Un usuario ajeno o multi-organización se rechaza sin revelar datos. La política de administración global de esas identidades está diferida; no se concede a un admin empresarial por accidente.

Una operación ya autorizada/en curso puede terminar si la revocación ocurre después del check. Para operaciones sensibles futuras, revalidar dentro de la transacción y definir bloqueos según el caso de uso; no se promete cancelar requests en vuelo.

## CSRF y frontera web/API

Amenaza: un sitio atacante induce al navegador a enviar cookies de MaxBio, incluyendo login CSRF y subdominios del mismo sitio. SameSite es defensa adicional; por sí solo no cubre todos esos casos. XSS de mismo origen puede hacer requests autorizados y queda fuera de lo que CSRF puede impedir.

Todos los métodos distintos de GET/HEAD/OPTIONS requieren `Origin === WEB_ORIGIN`, `X-Maxbio-Csrf: 1` y ausencia de `Sec-Fetch-Site: cross-site`. Next.js y el guard global de NestJS aplican el control, incluso para login público. No se acepta ausencia de Origin ni fallback al Host/forwarded headers. El valor del header no es un secreto: un formulario de otro origen no puede enviarlo y JavaScript de otro origen necesitaría un preflight que no se autoriza. El proxy valida el origen original antes de reconstruirlo hacia la API.

La web exige JSON y limita cuerpos a 4 KiB; solo permite rutas/métodos conocidos, no URLs elegidas por el cliente. Reenvía exclusivamente la cookie propia y no headers de identidad o IP declarada. API aplica DTOs estrictos, límites de campos y body parser de Nest. Los errores se sanitizan. Respuestas autenticadas/proxies son `no-store`; la página estática no contiene identidad ni datos privados. La UI revalida al volver a la pestaña, restaurar la página y usarla tras el intervalo de actividad. No hay redirects elegidos por el usuario.

Al agregar operaciones comerciales: conservar guard global, exigir CSRF en cada escritura y actualizar de manera explícita los proxies. GET no debe modificar negocio. Si se cambia la topología o se habilita CORS, revisar esta estrategia antes de abrir orígenes, especialmente subdominios. Producción exige un WEB_ORIGIN HTTPS explícito en ambos procesos.

## Rate limiting

Sin Redis: memoria de una instancia, ventana fija de 15 minutos, 10 intentos por email normalizado (clave SHA-256), 30 por IP de conexión y máximo 4 verificaciones en vuelo. Se cuentan también logins correctos para limitar costo Argon2 y creación abusiva de sesiones. La tabla temporal elimina ventanas vencidas y está limitada a 10.000 claves. Devuelve 429 con mensaje humano; no persiste emails/IP del limiter.

Limitaciones: reiniciar borra contadores, distintas instancias no comparten límites y un atacante puede agotar temporalmente el cupo de un email. Como Next es el proxy, la IP en Nest es normalmente la de Next y el límite IP agrupa usuarios. No se confía en X-Forwarded-For arbitrario ni se presenta como protección distribuida. Antes de escalar, ubicar el límite IP en una frontera confiable y reemplazar el provider por contadores compartidos/infraestructura existente. No se bloquean cuentas permanentemente.

## Auditoría

AuditEvent conserva organización/actor/sesión opcionales para eventos previos al login, acción, tipo/UUID de recurso, SUCCESS/FAILURE, UUID de request, metadata JSON y fecha UTC. Eventos: INITIAL_ADMIN_CREATED, AUTH_LOGIN_SUCCEEDED, AUTH_LOGIN_FAILED, AUTH_LOGOUT, SESSION_REVOKED, USER_SESSIONS_REVOKED, USER_DISABLED y ACTIVE_ORGANIZATION_SELECTED.

`AuditService` solo expone append/success. Construye campos explícitamente y metadata con allowlist (`reason=INVALID_CREDENTIALS`, `count` entero seguro); no copia bodies, cookies, tokens, hashes ni emails. Para eventos comerciales futuros ampliar schemas semánticos de metadata, no habilitar dumps genéricos. Un login fallido tiene actor, sesión y tenant null, con la misma información para email existente e inexistente. Un intento bloqueado por rate/CSRF/DTO no genera audit de credenciales, evitando un write ilimitado por cada request malicioso.

Login, logout, selección, revocación y disable escriben cambio + evento en la misma transacción. Si falla la auditoría, se revierte el cambio y no se declara éxito. Login fallido guarda evento sin transacción de negocio. Los fallos de DB no se convierten en falsas credenciales inválidas: respuesta técnica sanitizada 500/503 según la capa. No hay auditoría exitosa de una operación fallida.

Para próximos casos de uso:

```typescript
await database.client.$transaction(async (tx) => {
  // Validar permisos y modificar exclusivamente recursos de context.organizationId.
  await audit.success(context, action, resourceType, resourceId, tx);
});
```

Append-oriented por interfaz de aplicación, sin endpoints de edición/delete. FK Restrict conserva vínculos. El propietario de DB/Prisma conserva capacidad técnica de update/delete: no es almacenamiento inmutable frente al administrador. Los tests borran únicamente sus fixtures UUID. Roles DB de privilegio mínimo, retención, export, acceso al historial y protección adicional contra manipulación quedan para producción.

## Uso local y endpoints

Seguir README para migración, seed y `pnpm admin:bootstrap` con variables temporales y contraseña leída sin eco. El seed no genera passwords. Bootstrap usa una transacción y advisory lock, es idempotente para el mismo primer admin y nunca sustituye identidades/credenciales existentes. No permite recuperar un admin bloqueado ni reactivarlo sin una operación explícita.

Los endpoints siguientes se alcanzan desde la web con `/api/auth/…`; en la API llevan `/api/v1/auth/…`:

| Método | Sufijo              | Requisito / respuesta                                                    |
| ------ | ------------------- | ------------------------------------------------------------------------ |
| POST   | login               | Público + CSRF; email/password/deviceName opcional, cookie y `{ok:true}` |
| GET    | me                  | Sesión; identidad pública, vencimientos y pertenencias válidas           |
| POST   | organization        | Sesión + CSRF; membershipId validado                                     |
| POST   | logout              | Sesión + CSRF; revoca actual y borra cookie                              |
| GET    | sessions            | Sesión; dispositivos propios sin verificadores                           |
| POST   | sessions/:id/revoke | Sesión + CSRF; revoca UUID propio                                        |
| POST   | sessions/revoke-all | Sesión + CSRF; cierra todos los dispositivos propios                     |
| GET    | admin-check         | Sesión + tenant ADMIN; organización resuelta por servidor                |

Para probar revocación propia desde la consola del navegador autenticado, sin leer el secreto:

```javascript
const devices = await (await fetch('/api/auth/sessions')).json();
// Elegir conscientemente el UUID del dispositivo a revocar.
await fetch(`/api/auth/sessions/${devices[0].id}/revoke`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Maxbio-Csrf': '1' },
  body: '{}',
});
```

La UI distingue indisponibilidad de conexión de logout/401. Revocación o expiración con cookie enviada muestra “Tu sesión terminó. Iniciá sesión nuevamente para continuar.” Si el navegador ya eliminó la cookie expirada, aparece el login normal: no existe un secreto que permita distinguir primera visita de expiración sin agregar otro marcador.

## Dependencias y decisiones diferidas

Únicas nuevas dependencias runtime: `argon2` para hashing maduro y `cookie` para parse/serialización de cookies. El build nativo de Argon2 está autorizado en pnpm. `node:crypto` aporta SHA-256, UUIDs y aleatoriedad. No hay JWT, librería grande de auth, Redis, OAuth, MFA, email ni frontend de administración.

Recuperación y cambio de contraseña, altas posteriores, email verificado, MFA/passkeys, permisos adicionales, retención, RLS, TLS/secrets/backups y despliegue están diferidos. El bootstrap local no convierte el sistema en un SaaS listo para producción. Antes de Products, usar esta fundación para diseñar alcance tenant y auditoría de cada operación. Ningún módulo comercial fue implementado en esta tarea.

Referencias: [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [node-argon2](https://github.com/ranisalt/node-argon2).

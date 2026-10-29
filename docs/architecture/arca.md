# Facturación V2: perfil fiscal y WSAA de homologación

Actualización 29/10/2026: [TA persistente y diagnóstico V4](arca-v4-persistent-ta.md) reemplaza la limitación histórica de caché solo en memoria con almacenamiento privado cifrado y recuperación tras reinicios.

Actualización V3 (28/10/2026): [Facturación WSFEv1](invoicing-v3-wsfev1.md) consume
el nuevo puerto server-side `FiscalService.authenticate`, reutilizando ACTIVE y el TA
existentes sin exponerlos a HTTP. Este documento conserva la descripción histórica V2;
V3 agrega los métodos de negocio, configuración POS e intentos fiscales separados.

Implementación del 27 de octubre de 2026 sobre `fe0a5a0c10c5d67eb8e174dca0986764b6835700`, rama `main`, working tree inicialmente limpio. No se hicieron commit ni push. [Procedimiento manual](arca-homologation-setup.md) y [reporte de verificación](arca-verification.md).

## Frontera

Organization → OrganizationFiscalProfile → ArcaIntegrationConfig → ArcaCredential / PrivateCredentialStorage → CmsSigner → ArcaWsaaClient → ArcaTicketProvider.

Todo está en `apps/api/src/modules/fiscal`; InvoicingService no depende de este módulo. Invoice, InvoiceLine, InvoiceDeliveryNote, DRAFT/READY, precios, IVA, snapshots, Remito completo, multi-remito del mismo cliente y protección contra doble facturación conservan sus reglas. Un perfil incompleto o un certificado ausente no bloquean V1.

V1 es factura interna; V2 prepara credenciales y autenticación WSAA de homologación; V3 incorporará WSFEv1/CAE; V4, PDF fiscal; V5, producción y hardening. V2 no tiene operaciones de negocio WSFEv1, punto de venta, numeración fiscal, CAE ni PDF de factura. GS1, GLN y ANMAT pertenecen a otros dominios.

## Perfil del emisor

`OrganizationFiscalProfile` tiene UUID, organizationId único, legalName, tradeName, cuit, vatCondition, grossIncomeRegime, grossIncomeNumber, addressLine, locality, province, postalCode, country, nationalActivityCode, multilateralActivityCode, version y timestamps UTC. Dirección plana, siguiendo Customers. Los datos pueden guardarse parcialmente; `COMPLETE` se deriva y no significa ARCA autenticada.

Completo requiere nombre fiscal, CUIT válido, condición IVA, domicilio completo argentino y régimen IIBB; LOCAL y MULTILATERAL_AGREEMENT requieren número. Condiciones IVA internas: RESPONSABLE_INSCRIPTO, MONOTRIBUTO, EXENTO, CONSUMIDOR_FINAL, NO_ALCANZADO. IIBB: LOCAL, MULTILATERAL_AGREEMENT, EXEMPT, NOT_APPLICABLE. No hay códigos fiscales externos inventados.

Se reutiliza la validación matemática de CUIT de Customers: once dígitos, no todos cero, módulo 11 con pesos 5/4/3/2/7/6/5/4/3/2; se rechaza resultado 10. Contratos aceptan forma canónica o con guiones y guardan solo dígitos; presentación XX-XXXXXXXX-X. La API vuelve a parsear; PostgreSQL aplica `maxbio_valid_cuit`. No se verifica inscripción de la persona en ARCA.

Creación exige expectedVersion=0; cambios, versión actual. Advisory lock por organización, update condicional e incremento de versión evitan pérdida de cambios. No se cargaron datos Bourbon por seed o migración.

## Configuración y credenciales

`ArcaEnvironment` solo admite HOMOLOGATION. ArcaIntegrationConfig fija `service=wsfe`, version y fechas/resultados no secretos de autenticación. ArcaCredential conserva ID propio, org, entorno, CN, nombre fiscal/CUIT del CSR, estado, version, operationId/hash de generación, referencias opacas de archivos y metadatos de certificado (huella SHA-256, serie, subject, issuer y vigencia).

Estados: CSR_READY → CERTIFICATE_INSTALLED → ACTIVE → REPLACED. Índices parciales aseguran como máximo una ACTIVE y una pendiente por org/entorno. La solicitud nueva crea otra clave y archivos; no sobreescribe los anteriores. Cargar un certificado no activa automáticamente. La activación exige versiones de credencial y configuración, reemplaza la activa y audita en una transacción. No se puede cargar encima de un certificado instalado: requiere nueva solicitud.

Generación usa UUID de operación y hash para replay. Si ya hay una pendiente, Generar solicitud devuelve su estado sin crear otra clave. Reemplazarla exige replacePending explícito y versión actual. La UI advierte que un certificado anterior no corresponde a la nueva solicitud.

La migración `20261027161753_fiscal_arca_homologation` fue creada con Prisma Migrate; `20261027170000_fiscal_arca_constraints` agrega invariantes sin modificar la primera ya aplicada. No se editaron migraciones históricas. No se usó db push.

## Archivos y criptografía

`PrivateCredentialStorage` es un port independiente de Printing: put/read/remove con organización explícita. LocalPrivateCredentialStorage usa `.maxbio-private-credentials` (gitignored) o ARCA_CREDENTIAL_STORAGE_DIR. Claves opacas `orgUUID/fileUUID`, comparación de tenant y ruta resuelta, sin nombres de archivo del navegador; rechaza traversal y symlinks. No tiene servidor estático ni endpoint para clave/certificado. Los archivos usan creación exclusiva; en POSIX se exigen directorios 0700 y archivos 0600. En Windows se deben configurar ACL restrictivas en el directorio y la identidad de servicio; chmod no proporciona esa garantía.

Respaldar almacenamiento privado junto con DB. Usar un directorio persistente fuera de public/ y de document roots, y una cuenta de servicio dedicada. No hay secret manager ni cifrado de secretos en DB improvisado. Las claves locales están protegidas por filesystem; una futura implementación del port podrá usar un secret manager.

Node crypto genera RSA 2048, exponente 65537 y PKCS#8 privado en el servidor. OpenSSL genera CSR PKCS#10 firmado SHA-256, subject `C=AR/O=<nombre fiscal>/CN=<alias>/serialNumber=CUIT <once dígitos>`, UTF-8 y escape de atributos. La private key nunca es un contrato HTTP. El único archivo descargable es el CSR público.

OpenSslArcaCrypto encapsula execFile sin shell, argumentos separados, archivos temporales con nombres fijos y permisos restrictivos, timeout 15 s y salida acotada. No hereda stdout/stderr. Borra únicamente sus archivos conocidos y directorio temporal en finally. Los errores descartan stderr, argumentos, rutas y causas; buffers privados se limpian al terminar. El administrador del servidor debe mantener privado también el directorio temporal del proceso. Un crash abrupto puede requerir limpieza operativa de temporales; no se promete borrado seguro de memoria/disco frente a un administrador del sistema.

Al fallar una transacción, cleanup comprueba referencias persistidas antes de eliminar archivos nuevos. Si la DB no permite determinar si hubo commit, los conserva: evita borrar una credencial válida ante resultado incierto. Reconciliar esos huérfanos excepcionalmente con DB disponible; no se elimina historia activa por antigüedad.

Upload: JSON base64 del contenido de un único certificado PEM/CRT/DER, máximo decodificado 100 KiB, máximo BFF 140000 bytes. No ZIP, PFX, clave privada, cadenas PEM múltiples ni confianza basada en extensión. X509Certificate verifica parseo; se comprueban fechas, no CA (también Basic Constraints CA:TRUE aunque falte keyCertSign), RSA >=2048, serialNumber/CUIT exacto, CN presente (1–64 caracteres, sin controles) y Key Usage digitalSignature cuando existe. WSASS emite el DN con formato fijo `SERIALNUMBER=CUIT nnnnnnnnnnn, CN=<alias>` ([manual](https://www.arca.gob.ar/ws/WSASS/html/crearcertificado.html)): no incluye C ni O y su CN es el alias elegido en WSASS, no el CN del CSR. Por eso no se exige C=AR ni igualdad con el CN del CSR; el CN emitido queda en el subject guardado y es la identidad esperada como `destination` del ticket WSAA. Un challenge aleatorio SHA256/RSA firmado con la clave privada se verifica con la pública del certificado. Se guardan PEM privado y metadatos; expired/not-yet-valid y key mismatch se rechazan. Vigencia: VALID / EXPIRING_SOON (<30 días) / EXPIRED / INVALID.

No se declara una cadena de confianza válida por parsear el archivo. V2 no incluye una CA de emisión de WSASS fijada ni validación de revocación de certificados cliente. El estado local queda PENDING_WSAA; solo WSAA autenticado verifica operativamente la aceptación y autorización. Se rechazan emisores que indiquen explícitamente producción, pero el entorno no siempre puede inferirse del X.509. La protección determinante es que ningún transporte puede dirigirse a producción.

## TRA, firma y transporte

TraFactory centraliza tiempos con ArcaClock inyectable. uniqueId es uint32 temporal monotónico dentro del proceso (segundos UNIX como base y secuencia ante coincidencias); junto con generationTime identifica la solicitud. XML tiene generationTime=UTC−2 minutos y expirationTime=UTC+10 minutos. No se incluyen source/destination opcionales en el TRA: el certificado incluido identifica al firmante.

CmsSigner es el port reemplazable. OpenSSL produce SignedData CMS DER, con certificado y contenido encapsulado exacto, binary/nodetach, codificado base64 para loginCms. Se seleccionó SHA1+RSA porque así lo exige la especificación WSAA 1.2.2 publicada actualmente; se limita a este adaptador de interoperabilidad, no a otros usos de firma. Los tests verifican CMS y CSR usando las operaciones independientes req/cms de OpenSSL.

ArcaWsaaClient solo hace SOAP loginCms. Endpoint server-side con allowlist exacta: `https://wsaahomo.afip.gov.ar/ws/services/LoginCms`. ARCA_WSAA_ENDPOINT puede repetir únicamente ese valor; cualquier otro falla en configuración y nuevamente en transporte. El navegador no puede enviar endpoint, service ni entorno. Sin redirects, sin HTTP a ARCA, timeout total 12 s, cuerpo máximo 256 KiB, validación UTF-8 y Content-Type XML. Fetch conserva verificación TLS y hostname de Node; nunca se desactiva TLS.

El parser usa SAX existente con árbol acotado: profundidad 12, 100 nodos, raíz única, tags balanceados, namespaces de SOAP y WSAA, campos únicos, estructura esperada, sin DTD/ENTITY, entidades externas ni recuperación tolerante. El ticket embebido vuelve a pasar por el parser. Se validan identidad WSAA homologación, CUIT/CN destinatario, uint32 y fechas/vigencia antes de aceptar Token/Sign. No se persiste XML SOAP/TRA/CMS ni respuesta completa. Los SOAP Fault se convierten a códigos/mensajes propios: servicio no autorizado, reloj, certificado, ya autenticado, red o rechazo general. Nunca se refleja faultstring.

## Ticket y concurrencia

ArcaTicketProvider retiene Token/Sign solo en memoria; clave incluye organización, homologación, wsfe e ID de credencial. Reutiliza tickets con más de 2 minutos de vigencia. 20 solicitudes concurrentes comparten una promesa; finally libera single-flight aun ante error. El cache se limita a 1000 tickets y elimina expirados; rotación invalida los del tenant en ese proceso. Otro proceso siempre revalida credencial/configuración en DB.

**Diferencia deliberada respecto del ejemplo de refresh anticipado:** dentro de los últimos 2 minutos no se reutiliza ni se solicita un nuevo TA. Se renueva después del vencimiento efectivo, por la restricción coe.alreadyAuthenticated del protocolo. El test cubre ese intervalo sin sleeps. Para V3 debe manejarse esta breve indisponibilidad explícitamente.

Antes de llamar a WSAA, se confirma en DB una reserva no secreta por 12 horas + 5 minutos. Permite coordinar procesos y evita que un restart o respuesta perdida cause otro loginCMS innecesario. Al éxito se ajusta al vencimiento real; ante fallo de entrega/parseo incierto se conserva el plazo máximo. Un rechazo conocido permite volver a probar manualmente después de 60 segundos y corregir su causa; no hay retries automáticos. Tras restart se pierde el secreto del ticket, por lo que puede ser necesario esperar a su vencimiento antes de autenticar de nuevo. La UI muestra la fecha. Rotación no borra esta defensa mientras pueda haber una solicitud anterior en vuelo.

Readiness no obtiene tickets ni escribe negocio. Revalida metadatos y archivos de la credencial activa y devuelve estados, fechas, IDs y metadatos permitidos. Nunca Token/Sign, claves, rutas, CSR salvo descarga dedicada, XML o CMS. El estado de autenticación previo almacenado sin ticket local no equivale a acceso operativo disponible.

## API, BFF, permisos y auditoría

Todas las rutas requieren ADMIN; OPERATOR no consulta configuración fiscal ni certificados. Organización proviene de RequestActorContext. Las escrituras vuelven a validar sesión, pertenencia, rol y estados del tenant dentro de la transacción; los recursos ajenos son 404.

| Método    | API (prefijo /api/v1/fiscal)      | Función                                        |
| --------- | --------------------------------- | ---------------------------------------------- |
| GET / PUT | /profile                          | Perfil / edición con expectedVersion           |
| GET       | /arca/readiness                   | Estado seguro                                  |
| POST      | /arca/credentials/generate        | Nueva solicitud o replay                       |
| GET       | /arca/credentials/:id/csr         | CSR público en PEM validado                    |
| POST      | /arca/credentials/:id/certificate | Instalación local                              |
| POST      | /arca/credentials/:id/activate    | Activación explícita                           |
| POST      | /arca/wsaa/test                   | Obtener/reutilizar ticket; respuesta readiness |

BFF Next `/api/fiscal/[...path]` con allowlist fiscalRouteContract; no proxy genérico. JSON/cuerpos y respuestas Zod strict; queries rechazadas, Origin exacto, X-Maxbio-Csrf, rechazo cross-site, solo cookie de sesión y no-store. Tamaño y Content-Type acotados; las respuestas con un campo secreto adicional se descartan. No hay private-key download ni export de tickets.

AuditService conserva allowlist existente; estos eventos no tienen metadata: FISCAL_PROFILE_UPDATED, ARCA_CREDENTIAL_GENERATED, ARCA_CERTIFICATE_INSTALLED, ARCA_CREDENTIAL_ACTIVATED, ARCA_WSAA_TEST_SUCCEEDED / FAILED. Cambios de perfil/ciclo y audit son transaccionales. Un fallo de auditoría posterior a WSAA no deshace el ticket externo; se conserva la reserva y no se duplica el login. Logs de error solo usan el filtro existente (requestId/status/event), nunca cuerpos, CUIT, subject ni mensajes del proveedor.

## Dependencias y runtime

Sin nuevas dependencias npm ni cambios de lockfile. Se evaluaron PKIjs / ASN.1 / bibliotecas X.509 y un stack SOAP general: agregarían superficie para esta sola operación. Node crypto ya cubre RSA/X.509; saxen 11.2.0 (MIT, dependencia existente) cubre parseo sin resolver entidades. Se eligió el adaptador de OpenSSL 3.x, proyecto mantenido y licencia Apache-2.0. Las pruebas locales usaron el ejecutable 3.2.3 ya instalado con Git for Windows; esa rama está fuera de soporte y no se incorpora ni se recomienda como runtime del despliegue. Para operar con credenciales reales, instalar una rama mantenida, preferentemente 3.5 LTS, y configurarla en PATH o ARCA_OPENSSL_PATH (ruta confiable del servidor). La [tabla oficial de soporte y licencia de OpenSSL](https://openssl-library.org/source/), consultada el 27/10/2026, informa soporte de 3.5 LTS hasta el 8/4/2030. No se descarga ni instala desde inputs web. CmsSigner permite sustituir la implementación.

No existe imagen Docker de API/web en el repositorio; Compose sigue proporcionando PostgreSQL. Un despliegue futuro deberá incluir OpenSSL, directorio privado persistente/ACL, backup y reloj NTP sincronizado. NODE_ENV=production no habilita ARCA producción: V2 sigue bloqueada en homologación.

## Fuentes oficiales consultadas

Consulta: **27 de octubre de 2026**. Se siguieron los enlaces publicados actualmente por ARCA, aun cuando conservan dominios/nombres AFIP.

- [WSAA: documentación y URLs](https://www.arca.gob.ar/ws/documentacion/wsaa.asp), página vigente sin versión: confirma endpoint y trámite humano.
- [Especificación Técnica WSAA 1.2.2](https://www.arca.gob.ar/ws/WSAA/Especificacion_Tecnica_WSAA_1.2.2.pdf): esquemas, uint32, SHA1+RSA, errores y restricciones de reutilización/espera. Los ejemplos tipográficos de fechas se subordinan al tipo xsd:dateTime indicado por su esquema; implementación usa ISO 8601 UTC.
- [Manual del Desarrollador WSAA, publicación 20.2.19](https://www.arca.gob.ar/ws/WSAA/WSAAmanualDev.pdf): flujo y CMS encapsulado.
- [Manual WSASS, HTML sin versión](https://www.arca.gob.ar/ws/WSASS/html/index.html), [CSR](https://www.arca.gob.ar/ws/WSASS/html/generarcsr.html), [crear certificado](https://www.arca.gob.ar/ws/WSASS/html/crearcertificado.html) y [autorizar acceso](https://www.arca.gob.ar/ws/WSASS/html/crearautorizacion.html): requisitos de solicitud, mínimo RSA 2048 y autorización manual.
- [Certificados digitales](https://www.arca.gob.ar/ws/programadores/certificados-digitales.asp), página sin versión, distingue emisión y autorización.
- [Manual Facturación RG 4291, proyecto FE v4.7, revisión 1/9/2026](https://www.arca.gob.ar/ws/documentacion/manuales/manual-desarrollador-ARCA-COMPG.pdf), apartado Autenticación, página 18: service WSAA **wsfe**, no wsfev1. Se consultó solo para preparar autenticación futura; no se implementaron sus operaciones comerciales.

No se usaron blogs, snippets o repositorios de terceros como fuente de protocolo.

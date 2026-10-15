# SPEC-02 — Contrato funcional AUTH, etapa C

Estado: etapa C validada para cierre; pruebas aisladas y ocho pruebas MySQL aprobadas con limpieza verificada.
Antecedentes obligatorios: AGENTS.md, SPEC-02, DOCX rector y diseño físico aprobado del historial.
No implementa ADMIN ni frontend. Consume intactos los contratos de persistencia de A y seguridad de B.

## Composición y responsabilidades

- `auth.routes.js`: montaje único `/api/auth`, limitadores existentes y dependencias diferidas.
- `auth.controller.js`: HTTP, datos validados, cookies y respuestas públicas.
- `auth.service.js`: casos de uso, autorización efectiva, transacciones y envío posterior al commit.
- `auth.repository.js`: consultas parametrizadas sobre las cinco tablas existentes. Cada unidad de
  trabajo toma una conexión UTC del pool de A y la libera siempre; no crea ni migra estructuras.
- `auth.validators.js`: tipos, campos admitidos y mensajes marcados con `publicValidationMessage()` de B.
- `authenticate`: JWT de B más sesión/cuenta/correo actuales. `authorize`: rol consultado, no claim.
- `auth.email.js`: textos funcionales y enlaces; reutiliza íntegramente Nodemailer/envío de B.

`createApp({ env, authContext? })` permite pruebas HTTP con dobles sin modificar servicios compartidos.
La aplicación exportada por defecto y `server.js` mantienen el arranque existente. Importar la
aplicación o consultar health no inicializa pool, consulta MySQL ni envía correo. El primer acceso AUTH
resuelve configuración de A/B y el pool; las pruebas inyectan un contexto sin servicios externos.

## HTTP y seguridad del navegador

| Entorno | FRONTEND_ORIGIN | Cookie |
|---|---|---|
| development/test | Origen exacto; por defecto `http://localhost:5173`. HTTP solo localhost/127.0.0.1/[::1]. | HttpOnly, SameSite=Strict, Path=/api; Secure si el origen usa HTTPS |
| production | Obligatorio y HTTPS, sin ruta, barra final, credenciales, query, fragmento o comodines. | HttpOnly, Secure, SameSite=Strict, Path=/api |

- Cookie host-only `matista_session`; no se define Domain. Duración no superior a los 7200 segundos
  del JWT existente. Se elimina con el mismo nombre, path y atributos en logout, cambio/reset de
  contraseña y confirmación de cambio de correo. El JWT no se devuelve en JSON.
- CORS permite exclusivamente el origen configurado, credenciales, métodos GET/POST/PATCH/OPTIONS y
  Content-Type. Un origen ajeno obtiene 403, sin cabeceras que le permitan leer la respuesta.
- Todas las operaciones mutables AUTH exigen cabecera Origin exacta, incluso login, registro y los
  endpoints públicos con token. Ausencia y `Origin: null` se rechazan. No hay fallback a Host/Referer,
  ni confianza añadida en X-Forwarded-* o cambios de `trust proxy`.
- GET/HEAD sin Origin no reciben permisos CORS, pero pueden consultar recursos con su autorización
  normal. Preflight permitido responde mediante cors. Las respuestas AUTH incluyen `Cache-Control: no-store`.
- Producción debe publicar frontend/API bajo HTTPS y el mismo sitio, por ejemplo `matista.example` y
  `api.matista.example`, para conservar SameSite=Strict. No se propone relajar la cookie a None.
- Las pruebas de producción inspeccionan la política HTTP/cabeceras en loopback; no sustituyen una
  futura prueba de navegador/TLS del despliegue. Herramientas HTTP deben enviar Origin explícitamente.

## Endpoints

Todos los cuerpos son JSON y rechazan campos desconocidos. Datos de entrada en inglés/técnicos según
el contrato; campos personales conservan los identificadores existentes en español.

| Método / ruta bajo `/api/auth` | Entrada | Éxito |
|---|---|---|
| POST `/register` | legajo, nombre, apellido, email, password; opcionales segundo_nombre, segundo_apellido, telefono, direccion | 201 ACCOUNT_REGISTERED, estado=PENDIENTE, verificationDelivery |
| POST `/verify-email` | token | 200 EMAIL_VERIFIED o EMAIL_ALREADY_VERIFIED, sin sesión |
| POST `/resend-verification` | email pendiente | 200 VERIFICATION_REQUEST_ACCEPTED neutro |
| POST `/login` | email, password | 200 user y Set-Cookie, sin token JSON |
| POST `/logout` | cuerpo vacío; cookie opcional | 204, elimina cookie; idempotente |
| POST `/forgot-password` | email | 200 RECOVERY_REQUEST_ACCEPTED neutro |
| POST `/reset-password` | token, newPassword | 200 PASSWORD_RESET, elimina cookie |
| GET `/me` | cookie | 200 user autorizado |
| PATCH `/me` | uno o más campos personales permitidos | 200 user posterior |
| POST `/change-password` | currentPassword, newPassword; cookie | 200 PASSWORD_CHANGED, elimina cookie |
| POST `/change-email` | email nuevo, currentPassword; cookie | 200 EMAIL_CHANGE_REQUESTED, verificationDelivery |
| POST `/confirm-email-change` | token | 200 EMAIL_CHANGED, elimina cookie; token de un solo uso |

Perfil editable: nombre, segundo_nombre, apellido, segundo_apellido, telefono y direccion. Los
campos opcionales admiten null. Nunca se aceptan rol, estado, legajo, hashes o cambios directos de
correo/contraseña mediante PATCH. Respuesta user: legajo, rol, estado, esos campos personales, email
actual y pendingEmail propio. No expone hashes, tokens, filas de sesión ni filas de auditoría.

DNI es cadena de 7–10 dígitos. Nombres/apellidos obligatorios: texto no vacío hasta 100 caracteres;
segundos nombres/apellidos hasta 100, teléfono hasta 20 y dirección hasta 255. Correo hasta 255,
validado y normalizado únicamente con trim/minúsculas. Contraseñas no se recortan ni normalizan;
se aplican íntegramente los límites de B al crear/modificar, no el mínimo nuevo al comparar un hash.

## Estado, sesiones y concurrencia

- Registro fija ASESOR/PENDIENTE; crea identidad, correo pendiente, hash de token y auditoría en una
  transacción. Verificar crea correo ACTUAL verificado, pero no activa al empleado ni emite JWT.
- Login por correo ACTUAL verificado. Tras comprobar la contraseña, vuelve a bloquear y consultar
  empleado/correos para revalidar contraseña, correo, estado y rol antes de persistir la sesión.
- Credenciales erróneas reciben siempre INVALID_CREDENTIALS/401; un hash ficticio de costo real
  se utiliza si no existe identidad. Con credenciales válidas, correo sin confirmar recibe
  EMAIL_VERIFICATION_REQUIRED/403, pendiente ACCOUNT_PENDING_APPROVAL/403 y no habilitada
  ACCOUNT_NOT_ACTIVE/403. No se emite sesión operativa en esos casos.
- Cada solicitud protegida verifica JWT con jose/B y luego jti/sub, tiempos coincidentes con la
  sesión persistida, no revocación, cuenta ACTIVO, rol ADMIN/ASESOR y correo actual verificado.
  Las operaciones personales mutables revalidan y bloquean dentro de su transacción.
- Logout revoca solo el jti válido presentado, incluso si la cuenta fue desactivada. JWT ausente,
  inválido o vencido no produce consultas de logout ni necesita ser revocado para dejar de autorizar.
- Cambio/reset de contraseña revoca todas las sesiones y tokens de recuperación, y cancela/revoca
  cambios de correo pendientes autorizados con la credencial anterior. No modifica estado ni rol.
- Cambio de correo exige contraseña actual y conserva el actual hasta confirmar. Un intento
  conflictivo revierte cancelación y revocaciones previas. Confirmar primero pasa ACTUAL a ANTERIOR,
  después PENDIENTE a ACTUAL, consume token, audita, revoca sesiones y tokens reset anteriores.
- Un token de registro no confirma cambio de correo ni viceversa. Se exige que correo_id pertenezca
  al empleado del token. Reset usa únicamente RESET_PASSWORD y no recupera cuentas BAJA.
- Bloqueo de empleado común antes de token/correos permite serializar consumo y cambios sensibles.
  Reenvío revoca tokens abiertos anteriores aunque vencieron: la clave abierta de A no depende del reloj.
- Verificación inicial repetida sobre el mismo token ya consumido/correo actual y cuenta aún pendiente
  responde estable sin efectos adicionales. Reset y confirmación de cambio rechazan reutilización.

## Correo, errores y auditoría

Envío siempre posterior al commit. Registro/cambio solicitado devuelve verificationDelivery=ACCEPTED
o RETRY_REQUIRED: no se revierte cuenta ni correo actual por fallo SMTP. Reenvío y recuperación
mantienen el mismo cuerpo/estado para correo inexistente, no elegible o fallo de entrega.
Un incidente de entrega registra solo `AUTH_EMAIL_FAILED` y el tipo de operación, nunca el error
SMTP, destinatario, DNI o token. No se incorpora cola/outbox ni envío real en las pruebas.

Enlaces previstos para etapa D: FRONTEND_ORIGIN + `/confirm-email`, `/confirm-email-change` o
`/reset-password`, con `#token=...`. El fragmento no viaja en la petición HTTP al servidor frontend;
la futura interfaz lo enviará al endpoint POST correspondiente. Las pantallas aún no están implementadas.

Se conserva el contrato de error de B: `{ error: { code, message, details? } }`. Otros códigos
funcionales: TOKEN_INVALID/400, CURRENT_PASSWORD_INVALID/400, EMAIL_UNCHANGED/400,
IDENTITY_CONFLICT/409, CREDENTIALS_CHANGED/409, SESSION_REQUIRED/401, SESSION_INVALID/401,
ROLE_FORBIDDEN/403, ORIGIN_NOT_ALLOWED/403 y AUTH_ROUTE_NOT_FOUND/404. Los errores inesperados
siguen siendo INTERNAL_ERROR/500 sin información privada. Los limitadores B conservan sus
parámetros: login 5/15 minutos, recuperación 3/hora y reenvío 3/hora.

Auditoría según eventos/campos existentes: REGISTRO/CUENTA, EMAIL_VERIFICADO/EMAIL,
EMAIL_CAMBIADO/EMAIL y PASSWORD_CAMBIADA/PASSWORD. Password siempre con valores NULL.
La revocación ya se materializa en auth_sesiones; no se inventa un evento SESIONES_REVOCADAS.
El esquema no contempla un evento de edición de teléfono/nombre/dirección; no se reutilizan
eventos con significado diferente ni se altera el esquema para registrarlo.

## Pruebas y cierre

- `npm run test:auth`: unitarias y HTTP con repositorio/correo simulados, sin MySQL ni SMTP.
- `npm run test:auth-infra`: regresión íntegra de las 29 pruebas de B y health.
- `node --check tests/auth/auth.repository.integration.test.js`: solo compilación sintáctica.
- `test:auth:db`: suite separada ejecutada con autorización expresa: **8/8 aprobadas**, sin fallos,
  omisiones ni cancelaciones. No importa ni llama al runner de migraciones. Nuevas ejecuciones
  siguen requiriendo autorización expresa.

Comando utilizado en la ejecución MySQL autorizada:

```bash
NODE_ENV=test DB_NAME=matista_test npm run test:auth:db
```

La suite opt-in exige configuración test, verifica SELECT DATABASE() y el esquema ya existente
antes de escribir. Usa correo fake, claves efímeras y DNI/correos sintéticos aleatorios. Limpia solo
los legajos propios creados exitosamente, en orden de FK, dentro de una transacción, revalidando
la base antes de DELETE y comprobando después ausencia de filas propias. No usa DDL, migraciones,
TRUNCATE, DROP ni limpieza global. Si la limpieza falla, la prueba falla y lo informa.

Casos reales preparados: unicidad concurrente, doble verificación/reset, token vencido abierto,
rollback por conflicto y por fallo de auditoría, sesión revocada/desactivada, logout individual,
perfil persistente, cambio de correo y contraseña, y carrera entre login y cambio de estado.
Activar/desactivar dentro de fixtures es preparación de datos propios, no una API ADMIN.

La ejecución utilizó exclusivamente matista_test, verificada mediante SELECT DATABASE(). Las cinco
tablas AUTH estaban vacías antes de las pruebas y una comprobación independiente posterior confirmó
cero registros en cada una. schema_migrations conservó sus cinco versiones. No se ejecutaron
migraciones ni SMTP real. Esta evidencia satisface el requisito de integración y limpieza para cerrar C.

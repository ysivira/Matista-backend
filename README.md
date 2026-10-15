# MATISTA Backend

API base de MATISTA construida con Node.js, Express 5 y JavaScript ES Modules.

## Estado actual

Implementado:

- Bootstrap de Express separado entre `src/app.js` y `src/server.js`.
- Carga de variables de entorno mediante `dotenv`.
- CORS para el frontend local en `http://localhost:5173`.
- Parser global de cuerpos JSON.
- Endpoint de salud `GET /api/health`.
- Configuracion validada de conexion MySQL para `matista_dev` y `matista_test`.
- Bootstrap local explicito y migraciones versionadas de persistencia AUTH.
- Runner de migraciones con checksums y deteccion de aplicaciones parciales.
- Pruebas unitarias de configuracion y migraciones; pruebas MySQL opt-in.
- Infraestructura compartida AUTH: contraseñas bcrypt, JWT con jose y tokens temporales.
- Transporte SMTP sustituible, errores uniformes, adaptador de validación y rate limiting.
- Pruebas aisladas de etapa B, incluida regresión del endpoint de salud.

Reservado, pero no implementado:

- Modulos `auth`, `admin` y `asesor`.
- Dominio comercial de tarifas, aportes, descuentos y cotizacion.
- Middleware de autenticación, consulta de sesión y autorización por rol/estado.
- Infraestructura de PDF y plantillas funcionales de correo.
- Repositorios, servicios y casos de uso sobre las tablas AUTH.

Los directorios reservados contienen unicamente archivos `.gitkeep`. No exponen
rutas ni incluyen controladores, servicios, repositorios, validadores, reglas de
negocio, migraciones o pruebas ejecutables.

## Requisitos

- Node.js 20.19 o una version compatible posterior.
- npm y las dependencias declaradas en `package.json`.

La version minima se declara mediante `engines.node`.

## Configuracion

La plantilla versionada se encuentra en `.env.example`:

```dotenv
PORT=3000
NODE_ENV=development

DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=matista_dev
DB_USER=
DB_PASSWORD=
DB_CONNECTION_LIMIT=10
```

`PORT` es opcional. Si no se define, `src/server.js` utiliza el puerto `3000`.
La plantilla no contiene secretos. `DB_NAME` debe coincidir estrictamente con
`NODE_ENV`: `development` usa `matista_dev`, `test` usa `matista_test` y la
configuracion futura de `production` queda reservada para `matista_db`.

## Comandos

Instalar exactamente las dependencias del lockfile:

```bash
npm ci
```

Iniciar en desarrollo con reinicio automatico de Node:

```bash
npm run dev
```

Iniciar sin modo watch:

```bash
npm start
```

Validar configuracion y conexion sin modificar el esquema:

```bash
npm run db:check
```

Aplicar migraciones a la base seleccionada y validada:

```bash
npm run db:migrate
```

Ejecutar pruebas de infraestructura de persistencia sin habilitar MySQL:

```bash
npm test
```

Ejecutar exclusivamente las pruebas de infraestructura compartida AUTH (etapa B):

```bash
npm run test:auth-infra
```

Esta suite no carga `.env`, no conecta a MySQL ni SMTP y utiliza secretos efímeros,
transporte simulado y fechas controladas. Para comprobar Express usa servidores de
prueba en loopback y puertos efímeros, cerrados al finalizar. No ejecuta migraciones.
Las 21 pruebas de persistencia previamente validadas conservan sus scripts y archivos.

Las pruebas de esquema MySQL son explicitas y exigen `NODE_ENV=test`,
`DB_NAME=matista_test` y credenciales de esa base:

```bash
npm run test:db
```

El bootstrap `database/bootstrap/000_create_local_databases.sql` no se ejecuta
desde ningun script. Debe revisarse y ejecutarse de forma explicita con una
cuenta local autorizada.

## Endpoint de salud

Con el servidor iniciado en el puerto predeterminado:

```bash
curl http://localhost:3000/api/health
```

Respuesta esperada:

```json
{
  "status": "ok",
  "application": "MATISTA",
  "service": "backend"
}
```

## Arquitectura

```text
src/
|-- modules/                     # Reservado
|   |-- auth/
|   |-- admin/
|   `-- asesor/
|-- domain/comercial/            # Reservado
|   |-- tarifas/
|   |-- aportes/
|   |-- descuentos/
|   `-- cotizacion/
|-- shared/
|   |-- middleware/              # Limitadores AUTH sin montar
|   |-- validators/              # Adaptador de express-validator
|   `-- errors/                  # Contrato y manejador centralizado
|-- infrastructure/
|   |-- database/                # Conexion y migraciones AUTH
|   |-- security/                # Configuración, bcrypt, JWT y tokens
|   |-- pdf/
|   `-- email/                   # Transporte SMTP y envío genérico
|-- app.js                       # Implementado
`-- server.js                    # Implementado
migrations/                      # DDL versionado AUTH
tests/                           # Pruebas unitarias y MySQL opt-in
```

Las reglas comerciales futuras deben residir en el dominio backend y no deben
duplicarse en React. Los casos de uso de autenticación y administración de cuentas
siguen pendientes; la infraestructura compartida no constituye autenticación operativa.

## Contratos compartidos AUTH — etapa B

Todas las funciones nuevas están documentadas mediante JSDoc en español. Ningún
módulo nuevo carga `.env`, abre conexiones ni envía mensajes al importarse.

### Configuración y contraseñas

`loadSecurityConfig(env)` en `src/infrastructure/security/config.js` valida la
configuración explícitamente cuando un llamador necesita seguridad. No se cambia
el arranque existente para exigir secretos antes de disponer de endpoints AUTH.

| Parámetro | Contrato |
|---|---|
| `NODE_ENV` | `development`, `test` o `production`; obligatorio |
| `PASSWORD_MIN_LENGTH` | Mínimo configurable: 4 en development/test y 10 en production; por defecto el mínimo del entorno |
| Bcrypt | Costo 12 y máximo 72 bytes UTF-8; centralizados en config.js |
| `JWT_SECRET` | Al menos 32 bytes aleatorios, en base64url canónico sin relleno; obligatorio |
| `JWT_ISSUER` | Por defecto `matista-backend`; no admite vacío |
| `JWT_AUDIENCE` | Por defecto `matista-frontend`; no admite vacío |
| JWT | HS256, duración de 7200 segundos |
| Verificación de correo | 86400 segundos (24 horas) |
| Recuperación | 1800 segundos (30 minutos) |

La plantilla `.env.example` es local: antes de un despliegue se debe retirar su
`PASSWORD_MIN_LENGTH=4` o sustituirlo por 10 o más. En producción el valor 4 causa
un error de configuración, nunca una reducción silenciosa. El secreto debe generarse
fuera del código con un generador criptográfico; no se incluyen claves de ejemplo.

`hashPassword(password, config)` aplica la política al crear/modificar credenciales.
Cuenta caracteres Unicode y comprueba bytes UTF-8; no recorta ni normaliza.
`verifyPassword(password, hash)` compara hashes existentes sin imponer el mínimo
actual; rechaza entradas mayores a 72 bytes para evitar truncamiento bcrypt.
Los errores nunca incorporan la contraseña recibida.

### JWT y tokens temporales

- `signAccessToken({ legajo, jti? }, config, now?)` genera un UUID si falta `jti` y
  devuelve `{ token, jti, issuedAt, expiresAt }`. Las fechas corresponden exactamente
  a los segundos `iat`/`exp` que debe guardar la futura sesión.
- `verifyAccessToken(token, config, now?)` exige firma HS256, emisor, audiencia,
  expiración y los seis claims `sub`, `jti`, `iat`, `exp`, `iss`, `aud`. Valida DNI,
  UUID, duración y emisión no futura. Un rechazo produce `ACCESS_TOKEN_INVALID`/401.
- La validación criptográfica **no autoriza**: etapa C debe comprobar en MySQL la
  asociación `jti`/`sub`, vigencia/revocación de sesión, cuenta activa, correo y rol
  actuales. No se incorpora refresh token.
- `createTemporaryToken(type, config, now?)` admite `VERIFICAR_EMAIL` o
  `RESET_PASSWORD` y devuelve `{ token, tokenHash, expiresAt }`.
  `hashTemporaryToken(token)` produce SHA-256 binario de 32 bytes compatible con
  `auth_tokens.token_hash`. El token crudo solo se entrega al llamador para enviarlo;
  nunca se registra ni persiste aquí. Su consumo único y validación contra la fila
  persistida corresponden a etapa C.

### Correo: reutilización selectiva de SIGEC

Se inspeccionó en solo lectura `backend-sigec/service/emailService.js`. Sus únicas
dependencias directas importadas son Nodemailer y dotenv. Se adaptaron su transporte
`createTransport`, mensaje `mailOptions` y secuencia `sendMail` con `try/catch`.
Son cambios acotados, sin necesidad de trasladar el archivo funcional completo.

La adaptación ESM en `src/infrastructure/email/email.service.js` elimina Gmail fijo,
marca SIGEC, URLs locales, plantillas de registro/reset/bienvenida, carga global de
dotenv y logs de respuestas/errores SMTP. No se copiaron credenciales.

- `createEmailTransport(env)` requiere `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`
  (`true`/`false`), `SMTP_USER` y `SMTP_PASSWORD`. En modo no implícito exige STARTTLS;
  no deshabilita validación de certificados. Crear el transporte no envía mensajes.
- `sendEmail({ to, subject, text?, html? }, { transport, from })` requiere transporte
  explícito y remitente; `from` puede obtenerse de `SMTP_FROM`. Devuelve solamente
  `{ messageId, accepted: true }`: aceptación SMTP, no confirmación de entrega final.
- Fallos o rechazos producen `EMAIL_SEND_FAILED`/503 sin adjuntar errores originales.
  El llamador de etapa C gestionará reintentos y estado controlado después del commit.

### Errores, validaciones y rate limiting

`createAppError(code, message, status, details?)` crea errores operativos reconocidos
por `errorHandler`, integrado al final de `src/app.js`. Los códigos y mensajes deben
ser constantes públicas del servidor, sin interpolar datos sensibles recibidos.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Revise los campos indicados.",
    "details": [{ "field": "email", "message": "Ingrese un correo válido." }]
  }
}
```

`details` es opcional y solo conserva `field`/`message`. Errores inesperados devuelven
`INTERNAL_ERROR`/500; JSON inválido, `INVALID_JSON`/400. No se serializa stack, SQL,
causas ni objetos originales. Con `headersSent` se delega mediante `next(error)`.

`handleValidationResult` adapta cadenas reales de express-validator, excluye valores
recibidos y continúa si son válidas. Las futuras cadenas deben definir mensajes
públicos comprensibles; sus reglas funcionales se implementarán en etapa C.

`createAuthRateLimiter(operation, { windowMs?, limit?, store? })` crea instancias
independientes. Políticas aprobadas centralizadas en `security/config.js`:

| Operación | Límite | Ventana |
|---|---:|---:|
| `login` | 5 | 15 minutos |
| `passwordRecovery` | 3 | 1 hora |
| `verificationResend` | 3 | 1 hora |

Usa claves IP de express-rate-limit con tratamiento IPv6 y almacén en memoria por
instancia, adecuado al proceso actual. Un despliegue multiproceso requerirá un
almacén compartido configurado explícitamente. No se modifica `trust proxy` de la
aplicación. Se emiten cabeceras estándar draft-7 y `Retry-After`, sin cabeceras legacy.
Al exceder se entrega `RATE_LIMIT_EXCEEDED`/429 al manejador centralizado.
Los limitadores aún no están montados en endpoints funcionales.

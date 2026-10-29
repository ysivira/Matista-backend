# MATISTA · Backend

API de MATISTA, proyecto académico de **Taller de Desarrollo de Aplicaciones Informáticas**. El sistema surge de la refactorización y evolución de SIGEC, reorganizando responsabilidades y funcionalidades en dos repositorios independientes: backend y frontend.

Este repositorio implementa autenticación, administración y cotizaciones comerciales. El backend conserva la autoridad sobre permisos, datos persistidos y cálculos económicos; la interfaz React consume sus contratos HTTP.

## Contenido

- [Alcance funcional](#alcance-funcional)
- [Tecnologías y requisitos](#tecnologías-y-requisitos)
- [Arquitectura](#arquitectura)
- [API](#api)
- [Configuración](#configuración)
- [Base de datos e inicialización](#base-de-datos-e-inicialización)
- [Instalación y ejecución](#instalación-y-ejecución)
- [Pruebas](#pruebas)
- [Seguridad y operación](#seguridad-y-operación)

## Alcance funcional

### AUTH · Cuenta y sesión

- Registro de cuentas como **ASESOR/PENDIENTE** y confirmación de correo con token temporal.
- Reenvío de verificación, inicio y cierre de sesión, recuperación y restablecimiento de contraseña.
- Consulta y edición de perfil, cambio de contraseña y cambio de correo con confirmación del nuevo destinatario.
- JWT en cookie HttpOnly y sesión persistida revocable. La autorización comprueba sesión, cuenta y rol actuales, no sólo la firma del token.

Confirmar el correo **no activa la cuenta**: la aprobación corresponde a ADMIN. No hay refresh token ni renovación automática de sesión.

### ADMIN · Usuarios y configuración comercial

- Directorio y detalle de empleados; cambios de estado y rol, con auditoría, protección del último administrador y restricciones sobre operaciones propias.
- Activación/reactivación condicionada a la verificación del correo actual; inactivación y baja lógica según transiciones permitidas.
- Consulta del catálogo de planes y tarifas.
- Versionado tarifario: borradores desde referencias existentes, edición de importes, vista previa y aplicación de aumentos masivos, finalización, reanudación, activación **manual**, descarte, recuperación histórica y deshacer según estado.
- Versionado de políticas comerciales, vigencia inmediata o programada, historial, recuperación y cancelación de pendientes.
- Consulta y descarga de documentos de catálogo/listas, con autorización.

El catálogo se inicializa mediante una carga controlada desde SIGEC. **No existe un CRUD general de planes ni de listas independientes del ciclo de versiones.** El scheduler activa políticas comerciales; no equivale a una activación automática de versiones tarifarias.

### ASESOR · Clientes y cotizaciones

- Búsqueda por DNI, alta y edición autorizada de clientes; cartera propia y proyección limitada al encontrar clientes ajenos.
- Cotización en modalidades **Obligatorio, Voluntario y Monotributo**, con grupo familiar, plan, aportes y condiciones comerciales.
- Cálculo económico del servidor: segmentos etarios, beneficio joven, descuentos comerciales fijos/escalonados, TDC, afinidad, topes, aportes e impuestos según modalidad y política vigente.
- Vista previa sin crear un borrador por cada edición; preparación, cálculo y emisión con revisión y huella del resultado.
- Historial y detalle propios; edición de borradores, corrección de contacto, recotización vinculada sin sustituir el original y anulación lógica con motivo.
- PDF de cotización a partir del snapshot emitido; consulta de planes, listas y condiciones comerciales.

Los estados principales de cotización son `BORRADOR`, `EMITIDA` y `ANULADA`. Una emisión no se edita como un borrador ni se recalcula para generar su PDF.

**Roles funcionales implementados: ADMIN y ASESOR. Supervisor no es un módulo implementado.**

## Tecnologías y requisitos

JavaScript con ES Modules. Versiones siguientes verificadas en `package-lock.json`; los rangos declarados están en `package.json`.

| Tecnología | Versión bloqueada | Uso |
|---|---|---|
| Express | 5.3.0 | HTTP y routers |
| mysql2 | 3.24.6 | MySQL, pools y consultas |
| dotenv | 18.0.8 | Configuración del proceso/scripts |
| bcryptjs | 3.0.3 | Hash de contraseñas |
| jose | 6.2.12 | JWT HS256 |
| cookie-parser / cors | 1.4.7 / 2.8.6 | Cookies y política de origen |
| express-validator | 7.3.2 | Validación AUTH |
| express-rate-limit | 8.7.1 | Límites de solicitudes AUTH |
| Nodemailer | 10.1.1 | Correo SMTP |

- `engines.node` declara **Node.js >=20.19.0**. Para trabajar con ambos repositorios y el PDF, se recomienda **Node.js 24.x desde 24.15.0**, compatible con los requisitos de las herramientas frontend bloqueadas. No se fija una versión de npm en este repositorio.
- MySQL compatible con el SQL del proyecto; el bootstrap utiliza `utf8mb4_0900_ai_ci`, propio de MySQL 8. No se verificó una versión concreta del servidor en esta revisión ni compatibilidad con MariaDB.
- SMTP autorizado para enviar los enlaces de cuenta.
- PDF: Google Chrome accesible como `google-chrome` o mediante `CHROME_BIN`; el adaptador usa Chrome headless y el `WebSocket` global de Node. El mínimo declarado en `engines` no constituye por sí solo una garantía de PDF en todos los runtimes.
- Algunas pruebas opcionales de PDF requieren además `pdfinfo` y `pdftotext`.

No se utiliza Swagger/OpenAPI ni un ORM en la implementación inspeccionada.

## Arquitectura

```text
src/
├── server.js                 # dotenv, listener, scheduler y cierre de recursos
├── app.js                    # Express, CORS, routers y errores
├── modules/
│   ├── auth/                 # rutas, controladores, servicios, repositorio, correo y validadores
│   ├── admin/                # empleados, tarifarios, políticas, catálogo y carga inicial
│   └── asesor/               # clientes, cotizaciones, validación, persistencia y documentos
├── domain/comercial/         # motor económico, descuentos, edad y reglas confirmadas
├── infrastructure/
│   ├── database/             # configuración, conexión y runner de migraciones
│   ├── security/             # contraseñas, JWT y tokens temporales
│   ├── email/                # transporte SMTP
│   └── pdf/                  # impresión HTML mediante Chrome
└── shared/                   # errores, middleware, validación e importes exactos
database/bootstrap/           # creación explícita de bases locales
migrations/                   # 001–030 y verificaciones complementarias
scripts/                      # conexión, migraciones y carga inicial
tests/                        # unidades, HTTP, repositorios, MySQL y documentos
docs/                         # contratos técnicos por módulo/etapa
```

Los routers reciben solicitudes y aplican controles HTTP. AUTH separa controladores en `auth.controller.js`; ADMIN y ASESOR también tienen manejadores en sus archivos de rutas. Los servicios coordinan casos de uso, reglas, transacciones y auditoría; los repositorios concentran acceso SQL. El motor comercial calcula en backend y las plantillas documentales presentan snapshots y catálogos.

`createApp({ env, authContext })` permite inyectar dobles en pruebas sin iniciar el listener. El runtime compartido compone seguridad y pool MySQL; los módulos lo reutilizan en vez de mantener pools de autenticación independientes.

## API

| Prefijo | Responsabilidad |
|---|---|
| `/api/health` | Salud HTTP; no verifica MySQL ni SMTP |
| `/api/auth` | Registro, sesión y perfil |
| `/api/admin` | Operaciones de ADMIN |
| `/api/asesor` | Clientes y cotizaciones de ASESOR |
| `/api/catalogo` | Consultas/documentos compartidos por roles autorizados |

Ejemplos reales, no inventario exhaustivo:

| Método | Ruta | Acceso / propósito |
|---|---|---|
| GET | `/api/health` | Público, salud del servicio HTTP |
| POST | `/api/auth/register` | Registro público validado |
| POST | `/api/auth/login` | Autenticación |
| POST | `/api/auth/verify-email` | Consumo de token de verificación |
| GET / PATCH | `/api/auth/me` | Perfil de la sesión |
| PATCH | `/api/admin/employees/:legajo/estado` | ADMIN, transición de cuenta |
| GET | `/api/admin/tarifario/versiones/:id/aumentos/vista-previa` | ADMIN, previsualización |
| POST | `/api/admin/tarifario/versiones/:id/activacion` | ADMIN, activación manual |
| PUT | `/api/admin/politica-comercial/:id` | ADMIN, modificación/versionado |
| POST | `/api/asesor/cotizaciones/previsualizacion` | ASESOR, cálculo preliminar |
| POST | `/api/asesor/cotizaciones/:id/calculo` | ASESOR, cálculo del borrador; cuerpo vacío |
| POST | `/api/asesor/cotizaciones/:id/emision` | ASESOR, confirmación con revisión/huella |
| GET | `/api/asesor/cotizaciones/:id/pdf` | ASESOR, PDF autorizado |

Las rutas protegidas autentican exclusivamente la cookie `matista_session`, no un Bearer alternativo. Las operaciones mutables requieren el `Origin` exacto configurado. Los permisos de rol y propiedad se resuelven en backend; ocultar una acción en la interfaz no reemplaza esos controles.

AUTH utiliza `express-validator`; los servicios ADMIN/ASESOR incorporan sus validaciones de estructura, revisión, estado y reglas. El manejador central devuelve errores con envoltorio `error`, campos `code`, `message` y, cuando corresponde, `details`. Las excepciones inesperadas producen un error público genérico; no se envían stacks ni SQL al cliente.

Contratos complementarios: [AUTH](docs/auth-contract.md), [consultas ADMIN](docs/spec-03-sl2-http-contract.md), [versiones tarifarias](docs/spec-03-sl3-http-contract.md), [políticas](docs/spec-03-sl4-sl5-http-contract.md) y [ASESOR](docs/spec-04-asesor.md). Son documentos de distintas etapas; ante discrepancias, consultar los routers y servicios actuales. No hay un endpoint Swagger ni un archivo OpenAPI implementado.

## Configuración

La plantilla pública es [`.env.example`](.env.example). Copiarla sólo si no existe ya la configuración local y completar los valores de forma privada. **No sobrescribir un `.env` existente ni versionarlo.**

| Variable | Uso / valor no secreto de referencia |
|---|---|
| `PORT` | Puerto HTTP; predeterminado `3000` |
| `NODE_ENV` | `development`, `test` o `production` |
| `DB_HOST`, `DB_PORT` | Predeterminados `127.0.0.1` y `3306` |
| `DB_NAME` | Debe coincidir con el entorno; tabla de la sección siguiente |
| `DB_USER`, `DB_PASSWORD` | Usuario obligatorio y contraseña definida; completar fuera de Git |
| `DB_CONNECTION_LIMIT` | Predeterminado `10`, permitido entre 1 y 100 |
| `JWT_SECRET` | Secreto privado aleatorio de al menos 32 bytes, base64url canónico sin relleno |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Predeterminados `matista-backend` / `matista-frontend` |
| `PASSWORD_MIN_LENGTH` | Plantilla local `4`; producción exige al menos `10`; máximo bcrypt: 72 bytes UTF-8 |
| `SMTP_HOST`, `SMTP_PORT` | Servidor y puerto de correo autorizados |
| `SMTP_SECURE` | Literal `true` para TLS implícito o `false` con STARTTLS obligatorio |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Credenciales y remitente privados; sin ejemplos reales |
| `FRONTEND_ORIGIN` | Origen exacto, sin ruta ni barra final; local: `http://localhost:5173` |
| `CHROME_BIN` | Opcional, ejecutable Chrome para PDF; no está incluido en la plantilla |

Para la carga desde SIGEC se leen además `SIGEC_DB_HOST`, `SIGEC_DB_PORT`, `SIGEC_DB_DATABASE` (sólo `sigec_db`), `SIGEC_DB_USER`, `SIGEC_DB_PASSWORD` e `IMPORT_ACTOR_LEGAJO`. Estas variables **no están en `.env.example`** y deben configurarse privadamente sólo para la operación controlada. Usar una cuenta fuente con permisos de lectura.

No publicar secretos generados, credenciales locales, enlaces con tokens ni direcciones temporales de túneles. La configuración de producción requiere HTTPS y una revisión del entorno; cambiar `NODE_ENV` no crea un despliegue.

## Base de datos e inicialización

| Entorno | Base admitida por la aplicación |
|---|---|
| `development` | `matista_dev` |
| `test` | `matista_test` |
| `production` | `matista_db` |

El runner local de migraciones **rechaza producción**: sólo permite `matista_dev` y `matista_test`. Las 30 migraciones numeradas definen AUTH (001–005), catálogo/versiones/políticas y auditoría (006–023), y clientes/cotizaciones/guardas/identidad (024–030). El runner conserva checksums en `schema_migrations` y detecta inconsistencias; no editar SQL ya aplicado para hacer coincidir un entorno.

### Preparación de una instalación nueva, por un operador autorizado

1. Revisar `database/bootstrap/000_create_local_databases.sql`: crea únicamente las bases locales de desarrollo/pruebas, no usuarios MySQL ni cuentas ADMIN. Su ejecución es manual y no la realiza ningún script npm.
2. Configurar una cuenta MySQL con los permisos necesarios para cada operación, seleccionar el entorno/base correctos y verificar la conexión con `npm run db:check`.
3. Revisar y respaldar el destino antes de `npm run db:migrate`. **Modifica esquema y registros de migración**; no es un diagnóstico inocuo ni una operación con reversión DDL global garantizada.
4. Para el catálogo inicial, disponer de la fuente SIGEC autorizada y de un legajo existente en `empleados`. La carga requiere ese actor, aunque no necesariamente rol ADMIN.
5. Sólo tras revisar fuente y destino, ejecutar `npm run db:carga-inicial`: lee planes/listas/aportes de `sigec_db`, valida la matriz aprobada y escribe el catálogo, versión inicial y políticas en MATISTA. Su idempotencia comprueba consistencia; no es un importador de fuentes arbitrarias ni un seed autónomo incluido en Git.
6. Coordinar por separado el aprovisionamiento inicial del administrador. **No hay un script npm de creación del primer ADMIN ni credenciales de administrador predeterminadas**; el registro público crea cuentas pendientes y no permite autoasignar ese rol.

La fuente SIGEC, los usuarios MySQL y los datos operativos no se distribuyen aquí. Por ello, un clon más `npm ci` no produce por sí solo un sistema comercial inicializado. No usar fixtures de prueba como un volcado de producción ni improvisar instrucciones SQL de promoción de cuentas.

## Instalación y ejecución

Los comandos se documentan para una ejecución posterior en un entorno autorizado; no se ejecutaron al redactar este README.

Dentro de este repositorio, con Node/npm compatibles:

```bash
npm ci
```

Instala según `package-lock.json`; no sustituye la configuración ni la preparación de base/SMTP. Completadas esas etapas:

```bash
npm run dev
```

El script ejecuta `node --watch src/server.js`. Alternativa sin watcher:

```bash
npm start
```

**El arranque no es de sólo lectura:** inicializa el activador de políticas y puede activar pendientes vencidas en MySQL. Algunas consultas comerciales también resuelven activaciones vencidas. No arrancar contra datos de desarrollo/producción como si fuera una prueba aislada.

Con el servicio ya iniciado, `GET http://localhost:3000/api/health` comprueba HTTP, no disponibilidad integral de base, correo o PDF. Iniciar después el frontend y alinear su origen con `FRONTEND_ORIGIN`.

## Pruebas

Se usa el ejecutor nativo `node:test`, con concurrencia 1 en los scripts. Hay pruebas de unidades, repositorios con dobles, contratos HTTP, motor comercial y documentos; las que se llaman `integration` no son todas equivalentes: algunas simulan dependencias y otras acceden a MySQL.

| Script existente | Alcance / precaución |
|---|---|
| `npm test` | Infraestructura de datos y `tests/modules`; incluye arneses SQL/PDF condicionados |
| `npm run test:auth-infra` | Seguridad, correo simulado, errores, validaciones, limitadores y salud |
| `npm run test:auth` | Repositorio con dobles, servicios, autorización y HTTP AUTH; no sustituye la suite SQL |
| `npm run test:db` | Activa `RUN_DB_TESTS=1` para el esquema MySQL |
| `npm run test:auth:db` | Activa `RUN_AUTH_DB_TESTS=1` para persistencia AUTH real |

Para una regresión con opt-in externos desactivados, revisar el entorno antes de invocar:

```bash
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 npm test
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 npm run test:auth-infra
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 npm run test:auth
```

Los ejemplos de variables prefijadas corresponden a shells POSIX. Algunos archivos cargan `.env`; las pruebas pueden crear listeners efímeros en loopback y temporales. No se presenta la ejecución como carente de todo efecto local.

Las suites MySQL exigen `NODE_ENV=test` y `DB_NAME=matista_test`, además de esquema/datos previos según cada arnés. **Escriben, modifican o limpian datos**; algunas ADMIN requieren catálogo y acceso fuente SIGEC. Para habilitarlas se necesita una base de pruebas aislada y autorización explícita. El esquema solo no equivale a ejecutar todas las suites comerciales.

`RUN_PDF_TESTS=1` habilita casos opcionales de Chrome real en las pruebas de módulos; generan archivos temporales y algunas invocan utilidades PDF del sistema. No hay un script `test:pdf` independiente.

**SPEC-10 no ejecutó estas pruebas ni renueva resultados históricos.** Los comandos y alcances anteriores se comprobaron por lectura de scripts y arneses.

## Seguridad y operación

- Contraseñas con bcrypt, costo 12; JWT HS256 de duración limitada y tokens temporales persistidos mediante hash. No hay una clave JWT predeterminada publicable.
- Cookie `matista_session`: HttpOnly, SameSite=Strict, ruta `/api`, sin `Domain`; `Secure` depende del origen HTTPS validado, incluso en un entorno de desarrollo con HTTPS.
- CORS permite un único origen exacto y credenciales; las mutaciones comprueban Origin. `trust proxy` está limitado a loopback: una topología distinta requiere revisión, no confianza global en cabeceras.
- Rate limiting de login, recuperación y reenvío con almacenamiento en memoria por proceso; no es un limitador distribuido.
- Roles, propiedad, revisión optimista, transacciones y auditoría protegen operaciones comerciales según cada caso de uso.
- SMTP exige cifrado; errores públicos evitan divulgar SQL, stacks o errores originales del proveedor. Aun así, revisar retención y acceso a logs: las rutas pueden contener identificadores personales.
- `.env`, dependencias, compilaciones, cobertura y logs están ignorados. `.gitignore` **no elimina información ya existente en commits** ni protege archivos añadidos a la fuerza.

Estos controles no garantizan seguridad absoluta ni sustituyen una auditoría de despliegue y dependencias. No publicar copias de bases, datos personales o material comercial sin autorización. Revisar también el historial, la identidad pública de los commits y los derechos sobre textos/marca antes de abrir el repositorio.

El funcionamiento local o mediante **túnel de VS Code no constituye un despliegue permanente de producción**. No se incluyen URLs temporales, cuentas de demostración reales, capturas ni métricas no verificadas.

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

El catálogo se inicializa autónomamente desde datos comerciales verificados incluidos en el repositorio. La importación desde SIGEC se conserva solo por compatibilidad; **no es requisito de instalación**. No existe un CRUD general de planes ni de listas independientes del ciclo de versiones. El scheduler activa políticas comerciales; no equivale a una activación automática de versiones tarifarias.

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

- `engines.node` declara **Node.js 24.x**. Usar al menos **24.15.0** para ambos repositorios. No se fija una versión de npm.
- **MySQL 8.0.16 o posterior**, con CHECK efectivos y collation `utf8mb4_0900_ai_ci`; MariaDB no está validado. La instalación se verificó en el MySQL local indicado en la sección de aceptación.
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
| `DB_SSL` | Para la demostración local: `false`; no heredar configuración remota |
| `JWT_SECRET` | Secreto privado aleatorio de al menos 32 bytes, base64url canónico sin relleno |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Predeterminados `matista-backend` / `matista-frontend` |
| `PASSWORD_MIN_LENGTH` | Plantilla local `4`; producción exige al menos `10`; máximo bcrypt: 72 bytes UTF-8 |
| `SMTP_HOST`, `SMTP_PORT` | Servidor y puerto de correo autorizados |
| `SMTP_SECURE` | Literal `true` para TLS implícito o `false` con STARTTLS obligatorio |
| `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Credenciales y remitente privados; sin ejemplos reales |
| `FRONTEND_ORIGIN` | Origen exacto, sin ruta ni barra final; local: `http://localhost:5173` |
| `CHROME_BIN` | Opcional, ejecutable Chrome para PDF; no está incluido en la plantilla |

Solo para la importación heredada desde SIGEC se leen `SIGEC_DB_HOST`, `SIGEC_DB_PORT`, `SIGEC_DB_DATABASE` (solo `sigec_db`), `SIGEC_DB_USER`, `SIGEC_DB_PASSWORD` e `IMPORT_ACTOR_LEGAJO`. No definirlas para una instalación autónoma. `db:carga-autonoma` usa por defecto el legajo demo `900000001` como responsable; admite `IMPORT_ACTOR_LEGAJO` si se decide usar otro empleado existente en la base local.

No publicar secretos generados, credenciales locales, enlaces con tokens ni direcciones temporales de túneles. La configuración de producción requiere HTTPS y una revisión del entorno; cambiar `NODE_ENV` no crea un despliegue.

## Base de datos e inicialización

| Entorno | Base admitida por la aplicación |
|---|---|
| `development` | `matista_dev` o `matista_local` (solo MySQL loopback) |
| `test` | `matista_test` |
| `production` | `matista_db` o `matista_dev` (solo `purpose: 'application'`) |

La excepción `production/matista_dev` permite usar el nombre histórico de la base alojada en Aiven únicamente para la aplicación (`purpose: 'application'`, valor predeterminado). No cambia `NODE_ENV`, TLS, la política de seguridad ni las demás validaciones. No habilita ese destino para migraciones ni pruebas: las pruebas de persistencia siguen exigiendo `test/matista_test`. El nombre de la base no garantiza aislamiento; revisar también el servidor y los permisos para no compartir accidentalmente datos entre desarrollo y producción.

El runner **rechaza producción**, incluso con `DB_NAME=matista_dev`: admite `development/matista_dev`, `test/matista_test` y `development/matista_local`. Las 30 migraciones originales definen AUTH (001–005), catálogo/versiones/políticas/auditoría (006–023) y clientes/cotizaciones/guardas/identidad (024–030). Se reutilizan sin cambios y conservan checksums en `schema_migrations`.

### Datos autónomos e idempotencia

[`database/seed/carga_inicial_autonoma.json`](database/seed/carga_inicial_autonoma.json) contiene únicamente 4 planes (prestaciones y condiciones incluidas), 160 tarifas iniciales y 12 aportes de monotributo. Se recuperaron de la versión histórica **CARGA_INICIAL** de `matista_dev`, no de sus versiones comerciales posteriores, y se cotejaron fila por fila contra las mismas tablas de `matista_test`. No se clonó ninguna base ni se copiaron usuarios, clientes, cotizaciones o auditorías. Procedencia e integridad: [README del catálogo](database/seed/README.md).

La política E2 proviene de `POLITICA_INICIAL` en `src/modules/admin/carga-inicial.service.js`; los 9 porcentajes, de `PORCENTAJES_COMERCIALES_INICIALES` en su repositorio. La carga autónoma reutiliza el validador E2 y sus escritores SQL; no abre conexiones SIGEC. Conserva IDs de planes y normaliza las etiquetas etarias con las reglas existentes.

`db:admin-demo` y `db:carga-autonoma` admiten **únicamente `development/matista_local` con host `127.0.0.1`, `localhost` o `::1`**. Verifican la base efectiva y serializan inicializadores mediante un lock MySQL. Cada comando realiza una transacción con rollback ante errores. Las migraciones DDL **no** tienen rollback global: un error exige diagnóstico, no borrar tablas a ciegas.

Repetir la inicialización no duplica registros ni restablece contraseñas cambiadas. Si encuentra cuentas conflictivas o un catálogo parcial, aborta sin repararlos ni sobrescribirlos. Si el catálogo ya fue configurado posteriormente por ADMIN, no vuelve a aplicar importes iniciales. La instalación se debe usar sobre una **base nueva**: no es un mecanismo de limpieza o reparación de entornos existentes.

**Parámetros no inventados:** la política E2 deja `afinidad_pct`, `aporte_adherente` e `iva_voluntario_pct` sin configurar. Afinidad requiere aprobación/configuración antes de solicitarse; `aporte_adherente` es histórico y el motor nuevo de Monotributo utiliza `aporte_monotributo` también para cada adherente registrado. **Voluntario no puede calcularse hasta que ADMIN publique una política con el IVA aprobado**; no se usa cero ni un valor de prueba por defecto. Obligatorio y Monotributo funcionan con la carga inicial.

### Compatibilidad con la importación anterior

`npm run db:carga-inicial` sigue disponible para operaciones SIGEC autorizadas, con su fuente y actor explícitos. No forma parte de los pasos siguientes. El registro público sigue creando `ASESOR/PENDIENTE` y no asigna ADMIN; el único administrador conocido se crea explícitamente mediante el script local, nunca al arrancar la aplicación ni en producción.

## Instalación y ejecución

Procedimiento local para evaluación académica. Requiere Git, Node/npm compatibles, MySQL local y un operador autorizado para crear **una base nueva**. No modifica Aiven ni despliega a Vercel.

### 1. Descargar e instalar dependencias

En un directorio nuevo (no sobrescribir clones existentes):

```bash
git clone https://github.com/ysivira/Matista-backend.git
git clone https://github.com/ysivira/Matista-frontend.git
```

Usar revisiones que incluyan esta instalación; mientras no esté integrada, en backend seleccionar `git switch feat/spec-05-instalacion-autonoma` **una vez publicada esa rama**. No es necesario cambiar de rama en frontend. En cada repositorio ejecutar `npm ci`, que utiliza su `package-lock.json`.

### 2. Preparar exclusivamente la base nueva

Con una sesión **administrativa de MySQL local** (por ejemplo `sudo mysql` en Linux con auth_socket), revisar primero si existe `matista_local`. Si existe con información, **detenerse, no borrarla**. Para una instalación realmente nueva:

```sql
CREATE DATABASE matista_local
  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
```

Crear una cuenta MySQL local dedicada si no existe (elegir la contraseña privadamente, no usar el marcador literal), y conceder permisos **solo sobre esa base**:

```sql
CREATE USER 'matista_local_app'@'localhost'
  IDENTIFIED BY '<contraseña-local-elegida-privadamente>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES
  ON matista_local.* TO 'matista_local_app'@'localhost';
```

Si se usa una cuenta ya existente, concederle los permisos sobre `matista_local` sin recrearla ni cambiar su contraseña. Ajustar el host del GRANT al de la cuenta MySQL real. La aplicación no necesita permisos globales ni acceso a otras bases. El bootstrap general `database/bootstrap/000_create_local_databases.sql` declara también bases dev/test; **no hace falta ejecutarlo para esta instalación aislada**.

### 3. Configurar el backend privadamente

Solo en un clon nuevo y si no hay `.env`, copiar `.env.example` a `.env`. Completar `DB_USER`/`DB_PASSWORD` de la cuenta anterior y generar un `JWT_SECRET` aleatorio (no versionarlo). Por ejemplo, generar 32 bytes con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` y guardar el resultado únicamente en el entorno privado.

Configuración local no secreta necesaria:

```dotenv
NODE_ENV=development
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=matista_local
DB_USER=matista_local_app
DB_SSL=false
PASSWORD_MIN_LENGTH=4
FRONTEND_ORIGIN=http://localhost:5173
```

Además: `DB_PASSWORD` definido, `JWT_SECRET` válido; `DB_CONNECTION_LIMIT`, `JWT_ISSUER` y `JWT_AUDIENCE` pueden conservar los valores de la plantilla. No definir `SIGEC_DB_*` ni `IMPORT_ACTOR_LEGAJO` para el caso estándar. No reutilizar variables de Aiven, Vercel ni secretos de producción. La demostración está pensada para MySQL en el mismo equipo; hosts remotos se rechazan.

**SMTP es opcional para el login del ADMIN demo y las consultas de catálogo**. Se requiere configurar `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` y `SMTP_FROM` para altas/verificación y recuperación de cuentas reales de la demostración. Usar un servidor SMTP propio de pruebas: no hay credenciales SIGEC necesarias. Para PDF, instalar Chrome local o definir `CHROME_BIN`; no se modifica la configuración Vercel.

### 4. Migrar e inicializar

Dentro del backend, comprobar que el destino es `matista_local`; para evitar heredar un `.env` con otra base, los comandos POSIX siguientes fijan explícitamente el destino:

```bash
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run db:check
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run db:migrate
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run db:admin-demo
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run db:carga-autonoma
```

El administrador se crea **antes** del catálogo porque su legajo identifica al responsable de la política/aportes mediante FK. No se necesita SMTP para este aprovisionamiento. Resultado: 30 migraciones, 4 planes, 1 versión inicial ACTIVA, 160 tarifas, 12 aportes, 1 política VIGENTE y 9 porcentajes, sin clientes ni cotizaciones.

**ADMIN exclusivamente de demostración:** correo `admin@matista.test`, contraseña `admin2026*`, legajo `900000001`, rol `ADMIN`, estado `ACTIVO`, correo `ACTUAL` y verificado. Contraseña almacenada con bcrypt costo 12. No exige cambio al iniciar sesión. **Estas credenciales conocidas NO deben utilizarse en producción ni exponerse en una instalación pública.** No se añaden a variables ni configuraciones de producción.

### 5. Iniciar y verificar

En el backend:

```bash
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run dev
```

Alternativa: `npm start` con el mismo entorno. **El arranque puede escribir** (activación de políticas pendientes); nunca iniciarlo contra una base ajena a esta demostración.

En otra terminal, dentro de `Matista-frontend`, dejar `VITE_API_BASE_URL` vacía en su configuración local o ejecutar:

```bash
VITE_API_BASE_URL= npm run dev
```

Vite sirve `http://localhost:5173` y reenvía `/api` al backend local en 3000. No mezclar `localhost` y `127.0.0.1` al navegar ni cambiar de puerto sin alinear `FRONTEND_ORIGIN` y el proxy. No se necesitan cambios en el frontend para la instalación autónoma.

Verificar:

1. `npm run db:check` informa `matista_local`; `http://localhost:3000/api/health` responde `status: ok` (salud HTTP, no prueba SMTP/PDF).
2. Abrir `http://localhost:5173/login`, acceder con el ADMIN demo y consultar planes, las listas y los 9 porcentajes de la política comercial. Recargar la página debe conservar la sesión.
3. ADMIN **no puede cotizar**: registrar un ASESOR de prueba, verificar su correo vía SMTP local y activarlo desde el directorio ADMIN. Entrar como ese ASESOR y crear un cliente sintético para cotizar en **Obligatorio o Monotributo**. No forman parte del seed. Para Voluntario, configurar primero el IVA aprobado; no sustituirlo por un dato arbitrario.
4. Preparar, calcular y emitir; consultar el resultado. Descargar PDF si Chrome está disponible. Ninguna etapa exige SIGEC.
5. Repetir los comandos de ADMIN/catálogo: deben informar que ya existen sin duplicar ni resetear datos.

El clon autónomo necesita todavía configuración privada local, una cuenta MySQL y `npm ci`: no se distribuyen secretos, usuarios MySQL ni un despliegue productivo listo para publicar.

## Pruebas

Se usa el ejecutor nativo `node:test`, con concurrencia 1 en los scripts. Hay pruebas de unidades, repositorios con dobles, contratos HTTP, motor comercial y documentos; las que se llaman `integration` no son todas equivalentes: algunas simulan dependencias y otras acceden a MySQL.

| Script existente | Alcance / precaución |
|---|---|
| `npm test` | Infraestructura de datos y `tests/modules`; incluye arneses SQL/PDF condicionados |
| `npm run test:auth-infra` | Seguridad, correo simulado, errores, validaciones, limitadores y salud |
| `npm run test:auth` | Repositorio con dobles, servicios, autorización y HTTP AUTH; no sustituye la suite SQL |
| `npm run test:db` | Activa `RUN_DB_TESTS=1` para el esquema MySQL |
| `npm run test:auth:db` | Activa `RUN_AUTH_DB_TESTS=1` para persistencia AUTH real |
| `npm run test:install` | Aceptación SQL/HTTP únicamente en `development/matista_local` loopback; migra/carga si está vacía y revierte los fixtures HTTP |

Para una regresión con opt-in externos desactivados, revisar el entorno antes de invocar:

```bash
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 RUN_INSTALL_DB_TESTS=0 npm test
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 RUN_INSTALL_DB_TESTS=0 npm run test:auth-infra
RUN_DB_TESTS=0 RUN_AUTH_DB_TESTS=0 RUN_PDF_TESTS=0 RUN_INSTALL_DB_TESTS=0 npm run test:auth
```

Los ejemplos de variables prefijadas corresponden a shells POSIX. Algunos archivos cargan `.env`; las pruebas pueden crear listeners efímeros en loopback y temporales. No se presenta la ejecución como carente de todo efecto local.

Las suites MySQL históricas (`test:db`, `test:auth:db`, opt-in `RUN_DB_TESTS`) exigen `NODE_ENV=test` y `DB_NAME=matista_test`. Escriben/modifican/limpian datos; algunas ADMIN requieren SIGEC. **No ejecutarlas para esta aceptación**, que tiene su propia suite aislada:

```bash
NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local DB_SSL=false npm run test:install
```

Requiere una base local dedicada (creada por el operador), nunca borra ni recrea bases. En la primera ejecución sobre catálogo vacío verifica rollback real tras insertar las 160 tarifas; al repetirse omite ese caso para no limpiar información existente. Los comandos de aprovisionamiento sí quedan confirmados. Los fixtures HTTP posteriores (sesiones, asesor, cliente y emisión) utilizan SQL y servicios reales bajo una transacción exterior que se revierte al finalizar. No envía correo externo: el transporte de pruebas captura la verificación en memoria. La suite comprueba rechazo de producción/host remoto **antes de conectar** y compara huellas de todos los campos antes/después de repetir la instalación.

`RUN_PDF_TESTS=1` habilita casos opcionales de Chrome real en las pruebas de módulos; `npm run test:pdf` ejecuta las suites específicas de PDF. La aceptación autónoma no certifica Chrome ni entrega SMTP externa.

En la implementación de instalación autónoma (2026-11-03, Node 24.20.0 y MySQL 8.4.11 local) se verificaron las 30 migraciones sobre `matista_local` inicialmente vacía, los conteos 4/160/12/1/9, bcrypt/login ADMIN, repetición/concurrencia sin cambios, rechazo de producción y cotización HTTP en Obligatorio/Monotributo. Se preservó el rechazo de Voluntario sin IVA configurado. No se modificaron `matista_dev`, `matista_test`, Aiven ni el despliegue público.

**Pendientes de verificación manual:** recorrido en navegador, entrega SMTP externa, Chrome/PDF y repetir el procedimiento en un clon limpio con `npm ci`; las pruebas anteriores utilizaron las dependencias locales ya instaladas. Voluntario requiere además un IVA aprobado publicado por ADMIN. La revisión final previa al commit ejecuta la regresión sin opt-in MySQL, sin volver a modificar bases existentes.

## Seguridad y operación

- Contraseñas con bcrypt, costo 12; JWT HS256 de duración limitada y tokens temporales persistidos mediante hash. No hay una clave JWT predeterminada publicable.
- Cookie `matista_session`: HttpOnly, SameSite=Strict, ruta `/api`, sin `Domain`; `Secure` depende del origen HTTPS validado, incluso en un entorno de desarrollo con HTTPS.
- CORS permite un único origen exacto y credenciales; las mutaciones comprueban Origin. `trust proxy` está limitado a loopback: una topología distinta requiere revisión, no confianza global en cabeceras.
- Rate limiting de login, recuperación y reenvío con almacenamiento en memoria por proceso; no es un limitador distribuido.
- Roles, propiedad, revisión optimista, transacciones y auditoría protegen operaciones comerciales según cada caso de uso.
- SMTP exige cifrado; errores públicos evitan divulgar SQL, stacks o errores originales del proveedor. Aun así, revisar retención y acceso a logs: las rutas pueden contener identificadores personales.
- `.env`, dependencias, compilaciones, cobertura y logs están ignorados. `.gitignore` **no elimina información ya existente en commits** ni protege archivos añadidos a la fuerza.

Estos controles no garantizan seguridad absoluta ni sustituyen una auditoría de despliegue y dependencias. No publicar copias de bases, datos personales o material comercial sin autorización. Revisar también el historial, la identidad pública de los commits y los derechos sobre textos/marca antes de abrir el repositorio.

El funcionamiento local o mediante **túnel de VS Code no constituye un despliegue permanente de producción**. La única cuenta conocida distribuida es la demo local explícita; nunca usarla en una instalación pública.

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

Reservado, pero no implementado:

- Modulos `auth`, `admin` y `asesor`.
- Dominio comercial de tarifas, aportes, descuentos y cotizacion.
- Utilidades compartidas de middleware, validacion y errores.
- Infraestructura de PDF y correo.
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

Ejecutar pruebas que no acceden a MySQL:

```bash
npm test
```

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
|-- shared/                      # Reservado
|   |-- middleware/
|   |-- validators/
|   `-- errors/
|-- infrastructure/
|   |-- database/                # Conexion y migraciones AUTH
|   |-- pdf/
|   `-- email/
|-- app.js                       # Implementado
`-- server.js                    # Implementado
migrations/                      # DDL versionado AUTH
tests/                           # Pruebas unitarias y MySQL opt-in
```

Las reglas comerciales futuras deben residir en el dominio backend y no deben
duplicarse en React. El motor comercial, la persistencia, la autenticacion, PDF
y correo se encuentran fuera del alcance del estado actual.

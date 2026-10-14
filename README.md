# MATISTA Backend

API base de MATISTA construida con Node.js, Express 5 y JavaScript ES Modules.

## Estado actual

Implementado:

- Bootstrap de Express separado entre `src/app.js` y `src/server.js`.
- Carga de variables de entorno mediante `dotenv`.
- CORS para el frontend local en `http://localhost:5173`.
- Parser global de cuerpos JSON.
- Endpoint de salud `GET /api/health`.

Reservado, pero no implementado:

- Modulos `auth`, `admin` y `asesor`.
- Dominio comercial de tarifas, aportes, descuentos y cotizacion.
- Utilidades compartidas de middleware, validacion y errores.
- Infraestructura de base de datos, PDF y correo.
- Migraciones y pruebas automatizadas.

Los directorios reservados contienen unicamente archivos `.gitkeep`. No exponen
rutas ni incluyen controladores, servicios, repositorios, validadores, reglas de
negocio, migraciones o pruebas ejecutables.

## Requisitos

- Node.js 18 o una version compatible posterior.
- npm y las dependencias declaradas en `package.json`.

El proyecto no declara actualmente una version de Node mediante `engines`.

## Configuracion

La plantilla versionada se encuentra en `.env.example`:

```dotenv
PORT=3000
```

`PORT` es opcional. Si no se define, `src/server.js` utiliza el puerto `3000`.
La plantilla no contiene secretos ni configuracion de base de datos, JWT o SMTP.

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

No existen todavia scripts de pruebas, lint o build en este repositorio.

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
|-- infrastructure/              # Reservado
|   |-- database/
|   |-- pdf/
|   `-- email/
|-- app.js                       # Implementado
`-- server.js                    # Implementado
migrations/                      # Reservado
tests/                           # Reservado
```

Las reglas comerciales futuras deben residir en el dominio backend y no deben
duplicarse en React. El motor comercial, la persistencia, la autenticacion, PDF
y correo se encuentran fuera del alcance del estado actual.

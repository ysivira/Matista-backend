# SPEC-03 SL-2 - Contrato HTTP de consulta ADMIN

Este contrato cubre exclusivamente RF-D06/D07 y HU-ADM-03/04. Todas las
operaciones son de solo lectura, requieren una sesion ADMIN vigente y responden
con `Cache-Control: no-store`.

## GET /api/admin/planes

Devuelve los planes activos ordenados por `id` ascendente.

```json
{
  "planes": [
    {
      "id": 1,
      "nombre": "PLAN DE EJEMPLO",
      "detalles": null,
      "condiciones_generales": null
    }
  ]
}
```

- `id`: entero positivo.
- `nombre`: string no vacio.
- `detalles`: string o `null`.
- `condiciones_generales`: string o `null`.
- Si no hay planes activos, responde `200` con `{ "planes": [] }`.

## GET /api/admin/tarifario/planes/:planId/:tipoIngreso

Consulta las tarifas activas de la version vigente para un plan activo y una
modalidad. `planId` debe ser un entero decimal entre 1 y 65535, sin signo,
decimales ni ceros iniciales. `tipoIngreso` admite exactamente `Obligatorio` o
`Voluntario`; su valor debe codificarse como segmento de URL.

```json
{
  "plan": {
    "id": 1,
    "nombre": "PLAN DE EJEMPLO"
  },
  "tipo_ingreso": "Obligatorio",
  "version": {
    "id": "1",
    "tipo": "CARGA_INICIAL",
    "estado": "ACTIVA",
    "fecha_activacion": "2026-10-20T12:00:00.000Z"
  },
  "tarifas": [
    {
      "rango_clave": "0-25",
      "rango_etario": "0-25",
      "rango_nota": null,
      "precio": "0.00"
    }
  ]
}
```

El precio del ejemplo es ilustrativo y no representa un precio real.

- `version.id` es una cadena decimal para preservar el `BIGINT`.
- `fecha_activacion` usa ISO 8601 en UTC.
- `precio` es una cadena decimal con dos posiciones; el backend no lo convierte
  a punto flotante.
- Solo se incluyen filas con `activa=1`.
- `rango_clave` conserva la clave canonica; `rango_etario` conserva la etiqueta
  original y `rango_nota` conserva anotaciones como `(*)`.
- La coleccion respeta el orden comercial de las veinte claves de E2. Si todas
  las tarifas del grupo estan inactivas, responde `200` con `tarifas: []`.

El orden completo es: `0-25`, `26-35`, `36-40`, `41-50`, `51-60`, `61-65`,
`66+`, `FAMILIAR A CARGO`, `HIJO 0-1`, `HIJO 2-20`, `HIJO 21-29`,
`HIJO 30-39`, `HIJO 40-49`, `MAT 0-25`, `MAT 26-35`, `MAT 36-40`,
`MAT 41-50`, `MAT 51-60`, `MAT 61-65`, `MAT 66-00`.

## Errores

| Caso | HTTP | Codigo |
|---|---:|---|
| Parametro invalido | 400 | `ADMIN_VALIDACION` |
| Plan inexistente | 404 | `ADMIN_NO_ENCONTRADO` |
| Plan inactivo | 409 | `ADMIN_ESTADO` |
| Sin version vigente efectiva | 409 | `ADMIN_ESTADO` |
| Sin sesion valida | 401 | Contrato AUTH vigente |
| Rol distinto de ADMIN | 403 | `ROLE_FORBIDDEN` |

Los errores conservan la forma compartida:

```json
{
  "error": {
    "code": "ADMIN_VALIDACION",
    "message": "Los parametros de la consulta no son validos.",
    "details": [
      {
        "field": "tipoIngreso",
        "message": "Debe ser Obligatorio o Voluntario."
      }
    ]
  }
}
```

La vigencia se resuelve con `resolverVersionVigente`: mayor
`fecha_activacion` no futura entre versiones `ACTIVA`, excluyendo cualquier
version con cancelacion abierta. Una version cancelada no impide recuperar una
version anterior que continue siendo efectiva.

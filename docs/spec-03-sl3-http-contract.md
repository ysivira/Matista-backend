# SPEC-03 SL-3 · Contrato HTTP de versiones del tarifario (modelo "copia completa")

Este contrato cubre las consultas del historial de versiones de ADMIN según el
modelo funcional cerrado (decreciones O-1..O-7, migraciones 013/014/015). Todas
las operaciones son de solo lectura (nunca activan ni modifican estados),
requieren sesión ADMIN vigente y responden con `Cache-Control: no-store`.

Convenciones compartidas: los identificadores BIGINT (`id`, `version_base_id`)
viajan como string decimal; los precios DECIMAL como string con dos decimales;
las fechas en ISO 8601 UTC con precisión hasta milisegundo (la presentación en
pantalla usa `America/Argentina/Buenos_Aires`). El `id` es un identificador
técnico: **no** constituye numeración comercial consecutiva de versión.

## GET /api/admin/tarifario/versiones

Historial completo de versiones en orden cronológico de creación
(`created_at` ascendente). Incluye vigentes, históricas, en preparación y
canceladas (estructura heredada, sin productor nuevo).

```json
{
  "versiones": [
    {
      "id": "7",
      "tipo": "EDICION_LISTA",
      "estado": "PREPARACION",
      "revision": 0,
      "fecha_activacion": null,
      "version_base_id": "1",
      "created_at": "2026-10-21T14:00:00.000Z",
      "actor_legajo": "1234567",
      "actor_nombre": "Marcelo",
      "actor_apellido": "Suarez"
    },
    {
      "id": "1",
      "tipo": "CARGA_INICIAL",
      "estado": "ACTIVA",
      "revision": 0,
      "fecha_activacion": "2026-10-19T16:37:36.000Z",
      "version_base_id": null,
      "created_at": "2026-10-19T16:20:00.000Z",
      "actor_legajo": null,
      "actor_nombre": null,
      "actor_apellido": null
    }
  ]
}
```

- `actor_*`: identidad del creador. La carga inicial (`CARGA_INICIAL`, id 1)
  no tiene actor legajo: los tres campos son `null` y la pantalla presenta
  "Sistema (carga inicial)".
- `revision`: contador interno de escrituras de la versión (número, no
  string). Vuelve a `null` en proyecciones sin cabecera persistida. La
  pantalla lo usa como revisión inicial del borrador abierto: cada
  operación de SL-4 exige esa revisión en el cuerpo y la respuesta
  devuelve la nueva.
- `fecha_activacion`: `null` en borradores (PREPARACION/LISTA_PARA_ACTIVAR).
- Sin versiones: `200 { "versiones": [] }`.

## GET /api/admin/tarifario/versiones/:id

Detalle de una versión con su trazabilidad de creación.

- 400 `ADMIN_VALIDACION` si `id` no es entero positivo sin ceros iniciales
  (rango seguro de JavaScript).
- 404 `ADMIN_NO_ENCONTRADO` si no existe; versión con cualquier estado
  responde 200.
- 200: mismo objeto `version` del listado.

## GET /api/admin/tarifario/versiones/:id/tarifas

Lista completa del snapshot de la versión: todas las filas, activas e
inactivas (`activa: true|false`), ordenadas por plan, modalidad y posición
comercial de la clave de rango.

```json
{
  "version": { "id": "7", "tipo": "EDICION_LISTA", "estado": "PREPARACION" },
  "tarifas": [
    {
      "id": "101",
      "plan_id": "1",
      "plan_nombre": "RUBI",
      "tipo_ingreso": "Obligatorio",
      "rango_clave": "0-25",
      "rango_etario": "0-25",
      "rango_nota": null,
      "precio": "10.00",
      "activa": true
    }
  ]
}
```

- 400/404 con las mismas reglas del detalle.

## GET /api/admin/tarifario?fecha=…

Consulta histórica: identifica la versión que estaba efectivamente activa en
la fecha pedida y devuelve su tarifario efectivo (solo filas `activa = 1`).
La consulta nunca modifica estados; no proyecta activaciones futuras
(activación exclusivamente manual): una fecha posterior a la última
activación responde la versión vigente actual.

- `fecha` obligatoria: ISO 8601 con zona horaria explícita (`Z` o
  `±HH:MM`), hasta 3 decimales de fracción (milisegundo). Sin zona,
  malformada o de calendario inexistente → 400 `ADMIN_VALIDACION`.
- Anterior a toda activación → 409 `ADMIN_ESTADO`.

```json
{
  "fecha": "2026-10-20T12:30:00.000Z",
  "version": { "id": "1", "tipo": "CARGA_INICIAL", "estado": "ACTIVA", "fecha_activacion": "..." },
  "tarifas": [ { "plan_id": "1", "plan_nombre": "RUBI", "tipo_ingreso": "Obligatorio", "rango_clave": "0-25", "rango_etario": "0-25", "rango_nota": null, "precio": "404808.93", "activa": true } ]
}
```

## Errores

| Caso | HTTP | Código |
|---|---:|---|
| `id` o `fecha` inválidos | 400 | `ADMIN_VALIDACION` |
| Versión inexistente (detalle/tarifas) | 404 | `ADMIN_NO_ENCONTRADO` |
| Sin versión vigente a la fecha pedida | 409 | `ADMIN_ESTADO` |
| Sin sesión válida / rol no ADMIN | 401 / 403 | Contrato AUTH / `ROLE_FORBIDDEN` |
| Ruta ADMIN inexistente | 404 | `ADMIN_ROUTE_NOT_FOUND` |

Fuera de contrato: comparación de versiones y endpoints de diferencias no
existen ni se implementan (decreto funcional de la corrección definitiva del
modelo de versionado).

# SPEC-03 SL-4/SL-5 · Contrato HTTP del ciclo de vida de borradores

Complementa `spec-03-sl3-http-contract.md`: cubre las operaciones de
escritura sobre el ciclo de vida de una versión EDICION_LISTA según el
modelo "copia completa" (decisiones O-1..O-7, migraciones 013/014/015).
Todas las rutas requieren sesión ADMIN vigente, `Cache-Control: no-store`
y un cuerpo JSON (la petición sin cuerpo JSON válido responde por el
contrato HTTP general). Toda escritura corona un evento de auditoría en
`tarifario_versiones_eventos` (014) y avanza el contador de revisión
optimista del borrador.

Flujo unívoco del ciclo: **A** creación del borrador (copia de la ACTIVA)
→ **B** ediciones (aumento masivo y/o precios individuales) → **C**
finalización (`PREPARACION` → `LISTA_PARA_ACTIVAR`) → **D** activación
manual (`LISTA_PARA_ACTIVAR` → `ACTIVA`, la ACTIVA vigente pasa a
`HISTORICA`). La activación es exclusivamente manual: no existe
activación programada ni automática.

Convenciones compartidas con SL-3: identificadores BIGINT como string
decimal, precios DECIMAL como string con dos decimales, fechas ISO 8601
UTC.

## POST /api/admin/tarifario/versiones · (caso A)

Crea el borrador copiando íntegra la versión ACTIVA vigente:
`tarifario_versiones` (estado `PREPARACION`, `version_base_id` = ACTIVA)
+ `tarifas` (fila por fila) + evento `CREACION`.

- Sin cuerpo relevante: el sistema ignora parámetros de la petición y usa
  el snapshot vigente.
- 201 con la versión creada:

```json
{
  "version": {
    "id": "7",
    "tipo": "EDICION_LISTA",
    "estado": "PREPARACION",
    "version_base_id": "1",
    "actor_legajo": "1234567",
    "evento": { "id": "9", "tipo": "CREACION" }
  }
}
```

- 409 `ADMIN_ESTADO` si ya existe un borrador abierto. El evento incluye
  al borrador ganador de la carrera:

```json
{
  "error": {
    "code": "ADMIN_ESTADO",
    "message": "Ya existe una edicion de precios abierta (borrador 7) desde el 21/10/2026 12:00.",
    "details": { "version": { "id": "7", "estado": "PREPARACION" } }
  }
}
```

- 409 `ADMIN_ESTADO` si no hay una versión ACTIVA de la cual copiar.

## POST /api/admin/tarifario/versiones/:id/aumentos · (caso B)

Aumento masivo porcentual sobre todas las filas del borrador (o de una
modalidad si se pide). Solo versión `PREPARACION`. Cada fila captura su
valor anterior ANTES de escribir; el incremento se calcula con aritmética
exacta (HALF-UP en centavos) y se aborta todo si una fila excedería el
tope DECIMAL(10,2). Auditoría: evento agrupador
(`MODIFICACION` + `AUMENTO_MASIVO`) y un hijo `PRECIO` con
`valor_anterior`/`valor_nuevo` e identificación plan/modalidad/rango por
fila.

```json
{ "porcentaje": "5", "tipoIngreso": "Voluntario", "revision": "0" }
```

- `porcentaje`: obligatorio, `0 < p < 100`, hasta 2 decimales.
- `tipoIngreso`: opcional (`Obligatorio` o `Voluntario`); sin él el
  aumento alcanza a las dos modalidades.
- `revision`: obligatoria, versión optimista del borrador (`n ≥ 0`).

- 200:

```json
{
  "evento": { "id": "12", "tipo": "AUMENTO_MASIVO" },
  "porcentaje": "5",
  "filas": 2,
  "revision": 1
}
```

## PATCH /api/admin/tarifario/versiones/:id/tarifas/:tarifaId · (caso B)

Cambia el precio de una fila individual del borrador. Solo versión
`PREPARACION`. La tarifa debe pertenecer a la versión pedida (404 si
no); el evento hijo queda identificado con plan/modalidad/rango.

```json
{ "precio": "120.50", "revision": "1" }
```

- `precio`: obligatorio, `> 0`, DECIMAL(10,2).
- `revision`: obligatoria, contra el contador del borrador.

- 200:

```json
{
  "tarifa": {
    "id": "201",
    "plan_id": "1",
    "tipo_ingreso": "Obligatorio",
    "rango_clave": "0-25",
    "precio": "120.50"
  },
  "revision": 2
}
```

- 404 `ADMIN_NO_ENCONTRADO` si la tarifa no existe dentro de la versión.

## POST /api/admin/tarifario/versiones/:id/finalizacion · (caso C)

Cierra la edición: `PREPARACION` → `LISTA_PARA_ACTIVAR` con evento
`FINALIZACION`. No activa nada: queda esperando la activación manual.

```json
{ "revision": "2" }
```

- 200:

```json
{
  "version": {
    "id": "7",
    "tipo": "EDICION_LISTA",
    "estado": "LISTA_PARA_ACTIVAR",
    "revision": 3
  }
}
```

## POST /api/admin/tarifario/versiones/:id/activacion · (caso D, SL-5)

Activación manual transaccional. En una sola operación:

1. Bloquea (`FOR UPDATE`) la cabecera y exige estado
   `LISTA_PARA_ACTIVAR`.
2. Exige snapshot no vacío (la integridad restante la imponen los
   UNIQUE y CHECK del esquema; un plan inactivo no frena la activación).
3. Exige existencia de una versión ACTIVA vigente a reemplazar.
4. Convierte la ACTIVA en `HISTORICA` y marca el borrador como `ACTIVA`
   con `fecha_activacion = NOW(6)`.
5. Registra el evento `ACTIVACION`.

Cualquier fallo hace rollback y deja la vigencia anterior intacta: la
garantía "una sola ACTIVA" nunca queda comprometida en pantalla.

- Sin cuerpo.
- 200:

```json
{
  "version": { "id": "7", "tipo": "EDICION_LISTA", "estado": "ACTIVA", "fecha_activacion": "..." },
  "versionReemplazada": "1",
  "evento": { "id": "20", "tipo": "ACTIVACION" }
}
```

## Errores

| Caso | HTTP | Código |
|---|---:|---|
| `id`/`tarifaId`/`precio`/`porcentaje`/`revision`/`tipoIngreso` inválidos | 400 | `ADMIN_VALIDACION` |
| Versión sin filas (aumento) o tarifa ajena a la versión | 404 | `ADMIN_NO_ENCONTRADO` (tarifa) / 409 `ADMIN_ESTADO` (sin filas) |
| Versión inexistente | 404 | `ADMIN_NO_ENCONTRADO` |
| Borrador ya existente al crear otro | 409 | `ADMIN_ESTADO` |
| Operación sobre versión con estado incompatible (ej. activar algo no `LISTA_PARA_ACTIVAR`, ediciones de una versión histórica) | 409 | `ADMIN_TRANSICION` |
| Desfase de revisión (otro ADMIN escribió primero) | 409 | `ADMIN_CONCURRENCIA` |
| Aumento fuera del tope DECIMAL en alguna fila | 409 | `ADMIN_ESTADO` |
| Activación sin versión ACTIVA vigente que reemplazar | 409 | `ADMIN_ESTADO` |
| Sin sesión válida / rol no ADMIN | 401 / 403 | Contrato AUTH / `ROLE_FORBIDDEN` |

Garantías transversales: revisiones optimistas (el doble escritor tiene
409 y reintenta leyendo la versión); toda escritura es transaccional
(begin/commit/rollback); los eventos de auditoría se graban junto al
cambio de estado y con los valores capturados previamente; la concurrencia
exclusiva del borrador y la unidad de ACTIVA la garantiza el esquema
(columnas generadas + UNIQUE de 015), también para una carrera entre dos
`POST /tarifario/versiones` simultáneos.

## GET /api/admin/tarifario/versiones/:id/eventos · Resumen de cambios

Lee el resumen de cambios de la versión construido SOBRE LOS EVENTOS
REALES de auditoría (014): nada se reconstruye desde diferencias de
snapshots. Cada operación registrada aparece con su responsable, su
fecha, su entidad y sus valores anterior/nuevo; un aumento masivo
suma además la cantidad real de sus filas hijas (contadas en la misma
tabla por `agrupador_id`). La lista viaja del más reciente al más
antiguo.

- 200:

```json
{
  "version": { "id": "7", "tipo": "EDICION_LISTA", "estado": "PREPARACION", "revision": 4 },
  "eventos": [
    {
      "id": "14",
      "tipo_evento": "MODIFICACION",
      "tipo_operacion": "PRECIO",
      "agrupador": null,
      "entidad": { "plan_id": "2", "tipo_ingreso": "Voluntario", "rango_clave": "HIJO 0-1" },
      "valor_anterior": "30.00",
      "valor_nuevo": "45.50",
      "detalle": "mod. PRECIO del rango HIJO 0-1.",
      "actor_legajo": "1234567",
      "actor_nombre": "Marcelo",
      "actor_apellido": "Suarez",
      "evento_en": "2026-10-21T15:03:00.000Z"
    },
    {
      "id": "11",
      "tipo_evento": "MODIFICACION",
      "tipo_operacion": "AUMENTO_MASIVO",
      "agrupador": null,
      "filas_agrupadas": 2,
      "entidad": null,
      "valor_anterior": null,
      "valor_nuevo": null,
      "detalle": "DESHACE: restablece los precios previos del ultimo aumento masivo aplicado a la version 7.",
      "actor_legajo": "1234567",
      "actor_nombre": "Marcelo",
      "actor_apellido": "Suarez",
      "evento_en": "..."
    }
  ]
}
```

- `filas_agrupadas` solo existe en eventos `AUMENTO_MASIVO` (cabezal del
  grupo); los hijos `PRECIO` del grupo viajan con su `agrupador` y sus
  dos valores. Eventos del ciclo (`CREACION`, `FINALIZACION`,
  `ACTIVACION`) viajan con entidad y valores nulos.
- La reversion generada por el deshacer se reconoce por el prefijo
  `DESHACE:` en `detalle` (convencion acordada del deshacer).
- 404 `ADMIN_NO_ENCONTRADO` si la version no existe.

## POST /api/admin/tarifario/versiones/:id/deshacer · Deshacer último cambio

Deshace el ÚLTIMO cambio económico AÚN VIGENTE del borrador dentro de
una única transacción, con revisión optimista. Semántica por capas:

1. Encuentra en la auditoría el evento `PRECIO` más reciente que no haya
   sido ya restaurado por un deshacer anterior. Si es un hijo agrupado,
   el objetivo es el grupo completo (`AUMENTO_MASIVO` original + todos
   sus hijos); si es suelto, la edición individual.
2. Verifica por cada fila objetivo que el precio actual coincida con
   `valor_nuevo` registrado (integridad: si la fila cambió por otra vía,
   aborta sin aplicar nada con 409 `ADMIN_ESTADO`).
3. Restaura `valor_anterior` en cada fila y registra su propia
   auditoría: para el caso masivo, un grupo `AUMENTO_MASIVO` con
   `detalle` `DESHACE: ...` y un hijo `PRECIO` `DESHACE: ...` por fila;
   para el caso individual, un único evento `PRECIO` `DESHACE: ...`.
4. Avanza la revisión una unidad (el deshacer es también una escritura:
   avanza el contador para mantener la exclusividad optimista).

Restricciones de diseño: sobre versiones cerradas no hay deshacer
(`LISTA_PARA_ACTIVAR`, `ACTIVA`, `HISTORICA` responden 409
`ADMIN_TRANSICION`); las activaciones no se revierten; una reversión
previa no se "des-deshace" (propondría precios invalidados): pedir
deshacer otra vez sigue deshaciendo el siguiente cambio pendiente.

```json
{ "revision": "3" }
```

- 200:

```json
{
  "filas": 2,
  "revision": 4,
  "evento": { "id": "11", "tipo": "DESHACER_GRUPO" }
}
```

- `evento.tipo` es `DESHACER_EDICION` (una fila) o `DESHACER_GRUPO`
  (aumento masivo revertido); `id` referencia al evento `DESHACE`
  registrado (grupo para `DESHACER_GRUPO`, hijo único para
  `DESHACER_EDICION`).
- 409 `ADMIN_ESTADO` si no queda ningún cambio pendiente, si una fila
  no existe más o si su precio no coincide con la auditoría.

## Errores adicionales de trazabilidad/deshacer

| Caso | HTTP | Código |
|---|---:|---|
| Deshacer sin cambios pendientes | 409 | `ADMIN_ESTADO` |
| Fila del evento inexistente o precio inconsistente con auditoría | 409 | `ADMIN_ESTADO` |
| Deshacer sobre versión cerrada/activación | 409 | `ADMIN_TRANSICION` |
| Desfase de revisión en deshacer | 409 | `ADMIN_CONCURRENCIA` |

## POST /api/admin/tarifario/versiones/:id/recuperacion · Recuperar HISTORICA

Crea un borrador de edición en `PREPARACION` copiando íntegramente una
versión `HISTORICA` elegida del historial (recuperación funcional). La
nueva versión conserva el origen en `version_base_id`, copia fila a fila
todas las tarifas de la fuente y registra su evento `CREACION`
(`Recuperacion de la version historica N con X filas...`). La activación
posterior usa el procedimiento normal (caso D): nunca reactiva ni borra
versiones cerradas desde la interfaz.

Responde 201 con `{ version }` (misma forma del caso A, con
`version_base_id` = la versión histórica de origen).
- 404 `ADMIN_NO_ENCONTRADO` si la versión indicada no existe.
- 409 `ADMIN_TRANSICION` si el origen no es `HISTORICA` (la `ACTIVA` se
  copia con el caso A; una `LISTA_PARA_ACTIVAR` es el propio borrador
  abierto).
- 409 `ADMIN_ESTADO` si ya existe un borrador abierto (exclusividad
  `uq_guard_borrador_version`), con `version` del existente en la
  respuesta de error.

Notas de cierre:
- La finalización (caso C) NO exige cambios respecto de la base: puede
  enviarse a `LISTA_PARA_ACTIVAR` un borrador cuyos precios sean
  idénticos a su fuente; solo exige estado `PREPARACION`, revisión
  optimista vigente y snapshot íntegro (la activación valida las filas).
- «Debe iniciar sesión para continuar.» es `401 SESSION_REQUIRED`: la
  cookie `matista_session` (2 h,/httpOnly) no viajó en el pedido. El
  frontend la trata como sesión vencida (limpia el estado local y
  redirige a `/login`); el backend no hace excepciones.

## POST /api/admin/tarifario/versiones/:id/reanudacion · Volver a edición

Reabre la edición de una versión finalizada: `LISTA_PARA_ACTIVAR` ->
`PREPARACION`, conservando todos los precios, la revisión y la auditoría
previa. Registra un evento `REANUDACION` del ciclo de vida (migración
016; amigo de la auditoría y visible en el resumen). No crea versiones
nuevas y no toca `ACTIVA`/`HISTORICA`.

- 200:

```json
{
  "version": { "id": "7", "tipo": "EDICION_LISTA", "estado": "PREPARACION", "revision": 2 },
  "evento": { "id": "9", "tipo": "REANUDACION" }
}
```

- 404 `ADMIN_NO_ENCONTRADO` si la versión no existe.
- 409 `ADMIN_TRANSICION` si el estado no es `LISTA_PARA_ACTIVAR`
  (`PREPARACION` ya está abierta, `ACTIVA`/`HISTORICA` permanecen
  protegidas contra modificaciones directas).

## POST /api/admin/tarifario/versiones/:id/descarte · Descartar versión

Retira del ciclo una versión que nunca fue activada: `PREPARACION` o
`LISTA_PARA_ACTIVAR` -> `CANCELADA` (decisión de negocio tomada en la
ronda del descarte: se reutiliza el valor heredado de la 013, que no
tenía productor ni datos en ninguna base, y la pantalla lo muestra como
«Descartada»), conservando físicamente precios, numeración y auditoria.
Requiere cuerpo:

```json
{ "revision": 2, "motivo": "El cliente no aprobó la lista." }
```

- 200:

```json
{
  "version": { "id": "7", "tipo": "EDICION_LISTA", "estado": "CANCELADA", "revision": 2 },
  "evento": { "id": "9", "tipo": "DESCARTE" }
}
```

- 400 `ADMIN_VALIDACION` si falta el motivo, es vacío o supera 200
  caracteres.
- 404 `ADMIN_NO_ENCONTRADO` si la versión no existe.
- 409 `ADMIN_TRANSICION` para `ACTIVA`, `HISTORICA` y versiones ya
  descartadas: la vigencia queda intacta y los precios nunca se borran.
- 409 `ADMIN_CONCURRENCIA` si la revisión enviada quedó desfasada
  (edición o activación concurrente).

Notas de cierre del descarte:
- El evento `DESCARTE` es del ciclo de vida (`tipo_operacion` NULL, sin
  entidad): requiere la migración 017 (ENUM de `tipo_evento` con
  `DESCARTE`; pendiente de aprobación de ejecución al cierre de esta
  ronda). El detalle del evento incluye el motivo: `Descarte de la
  version N. Motivo: ...` (responsable + fecha automáticamente del
  esquema 014).
- La exclusividad de borradores se libera por esquema: `guard_borrador`
  (015) vale 1 solo para PREPARACION/LISTA_PARA_ACTIVAR, así que tras el
  descarte el índice único vuelve a aceptar un borrador nuevo de
  inmediato.
- `ACTIVACION`/ediciones posteriores sobre una descartada fallan con
  `ADMIN_TRANSICION`: los flujos de edición (caso B/C/D y reanudación)
  validan el estado antes de tocar datos.

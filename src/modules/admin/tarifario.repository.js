/**
 * Lista el catalogo publico de planes activos en su orden persistido.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @returns {Promise<object[]>} Planes activos sin campos internos.
 */
export async function listarPlanesActivos(connection) {
  const [filas] = await connection.execute(
    `SELECT id, nombre, detalles, condiciones_generales
       FROM planes
      WHERE activa = 1
      ORDER BY id`,
  );
  return filas;
}

/**
 * Busca un plan por identificador incluyendo su estado para distinguir 404 y 409.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @param {number} planId Identificador validado del plan.
 * @returns {Promise<object|undefined>} Plan interno o undefined si no existe.
 */
export async function obtenerPlanPorId(connection, planId) {
  const [filas] = await connection.execute(
    'SELECT id, nombre, activa FROM planes WHERE id = ?',
    [planId],
  );
  return filas[0];
}

/**
 * Lee las tarifas activas de un grupo dentro de un snapshot vigente.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @param {object} filtro Version, plan y modalidad ya validados.
 * @returns {Promise<object[]>} Rangos, notas y precios DECIMAL sin conversion numerica.
 */
export async function listarTarifasActivas(
  connection,
  { versionId, planId, tipoIngreso },
) {
  const [filas] = await connection.execute(
    `SELECT rango_clave, rango_etario, rango_nota, precio
       FROM tarifas
      WHERE version_id = ?
        AND plan_id = ?
        AND tipo_ingreso = ?
        AND activa = 1
      ORDER BY id`,
    [versionId, planId, tipoIngreso],
  );
  return filas;
}

/**
 * Lista las versiones del tarifario en orden cronologico de creacion
 * (decisión 6 del cierre funcional: created_at ascendente; el id es
 * identificador tecnico, no numeracion commercial). Los espacios BIGINT
 * llegan como BigInt y el responsable como JOIN vigente de empleados.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @returns {Promise<object[]>} Cabeceras con identidad del responsable.
 */
export async function listarVersiones(connection) {
  const [filas] = await connection.query(
    `SELECT v.id, v.tipo, v.estado, v.revision, v.fecha_activacion, v.version_base_id,
            v.actor_legajo, v.created_at, empleados.nombre, empleados.apellido
       FROM tarifario_versiones v
       LEFT JOIN empleados ON empleados.legajo = v.actor_legajo
      ORDER BY v.created_at ASC, v.id ASC`,
  );
  return filas;
}

/**
 * Busca una version por id con su identidad de responsable; el estado
 * queda visible para distinguir borradores, vigentes e historicas.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @param {number} versionId Identificador validado de la version.
 * @returns {Promise<object|undefined>} Version con responsable o undefined.
 */
export async function obtenerVersionPorId(connection, versionId) {
  const [filas] = await connection.query(
    `SELECT v.id, v.tipo, v.estado, v.revision, v.fecha_activacion, v.version_base_id,
            v.actor_legajo, v.created_at, empleados.nombre, empleados.apellido
       FROM tarifario_versiones v
       LEFT JOIN empleados ON empleados.legajo = v.actor_legajo
      WHERE v.id = ?`,
    [versionId],
  );
  return filas[0];
}

/**
 * Lee el snapshot completo de tarifas de una version; el historial exige
 * ver todas las filas (activas e inactivas) y la reconstrucción filtra
 * `soloActivas` para reproducir el tarifario efectivo de esa version.
 * @param {object} connection Conexion mysql2 de la unidad de lectura.
 * @param {number} versionId Identificador de la version pedida.
 * @param {{soloActivas: boolean?}} opciones Filtrado del snapshot.
 * @returns {Promise<object[]>} Filas con nombre de plan y DECIMAL sin convertir.
 */
export async function listarTarifasDeVersion(
  connection,
  versionId,
  { soloActivas = false } = {},
) {
  const [filas] = await connection.query(
    `SELECT t.id, t.plan_id, planes.nombre AS plan_nombre, t.tipo_ingreso,
            t.rango_clave, t.rango_etario, t.rango_nota, t.precio, t.activa
       FROM tarifas t
       JOIN planes ON planes.id = t.plan_id
      WHERE t.version_id = ?
        ${soloActivas ? 'AND t.activa = 1' : ''}
      ORDER BY t.plan_id, t.tipo_ingreso, t.id`,
    [versionId],
  );
  return filas;
}

// ─────────────────────────────────────────────────────────────────────
// SL-4/SL-5 · Persistencia del ciclo de vida (modelo "copia completa").
// Cada funcion asume una conexion transaccional entregada por el
// servicio; los bloqueos FOR UPDATE serializan los escritores sobre la
// cabecera de la version y la garantia de exclusividad queda en los
// UNIQUE generados de la migracion 015, no en banderas de aplicacion.
// ─────────────────────────────────────────────────────────────────────

/**
 * Bloquea y devuelve la version actualmente ACTIVA, punto de inicio de
 * cualquier copia (A) y de la sustitucion de vigencia (D). La lectura
 * bloqueante siempre ve el estado mas reciente confirmado en la base,
 * evitando copiar desde un snapshot viejo bajo REPEATABLE READ.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @returns {Promise<object|undefined>} Cabecera ACTIVA bloqueada o undefined.
 */
export async function bloquearVersionActiva(connection) {
  const [filas] = await connection.execute(
    `SELECT id, tipo, estado, fecha_activacion, version_base_id,
            actor_legajo, revision
       FROM tarifario_versiones
      WHERE estado = 'ACTIVA'
      LIMIT 1
      FOR UPDATE`,
  );
  return filas[0];
}

/**
 * Bloquea y devuelve el borrador abierto de exclusividad (PREPARACION o
 * LISTA_PARA_ACTIVAR) con la identidad de quien lo inicio. La lectura
 * bloqueante interactua con el UNIQUE de la migracion 015: si otro
 * escritor gana la carrera, esta consulta correctamente informa su
 * nombre, apellido, legajo y fecha de iniciacion para el 409 del
 * contrato de creacion.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @returns {Promise<object|undefined>} Borrador con responsable o undefined.
 */
export async function bloquearBorradorAbierto(connection) {
  const [filas] = await connection.query(
    `SELECT v.id, v.estado, v.actor_legajo, v.created_at,
            empleados.nombre, empleados.apellido
       FROM tarifario_versiones v
       LEFT JOIN empleados ON empleados.legajo = v.actor_legajo
      WHERE v.estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR')
      LIMIT 1
      FOR UPDATE`,
  );
  return filas[0];
}

/**
 * Crea la cabecera de un borrador tipo EDICION_LISTA en PREPARACION, a
 * partir de la version vigente; los guardas generados de la migracion
 * 015 protegen la exclusividad incluso en carrera concurrente.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{versionBaseId: number|string, actorLegajo: string,
 *          observacion: string}} datos Datos de la nueva cabecera.
 * @returns {Promise<number>} Identificador autogenerado del borrador.
 */
export async function insertarBorrador(
  connection,
  { versionBaseId, actorLegajo, observacion },
) {
  const [resultado] = await connection.execute(
    `INSERT INTO tarifario_versiones
        (tipo, estado, version_base_id, actor_legajo, observacion)
     VALUES ('EDICION_LISTA', 'PREPARACION', ?, ?, ?)`,
    [versionBaseId, actorLegajo, observacion],
  );
  return resultado.insertId;
}

/**
 * Copia integramente el snapshot de tarifas de la version origen hacia el
 * borrador destino dentro de la misma transaccion (modelo copia completa:
 * el borrador es una instantanea propia, base para ediciones libre).
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{origenId: number|string, destinoId: number|string}} ids
 *   Version vigente que se copia y borrador que recibe la copia.
 * @returns {Promise<number>} Cantidad de filas copiadas (property `affectedRows`).
 */
export async function copiarTarifas(connection, { origenId, destinoId }) {
  const [resultado] = await connection.execute(
    `INSERT INTO tarifas
        (version_id, plan_id, tipo_ingreso, rango_etario, rango_clave,
         rango_nota, precio, activa)
     SELECT ?, plan_id, tipo_ingreso, rango_etario, rango_clave,
            rango_nota, precio, activa
       FROM tarifas
      WHERE version_id = ?`,
    [destinoId, origenId],
  );
  return resultado.affectedRows;
}

/**
 * Bloquea la cabecera completa de una version (incluida `revision`) para
 * las operaciones B, C y D; la fila no se libera hasta el commit.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {number|string} versionId Identificador tecnico de la version.
 * @returns {Promise<object|undefined>} Cabecera bloqueada o undefined si no existe.
 */
export async function bloquearVersion(connection, versionId) {
  const [filas] = await connection.execute(
    `SELECT id, tipo, estado, fecha_activacion, version_base_id,
            actor_legajo, revision
       FROM tarifario_versiones
      WHERE id = ?
      FOR UPDATE`,
    [versionId],
  );
  return filas[0];
}

/**
 * Bloquea una tarifa individual del snapshot de un borrador.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{versionId: number|string, tarifaId: number|string}} ids
 *   Version y fila pedidas por el PATCH.
 * @returns {Promise<object|undefined>} Fila interna o undefined.
 */
export async function bloquearTarifa(connection, { versionId, tarifaId }) {
  const [filas] = await connection.execute(
    `SELECT id, version_id, plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE id = ? AND version_id = ?
      FOR UPDATE`,
    [tarifaId, versionId],
  );
  return filas[0];
}

/**
 * Actualiza unicamente el precio de la tarifa pedida dentro de su version.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{tarifaId: number|string, precio: string}} edicion Importe nuevo validado.
 * @returns {Promise<number>} Filas afectadas (0 si la fila desaparecio).
 */
export async function actualizarPrecioTarifa(connection, { tarifaId, precio }) {
  const [resultado] = await connection.execute(
    'UPDATE tarifas SET precio = ? WHERE id = ?',
    [precio, tarifaId],
  );
  return resultado.affectedRows;
}

/**
 * Aumenta los precios de una modalidad (o de ambas si `tipoIngreso` es
 * null) fijando el importe calculado HALF-UP por el servicio.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{versionId: number|string, importes: Array<[number, string]>,
 *          tipoIngreso: string|null}} aumento Filas ya calculadas por el servicio.
 * @returns {Promise<number>} Filas efectivamente aumentadas.
 */
export async function aumentarPrecios(
  connection,
  { versionId, importes, tipoIngreso },
) {
  let filasAfectadas = 0;
  for (const [tarifaId, precioNuevo] of importes) {
    const [resultado] = await connection.execute(
      'UPDATE tarifas SET precio = ? WHERE id = ? AND version_id = ?',
      [precioNuevo, tarifaId, versionId],
    );
    filasAfectadas += resultado.affectedRows;
  }
  return filasAfectadas;
}

/**
 * Actualiza el estado de una version dentro de la transaccion; para la
 * activacion (D) estampa ademas fecha_activacion NOW(6), que libera el
 * guarda uq_guard_activa de la version anterior al conmutar el estado.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{id: number|string, estado: string,
 *          activar: boolean?}} transicion Nuevo estado del ciclo.
 * @returns {Promise<number>} Filas afectadas.
 */
export async function actualizarEstadoVersion(
  connection,
  { id, estado, activar = false },
) {
  const [resultado] = await connection.execute(
    `UPDATE tarifario_versiones
       SET estado = ?${activar ? ', fecha_activacion = NOW(6)' : ''}
     WHERE id = ?`,
    [estado, id],
  );
  return resultado.affectedRows;
}

/**
 * Incrementa `revision` si la comparacion optimista coincide con la que
 * trajo el cliente; un afectado 0 es desfase (409 ADMIN_CONCURRENCIA).
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{id: number|string, revision: number}} edicion Revision esperada.
 * @returns {Promise<number>} 1 si la revision coincidio, 0 en caso contrario.
 */
export async function incrementarRevision(connection, { id, revision }) {
  const [resultado] = await connection.execute(
    'UPDATE tarifario_versiones SET revision = revision + 1 WHERE id = ? AND revision = ?',
    [id, revision],
  );
  return resultado.affectedRows;
}

/**
 * Registra un evento de trazabilidad en la tabla de migracion 014 con el
 * snapshot de identidad ya resuelto por el servicio. Los eventos del
 * ciclo de vida (CREACION/FINALIZACION/ACTIVACION) no llevan entidad ni
 * valores; las modificaciones de precio identifican la fila con
 * plan/tipo de ingreso/rango y los valores son DECIMAL(12,2).
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{versionId: number|string, tipoEvento: string,
 *          tipoOperacion?: string|null, agrupadorId?: number|null,
 *          planId?: number|null, tipoIngreso?: string|null,
 *          rangoClave?: string|null, valorAnterior?: string|null,
 *          valorNuevo?: string|null, actorLegajo: string,
 *          actorNombre: string, actorApellido: string,
 *          detalle: string}} evento Evento cerrado conforme a los CHECK de 014.
 * @returns {Promise<number>} Identificador del evento insertado.
 */
export async function insertarEvento(connection, evento) {
  const [resultado] = await connection.execute(
    `INSERT INTO tarifario_versiones_eventos
        (version_id, agrupador_id, tipo_evento, tipo_operacion, actor_legajo,
         actor_nombre, actor_apellido, plan_id, tipo_ingreso, rango_clave,
         valor_anterior, valor_nuevo, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [evento.versionId, evento.agrupadorId ?? null, evento.tipoEvento,
      evento.tipoOperacion ?? null, evento.actorLegajo, evento.actorNombre,
      evento.actorApellido, evento.planId ?? null, evento.tipoIngreso ?? null,
      evento.rangoClave ?? null, evento.valorAnterior ?? null,
      evento.valorNuevo ?? null, evento.detalle],
  );
  return resultado.insertId;
}

/**
 * Lee la fila del borrador o version y su responsable; usada al arrancar
 * la presentacion del 409 de exclusividad sin reabrir la transaccion.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {number|string} versionId Version ya bloqueada.
 * @returns {Promise<object|undefined>} Cabecera con responsable o undefined.
 */
export async function obtenerVersionConResponsable(connection, versionId) {
  const [filas] = await connection.query(
    `SELECT v.id, v.tipo, v.estado, v.revision, v.fecha_activacion, v.version_base_id,
            v.actor_legajo, v.created_at, empleados.nombre, empleados.apellido
       FROM tarifario_versiones v
       LEFT JOIN empleados ON empleados.legajo = v.actor_legajo
      WHERE v.id = ?
      FOR UPDATE`,
    [versionId],
  );
  return filas[0];
}

// ─────────────────────────────────────────────────────────────────────
// Trazabilidad y deshacer (mejoras SPEC-03): lectura de la auditoria y
// restauracion transaccional del ultimo cambio economico de un borrador.
// ─────────────────────────────────────────────────────────────────────

/**
 * Lee TODOS los eventos de auditoria de una version, ordenados
 * cronologicamente (evento_en e id ascendentes). Sin transformaciones:
 * el resumen y el deshacer lean las filas reales guardadas.
 * @param {object} connection Conexion de la unidad de trabajo (puede ser transaccional).
 * @param {number|string} versionId Identificador de la version.
 * @returns {Promise<object[]>} Filas completas de tarifario_versiones_eventos.
 */
export async function listarEventosDeVersion(connection, versionId) {
  const [filas] = await connection.query(
    `SELECT id, version_id, agrupador_id, tipo_evento, tipo_operacion,
            actor_legajo, actor_nombre, actor_apellido, evento_en,
            plan_id, tipo_ingreso, rango_clave,
            valor_anterior, valor_nuevo, detalle
       FROM tarifario_versiones_eventos
      WHERE version_id = ?
      ORDER BY evento_en ASC, id ASC`,
    [versionId],
  );
  return filas;
}

/**
 * Localiza y bloquea la fila de tarifa de una version identificada por la
 * clave de negocio (plan, modalidad, rango) que usan los eventos hijos.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {{versionId: number|string, planId: number|string,
 *          tipoIngreso: string, rangoClave: string}} clave Identificacion del evento.
 * @returns {Promise<object|undefined>} Fila con id y precio o undefined.
 */
export async function resolverTarifaPorClave(
  connection,
  { versionId, planId, tipoIngreso, rangoClave },
) {
  const [filas] = await connection.execute(
    `SELECT id, precio
       FROM tarifas
      WHERE version_id = ? AND plan_id = ? AND tipo_ingreso = ? AND rango_clave = ?
      FOR UPDATE`,
    [versionId, planId, tipoIngreso, rangoClave],
  );
  return filas[0];
}

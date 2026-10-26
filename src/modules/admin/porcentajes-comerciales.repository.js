/**
 * Obtiene todos los porcentajes comerciales actualmente vigentes.
 * @param {object} connection Conexión mysql2.
 * @returns {Promise<object[]>} Lista vigente ordenada descendente.
 */
export async function listarPorcentajesComercialesVigentes(connection) {
  const [rows] = await connection.execute(
    `SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta,
            actor_legajo, created_at
       FROM porcentajes_comerciales
      WHERE vigente_hasta IS NULL
      ORDER BY porcentaje DESC`,
  );
  return rows;
}

/**
 * Obtiene un porcentaje comercial vigente por su valor.
 * @param {object} connection Conexión mysql2.
 * @param {number|string} porcentaje Valor solicitado.
 * @returns {Promise<object|undefined>} Fila vigente o undefined.
 */
export async function obtenerPorcentajeComercialVigente(connection, porcentaje) {
  const [rows] = await connection.execute(
    `SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta,
            actor_legajo, created_at
       FROM porcentajes_comerciales
      WHERE porcentaje = ? AND vigente_hasta IS NULL
      LIMIT 1`,
    [porcentaje],
  );
  return rows[0];
}

/**
 * Obtiene el historial completo de un porcentaje.
 * @param {object} connection Conexión mysql2.
 * @param {number|string} porcentaje Valor solicitado.
 * @returns {Promise<object[]>} Filas históricas y vigente en orden descendente.
 */
export async function obtenerHistorialPorcentajeComercial(connection, porcentaje) {
  const [rows] = await connection.execute(
    `SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta,
            actor_legajo, created_at
       FROM porcentajes_comerciales
      WHERE porcentaje = ?
      ORDER BY fecha_vigencia DESC`,
    [porcentaje],
  );
  return rows;
}

/**
 * Inserta un porcentaje como fila abierta del contrato previo.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {{porcentaje: number|string, descripcion: string|null, actorLegajo: string}} datos Datos persistibles.
 * @returns {Promise<number>} Identificador insertado.
 */
export async function insertarPorcentajeComercial(
  connection,
  { porcentaje, descripcion, actorLegajo },
) {
  const [resultado] = await connection.execute(
    `INSERT INTO porcentajes_comerciales
        (porcentaje, descripcion, fecha_vigencia, actor_legajo)
     VALUES (?, ?, NOW(6), ?)`,
    [porcentaje, descripcion, actorLegajo],
  );
  return resultado.insertId;
}

/**
 * Cierra la fila vigente de un porcentaje.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number|string} porcentaje Valor a cerrar.
 * @returns {Promise<number>} Cantidad de filas afectadas.
 */
export async function cerrarPorcentajeComercial(connection, porcentaje) {
  const [resultado] = await connection.execute(
    `UPDATE porcentajes_comerciales
        SET vigente_hasta = NOW(6)
      WHERE porcentaje = ? AND vigente_hasta IS NULL`,
    [porcentaje],
  );
  return resultado.affectedRows;
}

/**
 * Indica si ya existe una fila abierta para el porcentaje.
 * @param {object} connection Conexión mysql2.
 * @param {number|string} porcentaje Valor consultado.
 * @returns {Promise<boolean>} true cuando existe una fila vigente.
 */
export async function existePorcentajeVigente(connection, porcentaje) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM porcentajes_comerciales
      WHERE porcentaje = ? AND vigente_hasta IS NULL
      LIMIT 1`,
    [porcentaje],
  );
  return rows.length > 0;
}

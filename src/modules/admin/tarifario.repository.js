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

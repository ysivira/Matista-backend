// Mecanismos de vigencia e historial compartidos de SPEC-03 ADMIN.
// Consultas de solo lectura sobre tarifario_versiones y sus
// dependencias; nunca escriben ni recalculan versiones historicas
// (inmutabilidad). El orden de vigencia es por fecha de activacion,
// nunca por id. Con el modelo "copia completa" (migraciones 013-015,
// decisiones O-1..O-7 cerradas) las cancelaciones y reversiones quedan
// descontinuadas funcionalmente: la vigencia se resuelve unicamente
// sobre estados efectivos ACTIVA/HISTORICA.

/**
 * Resuelve la version del tarifario vigente para una fecha de referencia.
 * Regla del modelo "copia completa": entre las versiones efectivamente
 * activas en ese momento -- estados ACTIVA e HISTORICA, que conservan la
 * fecha de activacion con que rigieron -- gana la de fecha de activacion
 * mas reciente menor o igual al instante pedido; el borrador actual
 * (PREPARACION/LISTA_PARA_ACTIVAR) nunca rige. Desempate estatico por id
 * mas alto ante fechas teoricamente iguales (la UNIQUE de fechas activas
 * impide colisiones reales).
 *
 * - Parametros: `connection` conexion mysql2; `fechaReferencia`
 *   string 'YYYY-MM-DD HH:MM:SS(.ffffff)' en UTC.
 * - Retorna: fila { id, tipo, estado, fecha_activacion, actor_legajo }
 *   de la version vigente, o null si aun no hay ninguna vigente.
 */
export async function resolverVersionVigente(connection, fechaReferencia) {
  const [filas] = await connection.execute(
    `SELECT v.id, v.tipo, v.estado, v.fecha_activacion, v.actor_legajo
       FROM tarifario_versiones v
      WHERE v.estado IN ('ACTIVA', 'HISTORICA')
        AND v.fecha_activacion <= ?
      ORDER BY v.fecha_activacion DESC, v.id DESC
      LIMIT 1`,
    [fechaReferencia],
  );
  return filas[0] ?? null;
}

/**
 * Devuelve el estado efectivo de una version: el estado de la columna
 * (ACTIVA/CANCELADA), o CANCELADA_EFECTIVA cuando existe una
 * cancelacion todavia sin reactivar (la version siga marcada ACTIVA
 * pero no rige hasta la reactivacion).
 *
 * - Parametros: `connection` conexion mysql2; `versionId` version a evaluar.
 * - Retorna: string 'ACTIVA' | 'CANCELADA' | 'CANCELADA_EFECTIVA'; o
 *   null si la version no existe.
 */
export async function estadoEfectivoVersion(connection, versionId) {
  const [filas] = await connection.execute(
    `SELECT v.estado,
            EXISTS (
              SELECT 1 FROM tarifario_cancelaciones c
               WHERE c.version_id = v.id AND c.reactivada_por IS NULL
            ) AS cancelacionAbierta
       FROM tarifario_versiones v
      WHERE v.id = ?`,
    [versionId],
  );
  if (!filas[0]) {
    return null;
  }
  const fila = filas[0];
  if (Number(fila.cancelacionAbierta) === 1) {
    return 'CANCELADA_EFECTIVA';
  }
  return fila.estado;
}

/**
 * Obtiene el snapshot completo de tarifas de una version historica.
 * Las tarifas son insert-only y pertenecen a una version: esta consulta
 * solo lee, preservando la inmutabilidad de las versiones pasadas (los
 * calculos posteriores nunca usan configuraciones que no existian en
 * esa version).
 *
 * - Parametros: `connection` conexion mysql2; `versionId` version pedida.
 * - Retorna: array de filas
 *   { plan_id, tipo_ingreso, rango_clave, precio } ordenado de forma
 *   estable (plan, modalidad, clave); vacio si la version no tiene.
 */
export async function obtenerTarifasDeVersion(connection, versionId) {
  const [filas] = await connection.query(
    `SELECT plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE version_id = ?
      ORDER BY plan_id, tipo_ingreso, rango_clave`,
    [versionId],
  );
  return filas;
}

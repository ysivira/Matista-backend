/**
 * ============================================================
 * MATISTA | PERSISTENCIA DE POLÍTICAS
 * ============================================================
 *
 * Archivo: politica-comercial.repository.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Persistir versiones de política, porcentajes vinculados y
 * eventos, conservando revisiones y snapshots de responsables.
 *
 * ============================================================
 */
const CAMPOS_POLITICA = `
  p.id,
  p.estado,
  p.revision,
  p.version_base_id,
  p.porcentaje_aporte_reconocido,
  p.tope_sueldo_bruto,
  p.joven_porcentaje,
  p.comercial_fijo_max_pct,
  p.comercial_fijo_meses_max,
  p.comercial_escalonado_max_pct,
  p.comercial_escalonado_tramos_max,
  p.comercial_escalonado_total_meses_max,
  p.primer_tramo_50_meses_max,
  p.tdc_pct,
  p.tdc_habilitado,
  p.tope_comercial_tdc_pct,
  p.afinidad_pct,
  p.aporte_monotributo,
  p.aporte_adherente,
  p.iva_voluntario_pct,
  p.fecha_vigencia,
  p.vigente_hasta,
  p.cancelada_en,
  p.cancelada_por,
  p.motivo_cancelacion,
  p.actor_legajo,
  p.created_at,
  e.nombre AS actor_nombre,
  e.apellido AS actor_apellido`;
const JOIN_RESPONSABLE = 'LEFT JOIN empleados e ON e.legajo = p.actor_legajo';

/**
 * Obtiene la política vigente con el nombre real de su responsable.
 * @param {object} connection Conexión mysql2 activa.
 * @param {{forUpdate?: boolean}} opciones Activa el bloqueo de fila al escribir.
 * @returns {Promise<object|undefined>} Versión vigente o undefined.
 */
export async function obtenerPoliticaComercialVigente(connection, { forUpdate = false } = {}) {
  const [rows] = await connection.query(`SELECT ${CAMPOS_POLITICA}
       FROM politica_comercial p
       ${JOIN_RESPONSABLE}
      WHERE p.estado = 'VIGENTE'
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows[0];
}

/**
 * Obtiene la única programación abierta y su responsable.
 * @param {object} connection Conexión mysql2 activa.
 * @param {{forUpdate?: boolean}} opciones Activa el bloqueo de fila al escribir.
 * @returns {Promise<object|undefined>} Versión programada o undefined.
 */
export async function obtenerPoliticaComercialProgramada(connection, { forUpdate = false } = {}) {
  const [rows] = await connection.query(`SELECT ${CAMPOS_POLITICA}
       FROM politica_comercial p
       ${JOIN_RESPONSABLE}
      WHERE p.estado = 'PROGRAMADA'
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`);
  return rows[0];
}

/**
 * Obtiene una versión por identificador junto con el empleado responsable.
 * @param {object} connection Conexión mysql2 activa.
 * @param {number} politicaId Identificador validado.
 * @param {{forUpdate?: boolean}} opciones Activa el bloqueo de fila al escribir.
 * @returns {Promise<object|undefined>} Versión encontrada o undefined.
 */
export async function obtenerPoliticaComercialPorId(
  connection,
  politicaId,
  { forUpdate = false } = {}
) {
  const [rows] = await connection.query(
    `SELECT ${CAMPOS_POLITICA}
       FROM politica_comercial p
       ${JOIN_RESPONSABLE}
      WHERE p.id = ?
      LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [politicaId]
  );
  return rows[0];
}

/**
 * Lista el historial completo, incluida la programación y las canceladas.
 * @param {object} connection Conexión mysql2 activa.
 * @returns {Promise<object[]>} Versiones desde la creación más reciente.
 */
export async function listarPoliticasComerciales(connection) {
  const [rows] = await connection.query(`SELECT ${CAMPOS_POLITICA}
       FROM politica_comercial p
       ${JOIN_RESPONSABLE}
      ORDER BY p.created_at DESC, p.id DESC`);
  return rows;
}

/**
 * Lista los porcentajes vinculados a las versiones pedidas.
 * @param {object} connection Conexión mysql2 activa.
 * @param {number[]} politicaIds Identificadores de snapshots.
 * @param {{forUpdate?: boolean}} opciones Activa el bloqueo para una edición pendiente.
 * @returns {Promise<object[]>} Porcentajes ordenados de mayor a menor.
 */
export async function listarPorcentajesDePoliticas(
  connection,
  politicaIds,
  { forUpdate = false } = {}
) {
  if (politicaIds.length === 0) return [];
  const placeholders = politicaIds.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT id, politica_comercial_id, porcentaje, descripcion,
            fecha_vigencia, vigente_hasta, actor_legajo, created_at
       FROM porcentajes_comerciales
      WHERE politica_comercial_id IN (${placeholders})
      ORDER BY porcentaje DESC, id DESC${forUpdate ? ' FOR UPDATE' : ''}`,
    politicaIds
  );
  return rows;
}

/**
 * Inserta una versión completa con estado y fecha de activación definidos.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {object} politica Valores comerciales completos ya validados.
 * @param {{estado: string, fechaVigencia: string, actorLegajo: string,
 *          versionBaseId: number}} metadatos Datos del ciclo de vida.
 * @returns {Promise<number>} Identificador de la nueva versión.
 */
export async function insertarPoliticaComercial(connection, politica, metadatos) {
  const [resultado] = await connection.execute(
    `INSERT INTO politica_comercial
      (estado, revision, version_base_id,
       porcentaje_aporte_reconocido, tope_sueldo_bruto, joven_porcentaje,
       comercial_fijo_max_pct, comercial_fijo_meses_max,
       comercial_escalonado_max_pct, comercial_escalonado_tramos_max,
       comercial_escalonado_total_meses_max, primer_tramo_50_meses_max,
       tdc_pct, tdc_habilitado, tope_comercial_tdc_pct, afinidad_pct,
       aporte_monotributo, aporte_adherente, iva_voluntario_pct,
       fecha_vigencia, actor_legajo)
     VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      metadatos.estado,
      metadatos.versionBaseId,
      politica.porcentaje_aporte_reconocido,
      politica.tope_sueldo_bruto,
      politica.joven_porcentaje,
      politica.comercial_fijo_max_pct,
      politica.comercial_fijo_meses_max,
      politica.comercial_escalonado_max_pct,
      politica.comercial_escalonado_tramos_max,
      politica.comercial_escalonado_total_meses_max,
      politica.primer_tramo_50_meses_max,
      politica.tdc_pct,
      politica.tdc_habilitado,
      politica.tope_comercial_tdc_pct,
      politica.afinidad_pct,
      politica.aporte_monotributo,
      politica.aporte_adherente ?? null,
      politica.iva_voluntario_pct ?? null,
      metadatos.fechaVigencia,
      metadatos.actorLegajo
    ]
  );
  return resultado.insertId;
}

/**
 * Inserta el catálogo completo de un snapshot de política.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Versión propietaria.
 * @param {string[]} porcentajes Valores normalizados a dos decimales.
 * @param {{actorLegajo: string, fechaVigencia: string}} metadatos Auditor y fecha.
 * @returns {Promise<void>} Finaliza al insertar todo el catálogo.
 */
export async function insertarPorcentajesComerciales(
  connection,
  politicaId,
  porcentajes,
  metadatos
) {
  for (const porcentaje of porcentajes) {
    await connection.execute(
      `INSERT INTO porcentajes_comerciales
        (politica_comercial_id, porcentaje, descripcion, fecha_vigencia, actor_legajo)
       VALUES (?, ?, NULL, ?, ?)`,
      [politicaId, porcentaje, metadatos.fechaVigencia, metadatos.actorLegajo]
    );
  }
}

/**
 * Actualiza únicamente una programación editable mediante revisión optimista.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Programación bloqueada.
 * @param {object} politica Valores comerciales completos.
 * @param {{revision: number, fechaVigencia: string, actorLegajo: string}} metadatos Edición.
 * @returns {Promise<number>} Cantidad de filas actualizadas.
 */
export async function actualizarPoliticaProgramada(connection, politicaId, politica, metadatos) {
  const [resultado] = await connection.execute(
    `UPDATE politica_comercial
        SET porcentaje_aporte_reconocido = ?, tope_sueldo_bruto = ?,
            joven_porcentaje = ?, comercial_fijo_max_pct = ?,
            comercial_fijo_meses_max = ?, comercial_escalonado_max_pct = ?,
            comercial_escalonado_tramos_max = ?,
            comercial_escalonado_total_meses_max = ?,
            primer_tramo_50_meses_max = ?, tdc_pct = ?, tdc_habilitado = ?,
            tope_comercial_tdc_pct = ?, afinidad_pct = ?, aporte_monotributo = ?, aporte_adherente = ?, iva_voluntario_pct = ?,
            fecha_vigencia = ?,
            actor_legajo = ?, revision = revision + 1
      WHERE id = ? AND estado = 'PROGRAMADA' AND revision = ?`,
    [
      politica.porcentaje_aporte_reconocido,
      politica.tope_sueldo_bruto,
      politica.joven_porcentaje,
      politica.comercial_fijo_max_pct,
      politica.comercial_fijo_meses_max,
      politica.comercial_escalonado_max_pct,
      politica.comercial_escalonado_tramos_max,
      politica.comercial_escalonado_total_meses_max,
      politica.primer_tramo_50_meses_max,
      politica.tdc_pct,
      politica.tdc_habilitado,
      politica.tope_comercial_tdc_pct,
      politica.afinidad_pct,
      politica.aporte_monotributo,
      politica.aporte_adherente ?? null,
      politica.iva_voluntario_pct ?? null,
      metadatos.fechaVigencia,
      metadatos.actorLegajo,
      politicaId,
      metadatos.revision
    ]
  );
  return resultado.affectedRows;
}

/**
 * Reemplaza los porcentajes de una programación mutable; nunca toca historial.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Programación validada y bloqueada.
 * @param {string[]} porcentajes Nuevo catálogo completo.
 * @param {{actorLegajo: string, fechaVigencia: string}} metadatos Auditor y fecha.
 * @returns {Promise<void>} Finaliza con el catálogo pendiente sustituido.
 */
export async function reemplazarPorcentajesProgramados(
  connection,
  politicaId,
  porcentajes,
  metadatos
) {
  await connection.execute('DELETE FROM porcentajes_comerciales WHERE politica_comercial_id = ?', [
    politicaId
  ]);
  await insertarPorcentajesComerciales(connection, politicaId, porcentajes, metadatos);
}

/**
 * Cierra la vigente como histórica en el instante efectivo de sustitución.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Versión vigente bloqueada.
 * @param {string} fechaCierre Instante UTC efectivo de cierre.
 * @returns {Promise<void>} Finaliza al cerrar cabecera y porcentajes.
 */
export async function cerrarPoliticaVigente(connection, politicaId, fechaCierre) {
  await connection.execute(
    `UPDATE porcentajes_comerciales
        SET vigente_hasta = ?
      WHERE politica_comercial_id = ? AND vigente_hasta IS NULL`,
    [fechaCierre, politicaId]
  );
  await connection.execute(
    `UPDATE politica_comercial
        SET estado = 'HISTORICA', vigente_hasta = ?
      WHERE id = ? AND estado = 'VIGENTE'`,
    [fechaCierre, politicaId]
  );
}

/**
 * Convierte una programación en vigente sin modificar su snapshot.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Programación bloqueada.
 * @returns {Promise<number>} Cantidad de filas activadas.
 */
export async function activarPoliticaProgramada(connection, politicaId) {
  const [resultado] = await connection.execute(
    `UPDATE politica_comercial
        SET estado = 'VIGENTE'
      WHERE id = ? AND estado = 'PROGRAMADA'`,
    [politicaId]
  );
  return resultado.affectedRows;
}

/**
 * Cancela una programación conservando cabecera, descuentos y motivo.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Programación bloqueada.
 * @param {{actorLegajo: string, motivo: string, revision?: number}} datos Cancelación.
 * @returns {Promise<number>} Cantidad de filas canceladas.
 */
export async function cancelarPoliticaProgramada(connection, politicaId, datos) {
  const revisar = Number.isInteger(datos.revision);
  const [resultado] = await connection.execute(
    `UPDATE politica_comercial
        SET estado = 'CANCELADA', cancelada_en = UTC_TIMESTAMP(6),
            cancelada_por = ?, motivo_cancelacion = ?
      WHERE id = ? AND estado = 'PROGRAMADA'${revisar ? ' AND revision = ?' : ''}`,
    revisar
      ? [datos.actorLegajo, datos.motivo, politicaId, datos.revision]
      : [datos.actorLegajo, datos.motivo, politicaId]
  );
  return resultado.affectedRows;
}

/**
 * Lee la identidad actual del empleado para crear un snapshot de auditoría.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {string} actorLegajo Legajo autenticado o responsable de la programación.
 * @returns {Promise<{legajo: string, nombre: string, apellido: string}>} Identidad real.
 */
export async function obtenerSnapshotActor(connection, actorLegajo) {
  const [rows] = await connection.execute(
    'SELECT nombre, apellido FROM empleados WHERE legajo = ?',
    [actorLegajo]
  );
  return {
    legajo: actorLegajo,
    nombre: rows[0]?.nombre ?? '',
    apellido: rows[0]?.apellido ?? ''
  };
}

/**
 * Registra un evento de ciclo de vida con identidad inmutable del responsable.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {{politicaId: number, tipoEvento: string, actor: object, detalle: string}} evento Datos
 * auditables.
 * @returns {Promise<number>} Identificador del evento.
 */
export async function insertarEventoPolitica(connection, evento) {
  const [resultado] = await connection.execute(
    `INSERT INTO politica_comercial_eventos
      (politica_comercial_id, tipo_evento, actor_legajo,
       actor_nombre, actor_apellido, detalle)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      evento.politicaId,
      evento.tipoEvento,
      evento.actor.legajo,
      evento.actor.nombre,
      evento.actor.apellido,
      evento.detalle
    ]
  );
  return resultado.insertId;
}

/**
 * Lista la auditoría real de una versión en orden cronológico inverso.
 * @param {object} connection Conexión mysql2 activa.
 * @param {number} politicaId Versión consultada.
 * @returns {Promise<object[]>} Eventos con nombre, apellido y legajo preservados.
 */
export async function listarEventosPolitica(connection, politicaId) {
  const [rows] = await connection.query(
    `SELECT id, politica_comercial_id, tipo_evento, actor_legajo,
            actor_nombre, actor_apellido, detalle, evento_en
       FROM politica_comercial_eventos
      WHERE politica_comercial_id = ?
      ORDER BY evento_en DESC, id DESC`,
    [politicaId]
  );
  return rows;
}

/** Lee las referencias ADMIN sin crear catálogos alternativos. */
export async function listarAportesMonotributo(c) {
  const [rows] = await c.query(
    'SELECT id,categoria,aporte,vigente_desde FROM monotributo_aportes WHERE vigente_hasta IS NULL ORDER BY id'
  );
  return rows;
}

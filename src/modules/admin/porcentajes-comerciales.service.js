import { withConnection } from '../auth/auth.repository.js';
import {
  cerrarPorcentajeComercial,
  existePorcentajeVigente,
  insertarPorcentajeComercial,
  listarPorcentajesComercialesVigentes,
  obtenerHistorialPorcentajeComercial,
} from './porcentajes-comerciales.repository.js';
import {
  errorEstado,
  errorNoEncontrado,
  errorValidacion,
  mapearErrorIntegridad,
} from './admin.errors.js';

/**
 * Valida un porcentaje y su descripción opcional.
 * @param {object} datos Datos recibidos por el contrato previo.
 * @returns {void}
 * @throws {Error} ADMIN_VALIDACION si el valor excede los límites.
 */
function validarPorcentajeComercial(datos) {
  const errores = [];
  const valor = Number(datos?.porcentaje);
  if (datos?.porcentaje === undefined || datos.porcentaje === null || datos.porcentaje === ''
      || !Number.isFinite(valor) || valor <= 0 || valor > 100) {
    errores.push({ field: 'porcentaje', message: 'Debe ser un número entre 0 y 100 (excluido 0).' });
  }
  if (datos?.descripcion !== undefined && datos.descripcion !== null
      && (typeof datos.descripcion !== 'string' || datos.descripcion.length > 100)) {
    errores.push({ field: 'descripcion', message: 'La descripción no debe exceder 100 caracteres.' });
  }
  if (errores.length > 0) {
    throw errorValidacion('Datos de porcentaje comercial inválidos.', errores);
  }
}

/**
 * Captura la identidad del actor para la auditoría existente.
 * @param {object} connection Conexión transaccional.
 * @param {string} actorLegajo Legajo del ADMIN.
 * @returns {Promise<{legajo: string}>} Identidad mínima de auditoría.
 */
async function snapshotActor(connection, actorLegajo) {
  const [filas] = await connection.execute(
    'SELECT nombre, apellido FROM empleados WHERE legajo = ?',
    [actorLegajo],
  );
  return { legajo: actorLegajo, nombre: filas[0]?.nombre ?? '', apellido: filas[0]?.apellido ?? '' };
}

/** Lista el catálogo vigente mediante una conexión de lectura. */
export async function listarPorcentajesComerciales(pool) {
  return withConnection(pool, listarPorcentajesComercialesVigentes);
}

/**
 * Lista el historial de un valor comercial.
 * @param {object} pool Pool MySQL.
 * @param {number|string} porcentaje Porcentaje solicitado.
 * @returns {Promise<object[]>} Historial persistido.
 */
export async function obtenerHistorialPorcentaje(pool, porcentaje) {
  return withConnection(
    pool,
    (connection) => obtenerHistorialPorcentajeComercial(connection, porcentaje),
  );
}

/**
 * Crea un porcentaje con su auditoría en una transacción.
 * @param {object} pool Pool MySQL.
 * @param {object} datos Porcentaje y descripción.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @returns {Promise<object>} Fila creada.
 */
export async function crearPorcentajeComercial(pool, datos, actor) {
  validarPorcentajeComercial(datos);
  const porcentaje = Number(datos.porcentaje);
  return withConnection(pool, async (connection) => {
    if (await existePorcentajeVigente(connection, porcentaje)) {
      throw errorEstado(`Ya existe un porcentaje comercial vigente con el valor ${porcentaje}%.`);
    }
    const actorInfo = await snapshotActor(connection, actor.legajo);
    const nuevaId = await insertarPorcentajeComercial(connection, {
      porcentaje,
      descripcion: datos.descripcion ?? null,
      actorLegajo: actor.legajo,
    });
    await connection.execute(
      `INSERT INTO empleados_auditoria
        (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
       VALUES (?, ?, 'PORCENTAJE_COMERCIAL_CREADO', 'PORCENTAJE', ?, ?, NOW(6))`,
      [actorInfo.legajo, actorInfo.legajo, 'N/A', `porcentaje#${nuevaId}:${porcentaje}%`],
    );
    const [filas] = await connection.execute(
      `SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta,
              actor_legajo, created_at
         FROM porcentajes_comerciales WHERE id = ?`,
      [nuevaId],
    );
    return filas[0];
  }, { transaction: true }).catch((error) => { throw mapearErrorIntegridad(error); });
}

/**
 * Versiona la descripción de un porcentaje vigente.
 * @param {object} pool Pool MySQL.
 * @param {number|string} porcentaje Valor vigente.
 * @param {{descripcion: string|null}} datos Descripción nueva.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @returns {Promise<object>} Nueva fila vigente.
 */
export async function actualizarPorcentajeComercial(pool, porcentaje, datos, actor) {
  if (!datos || Object.keys(datos).some((campo) => campo !== 'descripcion')
      || !Object.hasOwn(datos, 'descripcion')) {
    throw errorValidacion('Solo se permite actualizar la descripción del porcentaje comercial.');
  }
  validarPorcentajeComercial({ porcentaje, descripcion: datos.descripcion });
  return withConnection(pool, async (connection) => {
    const [filas] = await connection.execute(
      `SELECT id, porcentaje, descripcion
         FROM porcentajes_comerciales
        WHERE porcentaje = ? AND vigente_hasta IS NULL FOR UPDATE`,
      [porcentaje],
    );
    const actual = filas[0];
    if (!actual) throw errorNoEncontrado(`No existe un porcentaje comercial vigente con el valor ${porcentaje}%.`);
    const actorInfo = await snapshotActor(connection, actor.legajo);
    await cerrarPorcentajeComercial(connection, porcentaje);
    const nuevaId = await insertarPorcentajeComercial(connection, {
      porcentaje: actual.porcentaje,
      descripcion: datos.descripcion,
      actorLegajo: actor.legajo,
    });
    await connection.execute(
      `INSERT INTO empleados_auditoria
        (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
       VALUES (?, ?, 'PORCENTAJE_COMERCIAL_ACTUALIZADO', 'DESCRIPCION', ?, ?, NOW(6))`,
      [actorInfo.legajo, actorInfo.legajo, actual.descripcion ?? 'N/A', datos.descripcion ?? 'N/A'],
    );
    const [nuevas] = await connection.execute(
      `SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta,
              actor_legajo, created_at
         FROM porcentajes_comerciales WHERE id = ?`,
      [nuevaId],
    );
    return nuevas[0];
  }, { transaction: true }).catch((error) => { throw mapearErrorIntegridad(error); });
}

/**
 * Cierra un porcentaje vigente y registra la operación.
 * @param {object} pool Pool MySQL.
 * @param {number|string} porcentaje Valor vigente.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @returns {Promise<void>}
 */
export async function eliminarPorcentajeComercial(pool, porcentaje, actor) {
  return withConnection(pool, async (connection) => {
    const [filas] = await connection.execute(
      `SELECT id, porcentaje
         FROM porcentajes_comerciales
        WHERE porcentaje = ? AND vigente_hasta IS NULL FOR UPDATE`,
      [porcentaje],
    );
    const actual = filas[0];
    if (!actual) throw errorNoEncontrado(`No existe un porcentaje comercial vigente con el valor ${porcentaje}%.`);
    const actorInfo = await snapshotActor(connection, actor.legajo);
    await cerrarPorcentajeComercial(connection, porcentaje);
    await connection.execute(
      `INSERT INTO empleados_auditoria
        (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
       VALUES (?, ?, 'PORCENTAJE_COMERCIAL_ELIMINADO', 'PORCENTAJE', ?, 'ELIMINADO', NOW(6))`,
      [actorInfo.legajo, actorInfo.legajo, `porcentaje#${actual.id}:${actual.porcentaje}%`],
    );
  }, { transaction: true }).catch((error) => { throw mapearErrorIntegridad(error); });
}

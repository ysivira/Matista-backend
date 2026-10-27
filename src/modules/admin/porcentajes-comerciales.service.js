/**
 * Gestiona los porcentajes comerciales y sus versiones.
 */
import { withConnection } from '../auth/auth.repository.js';
import {
  cerrarPorcentajeComercial,
  bloquearPorcentajeComercialVigente,
  existePorcentajeVigente,
  insertarPorcentajeComercial,
  listarPorcentajesComercialesVigentes,
  obtenerHistorialPorcentajeComercial,
  obtenerPorcentajeComercialPorId,
  insertarEmpleadoAuditoria
} from './porcentajes-comerciales.repository.js';
import { obtenerEmpleado } from './employees.repository.js';
import {
  errorEstado,
  errorNoEncontrado,
  errorValidacion,
  mapearErrorIntegridad
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
  if (
    datos?.porcentaje === undefined ||
    datos.porcentaje === null ||
    datos.porcentaje === '' ||
    !Number.isFinite(valor) ||
    valor <= 0 ||
    valor > 100
  ) {
    errores.push({
      field: 'porcentaje',
      message: 'Debe ser un número entre 0 y 100 (excluido 0).'
    });
  }
  if (
    datos?.descripcion !== undefined &&
    datos.descripcion !== null &&
    (typeof datos.descripcion !== 'string' || datos.descripcion.length > 100)
  ) {
    errores.push({
      field: 'descripcion',
      message: 'La descripción no debe exceder 100 caracteres.'
    });
  }
  if (errores.length > 0) {
    throw errorValidacion('Datos de porcentaje comercial inválidos.', errores);
  }
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
  return withConnection(pool, connection =>
    obtenerHistorialPorcentajeComercial(connection, porcentaje)
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
  return withConnection(
    pool,
    async connection => {
      if (await existePorcentajeVigente(connection, porcentaje)) {
        throw errorEstado(`Ya existe un porcentaje comercial vigente con el valor ${porcentaje}%.`);
      }
      // Conserva la lectura en la misma conexión. La auditoría usaba únicamente
      // el legajo recibido, incluso si no existía fila de empleado; no persiste nombres.
      await obtenerEmpleado(connection, actor.legajo);
      const nuevaId = await insertarPorcentajeComercial(connection, {
        porcentaje,
        descripcion: datos.descripcion ?? null,
        actorLegajo: actor.legajo
      });
      await insertarEmpleadoAuditoria(connection, {
        legajo: actor.legajo,
        actor_legajo: actor.legajo,
        evento: 'PORCENTAJE_COMERCIAL_CREADO',
        campo: 'PORCENTAJE',
        valor_anterior: 'N/A',
        valor_nuevo: `porcentaje#${nuevaId}:${porcentaje}%`
      });
      return await obtenerPorcentajeComercialPorId(connection, nuevaId);
    },
    {
      transaction: true
    }
  ).catch(error => {
    throw mapearErrorIntegridad(error);
  });
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
  if (
    !datos ||
    Object.keys(datos).some(campo => campo !== 'descripcion') ||
    !Object.hasOwn(datos, 'descripcion')
  ) {
    throw errorValidacion('Solo se permite actualizar la descripción del porcentaje comercial.');
  }
  validarPorcentajeComercial({
    porcentaje,
    descripcion: datos.descripcion
  });
  return withConnection(
    pool,
    async connection => {
      const actual = await bloquearPorcentajeComercialVigente(connection, porcentaje);
      if (!actual)
        throw errorNoEncontrado(
          `No existe un porcentaje comercial vigente con el valor ${porcentaje}%.`
        );
      // Se mantiene la lectura transaccional; el evento conserva el legajo recibido.
      await obtenerEmpleado(connection, actor.legajo);
      await cerrarPorcentajeComercial(connection, porcentaje);
      const nuevaId = await insertarPorcentajeComercial(connection, {
        porcentaje: actual.porcentaje,
        descripcion: datos.descripcion,
        actorLegajo: actor.legajo
      });
      await insertarEmpleadoAuditoria(connection, {
        legajo: actor.legajo,
        actor_legajo: actor.legajo,
        evento: 'PORCENTAJE_COMERCIAL_ACTUALIZADO',
        campo: 'DESCRIPCION',
        valor_anterior: actual.descripcion ?? 'N/A',
        valor_nuevo: datos.descripcion ?? 'N/A'
      });
      return await obtenerPorcentajeComercialPorId(connection, nuevaId);
    },
    {
      transaction: true
    }
  ).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

/**
 * Cierra un porcentaje vigente y registra la operación.
 * @param {object} pool Pool MySQL.
 * @param {number|string} porcentaje Valor vigente.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @returns {Promise<void>}
 */
export async function eliminarPorcentajeComercial(pool, porcentaje, actor) {
  return withConnection(
    pool,
    async connection => {
      const actual = await bloquearPorcentajeComercialVigente(connection, porcentaje, {
        conDescripcion: false
      });
      if (!actual)
        throw errorNoEncontrado(
          `No existe un porcentaje comercial vigente con el valor ${porcentaje}%.`
        );
      // Se mantiene la lectura transaccional; el evento conserva el legajo recibido.
      await obtenerEmpleado(connection, actor.legajo);
      await cerrarPorcentajeComercial(connection, porcentaje);
      await insertarEmpleadoAuditoria(connection, {
        legajo: actor.legajo,
        actor_legajo: actor.legajo,
        evento: 'PORCENTAJE_COMERCIAL_ELIMINADO',
        campo: 'PORCENTAJE',
        valor_anterior: `porcentaje#${actual.id}:${actual.porcentaje}%`,
        valor_nuevo: 'ELIMINADO'
      });
    },
    {
      transaction: true
    }
  ).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

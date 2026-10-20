import { withConnection } from '../auth/auth.repository.js';
import { resolverVersionVigente } from './admin.vigencia.js';
import { errorEstado, errorNoEncontrado } from './admin.errors.js';
import {
  listarPlanesActivos,
  listarTarifasActivas,
  obtenerPlanPorId,
} from './tarifario.repository.js';
import { validarParametrosTarifario } from './tarifario.validators.js';

const CLAVES_EN_ORDEN = Object.freeze([
  '0-25', '26-35', '36-40', '41-50', '51-60', '61-65', '66+',
  'FAMILIAR A CARGO',
  'HIJO 0-1', 'HIJO 2-20', 'HIJO 21-29', 'HIJO 30-39', 'HIJO 40-49',
  'MAT 0-25', 'MAT 26-35', 'MAT 36-40', 'MAT 41-50', 'MAT 51-60',
  'MAT 61-65', 'MAT 66-00',
]);
const POSICION_CLAVE = new Map(CLAVES_EN_ORDEN.map((clave, indice) => [clave, indice]));

const DEPENDENCIAS_DEFECTO = Object.freeze({
  withConnection,
  listarPlanesActivos,
  obtenerPlanPorId,
  listarTarifasActivas,
  resolverVersionVigente,
});

/**
 * Convierte el reloj del proceso al formato DATETIME(6) UTC esperado por MySQL.
 * @param {Date} fecha Instante de referencia de la consulta.
 * @returns {string} Fecha `YYYY-MM-DD HH:mm:ss.ffffff` en UTC.
 * @throws {TypeError} Si el reloj no entrega una fecha valida.
 */
function fechaMysqlUtc(fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) {
    throw new TypeError('La consulta de vigencia requiere una fecha valida.');
  }
  return fecha.toISOString().replace('T', ' ').replace('Z', '000');
}

/**
 * Ordena las tarifas segun la matriz aprobada sin descartar claves futuras.
 * @param {object[]} tarifas Filas activas obtenidas del repositorio.
 * @returns {object[]} Copia ordenada; las claves desconocidas quedan al final.
 */
function ordenarTarifas(tarifas) {
  return [...tarifas].sort((a, b) => {
    const posicionA = POSICION_CLAVE.get(a.rango_clave) ?? Number.MAX_SAFE_INTEGER;
    const posicionB = POSICION_CLAVE.get(b.rango_clave) ?? Number.MAX_SAFE_INTEGER;
    return posicionA - posicionB || a.rango_clave.localeCompare(b.rango_clave, 'es');
  });
}

/**
 * Proyecta la cabecera vigente al contrato HTTP sin perder el BIGINT del id.
 * @param {object} version Fila devuelta por resolverVersionVigente.
 * @returns {object} Metadatos publicos con fecha ISO UTC.
 */
function presentarVersion(version) {
  return {
    id: String(version.id),
    tipo: version.tipo,
    estado: version.estado,
    fecha_activacion: new Date(version.fecha_activacion).toISOString(),
  };
}

/**
 * Proyecta una tarifa manteniendo precio decimal, etiqueta original y nota.
 * @param {object} tarifa Fila activa de la version vigente.
 * @returns {object} Tarifa publica del contrato SL-2.
 */
function presentarTarifa(tarifa) {
  return {
    rango_clave: tarifa.rango_clave,
    rango_etario: tarifa.rango_etario,
    rango_nota: tarifa.rango_nota ?? null,
    precio: String(tarifa.precio),
  };
}

/**
 * Consulta el catalogo de planes activos de RF-D06.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {object} dependencias Repositorio sustituible para pruebas unitarias.
 * @returns {Promise<object[]>} Catalogo publico, posiblemente vacio.
 */
export async function gestionarPlanes(pool, dependencias = DEPENDENCIAS_DEFECTO) {
  return dependencias.withConnection(
    pool,
    (connection) => dependencias.listarPlanesActivos(connection),
  );
}

/**
 * Consulta la matriz activa de la version vigente para un plan y modalidad.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{planId: unknown, tipoIngreso: unknown}} parametros Segmentos HTTP.
 * @param {Date} fechaReferencia Reloj UTC inyectado por el contexto AUTH.
 * @param {object} dependencias Repositorio y resolver sustituibles para pruebas.
 * @returns {Promise<object>} Plan, modalidad, version vigente y tarifas ordenadas.
 * @throws {Error} Validacion 400, plan 404, plan inactivo o falta de version 409.
 */
export async function gestionarTarifario(
  pool,
  parametros,
  fechaReferencia,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const filtro = validarParametrosTarifario(parametros);

  return dependencias.withConnection(pool, async (connection) => {
    const plan = await dependencias.obtenerPlanPorId(connection, filtro.planId);
    if (!plan) {
      throw errorNoEncontrado('El plan indicado no existe.');
    }
    if (Number(plan.activa) !== 1) {
      throw errorEstado('El plan indicado esta inactivo.');
    }

    const version = await dependencias.resolverVersionVigente(
      connection,
      fechaMysqlUtc(fechaReferencia),
    );
    if (!version) {
      throw errorEstado('No existe una version vigente del tarifario.');
    }

    const tarifas = await dependencias.listarTarifasActivas(connection, {
      versionId: version.id,
      ...filtro,
    });

    return {
      plan: { id: plan.id, nombre: plan.nombre },
      tipo_ingreso: filtro.tipoIngreso,
      version: presentarVersion(version),
      tarifas: ordenarTarifas(tarifas).map(presentarTarifa),
    };
  });
}

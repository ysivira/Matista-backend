import mysql from 'mysql2/promise';

import { loadSigecSourceConfig } from '../../infrastructure/database/config.js';

/** Abre una conexion de SOLO LECTURA hacia sigec_db.
 *
 *  - Las credenciales provienen de las variables SIGEC_DB_* y la base
 *    destino queda restringida a sigec_db por loadSigecSourceConfig.
 *  - Uso exclusivo de lectura: ninguna funcion de escritura se ejecuta
 *    con esta conexion (disciplina declarada en la autorizacion E2).
 *  - Retorna: la conexion abierta; el responsable debe cerrarla con
 *    connection.end() al terminar.
 */
export async function abrirConexionSigec() {
  const config = loadSigecSourceConfig(process.env);

  return mysql.createConnection({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    timezone: 'Z',
    multipleStatements: false,
  });
}

/** Lee la fuente SIGEC para la carga inicial.
 *
 *  - Parametros: `sourceConnection`: conexion abierta hacia `sigec_db`.
 *  - Retorna: `{ planes, referencias, aportes }` con TODAS las filas de
 *    cada tabla (sin filtrar): el filtrado y la trazabilidad de exclusiones
 *    se resuelven en el servicio, al nivel del caso de uso.
 *  - Errores: si alguna consulta falla, el servicio aborta antes de escribir.
 */
export async function leerFuenteSigec(sourceConnection) {
  const [planes] = await sourceConnection.query(
    `SELECT id, nombre, detalles, condiciones_generales, activo
       FROM planes
      ORDER BY id`,
  );

  const [referencias] = await sourceConnection.query(
    `SELECT lp.id, lp.plan_id, lp.tipo_ingreso, lp.rango_etario, lp.precio,
            lp.activo, p.activo AS plan_activo
       FROM listas_de_precios AS lp
       JOIN planes AS p ON p.id = lp.plan_id
      ORDER BY lp.id`,
  );

  const [aportes] = await sourceConnection.query(
    `SELECT categoria, aporte
       FROM monotributo_aportes
      ORDER BY categoria`,
  );

  return Object.freeze({
    planes: Object.freeze(planes),
    referencias: Object.freeze(referencias),
    aportes: Object.freeze(aportes),
  });
}

/** Consulta el estado actual del catalogo en MATISTA.
 *
 *  - Parametros: `matistaConnection`: conexion de la base destino.
 *  - Retorna: conteos de las tablas ADMIN + id/estado de la version
 *    CARGA_INICIAL y la cantidad de tarifas pertenecientes a esa version
 *    (0 si no existe), base para decidir la idempotencia. Incluye la
 *    politica vigente y su catalogo de porcentajes abiertos para que el
 *    servicio pueda completar cargas preexistentes sin catalogo.
 *  - Nota de vigencia: desde la migracion 021 una politica CANCELADA
 *    conserva `vigente_hasta IS NULL`, por lo que el conteo de politicas
 *    abiertas razona por `estado = 'VIGENTE'` y no por la fecha de cierre.
 */
export async function leerEstadoCatalogo(matistaConnection) {
  const [conteos] = await matistaConnection.query(
    `SELECT
       (SELECT COUNT(*) FROM planes) AS planes,
       (SELECT COUNT(*) FROM tarifario_versiones) AS versiones,
       (SELECT COUNT(*) FROM tarifas) AS tarifas,
       (SELECT COUNT(*) FROM monotributo_aportes WHERE vigente_hasta IS NULL)
         AS aportesAbiertos,
       (SELECT COUNT(*) FROM politica_comercial WHERE estado = 'VIGENTE')
         AS politicasAbiertas,
       (SELECT p.id FROM politica_comercial p
         WHERE p.estado = 'VIGENTE' ORDER BY p.id LIMIT 1)
         AS politicaVigenteId,
       (SELECT COUNT(*)
          FROM porcentajes_comerciales pc
          JOIN politica_comercial p ON p.id = pc.politica_comercial_id
         WHERE p.estado = 'VIGENTE' AND pc.vigente_hasta IS NULL)
         AS porcentajesVigenteAbiertos`,
  );

  const [version] = await matistaConnection.query(
    `SELECT id, estado
       FROM tarifario_versiones
      WHERE tipo = 'CARGA_INICIAL'
      ORDER BY id
      LIMIT 1`,
  );

  const versionCargaInicialId = version[0]?.id ?? null;
  let tarifasCargaInicial = 0;

  if (versionCargaInicialId !== null) {
    const [tarifas] = await matistaConnection.query(
      'SELECT COUNT(*) AS total FROM tarifas WHERE version_id = ?',
      [versionCargaInicialId],
    );

    tarifasCargaInicial = tarifas[0].total;
  }

  return Object.freeze({
    planes: conteos[0].planes,
    versiones: conteos[0].versiones,
    tarifas: conteos[0].tarifas,
    aportesAbiertos: conteos[0].aportesAbiertos,
    politicasAbiertas: conteos[0].politicasAbiertas,
    politicaVigenteId: conteos[0].politicaVigenteId ?? null,
    porcentajesVigenteAbiertos: conteos[0].porcentajesVigenteAbiertos,
    versionCargaInicialId,
    versionCargaInicialEstado: version[0]?.estado ?? null,
    tarifasCargaInicial,
  });
}

/** Verifica que el legajo del responsable exista en AUTH.
 *
 *  - Parametros: `matistaConnection`; `actorLegajo` (string).
 *  - Retorna: true si existe; lanza error descriptivo si no.
 *  - Nota: exige existencia, no rol: la carga puede ejecutarse cuando AUTH
 *    todavia no tiene cuentas ADMIN.
 */
export async function assertActorExistente(matistaConnection, actorLegajo) {
  const [rows] = await matistaConnection.query(
    'SELECT legajo FROM empleados WHERE legajo = ?',
    [actorLegajo],
  );

  if (rows.length === 0) {
    throw new Error(
      `El legajo ${actorLegajo} no existe en empleados; la carga requiere `
      + 'un responsable real registrado (variable IMPORT_ACTOR_LEGAJO).',
    );
  }

  return true;
}

/** Genera lotes de un maximo `tamano` elementos para inserts por lotes.
 *
 *  - Parametros: `filas` (array); `tamano` (entero positivo).
 *  - Retorna: array de arrays (lotes sin solapes).
 */
export function generarLotes(filas, tamano) {
  const lotes = [];

  for (let inicio = 0; inicio < filas.length; inicio += tamano) {
    lotes.push(filas.slice(inicio, inicio + tamano));
  }

  return lotes;
}

/** Arma el fragmento VALUES (?, ?, ...) para un insert de N filas.
 *
 *  - Parametros: `cantidadFilas`; `columnasPorFila`.
 *  - Retorna: string del tipo '(?, ?), (?, ?)' listo para concatenar.
 */
export function plantillasValues(cantidadFilas, columnasPorFila) {
  const fila = `(${Array(columnasPorFila).fill('?').join(', ')})`;

  return Array(cantidadFilas).fill(fila).join(', ');
}

/**
 * Inserta los planes activos preservando sus ids originales de SIGEC.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {object[]} planes Planes activos validados.
 * @returns {Promise<void>}
 */
export async function insertarPlanes(destino, planes) {
  await destino.query(
    `INSERT INTO planes
       (id, nombre, detalles, condiciones_generales, activa)
     VALUES ${plantillasValues(planes.length, 5)}`,
    planes.flatMap((plan) => [
      plan.id,
      plan.nombre.trim(),
      plan.detalles,
      plan.condiciones_generales,
      1,
    ]),
  );
}

/**
 * Crea la version CARGA_INICIAL con la observacion de procedencia.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {string} observacion Texto de procedencia registrado en la cabecera.
 * @returns {Promise<number>} Identificador de la version creada.
 */
export async function insertarVersionCargaInicial(destino, observacion) {
  const [resultado] = await destino.query(
    `INSERT INTO tarifario_versiones
       (tipo, fecha_activacion, estado, observacion)
     VALUES ('CARGA_INICIAL', UTC_TIMESTAMP(6), 'ACTIVA', ?)`,
    [observacion],
  );
  return resultado.insertId;
}

/**
 * Inserta las tarifas validadas en lotes de 50 filas.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {number} versionId Identificador de la version CARGA_INICIAL.
 * @param {object[]} tarifas Tarifas validadas con rango_clave ya normalizado.
 * @returns {Promise<void>}
 */
export async function insertarTarifasCargaInicial(destino, versionId, tarifas) {
  for (const lote of generarLotes(tarifas, 50)) {
    await destino.query(
      `INSERT INTO tarifas
         (version_id, plan_id, tipo_ingreso, rango_etario,
          rango_clave, rango_nota, precio, activa)
       VALUES ${plantillasValues(lote.length, 8)}`,
      lote.flatMap((referencia) => [
        versionId,
        referencia.plan_id,
        referencia.tipo_ingreso,
        referencia.rango_etario,
        referencia.rango_clave,
        referencia.rango_nota,
        referencia.precio,
        1,
      ]),
    );
  }
}

/**
 * Inserta los aportes de monotributo con vigencia actual.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {object[]} aportes Aportes de monotributo del origen.
 * @param {string} actorLegajo Responsable de la carga.
 * @returns {Promise<void>}
 */
export async function insertarAportesMonotributo(destino, aportes, actorLegajo) {
  for (const aporte of aportes) {
    await destino.query(
      `INSERT INTO monotributo_aportes
         (categoria, aporte, vigente_desde, vigente_hasta, actor_legajo)
       VALUES (?, ?, UTC_TIMESTAMP(6), NULL, ?)`,
      [aporte.categoria, aporte.aporte, actorLegajo],
    );
  }
}

/**
 * Inserta la politica comercial inicial vigente con los valores aprobados.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {object} politica Valores de politica_comercial aprobados.
 * @param {string} actorLegajo Responsable de la carga.
 * @returns {Promise<number>} Identificador de la politica creada.
 */
export async function insertarPoliticaComercial(destino, politica, actorLegajo) {
  const [resultado] = await destino.query(
    `INSERT INTO politica_comercial (
       estado, porcentaje_aporte_reconocido, tope_sueldo_bruto,
       joven_porcentaje, comercial_fijo_max_pct,
       comercial_fijo_meses_max, comercial_escalonado_max_pct,
       comercial_escalonado_tramos_max,
       comercial_escalonado_total_meses_max,
       primer_tramo_50_meses_max, tdc_pct, tdc_habilitado,
       tope_comercial_tdc_pct, afinidad_pct, aporte_monotributo,
       fecha_vigencia,
       actor_legajo
     ) VALUES ('VIGENTE', ?,
       ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6), ?)`,
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
      actorLegajo,
    ],
  );
  return resultado.insertId;
}

/**
 * Inserta el catalogo inicial de porcentajes comerciales de una politica.
 * @param {object} destino Conexion transaccional de la base destino.
 * @param {number} politicaId Version propietaria del catalogo.
 * @param {string} actorLegajo Responsable de la operacion.
 * @returns {Promise<void>}
 */
export async function insertarCatalogoPorcentajes(destino, politicaId, actorLegajo) {
  const filas = PORCENTAJES_COMERCIALES_INICIALES
    .map(() => '(?, ?, NULL, UTC_TIMESTAMP(6), ?)')
    .join(', ');
  await destino.query(
    `INSERT INTO porcentajes_comerciales
       (politica_comercial_id, porcentaje, descripcion, fecha_vigencia, actor_legajo)
     VALUES ${filas}`,
    PORCENTAJES_COMERCIALES_INICIALES.flatMap(
      (porcentaje) => [politicaId, porcentaje, actorLegajo],
    ),
  );
}

/**
 * Valores de politica_comercial aprobados para la carga inicial (E2,
 * autorizacion seccion 3.5). Vive en el repositorio porque el catalogo
 * de porcentajes se construye desde aqui.
 */
export const PORCENTAJES_COMERCIALES_INICIALES = Object.freeze([
  '50.00', '45.00', '40.00', '35.00', '30.00', '25.00', '20.00', '15.00', '10.00',
]);

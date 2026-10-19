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
 *    (0 si no existe), base para decidir la idempotencia.
 */
export async function leerEstadoCatalogo(matistaConnection) {
  const [conteos] = await matistaConnection.query(
    `SELECT
       (SELECT COUNT(*) FROM planes) AS planes,
       (SELECT COUNT(*) FROM tarifario_versiones) AS versiones,
       (SELECT COUNT(*) FROM tarifas) AS tarifas,
       (SELECT COUNT(*) FROM monotributo_aportes WHERE vigente_hasta IS NULL)
         AS aportesAbiertos,
       (SELECT COUNT(*) FROM politica_comercial WHERE vigente_hasta IS NULL)
         AS politicasAbiertas`,
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

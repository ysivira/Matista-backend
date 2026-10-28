/**
 * ============================================================
 * MATISTA | INTEGRACIÓN DEL CICLO TARIFARIO
 * ============================================================
 *
 * Archivo: tarifario.ciclo.integration.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Verificar borradores, aumentos y transiciones con fixtures
 * propios; las operaciones MySQL requieren RUN_DB_TESTS.
 *
 * ============================================================
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import {
  activarVersionTarifario,
  aumentarVersionTarifario,
  crearBorradorDesdeHistorica,
  crearBorradorTarifario,
  descartarVersionTarifario,
  editarTarifaVersion,
  finalizarVersionTarifario,
  reanudarEdicionVersion,
} from '../../../src/modules/admin/tarifario.service.js';
import * as repositorioTarifario
  from '../../../src/modules/admin/tarifario.repository.js';
import { withConnection } from '../../../src/modules/auth/auth.repository.js';
import { obtenerEmpleado } from '../../../src/modules/admin/employees.repository.js';
import { resolverVersionVigente } from '../../../src/modules/admin/admin.vigencia.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';

// Pruebas gated del ciclo de vida SL-4/SL-5 contra matista_test con el
// esquema 013/014/015 REAL: coleccion de borrador (copias completas),
// aumento masivo con HALF-UP, aumento por modulo, edicion individual con
// revision optimista, finalizacion, activacion transaccional y
// recuperacion de una version HISTORICA. Todo el ciclo se ejecuta sobre
// tablas temporales de una unica sesion: los nombres sombrean las tablas
// permanentes y desaparecen al cerrar la conexion, sin modificar la ACTIVA.
const enabled = process.env.RUN_DB_TESTS === '1';
const TABLAS_AISLADAS = [
  'empleados',
  'planes',
  'tarifario_versiones',
  'tarifas',
  'tarifario_versiones_eventos',
];

let config;
let poolInfraestructura;
let pool;
let connectionAislada;
let actorLegajo;
let versionActivaInicial;
let eventoInicialFilas;
let snapshotPermanenteInicial;
const versionIdsCreadas = new Set();
let versionCicloId;
let versionActivaCorridaId;
let versionHistoricaCorridaId;

/**
 * Copia el snapshot de tarifas fila por fila dentro de la sesion aislada.
 * MySQL no admite referenciar una tabla TEMPORARY dos veces en la misma
 * sentencia (error 1137), por lo que el INSERT-SELECT del repositorio se
 * reemplaza por lectura + insercion con la misma conectividad; el SQL real
 * de `copiarTarifas` sigue cubierto por la suite de trazabilidad, que
 * ejecuta contra tablas permanentes.
 * @param {object} connection Conexion de la sesion aislada.
 * @param {{origenId: number|string, destinoId: number|string}} ids
 *   Version vigente que se copia y borrador que recibe la copia.
 * @returns {Promise<number>} Cantidad de filas copiadas.
 */
async function copiarTarifasAislada(connection, { origenId, destinoId }) {
  const [filas] = await connection.query(
    `SELECT plan_id, tipo_ingreso, rango_etario, rango_clave,
            rango_nota, precio, activa
       FROM tarifas
      WHERE version_id = ?`,
    [origenId],
  );
  for (const fila of filas) {
    await connection.execute(
      `INSERT INTO tarifas
          (version_id, plan_id, tipo_ingreso, rango_etario, rango_clave,
           rango_nota, precio, activa)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [destinoId, fila.plan_id, fila.tipo_ingreso, fila.rango_etario,
        fila.rango_clave, fila.rango_nota, fila.precio, fila.activa],
    );
  }
  return filas.length;
}

// Dependencias por defecto reconstruidas desde su propia fuente, con la
// copiadora adaptada a las tablas temporales; asi los servicios operan la
// sesion aislada sin que el codigo de negocio cambie una sola linea.
const dependenciasAisladas = Object.freeze({
  withConnection,
  obtenerEmpleado,
  resolverVersionVigente,
  ...repositorioTarifario,
  copiarTarifas: copiarTarifasAislada,
});

/**
 * Extrae las claves declaradas por el servicio para detectar futuras omisiones sin duplicar su lista.
 * Solo admite el objeto explícito de identificadores actual; un cambio de sintaxis requiere revisión.
 * @returns {Promise<string[]>} Nombres de todas las dependencias por defecto del servicio.
 * @throws {AssertionError} Si no se identifica inequívocamente el contrato o cambia su forma.
 */
async function clavesDelContratoTarifario() {
  const fuente = await readFile(new URL('../../../src/modules/admin/tarifario.service.js', import.meta.url), 'utf8');
  const bloques = [...fuente.matchAll(/const DEPENDENCIAS_DEFECTO = Object\.freeze\(\{([^}]+)\}\);/g)];
  assert.equal(bloques.length, 1, 'Contrato de dependencias inequívoco');
  const claves = bloques[0][1].split(',').map(clave => clave.trim()).filter(Boolean);
  assert.ok(claves.length > 0);
  for (const clave of claves) assert.match(clave, /^[a-zA-Z_$][\w$]*$/, 'Revisar la sintaxis del contrato de dependencias');
  return claves;
}

/** Verifica sin MySQL que el arnés conserva todas las dependencias, especialmente la identidad real. */
test('FIX19 arnés de ciclo incluye el contrato completo de dependencias productivas', async () => {
  for (const clave of await clavesDelContratoTarifario()) {
    assert.equal(typeof dependenciasAisladas[clave], 'function', `Dependencia obligatoria ausente: ${clave}`);
  }
  assert.equal(dependenciasAisladas.obtenerEmpleado, obtenerEmpleado);
  assert.equal(dependenciasAisladas.withConnection, withConnection);
  assert.equal(dependenciasAisladas.copiarTarifas, copiarTarifasAislada);
});

/**
 * Ejercita con conexión doble la lectura REAL del actor y withConnection REAL del arnés.
 * Se detiene en insertarBorrador, antes de cualquier escritura; verifica rollback y liberación.
 */
test('FIX19 arnés lee la identidad por la misma conexión y revierte un corte previo a persistencia', async () => {
  const operaciones = [], legajo = '9900000001';
  const corte = new Error('Corte de prueba anterior a persistencia');
  const conexion = {
    /** Acepta exclusivamente zona horaria y SELECT parametrizado del repositorio real de empleados. */
    async query(sql, parametros) {
      if (sql === "SET time_zone = '+00:00'") { operaciones.push('zona'); return [[], []]; }
      assert.match(sql, /SELECT e\.legajo, e\.nombre,/);
      assert.match(sql, /WHERE e\.legajo = \?/);
      assert.deepEqual(parametros, [legajo]);
      operaciones.push('identidad');
      return [[{ legajo, nombre: 'Admin', apellido: 'Integracion' }], []];
    },
    /** Registra apertura transaccional sin motor ni persistencia. */
    async beginTransaction() { operaciones.push('begin'); },
    /** Registra un commit inesperado para que falle la comprobación de secuencia. */
    async commit() { operaciones.push('commit'); },
    /** Registra rollback del withConnection real ante el corte deliberado. */
    async rollback() { operaciones.push('rollback'); },
    /** Registra la liberación obligatoria de la única conexión del doble. */
    release() { operaciones.push('release'); },
  };
  const dependencias = {
    ...dependenciasAisladas,
    /** Resuelve el fixture activo comprobando que se usa la conexión transaccional original. */
    async bloquearVersionActiva(c) { assert.equal(c, conexion); return { id: 1 }; },
    /** El doble no tiene borradores; no consulta un servidor real. */
    async bloquearBorradorAbierto(c) { assert.equal(c, conexion); return null; },
    /** Detiene el servicio después del snapshotActor real y antes de ejecutar un INSERT. */
    async insertarBorrador(c, datos) {
      assert.equal(c, conexion);
      assert.equal(datos.actorLegajo, legajo);
      assert.equal(operaciones.at(-1), 'identidad');
      throw corte;
    },
  };
  await assert.rejects(crearBorradorTarifario({
    /** Entrega la misma conexión doble; nunca crea un pool MySQL. */
    async getConnection() { return conexion; },
  }, { legajo }, dependencias), error => error === corte);
  assert.deepEqual(operaciones, ['zona', 'begin', 'identidad', 'rollback', 'release']);
});

/**
 * Adapta una unica conexion a la interfaz de pool usada por los servicios.
 * `release` es deliberadamente neutro para conservar las tablas temporales
 * durante toda la suite; el after libera la conexion real.
 * @param {object} connection Conexion mysql2 reservada por la corrida.
 * @returns {object} Pool y conexion compatibles, limitados a esa sesion.
 */
function crearPoolAislado(connection) {
  const fachada = {
    query: connection.query.bind(connection),
    execute: connection.execute.bind(connection),
    beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection),
    rollback: connection.rollback.bind(connection),
    release: () => {},
  };
  return {
    getConnection: async () => fachada,
    query: fachada.query,
    execute: fachada.execute,
  };
}

/**
 * Serializa las tablas permanentes que el ciclo podria alterar si escapara
 * de la sesion aislada.
 * @param {object} poolReal Pool conectado a matista_test sin tablas temporales.
 * @returns {Promise<string>} Snapshot estable para comparar antes y despues.
 */
async function capturarSnapshotPermanente(poolReal) {
  const [versiones] = await poolReal.query(
    'SELECT * FROM tarifario_versiones ORDER BY id',
  );
  const [tarifas] = await poolReal.query('SELECT * FROM tarifas ORDER BY id');
  const [eventos] = await poolReal.query(
    'SELECT * FROM tarifario_versiones_eventos ORDER BY id',
  );
  return JSON.stringify({ versiones, tarifas, eventos });
}

/** Crea el catalogo minimo propio sobre tablas temporales de la sesion. */
async function prepararFixturesAislados() {
  for (const tabla of TABLAS_AISLADAS) {
    // MySQL 8.4 rechaza `CREATE TEMPORARY TABLE t LIKE db.t` (alias duplicado),
    // por lo que la estructura y sus indices se clonan desde SHOW CREATE TABLE
    // renombrando la definicion a TEMPORARY.
    const [filas] = await connectionAislada.query(
      `SHOW CREATE TABLE \`${config.database}\`.${tabla}`,
    );
    const lineasDefinicion = filas[0]['Create Table']
      .replace(/^CREATE TABLE /i, 'CREATE TEMPORARY TABLE ')
      .split('\n');
    // MySQL 8.4 no admite claves foraneas en tablas temporales: se descartan
    // y se completa la coma pendiente si la FK era la ultima definicion.
    const sinForaneas = lineasDefinicion
      .filter((linea) => !/^\s+CONSTRAINT\s+`fk_/i.test(linea))
      .join('\n')
      .replace(/,(\s*\n\))/, '$1');
    await connectionAislada.query(sinForaneas);
  }

  actorLegajo = '9900000001';
  versionActivaInicial = 1;
  await connectionAislada.execute(
    `INSERT INTO empleados
      (legajo, nombre, apellido, password_hash, rol, estado)
     VALUES (?, 'Admin', 'Integracion', 'fixture-sin-login', 'ADMIN', 'ACTIVO')`,
    [actorLegajo],
  );
  await connectionAislada.execute(
    `INSERT INTO planes (id, nombre, detalles, condiciones_generales, activa)
     VALUES (1, 'PLAN INTEGRACION', 'Fixture propio', 'Fixture propio', 1)`,
  );
  await connectionAislada.execute(
    `INSERT INTO tarifario_versiones
      (id, tipo, estado, revision, fecha_activacion, observacion, actor_legajo)
     VALUES (?, 'CARGA_INICIAL', 'ACTIVA', 0, '2026-01-01 00:00:00.000000',
       'Carga inicial temporal de la integracion.', NULL)`,
    [versionActivaInicial],
  );
  await connectionAislada.execute(
    `INSERT INTO tarifas
      (version_id, plan_id, tipo_ingreso, rango_etario, rango_clave, rango_nota, precio, activa)
     VALUES
      (?, 1, 'Obligatorio', '0-25', '0-25', NULL, 100.00, 1),
      (?, 1, 'Voluntario', '66-00', '66+', NULL, 80.25, 1)`,
    [versionActivaInicial, versionActivaInicial],
  );
  eventoInicialFilas = 2;
}

/**
 * Verifica que las tablas temporales solo contengan el fixture inicial y
 * las versiones registradas por la corrida.
 * @returns {Promise<void>}
 * @throws {AssertionError} Si aparece una version o relacion no registrada.
 */
async function verificarPropiedadDeFixtures() {
  const idsPermitidos = new Set([
    String(versionActivaInicial),
    ...[...versionIdsCreadas].map(String),
  ]);
  for (const tabla of ['tarifario_versiones', 'tarifas', 'tarifario_versiones_eventos']) {
    const columna = tabla === 'tarifario_versiones' ? 'id' : 'version_id';
    const [filas] = await connectionAislada.query(
      `SELECT DISTINCT ${columna} AS version_id FROM ${tabla}`,
    );
    assert.ok(
      filas.every((fila) => idsPermitidos.has(String(fila.version_id))),
      `${tabla} contiene datos ajenos a los fixtures de la corrida`,
    );
  }
}

/** Prepara la conexion permanente de control y la sesion temporal aislada. */
before(async () => {
  if (!enabled) {
    return;
  }

  config = loadDatabaseConfig(process.env, { purpose: 'migration' });
  assertTestDatabase(config);
  poolInfraestructura = createDatabasePool(config);
  await verifyDatabaseConnection(poolInfraestructura, 'matista_test');
  await runMigrations({
    pool: poolInfraestructura,
    config,
    migrationsDirectory: new URL('../../../migrations', import.meta.url)
      .pathname,
  });
  snapshotPermanenteInicial = await capturarSnapshotPermanente(poolInfraestructura);
  connectionAislada = await poolInfraestructura.getConnection();
  await prepararFixturesAislados();
  pool = crearPoolAislado(connectionAislada);
});

/**
 * Descarta las tablas temporales, comprueba que las tablas permanentes no
 * cambiaron y cierra el pool real.
 */
after(async () => {
  if (!poolInfraestructura) return;
  let errorLimpieza;
  try {
    if (connectionAislada) {
      await verificarPropiedadDeFixtures();
      for (const tabla of [...TABLAS_AISLADAS].reverse()) {
        await connectionAislada.query(`DROP TEMPORARY TABLE IF EXISTS ${tabla}`);
      }
    }
  } catch (error) {
    errorLimpieza = error;
  } finally {
    connectionAislada?.release();
  }
  try {
    const snapshotFinal = await capturarSnapshotPermanente(poolInfraestructura);
    assert.equal(snapshotFinal, snapshotPermanenteInicial);
  } catch (error) {
    errorLimpieza ??= error;
  } finally {
    await poolInfraestructura.end();
  }
  if (errorLimpieza) throw errorLimpieza;
});

test('SL-4: el borrador copia integramente el snapshot de la ACTIVA', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const creado = await crearBorradorTarifario(pool, { legajo: actorLegajo }, dependenciasAisladas);
  const versionId = Number(creado.version.id);
  versionIdsCreadas.add(versionId);
  versionCicloId = versionId;

  assert.equal(creado.version.tipo, 'EDICION_LISTA');
  assert.equal(creado.version.estado, 'PREPARACION');
  assert.equal(creado.version.version_base_id, String(versionActivaInicial));
  assert.equal(creado.version.actor_legajo, actorLegajo);

  const [copiadas] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [versionId],
  );
  assert.equal(copiadas[0].filas, eventoInicialFilas);

  // Exclusividad del borrador abierto (uq_guard_borrador_version + 409).
  await assert.rejects(
    crearBorradorTarifario(pool, { legajo: actorLegajo }, dependenciasAisladas),
    { code: 'ADMIN_ESTADO', status: 409 },
  );

  const [evento] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, agrupador_id
       FROM tarifario_versiones_eventos
      WHERE version_id = ?
      ORDER BY id ASC LIMIT 1`,
    [versionId],
  );
  assert.equal(evento[0].tipo_evento, 'CREACION');
  assert.equal(evento[0].tipo_operacion, null);
  assert.equal(evento[0].agrupador_id, null);
});

test('SL-4: el aumento masivo aplica HALF-UP y audita hijo por hijo', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  assert.ok(versionCicloId, 'necesita un borrador creado por la prueba previa');
  const versionId = versionCicloId;

  const aumento = await aumentarVersionTarifario(
    pool,
    { id: String(versionId) },
    { porcentaje: '10', revision: '0' },
    { legajo: actorLegajo },
  );
  assert.equal(aumento.filas, eventoInicialFilas);
  assert.equal(aumento.revision, 1);
  assert.equal(aumento.porcentaje, '10');
  assert.equal(aumento.evento.tipo, 'AUMENTO_MASIVO');

  const [copias] = await pool.query(
    `SELECT id, plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE version_id = ?
      ORDER BY id`,
    [versionId],
  );
  const [bases] = await pool.query(
    `SELECT plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE version_id = ?`,
    [versionActivaInicial],
  );
  // Lecturas separadas porque una tabla TEMPORARY no admite self-join.
  const precioBase = new Map(bases.map((fila) => [
    `${fila.plan_id}|${fila.tipo_ingreso}|${fila.rango_clave}`,
    String(fila.precio),
  ]));
  const primera = copias[0];
  const centavosBase = Math.round(
    Number(precioBase.get(`${primera.plan_id}|${primera.tipo_ingreso}|${primera.rango_clave}`))
      * 100,
  );
  const esperado = ((centavosBase + Math.round(centavosBase / 10)) / 100).toFixed(2);
  assert.equal(String(primera.precio), esperado);
  // Valida el redondeo HALF-UP en TODAS las filas del snapshot.
  for (const copia of copias) {
    const base = precioBase.get(`${copia.plan_id}|${copia.tipo_ingreso}|${copia.rango_clave}`);
    const centavos = Math.round(Number(base) * 100);
    const calculado = ((centavos + Math.round(centavos / 10)) / 100).toFixed(2);
    assert.equal(String(copia.precio), calculado);
  }

  const [hijos] = await pool.query(
    `SELECT COUNT(*) AS cant FROM tarifario_versiones_eventos
      WHERE version_id = ? AND tipo_operacion = 'PRECIO'
        AND agrupador_id IS NOT NULL`,
    [versionId],
  );
  assert.equal(Number(hijos[0].cant), eventoInicialFilas);
});

test('SL-4: la edicion individual respeta revision y bloquea estados cerrados', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  assert.ok(versionCicloId, 'necesita un borrador creado por la prueba previa');
  const versionId = versionCicloId;
  const [filas] = await pool.query(
    'SELECT id FROM tarifas WHERE version_id = ? ORDER BY id LIMIT 1',
    [versionId],
  );
  const tarifaId = Number(filas[0].id);

  const edicion = await editarTarifaVersion(
    pool,
    { id: String(versionId), tarifaId: String(tarifaId) },
    { precio: '123.45', revision: '1' },
    { legajo: actorLegajo },
  );
  assert.equal(edicion.tarifa.precio, '123.45');
  assert.equal(edicion.revision, 2);

  const [evento] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, agrupador_id
       FROM tarifario_versiones_eventos
      WHERE version_id = ?
      ORDER BY id DESC LIMIT 1`,
    [versionId],
  );
  assert.equal(evento[0].tipo_evento, 'MODIFICACION');
  assert.equal(evento[0].tipo_operacion, 'PRECIO');
  assert.equal(evento[0].agrupador_id ?? null, null);

  // Revision en desfase: 409 ADMIN_CONCURRENCIA desde MySQL real.
  await assert.rejects(
    editarTarifaVersion(
      pool,
      { id: String(versionId), tarifaId: String(tarifaId) },
      { precio: '9.99', revision: '1' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_CONCURRENCIA', status: 409 },
  );

  // El precio de la fila no cambio con el intento rechazado.
  const [intacta] = await pool.query('SELECT precio FROM tarifas WHERE id = ?', [tarifaId]);
  assert.equal(String(intacta[0].precio), '123.45');
});

test('SL-5: la activacion manual conmuta la vigencia y deja evento tipado', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  assert.ok(versionCicloId, 'necesita un borrador creado por la prueba previa');
  const versionId = versionCicloId;

  // Estado PREPARACION rechazado antes de tocar la vigencia.
  await assert.rejects(
    activarVersionTarifario(pool, { id: String(versionId) }, { legajo: actorLegajo }),
    { code: 'ADMIN_ESTADO', status: 409 },
  );

  const finalizado = await finalizarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '2' },
    { legajo: actorLegajo },
  );
  assert.equal(finalizado.version.estado, 'LISTA_PARA_ACTIVAR');

  // Segunda finalizacion sobre un borrador ya cerrado: 409 transicion.
  await assert.rejects(
    finalizarVersionTarifario(
      pool,
      { id: String(versionId) },
      { revision: '3' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_TRANSICION', status: 409 },
  );

  const activado = await activarVersionTarifario(
    pool,
    { id: String(versionId) },
    { legajo: actorLegajo },
  );
  assert.equal(activado.version.id, String(versionId));
  assert.equal(activado.version.estado, 'ACTIVA');
  assert.equal(activado.versionReemplazada, String(versionActivaInicial));
  assert.ok(activado.version.fecha_activacion);
  versionActivaCorridaId = versionId;

  // La version UNICA: la inicial queda HISTORICA; el borrador es la nueva
  // ACTIVA con su fecha estampada.
  const [estados] = await pool.query(
    `SELECT id, estado, fecha_activacion
       FROM tarifario_versiones
      WHERE id IN (?, ?)
      ORDER BY id`,
    [versionActivaInicial, versionId],
  );
  const historica = estados.find((fila) => Number(fila.id) === versionActivaInicial);
  const activa = estados.find((fila) => Number(fila.id) === versionId);
  assert.equal(historica.estado, 'HISTORICA');
  assert.equal(activa.estado, 'ACTIVA');
  assert.ok(activa.fecha_activacion);

  const [evento] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, plan_id, valor_anterior, valor_nuevo
       FROM tarifario_versiones_eventos
      WHERE version_id = ? AND tipo_evento = 'ACTIVACION'
      ORDER BY id DESC
      LIMIT 1`,
    [versionId],
  );
  assert.equal(evento[0].tipo_evento, 'ACTIVACION');
  assert.equal(evento[0].tipo_operacion, null);
  assert.equal(evento[0].plan_id, null);
  assert.equal(evento[0].valor_anterior, null);
  assert.equal(evento[0].valor_nuevo, null);
});

// SL-5b: recuperacion funcional desde HISTORICA. La version inicial del
// ciclo ya quedo HISTORICA en la activacion previa; se recupera como
// borrador (copia completa), se rechaza una segunda recuperacion por la
// exclusividad de borrador abierto, se FINALIZA SIN CAMBIOS ECONOMICOS
// (los precios coinciden con la fuente: el borrador puede cerrarse
// igual) y se activa con el procedimiento normal (caso D).
test('SL-5b: la recuperacion desde HISTORICA crea un borrador completo, activable y sin cambios forzados', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const [fuente] = await pool.query(
    'SELECT estado FROM tarifario_versiones WHERE id = ?',
    [versionActivaInicial],
  );
  assert.equal(fuente[0].estado, 'HISTORICA');

  const [tarifasFuente] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [versionActivaInicial],
  );

  const recuperado = await crearBorradorDesdeHistorica(
    pool,
    { id: String(versionActivaInicial) },
    { legajo: actorLegajo },
    dependenciasAisladas,
  );
  assert.equal(recuperado.version.tipo, 'EDICION_LISTA');
  assert.equal(recuperado.version.estado, 'PREPARACION');
  assert.equal(recuperado.version.version_base_id, String(versionActivaInicial));
  const idRecuperado = Number(recuperado.version.id);
  versionIdsCreadas.add(idRecuperado);
  assert.ok(idRecuperado !== Number(recuperado.version.version_base_id));

  const [copiadas] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [idRecuperado],
  );
  assert.equal(copiadas[0].filas, tarifasFuente[0].filas);

  // Exclusividad: mientras exista el borrador abierto no hay otro.
  await assert.rejects(
    crearBorradorDesdeHistorica(
      pool,
      { id: String(versionActivaInicial) },
      { legajo: actorLegajo },
      dependenciasAisladas,
    ),
    { code: 'ADMIN_ESTADO', status: 409 },
  );

  // Finalizacion SIN cambios economicos: los precios copiados son
  // identicos a la fuente y el borrador igualmente puede cerrarse para
  // su activacion manual.
  const finalizado = await finalizarVersionTarifario(
    pool,
    { id: String(idRecuperado) },
    { revision: '0' },
    { legajo: actorLegajo },
  );
  assert.equal(finalizado.version.estado, 'LISTA_PARA_ACTIVAR');

  // Activacion con el procedimiento normal: reemplaza a la ACTIVA
  // vigente (el borrador activado en la prueba SL-5), no a la fuente.
  assert.ok(versionActivaCorridaId, 'necesita la version activada por la prueba previa');
  const activado = await activarVersionTarifario(
    pool,
    { id: String(idRecuperado) },
    { legajo: actorLegajo },
  );
  assert.equal(activado.version.estado, 'ACTIVA');
  assert.equal(activado.versionReemplazada, String(versionActivaCorridaId));
  versionHistoricaCorridaId = versionActivaCorridaId;
  versionActivaCorridaId = idRecuperado;
});

// SL-5c: Volver a edicion (correccion integral). Si en alguna base el
// ENUM todavia no incluye REANUDACION (por ejemplo una copia anterior a
// la 016), la prueba se salta sin romper la corrida; de lo contrario
// exige el flujo completo: borrar -> aumentar -> finalizar -> volver a
// edicion -> editar otro precio -> finalizar -> activar, con ambas
// modificaciones conservadas y auditadas.
test('SL-5c: volver a edicion reabre el borrador y conserva ambas modificaciones auditadas', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const [columna] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'tarifario_versiones_eventos'
        AND column_name = 'tipo_evento'`,
  );
  if (!/REANUDACION/.test(String(columna[0].COLUMN_TYPE))) {
    t.skip('requiere la migracion 016 (ENUM con REANUDACION) sobre la base objetivo');
    return;
  }

  const creado = await crearBorradorTarifario(pool, { legajo: actorLegajo }, dependenciasAisladas);
  const versionId = Number(creado.version.id);
  versionIdsCreadas.add(versionId);

  // Primera modificacion economica: aumento masivo del 10%.
  await aumentarVersionTarifario(
    pool,
    { id: String(versionId) },
    { porcentaje: '10', revision: '0' },
    { legajo: actorLegajo },
  );
  await finalizarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '1' },
    { legajo: actorLegajo },
  );

  // Volver a edicion: PREPARACION de nuevo, precios y auditoria intactos.
  const reanudado = await reanudarEdicionVersion(
    pool,
    { id: String(versionId) },
    { legajo: actorLegajo },
  );
  assert.equal(reanudado.version.estado, 'PREPARACION');
  // La revision optimista del ciclo quedo en 2: aumentar la hizo 1 y la
  // finalizacion (que tambien la incrementa) la dejo en 2 antes de la
  // reapertura; volver a edicion conserva exactamente ese valor.
  assert.equal(reanudado.version.revision, 2);

  // Segunda modificacion economica despues de la reapertura.
  const [filas] = await pool.query(
    'SELECT id FROM tarifas WHERE version_id = ? ORDER BY id LIMIT 1',
    [versionId],
  );
  await editarTarifaVersion(
    pool,
    { id: String(versionId), tarifaId: String(filas[0].id) },
    { precio: '150.00', revision: '2' },
    { legajo: actorLegajo },
  );

  // Re-finalizacion y activacion con el caso D normal.
  await finalizarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '3' },
    { legajo: actorLegajo },
  );
  const activado = await activarVersionTarifario(
    pool,
    { id: String(versionId) },
    { legajo: actorLegajo },
  );
  assert.equal(activado.version.estado, 'ACTIVA');
  versionHistoricaCorridaId = versionActivaCorridaId;
  versionActivaCorridaId = versionId;

  // La version finalizada conserva las dos modificaciones: la fila
  // editada tiene el precio nuevo y el resto mantienen el aumento;
  // lecturas separadas porque una tabla TEMPORARY no admite self-join.
  const [precios] = await pool.query(
    `SELECT id, plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE version_id = ?
      ORDER BY id`,
    [versionId],
  );
  const [preciosBase] = await pool.query(
    `SELECT plan_id, tipo_ingreso, rango_clave, precio
       FROM tarifas
      WHERE version_id = ?`,
    [versionActivaInicial],
  );
  const basePorClave = new Map(preciosBase.map((fila) => [
    `${fila.plan_id}|${fila.tipo_ingreso}|${fila.rango_clave}`,
    String(fila.precio),
  ]));
  const editada = precios.find(
    (fila) => String(fila.id) === String(filas[0].id),
  );
  assert.ok(editada, 'la fila editada sigue presente en el snapshot');
  assert.equal(String(editada.precio), '150.00');
  const sinEdicion = precios.filter((fila) => fila !== editada);
  assert.ok(sinEdicion.length > 0, 'quedo al menos otra fila solo con el aumento');
  for (const fila of sinEdicion) {
    const base = basePorClave.get(
      `${fila.plan_id}|${fila.tipo_ingreso}|${fila.rango_clave}`,
    );
    const centavos = Math.round(Number(base) * 100);
    const aumento = ((centavos + Math.round(centavos / 10)) / 100).toFixed(2);
    assert.equal(String(fila.precio), aumento);
  }

  // Trazabilidad completa del ciclo reabierto.
  const [eventos] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, agrupador_id
       FROM tarifario_versiones_eventos
      WHERE version_id = ?
      ORDER BY id ASC`,
    [versionId],
  );
  const tipos = eventos.map((fila) => fila.tipo_evento);
  const operaciones = eventos.map((fila) => fila.tipo_operacion);
  assert.ok(tipos.includes('CREACION'));
  // El aumento masivo queda auditado como MODIFICACION con su
  // tipo_operacion tipado (no cambia la familia de eventos).
  assert.ok(operaciones.includes('AUMENTO_MASIVO'));
  assert.ok(tipos.includes('REANUDACION'));
  assert.equal(tipos.filter((tipo) => tipo === 'FINALIZACION').length, 2);
  assert.equal(tipos[tipos.length - 1], 'ACTIVACION');
  const reanudacion = eventos.find((fila) => fila.tipo_evento === 'REANUDACION');
  assert.equal(reanudacion?.tipo_operacion ?? null, null);
});

// Descarte de versiones no activadas (tanda del descarte). Si en alguna
// base el ENUM todavia no incluye DESCARTE (por ejemplo antes de
// ejecutar la migracion 017), la prueba se salta sin romper la corrida.
// El descarte reutiliza el estado interno CANCELADA heredado (013, sin
// productor propio): conserva precios, numeracion y auditoria, audita el
// motivo y libera la exclusividad del borrador de inmediato.
test('el descarte audita motivo con la revision vigente y libera el borrador', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const [columna] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'tarifario_versiones_eventos'
        AND column_name = 'tipo_evento'`,
  );
  if (!/DESCARTE/.test(String(columna[0].COLUMN_TYPE))) {
    t.skip('requiere la migracion 017 (ENUM con DESCARTE) sobre la base objetivo');
    return;
  }

  // Ciclo previo: borrador con un aumento ya finalizado
  // (LISTA_PARA_ACTIVAR; revision 2: creacion 0 -> aumento 1 -> cierre 2).
  const creado = await crearBorradorTarifario(pool, { legajo: actorLegajo }, dependenciasAisladas);
  const versionId = Number(creado.version.id);
  versionIdsCreadas.add(versionId);
  await aumentarVersionTarifario(
    pool,
    { id: String(versionId) },
    { porcentaje: '10', revision: '0' },
    { legajo: actorLegajo },
  );
  await finalizarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '1' },
    { legajo: actorLegajo },
  );

  // RevisiOn desfasada: rechazo ADMIN_CONCURRENCIA sin tocar el estado.
  await assert.rejects(
    descartarVersionTarifario(
      pool,
      { id: String(versionId) },
      { revision: '1', motivo: 'Intento con revision vieja.' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_CONCURRENCIA', status: 409 },
  );
  const [antes] = await pool.query(
    'SELECT estado FROM tarifario_versiones WHERE id = ?',
    [versionId],
  );
  assert.equal(antes[0].estado, 'LISTA_PARA_ACTIVAR');

  // Descarte correcto: estado interno CANCELADA mostrado como
  // Descartada, revision conservada y evento DESCARTE auditado con el
  // motivo (sin tipo_operacion: es del ciclo de vida).
  const descartado = await descartarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '2', motivo: 'La lista de prueba quedo fuera del ciclo.' },
    { legajo: actorLegajo },
  );
  assert.equal(descartado.version.estado, 'CANCELADA');
  assert.equal(descartado.version.revision, 2);
  assert.equal(descartado.evento.tipo, 'DESCARTE');

  const [cabecera] = await pool.query(
    'SELECT estado, revision FROM tarifario_versiones WHERE id = ?',
    [versionId],
  );
  assert.equal(cabecera[0].estado, 'CANCELADA');
  assert.equal(Number(cabecera[0].revision), 2);
  // La copia integral de precios NO se borra fisicamente.
  const [precios] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [versionId],
  );
  assert.ok(Number(precios[0].filas) > 0);

  const [eventos] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, detalle, actor_legajo
       FROM tarifario_versiones_eventos
      WHERE version_id = ?
      ORDER BY id DESC LIMIT 1`,
    [versionId],
  );
  const descarte = eventos[0];
  assert.equal(descarte.tipo_evento, 'DESCARTE');
  assert.equal(descarte.tipo_operacion, null);
  assert.equal(descarte.actor_legajo, actorLegajo);
  assert.ok(descarte.detalle.includes('Motivo: La lista de prueba quedo fuera del ciclo.'));

  // La exclusividad del borrador queda liberada por esquema
  // (guard_borrador vale 1 solo para PREPARACION/LISTA_PARA_ACTIVAR):
  // el descarte recien hecho ya permite crear un borrador nuevo.
  const reinicio = await crearBorradorTarifario(pool, { legajo: actorLegajo }, dependenciasAisladas);
  versionIdsCreadas.add(Number(reinicio.version.id));
  assert.equal(reinicio.version.estado, 'PREPARACION');

  // Aceptacion del descarte: rechaza una version REPETIDA con
  // ADMIN_TRANSICION y sin duplicar eventos.
  await assert.rejects(
    descartarVersionTarifario(
      pool,
      { id: String(versionId) },
      { revision: '2', motivo: 'Doble descarte prohibido.' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_TRANSICION', status: 409 },
  );
});

// Versiones del ciclo cerrado: la ACTIVA y la HISTORICA quedan protegidas
// contra el descarte (la vigencia y las historicas nunca se modifican).
test('el descarte rechaza versiones ACTIVA e HISTORICA sin tocarlas', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const [columna] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'tarifario_versiones_eventos'
        AND column_name = 'tipo_evento'`,
  );
  if (!/DESCARTE/.test(String(columna[0].COLUMN_TYPE))) {
    t.skip('requiere la migracion 017 (ENUM con DESCARTE) sobre la base objetivo');
    return;
  }

  for (const [estado, versionId] of [
    ['ACTIVA', versionActivaCorridaId],
    ['HISTORICA', versionHistoricaCorridaId],
  ]) {
    assert.ok(versionId, `la corrida necesita una version ${estado}`);
    const [versiones] = await pool.query(
      `SELECT id, estado, revision FROM tarifario_versiones WHERE id = ?`,
      [versionId],
    );
    assert.equal(versiones[0]?.estado, estado);
    const revision = Number(versiones[0].revision ?? 0);
    await assert.rejects(
      descartarVersionTarifario(
        pool,
        { id: String(versiones[0].id) },
        { revision, motivo: `Intento sobre una version ${estado.toLowerCase()}.` },
        { legajo: actorLegajo },
      ),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
    // El evento DESCARTE NO quedo registrado para esa version.
    const [eventos] = await pool.query(
      `SELECT COUNT(*) AS filas FROM tarifario_versiones_eventos
        WHERE version_id = ? AND tipo_evento = 'DESCARTE'`,
      [versiones[0].id],
    );
    assert.equal(Number(eventos[0].filas), 0);
  }
});

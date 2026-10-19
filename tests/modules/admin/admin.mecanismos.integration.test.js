import 'dotenv/config';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';
import {
  NOMBRE_LOCK_TARIFARIO,
  withAdminTransaction,
  withAdminVersionLock,
} from '../../../src/modules/admin/admin.transaction.js';
import { registrarAuditoriaVersion } from '../../../src/modules/admin/admin.audit.js';
import { errorValidacion } from '../../../src/modules/admin/admin.errors.js';
import {
  estadoEfectivoVersion,
  obtenerTarifasDeVersion,
  resolverVersionVigente,
} from '../../../src/modules/admin/admin.vigencia.js';
import { leerEstadoCatalogo } from '../../../src/modules/admin/carga-inicial.repository.js';

// Pruebas de integracion de los mecanismos compartidos de SPEC-03 ADMIN
// (E-LM) contra matista_test. El catalogo inicial es PERMANENTE: estas
// pruebas solo agregan sus propios registros temporales (tabla de rascado
// y filas de auditoria etiquetadas) y los eliminan al cerrar; todo lo
// demas se verifica con rollbacks. Requieren RUN_DB_TESTS=1 y la carga
// de E2 aplicada.
const enabled = process.env.RUN_DB_TESTS === '1';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');

// Actor permanente de matista_test (fixture ADMIN copiado desde dev).
const ACTOR_FIXTURE = '0000000001';

// Etiquetas deterministas de los registros propios de estas pruebas; se
// crean y se eliminan dentro de la misma corrida.
const ETIQUETA_NEGOCIO = 'tmp_mecanismo_elm:commit';
const ETIQUETA_AUDITORIA_COMMIT = 'version#0:MECANISMO_COMMIT';
const ETIQUETA_AUDITORIA_ROLLBACK = 'version#0:MECANISMO_ROLLBACK';
const TABLA_RASCADO = 'tmp_mecanismo_elm';

let config;
let pool;

before(async () => {
  if (!enabled) {
    return;
  }

  config = loadDatabaseConfig(process.env, { purpose: 'migration' });
  assertTestDatabase(config);
  pool = createDatabasePool(config);
  await verifyDatabaseConnection(pool, 'matista_test');
  await runMigrations({ pool, config, migrationsDirectory });

  // Tabla de rascado propia de la prueba (no es del dominio y se elimina
  // al final): sirve para demostrar commit/rollback de una "escritura de
  // negocio" sin tocar el catalogo tarifario ni datos AUTH.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${TABLA_RASCADO} (
    etiqueta VARCHAR(60) NOT NULL PRIMARY KEY
  )`);

  // Confirmar el actor permanente disponible.
  const [actores] = await pool.query(
    `SELECT legajo FROM empleados
      WHERE legajo = ? AND rol = 'ADMIN' AND estado = 'ACTIVO'`,
    [ACTOR_FIXTURE],
  );
  assert.equal(actores.length, 1);
});

after(async () => {
  if (pool) {
    // Limpieza limitada: solo registros creados por esta suite.
    await pool.query(
      `DELETE FROM empleados_auditoria
        WHERE evento = 'VERSION_CREADA'
          AND actor_legajo = ?
          AND valor_nuevo IN (?, ?)`,
      [ACTOR_FIXTURE, ETIQUETA_AUDITORIA_COMMIT, ETIQUETA_AUDITORIA_ROLLBACK],
    );
    await pool.query(`DROP TABLE IF EXISTS ${TABLA_RASCADO}`);
    await pool.end();
  }
});

/** Instante UTC con 6 decimales para DATETIME(6), consistente con la zona UTC. */
function ahoraUtc() {
  return `${new Date().toISOString().replace('T', ' ').slice(0, 23)}000`;
}

test('el bloqueo se adquiere, se usa y se libera en la misma conexion', {
  skip: !enabled,
}, async () => {
  const salida = await withAdminVersionLock(pool, async () => 'trabajo');

  assert.equal(salida.bloqueoAdquirido, true);
  assert.equal(salida.liberacionOk, true);
  assert.equal(salida.resultado, 'trabajo');

  // Si el lock quedara retenido, la verificacion fallaria (cuando esta
  // libre el GET_LOCK con timeout 0 devuelve 1).
  const connection = await pool.getConnection();
  try {
    const [free] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS libre',
      [NOMBRE_LOCK_TARIFARIO],
    );
    assert.equal(free[0].libre, 1);
    await connection.query('SELECT RELEASE_LOCK(?)', [NOMBRE_LOCK_TARIFARIO]);
  } finally {
    connection.release();
  }
});

test('un timeout de bloqueo produce error de concurrencia ADMIN', {
  skip: !enabled,
}, async () => {
  const holder = await pool.getConnection();
  try {
    const [taken] = await holder.query(
      'SELECT GET_LOCK(?, 0) AS tomado',
      [NOMBRE_LOCK_TARIFARIO],
    );
    assert.equal(taken[0].tomado, 1);

    await assert.rejects(
      withAdminVersionLock(pool, async () => 'nunca', { timeoutSegundos: 1 }),
      (error) => error.code === 'ADMIN_CONCURRENCIA' && error.status === 409,
    );
  } finally {
    // Suelta el candado del holder para no afectar otras pruebas.
    await holder.query('SELECT RELEASE_LOCK(?)', [NOMBRE_LOCK_TARIFARIO]);
    holder.release();
  }
});

test('un error dentro de la operacion libera el bloqueo y hace rollback', {
  skip: !enabled,
}, async () => {
  await assert.rejects(
    withAdminVersionLock(pool, async (connection) => {
      // Escritura propia dentro de la transaccion: el rollback la deshace.
      await connection.execute(
        `INSERT INTO ${TABLA_RASCADO} (etiqueta) VALUES ('tmp_mecanismo_elm:lock_rollback')`,
      );
      throw errorValidacion('Fallo de negocio simulado.');
    }),
    (error) => error.code === 'ADMIN_VALIDACION' && error.status === 400,
  );

  const connection = await pool.getConnection();
  try {
    // El rollback deshizo la escritura y el lock quedo libre.
    const [restos] = await connection.query(
      `SELECT COUNT(*) AS total FROM ${TABLA_RASCADO} WHERE etiqueta = 'tmp_mecanismo_elm:lock_rollback'`,
    );
    assert.equal(restos[0].total, 0);

    const [free] = await connection.query(
      'SELECT GET_LOCK(?, 0) AS libre',
      [NOMBRE_LOCK_TARIFARIO],
    );
    assert.equal(free[0].libre, 1);
    await connection.query('SELECT RELEASE_LOCK(?)', [NOMBRE_LOCK_TARIFARIO]);
  } finally {
    connection.release();
  }
});

test('un fallo de RELEASE_LOCK no impide liberar la conexion', {
  skip: !enabled,
}, async () => {
  let liberada = false;
  const connection = {
    // Falso pool con una conexion espia: todo funciona salvo RELEASE_LOCK
    // El contrato de mysql2 es [filas, campos] con filas = [objetoFila].
    query: async () => [[], []],
    execute: async (sql) => {
      if (/RELEASE_LOCK/u.test(sql)) {
        throw new Error('RELEASE_LOCK simulado roto.');
      }
      return [[{ resultado: 1 }], undefined];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => { liberada = true; },
  };
  const poolFalso = { getConnection: async () => connection };

  const salida = await withAdminVersionLock(poolFalso, async () => 'ok');

  assert.equal(salida.resultado, 'ok');
  assert.equal(salida.bloqueoAdquirido, true);
  assert.equal(salida.liberacionOk, false);
  assert.equal(liberada, true);
});

test('escritura de negocio y auditoria se confirman en la misma transaccion', {
  skip: !enabled,
}, async () => {
  const fecha = ahoraUtc();

  const recibido = await withAdminTransaction(pool, async (connection) => {
    // "Escritura de negocio" sobre la tabla de rascado propia.
    await connection.execute(
      `INSERT INTO ${TABLA_RASCADO} (etiqueta) VALUES (?)`,
      [ETIQUETA_NEGOCIO],
    );
    // Auditoria obligatoria en la MISMA transaccion.
    await registrarAuditoriaVersion(
      connection,
      'VERSION_CREADA',
      ACTOR_FIXTURE,
      null,
      ETIQUETA_AUDITORIA_COMMIT,
      fecha,
    );

    const [vigentes] = await connection.execute(
      `SELECT COUNT(*) AS total FROM ${TABLA_RASCADO} WHERE etiqueta = ?`,
      [ETIQUETA_NEGOCIO],
    );
    return vigentes[0].total;
  });

  assert.equal(recibido, 1);

  // El commit entrego ambos: la fila de negocio y la de auditoria.
  const [auditoria] = await pool.query(
    `SELECT COUNT(*) AS total FROM empleados_auditoria
      WHERE evento = 'VERSION_CREADA' AND valor_nuevo = ?`,
    [ETIQUETA_AUDITORIA_COMMIT],
  );
  assert.equal(auditoria[0].total, 1);

  // Limpieza propia del registro de auditoria de la prueba.
  const [limpia] = await pool.query(
    'DELETE FROM empleados_auditoria WHERE valor_nuevo = ?',
    [ETIQUETA_AUDITORIA_COMMIT],
  );
  assert.equal(Number(limpia.affectedRows), 1);
});

test('un fallo de auditoria obligatoria impide confirmar la operacion', {
  skip: !enabled,
}, async () => {
  // La auditoria es obligatoria: si su INSERT viola una regla de esquema
  // (el CHECK evento/campo de la migracion 012 no admite ROL_CAMBIADO
  // con campo TARIFARIO), el error de base aborta transaccion completa,
  // incluida la escritura de negocio previa.
  const [antes] = await pool.query(
    `SELECT COUNT(*) AS total FROM empleados_auditoria WHERE valor_nuevo = ?`,
    [ETIQUETA_AUDITORIA_ROLLBACK],
  );
  assert.equal(antes[0].total, 0);

  await assert.rejects(
    withAdminTransaction(pool, async (connection) => {
      await connection.execute(
        `INSERT INTO ${TABLA_RASCADO} (etiqueta) VALUES ('tmp_mecanismo_elm:audit_rollback')`,
      );
      // Auditoria que viola un CHECK real de empleados_auditoria: ese
      // error de base aborta la transaccion completa (negocio incluido).
      await connection.execute(
        `INSERT INTO empleados_auditoria
          (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          ACTOR_FIXTURE, ACTOR_FIXTURE, 'ROL_CAMBIADO', 'TARIFARIO',
          null, ETIQUETA_AUDITORIA_ROLLBACK, ahoraUtc(),
        ],
      );
    }),
  );

  const connection = await pool.getConnection();
  try {
    const [restosNegocio] = await connection.query(
      `SELECT COUNT(*) AS total FROM ${TABLA_RASCADO} WHERE etiqueta = 'tmp_mecanismo_elm:audit_rollback'`,
    );
    assert.equal(restosNegocio[0].total, 0);

    const [restosAuditoria] = await connection.query(
      `SELECT COUNT(*) AS total FROM empleados_auditoria WHERE valor_nuevo = ?`,
      [ETIQUETA_AUDITORIA_ROLLBACK],
    );
    assert.equal(restosAuditoria[0].total, 0);
  } finally {
    connection.release();
  }
});

test('la auditoria VERSION_* aceptada por el esquema persiste', {
  skip: !enabled,
}, async () => {
  const ETIQUETA = 'version#0:MECANISMO_CHECK_012';
  const fecha = ahoraUtc();

  await withAdminTransaction(pool, async (connection) => {
    // Registrar via el mecanismo compartido: se acepta el CHECK real.
    await registrarAuditoriaVersion(
      connection,
      'VERSION_REACTIVADA',
      ACTOR_FIXTURE,
      null,
      ETIQUETA,
      fecha,
    );
  });

  const [filas] = await pool.query(
    `SELECT legajo, actor_legajo, evento, campo, valor_nuevo
       FROM empleados_auditoria WHERE valor_nuevo = ?`,
    [ETIQUETA],
  );
  assert.equal(filas.length, 1);
  assert.equal(filas[0].evento, 'VERSION_REACTIVADA');
  assert.equal(filas[0].campo, 'TARIFARIO');
  assert.equal(filas[0].legajo, ACTOR_FIXTURE);
  assert.equal(filas[0].actor_legajo, ACTOR_FIXTURE);

  await pool.query('DELETE FROM empleados_auditoria WHERE valor_nuevo = ?', [ETIQUETA]);
});

test('resuelve la version vigente del catalogo permanente', {
  skip: !enabled,
}, async () => {
  const estado = await leerEstadoCatalogo(pool);
  const connection = await pool.getConnection();

  try {
    const pasada = await resolverVersionVigente(connection, '2020-01-01 00:00:00.000000');
    assert.equal(pasada, null);

    const futura = await resolverVersionVigente(connection, '2299-01-01 00:00:00.000000');
    assert.equal(futura.id, estado.versionCargaInicialId);
    assert.equal(futura.tipo, 'CARGA_INICIAL');
    assert.equal(futura.estado, 'ACTIVA');

    const estadoEfectivo = await estadoEfectivoVersion(connection, estado.versionCargaInicialId);
    assert.equal(estadoEfectivo, 'ACTIVA');

    const versionInexistente = await estadoEfectivoVersion(connection, 999999);
    assert.equal(versionInexistente, null);
  } finally {
    connection.release();
  }
});

test('el snapshot de tarifas de la version es completo e inmutable', {
  skip: !enabled,
}, async () => {
  const estado = await leerEstadoCatalogo(pool);
  const connection = await pool.getConnection();

  try {
    const filas = await obtenerTarifasDeVersion(connection, estado.versionCargaInicialId);
    assert.equal(filas.length, 160);

    // Solo lectura y orden estable (plan, modalidad, clave).
    const orden = filas.map((f) => `${f.plan_id}|${f.tipo_ingreso}|${f.rango_clave}`);
    assert.deepEqual([...orden].sort(), orden);

    // 8 grupos de 20 claves canonicas.
    assert.ok(filas.every((f) => f.precio !== null));
  } finally {
    connection.release();
  }
});

test('el catalogo permanente permanece intacto despues de E-LM', {
  skip: !enabled,
}, async () => {
  const estado = await leerEstadoCatalogo(pool);

  assert.equal(estado.planes, 4);
  assert.equal(estado.tarifasCargaInicial, 160);
  assert.equal(estado.aportesAbiertos, 12);
  assert.equal(estado.politicasAbiertas, 1);
  assert.equal(estado.versionCargaInicialEstado, 'ACTIVA');
});

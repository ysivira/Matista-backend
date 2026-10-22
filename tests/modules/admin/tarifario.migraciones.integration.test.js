import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';

// Pruebas gated de las migraciones 013/014/015 contra matista_test:
// integridad del ciclo de vida (estados, fecha pendiente), garantias de
// exclusividad (uq_guard_*), auditoria (identidad snapshot, agrupador de
// aumento masivo, coherencia de valores) y concurrencia de la reserva de
// borrador. Ninguna prueba persiste datos: todo vive en transacciones con
// rollback propio. Requieren RUN_DB_TESTS=1 con NODE_ENV=test y
// DB_NAME=matista_test.
const enabled = process.env.RUN_DB_TESTS === '1';

let config;
let pool;
let actorLegajo;
let actorNombre;
let actorApellido;
let planId;
const marcadorCorrida = `tarifario-migraciones-${randomUUID()}`;

/** Prepara la conexion y obtiene las referencias exigidas por las FK. */
before(async () => {
  if (!enabled) {
    return;
  }

  config = loadDatabaseConfig(process.env, { purpose: 'migration' });
  assertTestDatabase(config);
  pool = createDatabasePool(config);
  await verifyDatabaseConnection(pool, 'matista_test');
  await runMigrations({
    pool,
    config,
    migrationsDirectory: new URL('../../../migrations', import.meta.url)
      .pathname,
  });

  // Administrador real de la base de prueba: la FK de auditoria exige un
  // legajo existente para cada evento.
  const [empleados] = await pool.query(
    `SELECT legajo, nombre, apellido
       FROM empleados
      WHERE rol = 'ADMIN'
      ORDER BY legajo
      LIMIT 1`,
  );
  assert.ok(empleados[0], 'matista_test necesita un administrador registrado');
  actorLegajo = empleados[0].legajo;
  actorNombre = empleados[0].nombre;
  actorApellido = empleados[0].apellido;

  // Plan real de la base de prueba: la FK de la auditoria exige un plan
  // existente cuando el evento porta entidad de fila o de plan.
  const [planes] = await pool.query(
    'SELECT id FROM planes ORDER BY id LIMIT 1',
  );
  assert.ok(planes[0], 'matista_test necesita el catalogo de planes cargado');
  planId = planes[0].id;
});

/** Cierra el pool sin realizar limpieza global sobre datos compartidos. */
after(async () => {
  if (pool) {
    await pool.end();
  }
});

/** Ejecuta `callback` con una conexion propia en transaccion y aplica
 *  rollback incondicional al final: garantiza que ninguna prueba deje datos.
 *
 *  - Parametros: `callback` recibe la conexion abierta y en transaccion.
 *  - Errores: lanza el error de MySQL a traves del `callback` fallido.
 */
async function conTransaccionAislada(callback) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await callback(connection);
  } finally {
    await connection.rollback();
    connection.release();
  }
}

/** Inserta una version de tarifario con los campos minimos del nuevo modelo.
 *
 *  - Parametros: `connection` en transaccion; `datos` sobrescribe los
 *    valores por defecto de las columnas relevantes.
 *  - Retorno: el insert no devuelve id útil bajo transaccion; las pruebas
 *    que lo necesitan insertan y releen dentro de la misma transaccion.
 */
async function insertarVersion(connection, datos = {}) {
  const valores = {
    tipo: 'EDICION_LISTA',
    estado: 'PREPARACION',
    fecha_activacion: null,
    actor_legajo: actorLegajo,
    ...datos,
    observacion: marcadorCorrida,
  };
  await connection.execute(
    `INSERT INTO tarifario_versiones
       (tipo, estado, fecha_activacion, observacion, actor_legajo, version_base_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      valores.tipo,
      valores.estado,
      valores.fecha_activacion,
      valores.observacion,
      valores.actor_legajo,
      valores.version_base_id ?? null,
    ],
  );
}

/** Inserta un evento de auditoria con la identidad snapshot completa.
 *
 *  - Parametros: `connection`, `versionId` destino y `datos` para
 *    sobrescribir los campos del evento.
 */
async function insertarEvento(connection, versionId, datos = {}) {
  const valores = {
    tipo_evento: 'CREACION',
    tipo_operacion: null,
    actor_legajo: actorLegajo,
    actor_nombre: actorNombre,
    actor_apellido: actorApellido,
    plan_id: null,
    tipo_ingreso: null,
    rango_clave: null,
    valor_anterior: null,
    valor_nuevo: null,
    ...datos,
    detalle: datos.detalle
      ? `${marcadorCorrida}: ${datos.detalle}`
      : marcadorCorrida,
  };
  const [resultado] = await connection.execute(
    `INSERT INTO tarifario_versiones_eventos
       (version_id, agrupador_id, tipo_evento, tipo_operacion, actor_legajo,
        actor_nombre, actor_apellido, plan_id, tipo_ingreso, rango_clave,
        valor_anterior, valor_nuevo, detalle)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionId,
      valores.agrupador_id ?? null,
      valores.tipo_evento,
      valores.tipo_operacion,
      valores.actor_legajo,
      valores.actor_nombre,
      valores.actor_apellido,
      valores.plan_id,
      valores.tipo_ingreso,
      valores.rango_clave,
      valores.valor_anterior,
      valores.valor_nuevo,
      valores.detalle,
    ],
  );
  return resultado.insertId;
}

test('las tres migraciones quedan registradas y las garantias existen', {
  skip: !enabled,
}, async () => {
  const [[{ versiones }]] = await pool.query(
    `SELECT COUNT(*) AS versiones
       FROM schema_migrations
      WHERE version IN ('013_ciclo_vida_versiones',
                        '014_auditoria_eventos_versiones',
                        '015_garantias_exclusividad_versiones')`,
  );
  assert.equal(versiones, 3);

  const [columnas] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, EXTRA, IS_NULLABLE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tarifario_versiones'
        AND COLUMN_NAME IN ('guard_activa', 'guard_borrador', 'fecha_activacion', 'revision')
       ORDER BY COLUMN_NAME`,
  );
  const porColumna = new Map(columnas.map((fila) => [fila.COLUMN_NAME, fila]));
  assert.match(porColumna.get('guard_activa').EXTRA, /GENERATED/);
  assert.match(porColumna.get('guard_borrador').EXTRA, /GENERATED/);
  assert.equal(porColumna.get('fecha_activacion').IS_NULLABLE, 'YES');
  assert.equal(porColumna.get('revision').COLUMN_TYPE, 'int unsigned');

  const [checks] = await pool.query(
    `SELECT CONSTRAINT_NAME
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tarifario_versiones'
        AND CONSTRAINT_TYPE = 'CHECK'`,
  );
  const nombresChecks = checks.map((fila) => fila.CONSTRAINT_NAME);
  for (const esperado of [
    'chk_tarifario_versiones_estado',
    'chk_tarifario_versiones_tipo',
    'chk_tarifario_versiones_estado_fecha',
  ]) {
    assert.ok(nombresChecks.includes(esperado), `falta ${esperado}`);
  }

  const [indices] = await pool.query(
    `SELECT DISTINCT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'tarifario_versiones'
        AND INDEX_NAME IN ('uq_guard_activa_version', 'uq_guard_borrador_version')`,
  );
  assert.equal(indices.length, 2);
});

test('el catalogo de estados admite el ciclo de vida y rechaza valores ajenos', {
  skip: !enabled,
}, async () => {
  await conTransaccionAislada(async (connection) => {
    await insertarVersion(connection, { estado: 'HISTORICA', fecha_activacion: '2026-01-01 00:00:00' });
    // Estado ajeno: el CHECK lo rechaza.
    await assert.rejects(
      () => insertarVersion(connection, { estado: 'BANDEJA' }),
      (error) => error.errno === 3819,
    );
    // Borrador con fecha informada: viola chk_tarifario_versiones_estado_fecha.
    await assert.rejects(
      () => insertarVersion(connection, { fecha_activacion: '2026-01-01 00:00:00' }),
      (error) => error.errno === 3819,
    );
  });
});

test('uq_guard_borrador impide dos borradores simultaneos por persistencia', {
  skip: !enabled,
}, async () => {
  await conTransaccionAislada(async (connection) => {
    await insertarVersion(connection, {});
    await assert.rejects(
      () => insertarVersion(connection, {}),
      (error) => error.errno === 1062,
    );
  });
});

test('uq_guard_activa impide una segunda version ACTIVA por persistencia', {
  skip: !enabled,
}, async () => {
  await conTransaccionAislada(async (connection) => {
    await assert.rejects(
      () => insertarVersion(connection, { estado: 'ACTIVA', fecha_activacion: '2026-01-01 00:00:00' }),
      (error) => error.errno === 1062,
    );
  });
});

test('la auditoria exige identidad snapshot, coherencia de entidad y de valores', {
  skip: !enabled,
}, async () => {
  await conTransaccionAislada(async (connection) => {
    await insertarVersion(connection, {});
    const [version] = await connection.execute(
      'SELECT id FROM tarifario_versiones WHERE observacion = ? ORDER BY id DESC',
      [marcadorCorrida],
    );
    const versionId = version[0].id;

    const eventoId = await insertarEvento(connection, versionId, {
      detalle: 'Creacion de la version de pruebas',
    });
    assert.ok(eventoId > 0);

    // La identidad del snapshot no puede quedar vacia.
    await assert.rejects(
      () => insertarEvento(connection, versionId, { actor_nombre: '  ' }),
      (error) => error.errno === 3819,
    );

    // El responsable es un legajo existente: FK activa.
    await assert.rejects(
      () => insertarEvento(connection, versionId, { actor_legajo: '9999999' }),
      (error) => error.errno === 1452,
    );

    // Operaciones de modificacion exigen operacion catalogada; los eventos
    // del ciclo de vida no pueden iniciar una operacion ni entidad.
    await assert.rejects(
      () => insertarEvento(connection, versionId, { tipo_evento: 'MODIFICACION' }),
      (error) => error.errno === 3819,
    );
    await assert.rejects(
      () => insertarEvento(connection, versionId, {
        tipo_operacion: 'AUMENTO_MASIVO',
        plan_id: planId,
        detalle: 'Agrupador no puede llevar entidad',
      }),
      (error) => error.errno === 3819,
    );

    // Modificacion de plan: entidad a nivel plan, sin alcance de fila.
    await assert.rejects(
      () => insertarEvento(connection, versionId, {
        tipo_evento: 'MODIFICACION',
        tipo_operacion: 'ALTA_PLAN',
        plan_id: planId,
        tipo_ingreso: 'Obligatorio',
        detalle: 'Alta de plan no lleva alcance de fila',
      }),
      (error) => error.errno === 3819,
    );
    await insertarEvento(connection, versionId, {
      tipo_evento: 'MODIFICACION',
      tipo_operacion: 'ALTA_PLAN',
      plan_id: planId,
      detalle: 'Incorporacion del plan a la version',
    });

    // PRECIO exige valor anterior y nuevo distintos, con entidad completa.
    await assert.rejects(
      () => insertarEvento(connection, versionId, {
        tipo_evento: 'MODIFICACION',
        tipo_operacion: 'PRECIO',
        plan_id: planId,
        tipo_ingreso: 'Obligatorio',
        rango_clave: '0-25',
        valor_anterior: 1000,
        valor_nuevo: 1000,
      }),
      (error) => error.errno === 3819,
    );

    // ALTA_FILA no puede traer valor anterior.
    await assert.rejects(
      () => insertarEvento(connection, versionId, {
        tipo_evento: 'MODIFICACION',
        tipo_operacion: 'ALTA_FILA',
        plan_id: planId,
        tipo_ingreso: 'Obligatorio',
        rango_clave: '0-25',
        valor_anterior: 1000,
        valor_nuevo: 1500,
      }),
      (error) => error.errno === 3819,
    );

    // Aumento masivo: agrupador de MODIFICACION sin entidad y filas hijas
    // ligadas con el detalle individual.
    const agrupadorId = await insertarEvento(connection, versionId, {
      tipo_evento: 'MODIFICACION',
      tipo_operacion: 'AUMENTO_MASIVO',
      detalle: 'Aumento masivo del 10% sobre la lista vigente',
    });
    const hija = await insertarEvento(connection, versionId, {
      tipo_evento: 'MODIFICACION',
      agrupador_id: agrupadorId,
      tipo_operacion: 'PRECIO',
      plan_id: planId,
      tipo_ingreso: 'Obligatorio',
      rango_clave: '0-25',
      valor_anterior: 1000,
      valor_nuevo: 1100,
      detalle: 'Fila 1 del aumento masivo',
    });
    assert.ok(hija > 0);
  });
});

test('la exclusividad de borrador se impone ante escrituras concurrentes', {
  skip: !enabled,
}, async () => {
  const connectionUno = await pool.getConnection();
  const connectionDos = await pool.getConnection();

  try {
    await connectionUno.beginTransaction();
    await connectionDos.query('SET SESSION innodb_lock_wait_timeout = 1');
    await connectionDos.beginTransaction();

    await insertarVersion(connectionUno, {});

    // Escritura concurrente: el segundo insert queda bloqueado por la
    // primera reserva sin confirmar y desemboca en timeout de esperas
    // (o rechazo por indice unico, segun el plan de ejecucion de InnoDB).
    await assert.rejects(
      () => insertarVersion(connectionDos, {}),
      (error) => error.errno === 1205 || error.errno === 1062,
    );
  } finally {
    await connectionDos.rollback();
    connectionDos.release();
    await connectionUno.rollback();
    connectionUno.release();
  }
});

test('la corrida queda sin versiones ni auditoria propias despues del rollback', {
  skip: !enabled,
}, async () => {
  const [[{ versiones }]] = await pool.query(
    'SELECT COUNT(*) AS versiones FROM tarifario_versiones WHERE observacion = ?',
    [marcadorCorrida],
  );
  const [[{ eventos }]] = await pool.query(
    'SELECT COUNT(*) AS eventos FROM tarifario_versiones_eventos WHERE detalle LIKE ?',
    [`${marcadorCorrida}%`],
  );
  assert.equal(versiones, 0);
  assert.equal(eventos, 0);
});

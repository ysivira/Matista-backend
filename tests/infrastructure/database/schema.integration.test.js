import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
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
import {
  runMigrations,
} from '../../../src/infrastructure/database/migration-runner.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');

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
});

after(async () => {
  if (pool) {
    await pool.end();
  }
});

test('crea exclusivamente las tablas AUTH y la tabla tecnica', {
  skip: !enabled,
}, async () => {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (
          'schema_migrations',
          'empleados',
          'empleados_correos',
          'auth_tokens',
          'auth_sesiones',
          'empleados_auditoria'
        )
      ORDER BY TABLE_NAME`,
    ['matista_test'],
  );

  assert.deepEqual(
    rows.map((row) => row.tableName),
    [
      'auth_sesiones',
      'auth_tokens',
      'empleados',
      'empleados_auditoria',
      'empleados_correos',
      'schema_migrations',
    ],
  );
});

test('crea las tablas ADMIN del tarifario y la tecnica en orden FK', {
  skip: !enabled,
}, async () => {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?`,
    ['matista_test'],
  );

  assert.deepEqual(
    rows.map((row) => row.tableName),
    [
      'auth_sesiones',
      'auth_tokens',
      'empleados',
      'empleados_auditoria',
      'empleados_correos',
      'monotributo_aportes',
      'planes',
      'politica_comercial',
      'schema_migrations',
      'tarifario_cancelaciones',
      'tarifario_versiones',
      'tarifario_versiones_eventos',
      'tarifas',
    ],
  );
});

test('expone las columnas generadas e indices UNIQUE aprobados', {
  skip: !enabled,
}, async () => {
  const [columns] = await pool.query(
    `SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName, EXTRA AS extra
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = 'matista_test'
        AND (
          (TABLE_NAME = 'empleados_correos'
            AND COLUMN_NAME IN (
              'actual_legajo', 'pendiente_legajo', 'email_reservado'
            ))
          OR
          (TABLE_NAME = 'auth_tokens'
            AND COLUMN_NAME = 'token_abierto_clave')
          OR
          (TABLE_NAME = 'politica_comercial'
            AND COLUMN_NAME = 'vigente_abierta')
          OR
          (TABLE_NAME = 'monotributo_aportes'
            AND COLUMN_NAME = 'categoria_abierta')
        )`,
  );
  const [indexes] = await pool.query(
    `SELECT INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = 'matista_test'
        AND INDEX_NAME IN (
          'uq_empleados_correos_actual',
          'uq_empleados_correos_pendiente',
          'uq_empleados_correos_reservado',
          'uq_auth_tokens_hash',
          'uq_auth_tokens_abierto',
          'uq_politica_comercial_abierta',
          'uq_monotributo_abierta'
        )`,
  );

  assert.equal(columns.length, 6);
  assert.ok(columns.every((column) => column.extra.includes('STORED GENERATED')));
  assert.equal(indexes.length, 7);
  assert.ok(indexes.every((index) => index.nonUnique === 0));
});

test('crea las claves foraneas y restricciones CHECK AUTH sin ofertas ADMIN', {
  skip: !enabled,
}, async () => {
  const [rows] = await pool.query(
    `SELECT CONSTRAINT_NAME AS constraintName,
            CONSTRAINT_TYPE AS constraintType
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = 'matista_test'
        AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')
        AND TABLE_NAME IN (
          'empleados',
          'empleados_correos',
          'auth_tokens',
          'auth_sesiones',
          'empleados_auditoria'
        )`,
  );
  const foreignKeys = rows
    .filter((row) => row.constraintType === 'FOREIGN KEY')
    .map((row) => row.constraintName)
    .sort();
  const checks = rows
    .filter((row) => row.constraintType === 'CHECK')
    .map((row) => row.constraintName)
    .sort();

  assert.deepEqual(foreignKeys, [
    'fk_auth_sesiones_empleado',
    'fk_auth_tokens_correo',
    'fk_auth_tokens_empleado',
    'fk_empleados_auditoria_actor',
    'fk_empleados_auditoria_objetivo',
    'fk_empleados_correos_empleado',
  ]);
  assert.deepEqual(checks, [
    'chk_auth_sesiones_expiracion',
    'chk_auth_sesiones_fecha_revocacion',
    'chk_auth_sesiones_revocacion',
    'chk_auth_tokens_consumo_revocacion',
    'chk_auth_tokens_correo',
    'chk_auth_tokens_expiracion',
    'chk_auth_tokens_fecha_consumo',
    'chk_auth_tokens_fecha_revocacion',
    'chk_auth_tokens_tipo',
    'chk_empleados_apellido',
    'chk_empleados_auditoria_evento_campo',
    'chk_empleados_auditoria_password',
    'chk_empleados_correos_estado',
    'chk_empleados_correos_fechas',
    'chk_empleados_estado',
    'chk_empleados_legajo',
    'chk_empleados_nombre',
    'chk_empleados_password',
    'chk_empleados_rol',
  ]);
});

test('crea las claves foraneas y restricciones CHECK ADMIN aprobadas', {
  skip: !enabled,
}, async () => {
  const [rows] = await pool.query(
    `SELECT TABLE_NAME AS tableName,
            CONSTRAINT_NAME AS constraintName,
            CONSTRAINT_TYPE AS constraintType
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = 'matista_test'
        AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')
        AND TABLE_NAME IN (
          'planes',
          'tarifario_versiones',
          'tarifario_versiones_eventos',
          'tarifario_cancelaciones',
          'tarifas',
          'politica_comercial',
          'monotributo_aportes'
        )`,
  );
  const foreignKeys = rows
    .filter((row) => row.constraintType === 'FOREIGN KEY')
    .map((row) => row.constraintName)
    .sort();
  const checks = rows
    .filter((row) => row.constraintType === 'CHECK')
    .map((row) => row.constraintName)
    .sort();

  assert.deepEqual(foreignKeys, [
    'fk_eventos_actor',
    'fk_eventos_agrupador',
    'fk_eventos_plan',
    'fk_eventos_version',
    'fk_monotributo_aportes_actor',
    'fk_politica_comercial_actor',
    'fk_tarifario_cancelaciones_cancelada_por',
    'fk_tarifario_cancelaciones_reactivada_por',
    'fk_tarifario_cancelaciones_version',
    'fk_tarifario_versiones_actor',
    'fk_tarifario_versiones_base',
    'fk_tarifario_versiones_plan',
    'fk_tarifario_versiones_revertida',
    'fk_tarifas_plan',
    'fk_tarifas_version',
  ]);
  assert.deepEqual(checks, [
    'chk_eventos_actor_apellido',
    'chk_eventos_actor_nombre',
    'chk_eventos_agrupador_cero',
    'chk_eventos_agrupador_fila',
    'chk_eventos_detalle',
    'chk_eventos_entidad_ciclo',
    'chk_eventos_entidad_fila',
    'chk_eventos_entidad_plan',
    'chk_eventos_operacion',
    'chk_eventos_operacion_modificacion',
    'chk_eventos_valores',
    'chk_monotributo_aporte',
    'chk_monotributo_categoria',
    'chk_monotributo_vigencia',
    'chk_planes_activa',
    'chk_planes_nombre',
    'chk_politica_afinidad',
    'chk_politica_aporte_reconocido',
    'chk_politica_comercial_fijo_max_pct',
    'chk_politica_comercial_fijo_meses',
    'chk_politica_escalonado_max_pct',
    'chk_politica_escalonado_total_meses',
    'chk_politica_escalonado_tramos',
    'chk_politica_joven',
    'chk_politica_primer_tramo_meses',
    'chk_politica_tdc_habilitado',
    'chk_politica_tdc_pct',
    'chk_politica_tope_bruto',
    'chk_politica_tope_comercial_tdc',
    'chk_politica_vigencia',
    'chk_tarifario_cancelaciones_motivo',
    'chk_tarifario_cancelaciones_reactivacion',
    'chk_tarifario_versiones_actor',
    'chk_tarifario_versiones_carga_inicial',
    'chk_tarifario_versiones_estado',
    'chk_tarifario_versiones_estado_fecha',
    'chk_tarifario_versiones_modalidad',
    'chk_tarifario_versiones_porcentaje',
    'chk_tarifario_versiones_tipo',
    'chk_tarifas_activa',
    'chk_tarifas_precio',
    'chk_tarifas_rango_clave',
    'chk_tarifas_rango_etario',
    'chk_tarifas_tipo_ingreso',
  ]);
});

test('aplica unicidad de correo, token abierto y auditoria de password', {
  skip: !enabled,
}, async () => {
  const connection = await pool.getConnection();
  const legajo = String(randomInt(10_000_000, 99_999_999));
  const email = `schema-${randomBytes(6).toString('hex')}@example.test`;

  try {
    await connection.beginTransaction();
    await connection.query(
      `INSERT INTO empleados (
         legajo, nombre, apellido, password_hash
       ) VALUES (?, 'Prueba', 'Persistencia', 'hash-no-real')`,
      [legajo],
    );
    const [emailResult] = await connection.query(
      `INSERT INTO empleados_correos (legajo, email, estado)
       VALUES (?, ?, 'PENDIENTE')`,
      [legajo, email],
    );

    await assert.rejects(
      connection.query(
        `INSERT INTO empleados_correos (legajo, email, estado)
         VALUES (?, ?, 'PENDIENTE')`,
        [legajo, `other-${email}`],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );

    await connection.query(
      `INSERT INTO auth_tokens (
         legajo, correo_id, tipo, token_hash, expires_at, created_at
       ) VALUES (
         ?, ?, 'VERIFICAR_EMAIL', ?,
         UTC_TIMESTAMP(6) - INTERVAL 1 HOUR,
         UTC_TIMESTAMP(6) - INTERVAL 2 HOUR
       )`,
      [legajo, emailResult.insertId, randomBytes(32)],
    );

    await assert.rejects(
      connection.query(
        `INSERT INTO auth_tokens (
           legajo, correo_id, tipo, token_hash, expires_at
         ) VALUES (
           ?, ?, 'VERIFICAR_EMAIL', ?,
           UTC_TIMESTAMP(6) + INTERVAL 1 HOUR
         )`,
        [legajo, emailResult.insertId, randomBytes(32)],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );

    await connection.query(
      `UPDATE auth_tokens
          SET revoked_at = UTC_TIMESTAMP(6)
        WHERE legajo = ?
          AND tipo = 'VERIFICAR_EMAIL'
          AND consumed_at IS NULL
          AND revoked_at IS NULL`,
      [legajo],
    );
    await connection.query(
      `INSERT INTO auth_tokens (
         legajo, correo_id, tipo, token_hash, expires_at
       ) VALUES (
         ?, ?, 'VERIFICAR_EMAIL', ?,
         UTC_TIMESTAMP(6) + INTERVAL 1 HOUR
       )`,
      [legajo, emailResult.insertId, randomBytes(32)],
    );

    await assert.rejects(
      connection.query(
        `INSERT INTO empleados_auditoria (
           legajo, actor_legajo, evento, campo,
           valor_anterior, valor_nuevo
         ) VALUES (
           ?, ?, 'PASSWORD_CAMBIADA', 'PASSWORD', 'hash-1', 'hash-2'
         )`,
        [legajo, legajo],
      ),
      (error) => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED',
    );
  } finally {
    await connection.rollback();
    connection.release();
  }
});

test('aplica el comportamiento ADMIN aprobado (unicidades, CHECK y evento TARIFARIO)', {
  skip: !enabled,
}, async () => {
  const connection = await pool.getConnection();
  const legajo = String(randomInt(10_000_000, 99_999_999));

  try {
    await connection.beginTransaction();

    // Empleado necesario para las FKs actor/plan desde ADMIN.
    await connection.query(
      `INSERT INTO empleados (
         legajo, nombre, apellido, password_hash
       ) VALUES (?, 'Prueba', 'Tarifario', 'hash-no-real')`,
      [legajo],
    );

    const [planResult] = await connection.query(
      `INSERT INTO planes (nombre) VALUES (?)`,
      [`Basico-${legajo}`],
    );

    // Timestamps fijos: la comparacion de unicidad debe ser determinista.
    // Modelo "copia completa" (013/015): un borrador PREPARACION con actor
    // obligatorio (CHECK de 007) y fecha pendiente; el guarda generada
    // impide un segundo borrador abierto.
    const [borradorResult] = await connection.query(
      `INSERT INTO tarifario_versiones (
         tipo, estado, actor_legajo, observacion
       ) VALUES ('EDICION_LISTA', 'PREPARACION', ?, 'borrador de prueba')`,
      [legajo],
    );
    assert.equal(Number(borradorResult.insertId) > 0, true);

    // La exclusividad de borrador es de persistencia: segundo PREPARACION
    // viola uq_guard_borrador_version sin banderas de la aplicacion.
    await assert.rejects(
      connection.query(
        `INSERT INTO tarifario_versiones (
           tipo, estado, actor_legajo, observacion
         ) VALUES ('EDICION_LISTA', 'PREPARACION', ?, 'borrador duplicado')`,
        [legajo],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );

    // Los tipos de la arquitectura anterior ya no pertenecen al ciclo:
    // el CHECK de tipo (013) rechaza el intento incoherente.
    await assert.rejects(
      connection.query(
        `INSERT INTO tarifario_versiones (
           tipo, fecha_activacion, observacion
         ) VALUES (
           'AUMENTO_MASIVO',
           UTC_TIMESTAMP(6) + INTERVAL 1 MINUTE,
           'incoherente'
         )`,
      ),
      (error) => error.code === 'ER_CHECK_CONSTRAINT_VIOLATED',
    );

    // Snapshot completo: la misma clave tarifaria dentro de una version es unica.
    const versionId = borradorResult.insertId;

    await connection.query(
      `INSERT INTO tarifas (
         version_id, plan_id, tipo_ingreso, rango_etario, rango_clave, precio
       ) VALUES (?, ?, 'Obligatorio', 'a partir de 66', '66+', 100.50)`,
      [versionId, planResult.insertId],
    );
    await assert.rejects(
      connection.query(
        `INSERT INTO tarifas (
           version_id, plan_id, tipo_ingreso, rango_etario, rango_clave, precio
         ) VALUES (?, ?, 'Obligatorio', 'otro', '66+', 200.00)`,
        [versionId, planResult.insertId],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );

    // La baja logica (activa=0) conserva la fila sin bloquear la version.
    await connection.query(
      `UPDATE tarifas SET activa = 0
        WHERE version_id = ? AND plan_id = ? AND tipo_ingreso = 'Obligatorio'`,
      [versionId, planResult.insertId],
    );

    // El evento TARIFARIO ampliado en E1 se acepta; la FK a versiones se aprobo para una etapa posterior.
    await connection.query(
      `INSERT INTO empleados_auditoria (
         legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo
       ) VALUES (?, ?, 'VERSION_CREADA', 'TARIFARIO', NULL, ?)`,
      [legajo, legajo, JSON.stringify({ version_id: versionId })],
    );

    // Fila abierta: el catalogo permanente de E2 ya contiene una politica
    // vigente, por lo que el intento agrega otra fila abierta se rechaza
    // (unic value indice con columna generada).
    await assert.rejects(
      connection.query(
        `INSERT INTO politica_comercial (
           porcentaje_aporte_reconocido, tope_sueldo_bruto, joven_porcentaje,
           comercial_fijo_max_pct, comercial_fijo_meses_max,
           comercial_escalonado_max_pct, comercial_escalonado_tramos_max,
           comercial_escalonado_total_meses_max, primer_tramo_50_meses_max,
           tdc_pct, tdc_habilitado, tope_comercial_tdc_pct,
           fecha_vigencia, actor_legajo
         ) VALUES (
           7.00, 4800000.00, 26.00,
           40.00, 12,
           50.00, 4,
           12, 3,
           5.00, 1, 55.00,
           UTC_TIMESTAMP(6), ?
         )`,
        [legajo],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
  } finally {
    // Las instalaciones de prueba no deben dejar rastros permanentes: rollback completo.
    await connection.rollback();
    connection.release();
  }
});

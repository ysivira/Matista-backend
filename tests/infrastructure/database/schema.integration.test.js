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

test('expone las columnas generadas e indices UNIQUE aprobados', {
  skip: !enabled,
}, async () => {
  const [columns] = await pool.query(
    `SELECT COLUMN_NAME AS columnName, EXTRA AS extra
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
          'uq_auth_tokens_abierto'
        )`,
  );

  assert.equal(columns.length, 4);
  assert.ok(columns.every((column) => column.extra.includes('STORED GENERATED')));
  assert.equal(indexes.length, 5);
  assert.ok(indexes.every((index) => index.nonUnique === 0));
});

test('crea todas las claves foraneas y restricciones CHECK aprobadas', {
  skip: !enabled,
}, async () => {
  const [rows] = await pool.query(
    `SELECT CONSTRAINT_NAME AS constraintName,
            CONSTRAINT_TYPE AS constraintType
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = 'matista_test'
        AND CONSTRAINT_TYPE IN ('FOREIGN KEY', 'CHECK')`,
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

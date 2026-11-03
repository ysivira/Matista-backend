/**
 * ============================================================
 * MATISTA | PRUEBAS DEL RUNNER SQL
 * ============================================================
 *
 * Archivo: migration-runner.test.js
 * Módulo: Pruebas de base de datos
 *
 * Responsabilidad:
 * Probar validación de SQL y clasificación del historial,
 * incluidos checksums y aplicaciones parciales, sin acceder a MySQL.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessMigrationState,
  assertMigrationTarget,
  MigrationStateError,
  validateMigrationDefinition,
} from '../../../src/infrastructure/database/migration-runner.js';

const migration = Object.freeze({
  version: '001_create_example',
  targetTable: 'example',
  checksum: 'checksum-1',
});

test('valida una migracion de una sola tabla con metadato explicito', () => {
  const result = validateMigrationDefinition(
    '001_create_example.sql',
    '-- matista:target-table example\nCREATE TABLE example (id INT);\n',
  );

  assert.equal(result.version, '001_create_example');
  assert.equal(result.targetTable, 'example');
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
});

test('rechaza SQL destructivo o mas de una sentencia', () => {
  assert.throws(
    () => validateMigrationDefinition(
      '001_create_example.sql',
      '-- matista:target-table example\nDROP TABLE example;',
    ),
    /operacion SQL no permitida/,
  );

  assert.throws(
    () => validateMigrationDefinition(
      '001_create_example.sql',
      '-- matista:target-table example\n'
      + 'CREATE TABLE example (id INT); CREATE TABLE other (id INT);',
    ),
    /exactamente un CREATE TABLE/,
  );
});

test('el runner solo admite las bases locales aprobadas', () => {
  assert.doesNotThrow(() => assertMigrationTarget({
    nodeEnv: 'development',
    database: 'matista_dev',
  }));
  assert.doesNotThrow(() => assertMigrationTarget({
    nodeEnv: 'test',
    database: 'matista_test',
  }));
  assert.doesNotThrow(() => assertMigrationTarget({
    nodeEnv: 'development',
    database: 'matista_local',
    host: '127.0.0.1',
  }));
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'production',
      database: 'matista_db',
    }),
    /solo admite development\/matista_dev, test\/matista_test o development\/matista_local/,
  );
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'test',
      database: 'sigec_test',
    }),
    /solo admite development\/matista_dev, test\/matista_test o development\/matista_local/,
  );
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'test',
      database: 'matista_local',
    }),
    /solo development\/matista_local/,
  );
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'production',
      database: 'matista_local',
    }),
    /solo development\/matista_local/,
  );
  assert.throws(() => assertMigrationTarget({
    nodeEnv: 'development', database: 'matista_local', host: 'remote.invalid',
  }), /loopback local/);
});

test('el runner rechaza production/matista_dev aunque la aplicacion admita ese nombre', () => {
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'production',
      database: 'matista_dev',
    }),
    /solo admite development\/matista_dev, test\/matista_test o development\/matista_local/,
  );
});

test('clasifica migraciones pendientes y aplicadas sin deriva', () => {
  const pending = assessMigrationState([migration], [], []);
  const applied = assessMigrationState(
    [migration],
    [{ version: migration.version, checksum: migration.checksum }],
    [migration.targetTable],
  );

  assert.deepEqual(pending.pending, [migration]);
  assert.deepEqual(applied.applied, [migration]);
});

test('detecta tabla creada sin registro de version como aplicacion parcial', () => {
  assert.throws(
    () => assessMigrationState([migration], [], [migration.targetTable]),
    (error) => error instanceof MigrationStateError
      && error.details.type === 'untracked-target'
      && error.details.targetTable === 'example',
  );
});

test('detecta version registrada sin su tabla objetivo', () => {
  assert.throws(
    () => assessMigrationState(
      [migration],
      [{ version: migration.version, checksum: migration.checksum }],
      [],
    ),
    (error) => error instanceof MigrationStateError
      && error.details.type === 'missing-target',
  );
});

test('detecta checksums modificados y versiones sin archivo', () => {
  assert.throws(
    () => assessMigrationState(
      [migration],
      [{ version: migration.version, checksum: 'different' }],
      [migration.targetTable],
    ),
    (error) => error instanceof MigrationStateError
      && error.details.type === 'checksum-mismatch',
  );

  assert.throws(
    () => assessMigrationState(
      [],
      [{ version: migration.version, checksum: migration.checksum }],
      [],
    ),
    (error) => error instanceof MigrationStateError
      && error.details.type === 'missing-file',
  );
});

// --- Contratos del tipo alter (E1 SPEC-03: ajustes de restricciones sobre tablas existentes) ---

const altera = Object.freeze({
  version: '012_alter_example',
  kind: 'alter',
  targetTable: 'example',
  checksum: 'checksum-alter',
});

test('admite una migracion alter y backfill sobre una unica tabla objetivo', () => {
  const result = validateMigrationDefinition(
    '012_alter_example.sql',
    '-- matista:target-table example\n'
    + '-- matista:kind: alter\n'
    + 'ALTER TABLE example DROP CHECK chk_example;\n'
    + 'UPDATE example SET id = id WHERE id > 0;\n'
    + 'ALTER TABLE example ADD CONSTRAINT chk_example CHECK (id > 0);\n',
  );

  assert.equal(result.kind, 'alter');
  assert.equal(result.version, '012_alter_example');
  assert.match(result.checksum, /^[a-f0-9]{64}$/);
  assert.equal(result.statements.length, 3);
});

test('rechaza alter sin ALTER TABLE o con CREATE TABLE', () => {
  assert.throws(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\nSELECT 1;\n',
    ),
    /solo admite ALTER TABLE y UPDATE de backfill/,
  );

  assert.throws(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\n'
      + 'CREATE TABLE example (id INT);\n',
    ),
    /solo admite ALTER TABLE y UPDATE de backfill/,
  );
});

test('rechaza backfill o alter sobre una tabla distinta de la declarada', () => {
  assert.throws(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\n'
      + 'ALTER TABLE example ADD COLUMN value INT;\n'
      + 'UPDATE other SET value = 1;\n',
    ),
    /sobre su tabla objetivo/,
  );

  assert.throws(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\n'
      + 'ALTER TABLE other ADD COLUMN value INT;\n',
    ),
    /sobre su tabla objetivo/,
  );
});

test('solo permite DROP CHECK, cualquier otro DROP es operacion no permitida', () => {
  assert.doesNotThrow(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\n'
      + 'ALTER TABLE example DROP CHECK chk_example;\n',
    ),
  );

  assert.throws(
    () => validateMigrationDefinition(
      '012_alter_example.sql',
      '-- matista:target-table example\n-- matista:kind: alter\n'
      + 'ALTER TABLE example DROP INDEX ix;\n',
    ),
    /operacion SQL no permitida/,
  );
});

test('un archivo create no acepta DROP ni dos sentencias', () => {
  assert.throws(
    () => validateMigrationDefinition(
      '001_create_example.sql',
      '-- matista:target-table example\n'
      + 'CREATE TABLE example (id INT); ALTER TABLE example DROP CHECK chk;\n',
    ),
    /exactamente un CREATE TABLE/,
  );
});

test('clasifica alter: tabla preexistente sin registro es pendiente, no aplicacion parcial', () => {
  const pendfd = assessMigrationState([altera], [], [altera.targetTable]);
  const aplicada = assessMigrationState(
    [altera],
    [{ version: altera.version, checksum: altera.checksum }],
    [altera.targetTable],
  );

  assert.deepEqual(pendfd.pending, [altera]);
  assert.deepEqual(aplicada.applied, [altera]);

  // El registro aplicado sin tabla sigue siendo condición de error también para alter.
  assert.throws(
    () => assessMigrationState(
      [altera],
      [{ version: altera.version, checksum: altera.checksum }],
      [],
    ),
    (error) => error instanceof MigrationStateError
      && error.details.type === 'missing-target',
  );
});

test('el tipo por defecto sigue siendo create para archivos sin directiva', () => {
  const create = validateMigrationDefinition(
    '005_create_example.sql',
    '-- matista:target-table example\nCREATE TABLE example (id INT);\n',
  );

  assert.equal(create.kind, 'create');
  assert.equal(create.statements.length, 1);
});

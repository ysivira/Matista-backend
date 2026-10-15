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
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'production',
      database: 'matista_db',
    }),
    /solo admite development\/matista_dev o test\/matista_test/,
  );
  assert.throws(
    () => assertMigrationTarget({
      nodeEnv: 'test',
      database: 'sigec_test',
    }),
    /solo admite development\/matista_dev o test\/matista_test/,
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

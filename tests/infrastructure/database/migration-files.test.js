import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
} from '../../../src/infrastructure/database/migration-runner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');
const bootstrapFile = path.resolve(
  currentDirectory,
  '../../../database/bootstrap/000_create_local_databases.sql',
);

test('el bootstrap solo declara matista_dev y matista_test', async () => {
  const bootstrap = await readFile(bootstrapFile, 'utf8');

  assert.match(bootstrap, /CREATE DATABASE IF NOT EXISTS matista_dev/);
  assert.match(bootstrap, /CREATE DATABASE IF NOT EXISTS matista_test/);
  assert.doesNotMatch(bootstrap, /matista_db/);
  assert.doesNotMatch(bootstrap, /sigec_db|sigec_test/);
});

test('las cinco migraciones AUTH son validas, ordenadas y no destructivas', async () => {
  const migrations = await loadMigrations(migrationsDirectory);

  assert.deepEqual(
    migrations.map((migration) => migration.targetTable),
    [
      'empleados',
      'empleados_correos',
      'auth_tokens',
      'auth_sesiones',
      'empleados_auditoria',
    ],
  );
});

test('la auditoria declara campo y prohibe valores para password', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const auditMigration = migrations.find(
    (migration) => migration.targetTable === 'empleados_auditoria',
  );

  assert.match(auditMigration.sql, /campo VARCHAR\(16\)/);
  assert.match(auditMigration.sql, /campo = 'PASSWORD'/);
  assert.match(
    auditMigration.sql,
    /valor_anterior IS NULL AND valor_nuevo IS NULL/,
  );
});

test('tokens y correos contienen las claves generadas aprobadas', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const tokens = migrations.find(
    (migration) => migration.targetTable === 'auth_tokens',
  );
  const emails = migrations.find(
    (migration) => migration.targetTable === 'empleados_correos',
  );

  assert.match(tokens.sql, /token_abierto_clave/);
  assert.match(tokens.sql, /uq_auth_tokens_abierto/);
  assert.match(emails.sql, /uq_empleados_correos_actual/);
  assert.match(emails.sql, /uq_empleados_correos_pendiente/);
  assert.match(emails.sql, /uq_empleados_correos_reservado/);
  assert.match(emails.sql, /idx_empleados_correos_login/);
});

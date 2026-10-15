import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';

function environment(overrides = {}) {
  return {
    NODE_ENV: 'development',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    DB_NAME: 'matista_dev',
    DB_USER: 'matista_app',
    DB_PASSWORD: '',
    DB_CONNECTION_LIMIT: '10',
    ...overrides,
  };
}

test('acepta matista_dev unicamente para development', () => {
  const config = loadDatabaseConfig(environment());

  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.database, 'matista_dev');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
});

test('acepta matista_test y habilita la guarda de pruebas', () => {
  const config = loadDatabaseConfig(environment({
    NODE_ENV: 'test',
    DB_NAME: 'matista_test',
  }));

  assert.doesNotThrow(() => assertTestDatabase(config));
});

test('rechaza bases SIGEC y nombres MATISTA que no correspondan al entorno', () => {
  for (const database of ['sigec_db', 'sigec_test', 'matista_test', 'matista_db']) {
    assert.throws(
      () => loadDatabaseConfig(environment({ DB_NAME: database })),
      /no corresponde/,
    );
  }
});

test('las migraciones locales rechazan matista_db', () => {
  assert.throws(
    () => loadDatabaseConfig(environment({
      NODE_ENV: 'production',
      DB_NAME: 'matista_db',
    }), { purpose: 'migration' }),
    /solo pueden ejecutarse sobre matista_dev o matista_test/,
  );
});

test('la guarda de pruebas rechaza cualquier base distinta de matista_test', () => {
  const developmentConfig = loadDatabaseConfig(environment());

  assert.throws(
    () => assertTestDatabase(developmentConfig),
    /requieren NODE_ENV=test y DB_NAME=matista_test/,
  );
});

test('requiere usuario, password declarado y valores numericos validos', () => {
  const withoutPassword = environment();
  delete withoutPassword.DB_PASSWORD;

  assert.throws(
    () => loadDatabaseConfig(withoutPassword),
    /DB_PASSWORD debe estar definida/,
  );
  assert.throws(
    () => loadDatabaseConfig(environment({ DB_USER: '' })),
    /DB_USER es obligatoria/,
  );
  assert.throws(
    () => loadDatabaseConfig(environment({ DB_PORT: 'invalid' })),
    /DB_PORT debe ser un entero/,
  );
});

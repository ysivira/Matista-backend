/**
 * ============================================================
 * MATISTA | PRUEBAS DE CONFIGURACIÓN MYSQL
 * ============================================================
 *
 * Archivo: config.test.js
 * Módulo: Pruebas de base de datos
 *
 * Responsabilidad:
 * Validar bases permitidas por entorno, guardas de pruebas y
 * variables obligatorias sin establecer conexiones reales.
 *
 * ============================================================
 */
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

test('acepta matista_dev para development', () => {
  const config = loadDatabaseConfig(environment());

  assert.equal(config.nodeEnv, 'development');
  assert.equal(config.database, 'matista_dev');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
});

test('acepta matista_dev en production solo para la aplicacion, incluido el proposito predeterminado', () => {
  const env = environment({ NODE_ENV: 'production' });
  for (const options of [undefined, { purpose: 'application' }]) {
    const config = loadDatabaseConfig(env, options);
    assert.equal(config.nodeEnv, 'production');
    assert.equal(config.database, 'matista_dev');
    assert.ok(Object.isFrozen(config));
  }
});

test('conserva matista_db como base admitida para la aplicacion en production', () => {
  const config = loadDatabaseConfig(environment({
    NODE_ENV: 'production',
    DB_NAME: 'matista_db',
  }));
  assert.equal(config.database, 'matista_db');
});

test('la excepcion de production/matista_dev no admite otros propositos', () => {
  for (const purpose of ['migration', 'other', null]) {
    assert.throws(
      () => loadDatabaseConfig(environment({ NODE_ENV: 'production' }), { purpose }),
      /no corresponde/,
    );
  }
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

test('la excepcion no autoriza otras bases en production ni matista_dev en test', () => {
  for (const database of ['sigec_db', 'sigec_test', 'matista_test', 'defaultdb']) {
    assert.throws(
      () => loadDatabaseConfig(environment({ NODE_ENV: 'production', DB_NAME: database })),
      /no corresponde/,
    );
  }
  assert.throws(
    () => loadDatabaseConfig(environment({ NODE_ENV: 'test' })),
    /no corresponde/,
  );
  assert.throws(
    () => loadDatabaseConfig(environment({ NODE_ENV: 'staging' })),
    /NODE_ENV/,
  );
});

test('las migraciones conservan los destinos development/matista_dev y test/matista_test', () => {
  for (const [nodeEnv, database] of [['development', 'matista_dev'], ['test', 'matista_test']]) {
    assert.doesNotThrow(() => loadDatabaseConfig(environment({
      NODE_ENV: nodeEnv,
      DB_NAME: database,
    }), { purpose: 'migration' }));
  }
});

test('acepta matista_local solo en development, para la aplicacion y las migraciones', () => {
  for (const purpose of [undefined, { purpose: 'application' }, { purpose: 'migration' }]) {
    const config = loadDatabaseConfig(environment({ DB_NAME: 'matista_local' }), purpose);
    assert.equal(config.database, 'matista_local');
    assert.equal(config.nodeEnv, 'development');
  }
});

test('rechaza matista_local en production y test', () => {
  for (const [nodeEnv, database] of [['production', 'matista_local'], ['test', 'matista_local']]) {
    assert.throws(
      () => loadDatabaseConfig(environment({ NODE_ENV: nodeEnv, DB_NAME: database })),
      /no corresponde/,
    );
  }
});

test('matista_local rechaza MySQL remoto y admite solamente loopback', () => {
  for (const host of ['localhost', '127.0.0.1', '::1']) {
    assert.doesNotThrow(() => loadDatabaseConfig(environment({ DB_NAME: 'matista_local', DB_HOST: host })));
  }
  assert.throws(() => loadDatabaseConfig(environment({
    DB_NAME: 'matista_local', DB_HOST: 'remote.invalid',
  })), /loopback local/);
});

test('las migraciones locales rechazan matista_db', () => {
  assert.throws(
    () => loadDatabaseConfig(environment({
      NODE_ENV: 'production',
      DB_NAME: 'matista_db',
    }), { purpose: 'migration' }),
    /solo pueden ejecutarse sobre matista_dev, matista_test o matista_local/,
  );
});

test('la guarda de pruebas rechaza cualquier base distinta de matista_test', () => {
  const developmentConfig = loadDatabaseConfig(environment());

  assert.throws(
    () => assertTestDatabase(developmentConfig),
    /requieren NODE_ENV=test y DB_NAME=matista_test/,
  );
});

test('la guarda de pruebas rechaza el alias de production y matista_dev incluso con entorno test', () => {
  const productionConfig = loadDatabaseConfig(environment({ NODE_ENV: 'production' }));
  for (const config of [productionConfig, { ...productionConfig, nodeEnv: 'test' }]) {
    assert.throws(
      () => assertTestDatabase(config),
      /requieren NODE_ENV=test y DB_NAME=matista_test/,
    );
  }
});

test('el alias de production conserva las validaciones de variables obligatorias y rangos', () => {
  const env = environment({ NODE_ENV: 'production' });
  const withoutPassword = { ...env };
  delete withoutPassword.DB_PASSWORD;
  assert.throws(() => loadDatabaseConfig(withoutPassword), /DB_PASSWORD debe estar definida/);
  for (const [overrides, expected] of [
    [{ DB_NAME: '' }, /DB_NAME es obligatoria/],
    [{ DB_USER: '' }, /DB_USER es obligatoria/],
    [{ DB_PASSWORD: undefined }, /DB_PASSWORD debe estar definida/],
    [{ DB_PORT: 'invalid' }, /DB_PORT debe ser un entero/],
    [{ DB_PORT: '0' }, /DB_PORT debe ser un entero/],
    [{ DB_PORT: '65536' }, /DB_PORT debe ser un entero/],
    [{ DB_CONNECTION_LIMIT: '0' }, /DB_CONNECTION_LIMIT debe ser un entero/],
    [{ DB_CONNECTION_LIMIT: '101' }, /DB_CONNECTION_LIMIT debe ser un entero/],
  ]) {
    assert.throws(() => loadDatabaseConfig({ ...env, ...overrides }), expected);
  }
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

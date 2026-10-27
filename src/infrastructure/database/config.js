/**
 * Valida la configuración MySQL y restringe las bases por entorno.
 */
const DATABASE_BY_ENV = Object.freeze({
  development: 'matista_dev',
  test: 'matista_test',
  production: 'matista_db'
});

const MIGRATION_DATABASES = new Set(['matista_dev', 'matista_test']);

/** Exige una variable de entorno presente y no vacía; recorta y devuelve su valor. */
function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`La variable de entorno ${name} es obligatoria.`);
  }
  return value.trim();
}

/** Valida que el valor sea entero dentro del rango indicado; lanza error descriptivo si no. */
function parseInteger(value, name, { min, max }) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} debe ser un entero entre ${min} y ${max}.`);
  }
  return parsed;
}

/**
 * Resuelve el nombre de base de datos autorizado para el entorno dado.
 * @param {string} nodeEnv Valor de NODE_ENV (development, test o production).
 * @returns {string} Nombre de base correspondiente.
 * @throws {Error} Si el entorno no está reconocido.
 */
export function expectedDatabaseFor(nodeEnv) {
  const databaseName = DATABASE_BY_ENV[nodeEnv];
  if (!databaseName) {
    throw new Error('NODE_ENV debe ser development, test o production para usar MySQL.');
  }
  return databaseName;
}

/**
 * Lee y valida la configuración completa de MySQL desde variables de entorno.
 * La coherencia NODE_ENV/DB_NAME es obligatoria para evitar apuntar la
 * aplicación o las migraciones a una base no autorizada.
 * @param {object} env Entorno del proceso (por defecto process.env).
 * @param {object} [options] Con purpose='migration' restringe las bases permitidas.
 * @returns {object} Configuración congelada del pool (host, puerto, base, credenciales y límite).
 * @throws {Error} Si falta una variable obligatoria o la base no corresponde al entorno.
 */
export function loadDatabaseConfig(env = process.env, { purpose = 'application' } = {}) {
  const nodeEnv = requireValue(env, 'NODE_ENV');
  const database = requireValue(env, 'DB_NAME');
  const expectedDatabase = expectedDatabaseFor(nodeEnv);
  if (database !== expectedDatabase) {
    throw new Error(
      `DB_NAME=${database} no corresponde a NODE_ENV=${nodeEnv}; ` +
        `se esperaba ${expectedDatabase}.`
    );
  }
  if (purpose === 'migration' && !MIGRATION_DATABASES.has(database)) {
    throw new Error(
      `Las migraciones locales solo pueden ejecutarse sobre matista_dev o ` +
        `matista_test; se recibio ${database}.`
    );
  }
  const passwordDefined = Object.hasOwn(env, 'DB_PASSWORD') && typeof env.DB_PASSWORD === 'string';
  if (!passwordDefined) {
    throw new Error('La variable de entorno DB_PASSWORD debe estar definida.');
  }
  return Object.freeze({
    nodeEnv,
    host: env.DB_HOST?.trim() || '127.0.0.1',
    port: parseInteger(env.DB_PORT || '3306', 'DB_PORT', {
      min: 1,
      max: 65535
    }),
    database,
    user: requireValue(env, 'DB_USER'),
    password: env.DB_PASSWORD,
    connectionLimit: parseInteger(env.DB_CONNECTION_LIMIT || '10', 'DB_CONNECTION_LIMIT', {
      min: 1,
      max: 100
    })
  });
}

/**
 * Exige que la configuración corresponda al entorno de pruebas.
 * @param {object} config Configuración producida por loadDatabaseConfig.
 * @returns {void}
 * @throws {Error} Si NODE_ENV o DB_NAME no son test/matista_test.
 */
export function assertTestDatabase(config) {
  if (config.nodeEnv !== 'test' || config.database !== 'matista_test') {
    throw new Error(
      'Las pruebas de persistencia requieren NODE_ENV=test y ' + 'DB_NAME=matista_test.'
    );
  }
}

// Base de SIGEC: unica fuente de lectura autorizada para la carga inicial (E2).
const SIGEC_DATABASE = 'sigec_db';

// Lee la configuracion de solo lectura de SIGEC desde variables SIGEC_DB_*;
// lanza error si falta alguna. Nunca debe usarse para escritura.
export function loadSigecSourceConfig(env = process.env) {
  const database = env.SIGEC_DB_DATABASE?.trim() || SIGEC_DATABASE;
  if (database !== SIGEC_DATABASE) {
    throw new Error(
      `La fuente SIGEC solo puede apuntar a ${SIGEC_DATABASE}; ` + `se recibio ${database}.`
    );
  }
  const user = requireValue(env, 'SIGEC_DB_USER');
  if (!Object.hasOwn(env, 'SIGEC_DB_PASSWORD') || typeof env.SIGEC_DB_PASSWORD !== 'string') {
    throw new Error('La variable de entorno SIGEC_DB_PASSWORD debe estar definida.');
  }
  return Object.freeze({
    host: env.SIGEC_DB_HOST?.trim() || '127.0.0.1',
    port: parseInteger(env.SIGEC_DB_PORT || '3306', 'SIGEC_DB_PORT', {
      min: 1,
      max: 65535
    }),
    database,
    user,
    password: env.SIGEC_DB_PASSWORD
  });
}

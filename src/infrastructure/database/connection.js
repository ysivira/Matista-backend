/**
 * Crea el pool MySQL y comprueba la base seleccionada.
 */
import mysql from 'mysql2/promise';
import { loadDatabaseConfig } from './config.js';

/**
 * Crea el pool MySQL compartido con zona horaria UTC y sentencias múltiples desactivadas.
 * @param {object} [config] Configuración de loadDatabaseConfig; se calcula por defecto.
 * @returns {object} Pool mysql2 con conexiones en cola y keep-alive.
 */
export function createDatabasePool(config = loadDatabaseConfig()) {
  return mysql.createPool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionLimit: config.connectionLimit,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    timezone: 'Z',
    multipleStatements: false
  });
}

/**
 * Verifica la conexión fijando UTC y comprobando la base seleccionada.
 * @param {object} Pool del que se toma una conexión y se libera al final.
 * @param {string} expectedDatabase Nombre de base que debe reportar DATABASE().
 * @returns {Promise<object>} Nombre real de base y versión del servidor, congelados.
 * @throws {Error} Si la base seleccionada difiere de la esperada o falla la conexión.
 */
export async function verifyDatabaseConnection(pool, expectedDatabase) {
  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [rows] = await connection.query(
      'SELECT DATABASE() AS databaseName, VERSION() AS version'
    );
    const databaseName = rows[0]?.databaseName;
    if (databaseName !== expectedDatabase) {
      throw new Error(
        `La conexion selecciono ${databaseName ?? 'ninguna base'}; ` +
          `se esperaba ${expectedDatabase}.`
      );
    }
    return Object.freeze({
      databaseName,
      version: rows[0].version
    });
  } finally {
    connection.release();
  }
}

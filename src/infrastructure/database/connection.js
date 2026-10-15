import mysql from 'mysql2/promise';

import { loadDatabaseConfig } from './config.js';

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
    multipleStatements: false,
  });
}

export async function verifyDatabaseConnection(pool, expectedDatabase) {
  const connection = await pool.getConnection();

  try {
    await connection.query("SET time_zone = '+00:00'");
    const [rows] = await connection.query(
      'SELECT DATABASE() AS databaseName, VERSION() AS version',
    );
    const databaseName = rows[0]?.databaseName;

    if (databaseName !== expectedDatabase) {
      throw new Error(
        `La conexion selecciono ${databaseName ?? 'ninguna base'}; `
        + `se esperaba ${expectedDatabase}.`,
      );
    }

    return Object.freeze({
      databaseName,
      version: rows[0].version,
    });
  } finally {
    connection.release();
  }
}

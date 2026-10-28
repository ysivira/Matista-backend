/**
 * ============================================================
 * MATISTA | VERIFICACIÓN DE CONEXIÓN
 * ============================================================
 *
 * Archivo: check-database.js
 * Módulo: Mantenimiento
 *
 * Responsabilidad:
 * Comprobar la conexión y la identidad de la base configurada,
 * informar su versión y cerrar el pool al finalizar.
 *
 * ============================================================
 */
import 'dotenv/config';
import {
  createDatabasePool,
  verifyDatabaseConnection
} from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  const result = await verifyDatabaseConnection(pool, config.database);
  console.log(`Conexion verificada: ${result.databaseName} (MySQL ${result.version}).`);
} finally {
  await pool.end();
}

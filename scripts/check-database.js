import 'dotenv/config';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  const result = await verifyDatabaseConnection(pool, config.database);
  console.log(
    `Conexion verificada: ${result.databaseName} (MySQL ${result.version}).`,
  );
} finally {
  await pool.end();
}

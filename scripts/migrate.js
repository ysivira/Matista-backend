import 'dotenv/config';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabasePool } from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';
import { runMigrations } from '../src/infrastructure/database/migration-runner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../migrations');
const config = loadDatabaseConfig(process.env, { purpose: 'migration' });
const pool = createDatabasePool(config);

try {
  const result = await runMigrations({
    pool,
    config,
    migrationsDirectory,
  });

  console.log(`Base validada: ${config.database}.`);
  console.log(`Migraciones aplicadas: ${result.applied.join(', ') || 'ninguna'}.`);
  console.log(`Migraciones omitidas: ${result.skipped.join(', ') || 'ninguna'}.`);
} finally {
  await pool.end();
}

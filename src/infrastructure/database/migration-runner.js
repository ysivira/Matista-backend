import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MIGRATION_FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;
const TARGET_TABLE_PATTERN = /^-- matista:target-table ([a-z0-9_]+)$/m;
const FORBIDDEN_SQL_PATTERN = /\b(USE|DROP|CREATE\s+DATABASE|ALTER\s+USER|CREATE\s+USER|GRANT|REVOKE)\b/i;
const LOCAL_MIGRATION_TARGETS = new Map([
  ['development', 'matista_dev'],
  ['test', 'matista_test'],
]);

const SCHEMA_MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100)
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    checksum CHAR(64)
      CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    applied_at DATETIME(6)
      NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (version)
  ) ENGINE = InnoDB
    DEFAULT CHARACTER SET utf8mb4
    COLLATE utf8mb4_0900_ai_ci
`;

export class MigrationStateError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MigrationStateError';
    this.details = details;
  }
}

export function assertMigrationTarget(config) {
  const expectedDatabase = LOCAL_MIGRATION_TARGETS.get(config.nodeEnv);

  if (!expectedDatabase || config.database !== expectedDatabase) {
    throw new Error(
      'El runner solo admite development/matista_dev o test/matista_test.',
    );
  }
}

function executableStatements(sql) {
  const withoutLineComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();

  return withoutLineComments
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export function validateMigrationDefinition(fileName, sql) {
  const fileMatch = fileName.match(MIGRATION_FILE_PATTERN);

  if (!fileMatch) {
    throw new Error(
      `Nombre de migracion invalido: ${fileName}. `
      + 'Se esperaba NNN_nombre.sql.',
    );
  }

  const targetMatch = sql.match(TARGET_TABLE_PATTERN);

  if (!targetMatch) {
    throw new Error(
      `${fileName} debe declarar -- matista:target-table <tabla>.`,
    );
  }

  if (FORBIDDEN_SQL_PATTERN.test(sql)) {
    throw new Error(`${fileName} contiene una operacion SQL no permitida.`);
  }

  const statements = executableStatements(sql);

  if (statements.length !== 1 || !/^CREATE\s+TABLE\b/i.test(statements[0])) {
    throw new Error(
      `${fileName} debe contener exactamente un CREATE TABLE.`,
    );
  }

  const version = `${fileMatch[1]}_${fileMatch[2]}`;

  return Object.freeze({
    fileName,
    version,
    targetTable: targetMatch[1],
    checksum: createHash('sha256').update(sql).digest('hex'),
    sql: `${statements[0]};`,
  });
}

export async function loadMigrations(migrationsDirectory) {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
  const migrations = [];

  for (const fileName of fileNames) {
    const sql = await readFile(path.join(migrationsDirectory, fileName), 'utf8');
    migrations.push(validateMigrationDefinition(fileName, sql));
  }

  const versions = new Set();
  const targets = new Set();

  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new Error(`Version de migracion duplicada: ${migration.version}.`);
    }

    if (targets.has(migration.targetTable)) {
      throw new Error(
        `Tabla objetivo duplicada en migraciones iniciales: `
        + `${migration.targetTable}.`,
      );
    }

    versions.add(migration.version);
    targets.add(migration.targetTable);
  }

  return migrations;
}

export function assessMigrationState(
  migrations,
  appliedMigrations,
  existingTables,
) {
  const migrationsByVersion = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  const appliedByVersion = new Map(
    appliedMigrations.map((migration) => [migration.version, migration]),
  );
  const tables = new Set(existingTables);

  for (const applied of appliedMigrations) {
    if (!migrationsByVersion.has(applied.version)) {
      throw new MigrationStateError(
        `La version aplicada ${applied.version} no existe en el repositorio.`,
        { type: 'missing-file', version: applied.version },
      );
    }
  }

  const pending = [];
  const applied = [];

  for (const migration of migrations) {
    const record = appliedByVersion.get(migration.version);
    const tableExists = tables.has(migration.targetTable);

    if (record && record.checksum !== migration.checksum) {
      throw new MigrationStateError(
        `El checksum de ${migration.version} no coincide con el registrado.`,
        { type: 'checksum-mismatch', version: migration.version },
      );
    }

    if (record && !tableExists) {
      throw new MigrationStateError(
        `La version ${migration.version} figura aplicada, pero falta la tabla `
        + `${migration.targetTable}.`,
        {
          type: 'missing-target',
          version: migration.version,
          targetTable: migration.targetTable,
        },
      );
    }

    if (!record && tableExists) {
      throw new MigrationStateError(
        `Aplicacion parcial detectada: existe la tabla `
        + `${migration.targetTable}, pero no la version ${migration.version}.`,
        {
          type: 'untracked-target',
          version: migration.version,
          targetTable: migration.targetTable,
        },
      );
    }

    if (record) {
      applied.push(migration);
    } else {
      pending.push(migration);
    }
  }

  return Object.freeze({ applied, pending });
}

async function readAppliedMigrations(connection) {
  const [rows] = await connection.query(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return rows;
}

async function readExistingTargetTables(connection, database, migrations) {
  if (migrations.length === 0) {
    return [];
  }

  const targetTables = migrations.map((migration) => migration.targetTable);
  const placeholders = targetTables.map(() => '?').join(', ');
  const [rows] = await connection.query(
    `SELECT TABLE_NAME AS tableName
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME IN (${placeholders})`,
    [database, ...targetTables],
  );

  return rows.map((row) => row.tableName);
}

export async function runMigrations({ pool, config, migrationsDirectory }) {
  assertMigrationTarget(config);
  const migrations = await loadMigrations(migrationsDirectory);
  const connection = await pool.getConnection();
  const lockName = `matista:migrations:${config.database}`;
  let lockAcquired = false;

  try {
    const [databaseRows] = await connection.query(
      'SELECT DATABASE() AS databaseName',
    );
    const selectedDatabase = databaseRows[0]?.databaseName;

    if (selectedDatabase !== config.database) {
      throw new Error(
        `La conexion selecciono ${selectedDatabase ?? 'ninguna base'}; `
        + `se esperaba ${config.database}.`,
      );
    }

    const [lockRows] = await connection.query(
      'SELECT GET_LOCK(?, 10) AS acquired',
      [lockName],
    );

    if (lockRows[0]?.acquired !== 1) {
      throw new Error(`No se pudo adquirir el lock de migraciones ${lockName}.`);
    }

    lockAcquired = true;
    await connection.query(SCHEMA_MIGRATIONS_SQL);

    const appliedMigrations = await readAppliedMigrations(connection);
    const existingTables = await readExistingTargetTables(
      connection,
      config.database,
      migrations,
    );
    const state = assessMigrationState(
      migrations,
      appliedMigrations,
      existingTables,
    );
    const newlyApplied = [];

    for (const migration of state.pending) {
      await connection.query(migration.sql);

      try {
        await connection.query(
          `INSERT INTO schema_migrations (version, checksum)
           VALUES (?, ?)`,
          [migration.version, migration.checksum],
        );
      } catch (error) {
        throw new MigrationStateError(
          `La tabla ${migration.targetTable} fue creada, pero no se pudo `
          + `registrar ${migration.version}. La siguiente ejecucion se `
          + 'detendra para diagnostico.',
          {
            type: 'version-registration-failed',
            version: migration.version,
            targetTable: migration.targetTable,
            cause: error,
          },
        );
      }

      newlyApplied.push(migration.version);
    }

    return Object.freeze({
      applied: newlyApplied,
      skipped: state.applied.map((migration) => migration.version),
    });
  } finally {
    try {
      if (lockAcquired) {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]);
      }
    } finally {
      connection.release();
    }
  }
}

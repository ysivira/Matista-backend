/** SPEC-08: MySQL local real con escrituras confinadas a tablas TEMPORARY de una sesión. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDatabaseConfig, assertTestDatabase } from '../../src/infrastructure/database/config.js';
import { createDatabasePool } from '../../src/infrastructure/database/connection.js';
import { loadMigrations, assessMigrationState } from '../../src/infrastructure/database/migration-runner.js';

export const temporaryTables = Object.freeze(['empleados', 'empleados_correos', 'auth_sesiones', 'planes',
  'tarifario_versiones', 'tarifas', 'politica_comercial', 'porcentajes_comerciales',
  'politica_comercial_eventos', 'clientes', 'cotizaciones', 'miembros_cotizacion', 'asesor_auditoria']);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function localTestPool() {
  assert.equal(process.env.DB_SSL, 'false');
  const config = loadDatabaseConfig();
  assertTestDatabase(config);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
  assert.ok(config.connectionLimit >= 2, 'La sesión de control debe ser independiente');
  return createDatabasePool(config);
}

/** Solo lecturas de la conexión de control, sin sombras temporales ni activadores ADMIN. */
export async function permanentSnapshot(pool) {
  const c = await pool.getConnection();
  try {
    const [[identity]] = await c.query('SELECT DATABASE() AS db, VERSION() AS version, @@hostname AS hostname, @@port AS port, CONNECTION_ID() AS connectionId');
    assert.equal(identity.db, 'matista_test');
    assert.equal(identity.hostname, hostname());
    assert.equal(Number(identity.port), 3306);
    await c.query('START TRANSACTION READ ONLY');
    const [tables] = await c.execute('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', ['matista_test']);
    assert.equal(tables.length, 19);
    const fingerprint = [];
    for (const { name } of tables) {
      assert.match(name, /^[a-z_]+$/);
      const [columns] = await c.execute('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['matista_test', name]);
      const fields = columns.map(column => ['datetime', 'timestamp', 'date'].includes(column.type)
        ? `CAST(\`${column.name}\` AS CHAR) AS \`${column.name}\`` : `\`${column.name}\``).join(',');
      const [rows] = await c.query(`SELECT ${fields} FROM \`${name}\` ORDER BY 1`);
      const [[ddl]] = await c.query(`SHOW CREATE TABLE \`${name}\``);
      fingerprint.push({ table: name, count: rows.length, contentSha256: sha256(JSON.stringify(rows)), schemaSha256: sha256(ddl['Create Table']) });
    }
    await c.rollback();
    return { identity, fingerprint };
  } finally { c.release(); }
}

/** Copia únicamente catálogo comercial; no identidades ni cotizaciones permanentes. */
export async function commercialSeed(pool) {
  const c = await pool.getConnection();
  try {
    await c.query('START TRANSACTION READ ONLY');
    const [applied] = await c.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const migrations = await loadMigrations(new URL('../../migrations/', import.meta.url).pathname);
    const [tables] = await c.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', ['matista_test']);
    assert.equal(assessMigrationState(migrations, applied, tables.map(row => row.name)).pending.length, 0);
    const [pending] = await c.query("SELECT id FROM politica_comercial WHERE estado='PROGRAMADA'");
    assert.equal(pending.length, 0, 'Detener: revisar programación compartida antes de continuar');
    const [versions] = await c.query("SELECT * FROM tarifario_versiones WHERE estado IN ('ACTIVA','HISTORICA') AND fecha_activacion<=UTC_TIMESTAMP(6) ORDER BY fecha_activacion DESC,id DESC LIMIT 1");
    const [policies] = await c.query("SELECT * FROM politica_comercial WHERE estado='VIGENTE'");
    assert.equal(versions.length, 1); assert.equal(policies.length, 1);
    const [plans] = await c.query('SELECT * FROM planes WHERE activa=1 ORDER BY id');
    const [rates] = await c.execute('SELECT * FROM tarifas WHERE version_id=? ORDER BY id', [versions[0].id]);
    const [percentages] = await c.execute('SELECT * FROM porcentajes_comerciales WHERE politica_comercial_id=? ORDER BY id', [policies[0].id]);
    const seed = { planes: plans, tarifario_versiones: versions, tarifas: rates, politica_comercial: policies, porcentajes_comerciales: percentages };
    const definitions = [];
    for (const table of temporaryTables) {
      const [[row]] = await c.query(`SHOW CREATE TABLE \`${table}\``);
      const [columns] = await c.execute('SELECT COLUMN_NAME AS name, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['matista_test', table]);
      definitions.push({ table, original: row['Create Table'], columns });
    }
    await c.rollback();
    return { seed, definitions, applied };
  } finally { c.release(); }
}

/** La fachada NO reescribe consultas productivas ni sustituye resultados SQL. */
export async function temporarySession(pool, commercial, observation, directory) {
  const c = await pool.getConnection();
  try {
    const [[identity]] = await c.query('SELECT DATABASE() AS db, CONNECTION_ID() AS connectionId');
    assert.equal(identity.db, 'matista_test');
    const definitions = [];
    for (const definition of commercial.definitions) {
      const removedForeignKeys = definition.original.split('\n').filter(line => /^\s+CONSTRAINT\s+`fk_/i.test(line));
      const sql = definition.original.replace(/^CREATE TABLE /i, 'CREATE TEMPORARY TABLE ')
        .split('\n').filter(line => !/^\s+CONSTRAINT\s+`fk_/i.test(line)).join('\n').replace(/,(\s*\n\))/, '$1');
      assert.ok(sql.startsWith(`CREATE TEMPORARY TABLE \`${definition.table}\``));
      await c.query(sql);
      const [[created]] = await c.query(`SHOW CREATE TABLE \`${definition.table}\``);
      assert.match(created['Create Table'], /^CREATE TEMPORARY TABLE/);
      const checks = definition.original.match(/CONSTRAINT `[^`]+` CHECK/g) ?? [];
      for (const check of checks) assert.ok(created['Create Table'].includes(check));
      definitions.push({ table: definition.table, sql, removedForeignKeys, checksPreserved: checks.length, created: created['Create Table'] });
    }
    await writeFile(path.join(directory, 'aislamiento.json'), JSON.stringify({ identity, definitions, limitation: 'MySQL TEMPORARY no admite FKs; CHECK, columnas e índices conservados. Ningún DDL permanente.' }, null, 2) + '\n', { mode: 0o600 });
    let closed = false;
    const allowed = new Set(temporaryTables);
    async function run(method, sql, parameters = []) {
      assert.equal(closed, false);
      assert.ok(!sql.includes(';'), 'Sin sentencias múltiples');
      if (sql !== "SET time_zone = '+00:00'") {
        assert.match(sql.trim(), /^(SELECT|INSERT INTO|UPDATE|DELETE FROM)\b/i);
        const targets = [...sql.replaceAll('`', '').matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][\w.]*)/gi)].map(match => match[1]);
        assert.ok(targets.length > 0, 'SQL sin tabla prevista');
        for (const table of targets) assert.ok(allowed.has(table), `Acceso fuera de las tablas temporales: ${table}`);
      }
      const sensitive = /password|jti|empleados_correos|INSERT INTO clientes/i.test(sql);
      const params = sensitive ? ['[PARÁMETROS PRIVADOS OMITIDOS]'] : parameters;
      try {
        const result = await c[method](sql, parameters);
        observation.record('mysql-temporary', { connectionId: identity.connectionId, sql, parameters: params,
          rows: result[0] });
        return result;
      } catch (error) {
        observation.record('mysql-temporary-error', { sql, parameters: params, code: error.code });
        throw error;
      }
    }
    const facade = {
      query: (sql, params) => run('query', sql, params),
      execute: (sql, params) => run('execute', sql, params),
      async beginTransaction() { await c.beginTransaction(); observation.record('transaction', { event: 'begin', connectionId: identity.connectionId }); },
      async commit() { await c.commit(); observation.record('transaction', { event: 'commit', connectionId: identity.connectionId }); },
      async rollback() { await c.rollback(); observation.record('transaction', { event: 'rollback', connectionId: identity.connectionId }); },
      release() {},
    };
    // El seed y todas las operaciones pasan por la lista cerrada de tablas ya creadas.
    for (const definition of commercial.definitions) {
      for (const source of commercial.seed[definition.table] ?? []) {
        const row = { ...source };
        if (Object.hasOwn(row, 'actor_legajo') && row.actor_legajo !== null) row.actor_legajo = '9900000003';
        const fields = definition.columns.filter(column => !/(STORED|VIRTUAL) GENERATED/i.test(column.extra)).map(column => column.name);
        await facade.execute(`INSERT INTO \`${definition.table}\` (${fields.map(field => `\`${field}\``).join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => row[field]));
      }
    }
    return { connection: facade, pool: { getConnection: async () => facade }, connectionId: identity.connectionId,
      close() { closed = true; c.destroy(); observation.record('cleanup', { mechanism: 'Cerrar sesión física: elimina sus tablas TEMPORARY', connectionId: identity.connectionId }); } };
  } catch (error) { c.destroy(); throw error; }
}

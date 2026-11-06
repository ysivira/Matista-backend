/**
 * SPEC-06: ejecutor explícito, sin migraciones, SIGEC, instalación ni DDL permanente propio.
 * Uso: node tests/evidence/spec06.js run <directorio-evidencias> [bateria]
 * Cada archivo se asigna a una sola batería. Los bloqueados se inventarían, no se importan.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig, assertTestDatabase } from '../../src/infrastructure/database/config.js';
import { createDatabasePool } from '../../src/infrastructure/database/connection.js';
import { loadMigrations, assessMigrationState } from '../../src/infrastructure/database/migration-runner.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [action, directory, selected] = process.argv.slice(2);
assert.equal(action, 'run', 'Acción admitida: run');
assert.ok(directory && path.isAbsolute(directory), 'Indicar un directorio absoluto dedicado a evidencia');
const out = directory;
await mkdir(out, { recursive: true, mode: 0o700 });
assert.ok(!(await readdir(out)).some(name => name.endsWith('-resultado.json')), 'Este directorio ya contiene una ejecución: usar un subdirectorio nuevo para conservar los originales');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const files = [];
async function discover(dir) {
  for (const e of await readdir(path.join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) await discover(p);
    else if (e.name.endsWith('.test.js')) files.push(p);
  }
}
await discover('tests'); files.sort();
const blocked = {
  'tests/modules/admin/admin.mecanismos.integration.test.js': 'No autorizado crear/eliminar su tabla permanente; se bloquea también el hook compartido.',
  'tests/modules/admin/carga-inicial.integration.test.js': 'SIGEC no autorizado; C:324 también contiene borrado transaccional global de catálogo no autorizado.',
  'tests/modules/admin/instalacion.integration.test.js': 'matista_local e instalación desde base vacía no autorizados.',
};
const mysqlFiles = [
  'tests/infrastructure/database/schema.integration.test.js',
  'tests/modules/admin/employees.integration.test.js',
  'tests/modules/admin/tarifario.ciclo.integration.test.js',
  'tests/modules/admin/tarifario.migraciones.integration.test.js',
  'tests/modules/admin/tarifario.trazabilidad.integration.test.js',
  'tests/modules/asesor/asesor.integration.test.js',
  'tests/auth/auth.repository.integration.test.js',
];
const pdfFiles = [
  'tests/infrastructure/pdf/html-pdf.test.js', 'tests/infrastructure/pdf/pdf.routes.test.js',
  'tests/modules/asesor/documentos.test.js', 'tests/modules/asesor/documentos.compatibilidad.test.js',
  'tests/modules/asesor/documentos.contratos.test.js', 'tests/modules/asesor/clientes.normalizacion.test.js',
  'tests/modules/asesor/fix07.test.js', 'tests/modules/asesor/monotributo.test.js',
];
const batches = new Map();
function category(file) {
  if (blocked[file]) return 'bloqueada';
  if (mysqlFiles.includes(file)) return 'mysql-' + path.basename(file).replace('.integration.test.js', '');
  if (pdfFiles.includes(file)) return 'pdf';
  if (file.startsWith('tests/auth/')) return 'auth-http-servicios';
  if (file.startsWith('tests/infrastructure/security/') || file.startsWith('tests/infrastructure/email/') || file.startsWith('tests/shared/') || file === 'tests/health.test.js') return 'seguridad-http-infra';
  if (file.endsWith('.http.test.js')) return 'http-modulos';
  return 'unitarias-contratos';
}
const inventory = [];
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  const definitions = [...source.matchAll(/(?:^|\n)\s*(?:await\s+)?(?:(t|st)\.)?test\(\s*(['"`])([^\n]*?)\2/g)].map(m => ({
    name: m[3], line: source.slice(0, m.index + m[0].indexOf('test(')).split('\n').length,
    nested: Boolean(m[1]), depth: m[1] === 'st' ? 2 : m[1] === 't' ? 1 : 0, parameterized: m[2] === '`' && m[3].includes('${'),
  }));
  const group = category(file);
  inventory.push({ file, group, sha256: sha256(source), definitions, blocked: blocked[file] ?? null });
  if (group !== 'bloqueada') batches.set(group, [...(batches.get(group) ?? []), file]);
}
assert.ok(!selected || batches.has(selected), 'Batería desconocida');
await save('inventario-fuentes.json', inventory);
await save('bloqueos.json', inventory.filter(f => f.blocked));

// El entorno de los hijos queda fijado; nunca hereda el destino de Aiven o desarrollo.
const env = { ...process.env, TMPDIR: '/tmp/opencode', NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'matista_test', DB_SSL: 'false',
  RUN_DB_TESTS: '0', RUN_AUTH_DB_TESTS: '0', RUN_INSTALL_DB_TESTS: '0', RUN_PDF_TESTS: '0',
  FRONTEND_ORIGIN: 'http://localhost:5173', VERCEL: '', CHROME_BIN: '/usr/bin/google-chrome',
  MATISTA_EVIDENCE_FILE: path.join(out, 'escenarios.jsonl') };
const privateValues = ['DB_PASSWORD', 'JWT_SECRET', 'SMTP_PASSWORD', 'SMTP_USER'].map(k => process.env[k]).filter(v => v && v.length >= 4);
function safe(text) {
  for (const secret of privateValues) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'gu'), '[OCULTO]');
  }
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT OCULTO]');
}

/** SELECT exclusivamente; bloquea antes de arrancar una suite si hay migraciones pendientes. */
async function preflight(label) {
  process.env.DB_SSL = 'false';
  const config = loadDatabaseConfig(env); assertTestDatabase(config);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3306);
  const pool = createDatabasePool(config);
  const queries = [];
  const select = async (sql, params = []) => {
    const [rows] = await pool.execute(sql, params);
    queries.push({ sql, parameters: params, rows }); return rows;
  };
  try {
    const [identity] = await select('SELECT DATABASE() AS databaseName, VERSION() AS version, @@hostname AS hostname, @@port AS port');
    assert.equal(identity.databaseName, 'matista_test');
    assert.equal(identity.hostname, os.hostname()); assert.equal(Number(identity.port), 3306);
    const migrations = await loadMigrations(path.join(root, 'migrations'));
    const applied = await select('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const tables = await select('SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', ['matista_test']);
    const state = assessMigrationState(migrations, applied, tables.map(t => t.tableName));
    assert.equal(state.pending.length, 0, 'No se autorizó aplicar migraciones');
    assert.equal(tables.length, 19, 'No debe haber tablas de pruebas permanentes adicionales');
    const fingerprint = [];
    for (const { tableName } of tables) {
      assert.match(tableName, /^[a-z_]+$/);
      const [columns] = await pool.execute('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['matista_test', tableName]);
      const projection = columns.map(c => ['datetime','timestamp','date'].includes(c.type) ? `CAST(\`${c.name}\` AS CHAR) AS \`${c.name}\`` : `\`${c.name}\``).join(',');
      const [rows] = await pool.query(`SELECT ${projection} FROM \`${tableName}\` ORDER BY 1`);
      fingerprint.push({ table: tableName, count: rows.length, sha256: sha256(JSON.stringify(rows)) });
    }
    const result = { at: new Date().toISOString(), label, queries, fingerprint, pendingMigrations: 0 };
    await save(`${label}-preflight.json`, result);
    return result;
  } finally { await pool.end(); }
}

const dependencies = {};
for (const [name, args] of [['node',['--version']], ['/usr/bin/google-chrome',['--version']], ['pdfinfo',['-v']], ['pdftotext',['-v']]]) {
  const r = spawnSync(name, args, { encoding: 'utf8', timeout: 15000, env });
  dependencies[name] = { exit: r.status, output: safe((r.stdout ?? '') + (r.stderr ?? '')) };
}
await save('dependencias.json', dependencies);
const results = [];
const order = [...batches].sort(([a], [b]) => Number(a.startsWith('mysql-')) - Number(b.startsWith('mysql-')) || a.localeCompare(b));
for (const [batch, batchFiles] of order) {
  if (selected && selected !== batch) continue;
  const started = new Date().toISOString();
  const childEnv = { ...env };
  let before;
  try {
    if (batch === 'pdf' || batch === 'mysql-asesor') {
      for (const name of ['/usr/bin/google-chrome', 'pdfinfo', 'pdftotext']) assert.equal(dependencies[name].exit, 0, `Dependencia PDF no disponible: ${name}`);
    }
    if (batch.startsWith('mysql-')) {
      before = await preflight(batch + '-antes');
      childEnv.RUN_DB_TESTS = '1';
      if (batch === 'mysql-auth.repository') { childEnv.RUN_DB_TESTS = '0'; childEnv.RUN_AUTH_DB_TESTS = '1'; }
    }
    if (batch === 'pdf') childEnv.RUN_PDF_TESTS = '1';
    const eventsFile = path.join(out, batch + '-eventos.jsonl');
    const args = ['--experimental-test-module-mocks', '--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination=stdout',
      '--test-reporter=./tests/evidence/reporter.js', `--test-reporter-destination=${eventsFile}`, ...batchFiles];
    const command = { executable: process.execPath, args, environment: Object.fromEntries(['TMPDIR','NODE_ENV','DB_HOST','DB_PORT','DB_NAME','DB_SSL','RUN_DB_TESTS','RUN_AUTH_DB_TESTS','RUN_PDF_TESTS','RUN_INSTALL_DB_TESTS','CHROME_BIN','MATISTA_EVIDENCE_FILE'].map(k => [k,childEnv[k]])) };
    await save(batch + '-comando.json', command);
    const r = spawnSync(process.execPath, args, { cwd: root, env: childEnv, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    await writeFile(path.join(out, batch + '.tap'), safe(r.stdout ?? ''), { mode: 0o600 });
    await writeFile(path.join(out, batch + '-stderr.txt'), safe(r.stderr ?? ''), { mode: 0o600 });
    const result = { batch, files: batchFiles, started, ended: new Date().toISOString(), exit: r.status, signal: r.signal, error: r.error?.code ?? null };
    if (before) {
      const after = await preflight(batch + '-despues');
      result.integrity = { equal: JSON.stringify(before.fingerprint) === JSON.stringify(after.fingerprint), before: before.fingerprint, after: after.fingerprint };
    }
    await save(batch + '-resultado.json', result); results.push(result);
    console.log(`${batch}: exit=${r.status}; integridad=${result.integrity?.equal ?? 'sin MySQL'}`);
  } catch (error) {
    const result = { batch, files: batchFiles, started, ended: new Date().toISOString(), blocked: true, error: safe(error.message) };
    await save(batch + '-resultado.json', result); results.push(result);
    console.log(`${batch}: BLOQUEADA (${safe(error.message)})`);
  }
}
await save(selected ? `ejecucion-${selected}.json` : 'ejecucion.json', results);

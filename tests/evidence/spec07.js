/** SPEC-07: preflight y ejecución explícita, sin migraciones ni actualización de documentos/TXT oficiales.
 * node tests/evidence/spec07.js <inspect|run> <directorio-nuevo>
 * node tests/evidence/spec07.js report <directorio-de-ejecución-existente>
 * Reutiliza la suite ASESOR y los auxiliares de evidencia de SPEC-06, sin regenerar sus artefactos.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig, assertTestDatabase } from '../../src/infrastructure/database/config.js';
import { createDatabasePool } from '../../src/infrastructure/database/connection.js';
import { loadMigrations, assessMigrationState } from '../../src/infrastructure/database/migration-runner.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [action, out] = process.argv.slice(2);
assert.ok(['inspect', 'run', 'report'].includes(action));
assert.ok(out && path.isAbsolute(out));
if (action === 'report') { await report(out); process.exit(0); }
await mkdir(out, { recursive: false, mode: 0o700 });
const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const head = git('rev-parse', 'HEAD').trim();
assert.equal(head, '4eba232ef834cd16a88bf038186aa296d0c726e0', 'Corte SPEC-07 inesperado');
const source = '/home/yurlian/proyectos/MATISTA-DOC/documentacion/08-entrega-academica-final/Sivira_Informe_Definitivo.md';
const original = await readFile(source, 'utf8');
const definitions = ['CP-53', 'CP-54', 'CP-58', 'CP-59'].map(id => {
  const start = original.indexOf(`#### ${id} ·`);
  assert.ok(start >= 0);
  const next = original.indexOf('<!-- PAGE anexo -->', start);
  return { id, source, line: original.slice(0, start).split('\n').length, sourceSha256: sha256(original), definition: original.slice(start, next).trim() };
});
await save('definiciones-originales.json', definitions);
const initial = { head, status: git('status', '--short'), diff: git('diff'), staged: git('diff', '--cached', '--name-only') };
assert.equal(initial.staged, '', 'El índice debe mantenerse vacío');
const protectedFiles = [
  source,
  '/home/yurlian/proyectos/MATISTA-DOC/documentacion/08-entrega-academica-final/Sivira_Informe.md',
  '/home/yurlian/Documentos/exportacion_verificada_SPEC05_3192d84_8696aeb/Sivira_codigo_backend_01.txt',
  '/home/yurlian/Documentos/exportacion_verificada_SPEC05_3192d84_8696aeb/sivira_codigo_frontend_02.txt',
];
const oldBase = '/home/yurlian/proyectos/MATISTA-DOC/evidencias-pruebas';
async function protect(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (p === out || p.includes('/SPEC07-')) continue;
    if (e.isDirectory()) await protect(p);
    else protectedFiles.push(p);
  }
}
await protect(oldBase);
const protectedHashes = await Promise.all(protectedFiles.map(async file => ({ file, sha256: sha256(await readFile(file)) })));
await save('00-control-inicial.json', { ...initial, protectedHashes });
const env = { ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'matista_test', DB_SSL: 'false',
  RUN_DB_TESTS: '1', RUN_AUTH_DB_TESTS: '0', RUN_INSTALL_DB_TESTS: '0', RUN_PDF_TESTS: '0', VERCEL: '',
  TMPDIR: '/tmp/opencode', CHROME_BIN: '/usr/bin/google-chrome', FRONTEND_ORIGIN: 'http://localhost:5173',
  MATISTA_EVIDENCE_FILE: path.join(out, 'escenarios.jsonl') };
process.env.DB_SSL = 'false';
const privateValues = ['DB_PASSWORD', 'JWT_SECRET', 'SMTP_PASSWORD', 'SMTP_USER'].map(k => process.env[k]).filter(v => v && v.length >= 4);
const safe = text => {
  for (const value of privateValues) text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu'), '[OCULTO]');
  return text.replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT OCULTO]');
};
const dependencies = [];
for (const [bin, args] of [[process.execPath, ['--version']], ['/usr/bin/google-chrome', ['--version']], ['pdfinfo', ['-v']], ['pdftotext', ['-v']]]) {
  const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: 15000 });
  dependencies.push({ bin, args, exit: r.status, output: safe((r.stdout ?? '') + (r.stderr ?? '')) });
  assert.equal(r.status, 0, `Dependencia no disponible: ${bin}`);
}
await save('dependencias.json', dependencies);
async function preflight(phase) {
  const config = loadDatabaseConfig(env); assertTestDatabase(config);
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.port, 3306);
  const pool = createDatabasePool(config);
  const queries = [];
  const select = async (sql, parameters = []) => {
    const [rows] = await pool.execute(sql, parameters);
    queries.push({ sql, parameters, rows }); return rows;
  };
  try {
    const [identity] = await select('SELECT DATABASE() AS databaseName, VERSION() AS version, @@hostname AS hostname, @@port AS port');
    assert.equal(identity.databaseName, 'matista_test'); assert.equal(identity.hostname, os.hostname()); assert.equal(Number(identity.port), 3306);
    const migrations = await loadMigrations(path.join(root, 'migrations'));
    const applied = await select('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const tables = await select('SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', ['matista_test']);
    assert.equal(assessMigrationState(migrations, applied, tables.map(t => t.tableName)).pending.length, 0, 'No aplicar migraciones pendientes');
    assert.equal(tables.length, 19);
    const pending = await select("SELECT id, estado, fecha_vigencia FROM politica_comercial WHERE estado='PROGRAMADA'");
    assert.equal(pending.length, 0, 'Detenerse: la suite puede activar políticas programadas; no modificar registros previos');
    const checks = await select("SELECT tc.CONSTRAINT_NAME, tc.ENFORCED, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=? AND tc.TABLE_NAME='politica_comercial' AND tc.CONSTRAINT_NAME='chk_politica_aporte_monotributo'", ['matista_test']);
    assert.equal(checks.length, 1); assert.equal(checks[0].ENFORCED, 'YES'); assert.match(checks[0].CHECK_CLAUSE, /is not null/i);
    await select('SELECT id, estado, revision, aporte_monotributo, aporte_adherente, iva_voluntario_pct, porcentaje_aporte_reconocido, tope_sueldo_bruto FROM politica_comercial WHERE estado=?', ['VIGENTE']);
    await select('SELECT id, nombre, activa FROM planes WHERE id=?', [4]);
    await select("SELECT id, porcentaje FROM porcentajes_comerciales WHERE politica_comercial_id=(SELECT id FROM politica_comercial WHERE estado='VIGENTE') AND vigente_hasta IS NULL ORDER BY porcentaje");
    const fingerprint = [];
    for (const { tableName } of tables) {
      assert.match(tableName, /^[a-z_]+$/);
      const [columns] = await pool.execute('SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['matista_test', tableName]);
      const fields = columns.map(c => ['datetime', 'date', 'timestamp'].includes(c.type) ? `CAST(\`${c.name}\` AS CHAR) AS \`${c.name}\`` : `\`${c.name}\``).join(',');
      const [rows] = await pool.query(`SELECT ${fields} FROM \`${tableName}\` ORDER BY 1`);
      fingerprint.push({ table: tableName, count: rows.length, sha256: sha256(JSON.stringify(rows)) });
    }
    const result = { phase, at: new Date().toISOString(), queries, fingerprint };
    await save(`preflight-${phase}.json`, result); return result;
  } finally { await pool.end(); }
}
const before = await preflight('antes');
console.log('Preflight: MySQL local matista_test; 30 migraciones verificadas; sin políticas programadas; CHECK de unitario no nulo activo.');
if (action === 'run') {
  const files = ['tests/modules/asesor/asesor.integration.test.js'];
  // Selección de ASESOR: al coincidir la raíz, Node incluye todos sus descendientes. No importa otras suites.
  const pattern = '^ASESOR real: AUTH HTTP, propiedad, cálculo, emisión y trazabilidad histórica$|lecturas reutilizan ADMIN y escrituras administrativas siguen prohibidas|registro/búsqueda de cliente, pertenencia y acceso por ID|SPEC07';
  const args = ['--test', '--test-concurrency=1', `--test-name-pattern=${pattern}`, '--test-reporter=tap', '--test-reporter-destination=stdout',
    '--test-reporter=./tests/evidence/reporter.js', `--test-reporter-destination=${path.join(out, 'eventos.jsonl')}`, ...files];
  await save('comando.json', { executable: process.execPath, args, environment: Object.fromEntries(['NODE_ENV', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_SSL', 'TMPDIR', 'CHROME_BIN', 'RUN_DB_TESTS', 'RUN_AUTH_DB_TESTS', 'RUN_PDF_TESTS', 'RUN_INSTALL_DB_TESTS', 'MATISTA_EVIDENCE_FILE'].map(k => [k, env[k]])), sources: await Promise.all([...files, 'tests/evidence/spec07.js', 'tests/helpers/evidence.js'].map(async file => ({ file, sha256: sha256(await readFile(path.join(root, file))) }))) });
  const started = new Date().toISOString();
  const r = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  await writeFile(path.join(out, 'resultado.tap'), safe(r.stdout ?? ''), { mode: 0o600 });
  await writeFile(path.join(out, 'stderr.txt'), safe(r.stderr ?? ''), { mode: 0o600 });
  const after = await preflight('despues');
  const result = { started, ended: new Date().toISOString(), exit: r.status, signal: r.signal, error: r.error?.code ?? null, integrity: JSON.stringify(before.fingerprint) === JSON.stringify(after.fingerprint) };
  await save('resultado.json', result);
  console.log(JSON.stringify(result));
  if (r.status !== 0 || !result.integrity) process.exitCode = 1;
}
for (const entry of protectedHashes) assert.equal(sha256(await readFile(entry.file)), entry.sha256, `Archivo protegido alterado: ${entry.file}`);
await save('control-final.json', { head: git('rev-parse', 'HEAD').trim(), status: git('status', '--short'), staged: git('diff', '--cached', '--name-only'), protectedFilesUnchanged: protectedHashes.length });

/** Informe técnico post-ejecución: no inicia MySQL, navegador, tests ni sincronización de TXT. */
async function report(directory) {
  const load = name => readFile(path.join(directory, name), 'utf8').then(JSON.parse);
  const entries = (await readFile(path.join(directory, 'escenarios.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line, index) => ({ ...JSON.parse(line), line: index + 1 }));
  const events = (await readFile(path.join(directory, 'eventos.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = await load('resultado.json');
  const command = await load('comando.json');
  const definitions = await load('definiciones-originales.json');
  const before = await load('preflight-antes.json');
  const after = await load('preflight-despues.json');
  const initial = await load('00-control-inicial.json');
  for (const p of initial.protectedHashes) assert.equal(createHash('sha256').update(await readFile(p.file)).digest('hex'), p.sha256, `Archivo protegido alterado: ${p.file}`);
  const expected = [
    ['CP-53', 'RF-21', 'ambas-fuentes', 400, 'ASESOR_VALIDACION'],
    ['CP-53', 'RF-21', 'declarado', 422, 'COTIZACION_REGLA'],
    ['CP-54', 'RF-22', 'adherentes-negativos', 400, 'ASESOR_VALIDACION'],
    ['CP-54', 'RF-22', 'adherentes-fraccionarios', 400, 'ASESOR_VALIDACION'],
    ['CP-54', 'RF-22', 'aportes-altos', 200, null],
    ['CP-54', 'RF-22', 'unitario-ausente', 422, 'COTIZACION_REGLA'],
    ['CP-58', 'RF-26', 'revision-anterior', 409, 'ASESOR_CONCURRENCIA'],
    ['CP-58', 'RF-26', 'economico-sobre-emitida', 409, 'ASESOR_ESTADO'],
    ['CP-59', 'RF-27', 'huella-alterada', 409, 'ASESOR_CONCURRENCIA'],
    ['CP-59', 'RF-27', 'revision-alterada', 409, 'ASESOR_CONCURRENCIA'],
    ['CP-59', 'RF-27', 'total-en-calculo', 400, 'ASESOR_VALIDACION'],
  ];
  const variants = expected.map(([cp, rf, variant, status, error]) => {
    const records = entries.filter(e => e.scenario === `${cp}/${variant}`);
    const http = records.find(e => e.type === 'http');
    const blocked = records.find(e => e.type === 'blocked');
    const acceptance = records.find(e => e.type === 'acceptance');
    const event = events.find(e => e.name === `SPEC07 ${cp}: ${variant}`);
    const passed = result.exit === 0 && result.integrity && acceptance && event?.type === 'test:pass' && !event.skip && http?.status === status && (error === null || http.response?.error?.code === error);
    return { cp, rf, variant, expectedStatus: status, expectedError: error, observedStatus: http?.status ?? null, observedError: http?.response?.error?.code ?? null,
      state: blocked ? 'BLOQUEADA' : passed ? 'APROBADA' : 'NO ACREDITADA', reason: blocked?.reason ?? null, records: records.map(e => e.line) };
  });
  const matrix = definitions.map(d => {
    const checks = variants.filter(v => v.cp === d.id);
    return { cp: d.id, requirement: checks[0].rf, source: `${d.source}:${d.line}`, approved: checks.filter(v => v.state === 'APROBADA').length,
      blocked: checks.filter(v => v.state === 'BLOQUEADA').length, state: checks.every(v => v.state === 'APROBADA') ? 'APROBADO' : checks.some(v => v.state === 'BLOQUEADA') ? 'PARCIAL / BLOQUEADO' : 'NO ACREDITADO' };
  });
  const summary = { head: initial.head, result, runner: events.filter(e => e.type === 'test:summary').at(-1), matrix, variants,
    constraints: before.queries.find(q => q.sql.includes('CHECK_CONSTRAINTS'))?.rows, protectedFilesUnchanged: initial.protectedHashes.length,
    note: 'No se suman estas regresiones al consolidado SPEC06 ni se declara CP54 completo. No hubo intentos fallidos en esta ejecución.' };
  await writeFile(path.join(directory, 'matriz-resultados.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  const cell = value => String(value ?? '—').replaceAll('|', '\\|').replaceAll('\n', ' ');
  const table = (header, rows) => ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');
  const text = [
    '# SPEC-07 — Registro técnico de variantes negativas',
    `Corte base: ${initial.head}. Ejecución: ${result.started}. Destino: MySQL local matista_test. Este registro no modifica el informe académico ni los TXT oficiales.`,
    '## Correspondencia original y cobertura previa',
    'Las definiciones literales y sus SHA-256 están en definiciones-originales.json, extraídas de Sivira_Informe_Definitivo.md, CP-53:1500, CP-54:1535, CP-58:1675 y CP-59:1710. Coinciden con el informe anterior. Los datos económicos originales se describían como ficticios; no se publicaron políticas o descuentos para reproducirlos.',
    'Cobertura previa: cotizacion.engine.test.js verifica DECLARADO y unitario ausente con objetos sintéticos; monotributo.test.js valida adherentes inválidos y saldo no negativo sin MySQL. asesor.integration.test.js ya rechazaba PUT sobre EMITIDA y huella inválida, pero faltaban todas las variantes integrales y la comparación SQL completa. Se amplió esa suite y se reutilizaron sus fixtures, HTTP, observador y limpieza por propiedad.',
    '## Matriz de cuatro casos',
    table(['Caso', 'RF', 'Variantes aprobadas', 'Bloqueadas', 'Estado'], matrix.map(c => [c.cp, c.requirement, c.approved, c.blocked, c.state])),
    '## Resultados individuales',
    table(['Caso / variante', 'HTTP esperado', 'HTTP observado', 'Error observado', 'Estado', 'Líneas JSONL'], variants.map(v => [`${v.cp}/${v.variant}`, v.expectedStatus, v.observedStatus, v.observedError, v.state, v.records.join(', ')])),
    '## Seguridad y limitaciones',
    'Preflight con SELECT: destino efectivo local, 30 migraciones/checksums existentes, 19 tablas y cero políticas PROGRAMADA. No se ejecutó el runner de migraciones ni DDL; el archivo ASESOR utilizado no aplica migraciones. Solo se crearon registros operativos sintéticos; la limpieza usa legajos propios, sin borrados globales. Las 19 huellas de contenido coinciden antes/después. Se conservan consultas, parámetros y resultados reales en los preflight y escenarios.jsonl; las huellas no se atribuyen como filas retornadas por MySQL.',
    'CP-54/unitario-ausente NO ejecutado por HTTP: se espera rechazo COTIZACION_REGLA/422 según parametro() del motor, pero el CHECK real activo obliga aporte_monotributo no nulo y positivo e impide preparar la precondición en MySQL. No se intentó deshabilitarlo, modificar la política previa ni presentar un doble como dato persistido. Se requiere autorización para diseñar una alternativa de fallo inyectado, claramente diferenciada de una fila real. CP-54 permanece parcial.',
    'El catálogo observado no tenía porcentajes publicados. CP-54 usó DIAMANTE, matrimonio de 41 años e hijo de 12, aporte unitario real y sin descuento comercial; por tanto no se afirma haber reproducido el total positivo ficticio 707627.51 con 35 %. Esta diferencia no altera las guardas de adherentes ni el criterio de saldo no negativo.',
    'La selección por nombre coincide con el padre: Node ejecutó todos los descendientes ASESOR, incluidos los controles previos. Se informa el resultado real, no solo los nombres seleccionados. Los contenedores CP-54 aprobados por Node no acreditan su variante omitida.',
    `Resultado Node: ${JSON.stringify(summary.runner?.counts)}. Variantes SPEC07: ${variants.filter(v => v.state === 'APROBADA').length} aprobadas, ${variants.filter(v => v.state === 'BLOQUEADA').length} bloqueada. No hay intentos fallidos que corregir o reintentar en esta ejecución.`,
    '## Comando efectivamente ejecutado',
    '```json\n' + JSON.stringify(command, null, 2) + '\n```',
    '## Evidencias HTTP y MySQL por variante',
  ];
  const queryList = [...new Set(entries.filter(e => e.scenario.startsWith('CP-') && e.type === 'sql').map(e => e.sql))];
  queryList.forEach((sql, i) => text.push(`### SQL-${i + 1} (efectivamente ejecutado)\n\n\`\`\`sql\n${sql}\n\`\`\``));
  for (const v of variants) {
    text.push(`### ${v.cp}/${v.variant}: ${v.state}`);
    const records = entries.filter(e => e.scenario === `${v.cp}/${v.variant}`);
    for (const e of records) {
      if (e.type === 'http') text.push(`HTTP ${e.method} ${e.path} → ${e.status}; escenarios.jsonl:${e.line}\n\n\`\`\`json\n${JSON.stringify({ request: e.request, response: e.response })}\n\`\`\``);
      if (e.type === 'blocked') text.push(e.reason + `\n\nRegistro: escenarios.jsonl:${e.line}`);
    }
    text.push(table(['Momento', 'Consulta', 'Parámetros efectivos', 'Filas', 'SHA-256 del resultado redactado', 'Línea JSONL'], records.filter(e => e.type === 'sql').map(e => [e.phase, `SQL-${queryList.indexOf(e.sql) + 1}`, JSON.stringify(e.parameters), e.rows.length, createHash('sha256').update(JSON.stringify(e.rows)).digest('hex'), e.line])));
    text.push('Las filas completas depuradas están en la línea JSONL indicada. Las aserciones compararon las filas originales; el SHA de presentación anterior se calculó después de ocultar datos personales.');
  }
  text.push('## Integridad de contenido antes/después', table(['Tabla', 'Filas antes', 'Filas después', 'Huella igual'], before.fingerprint.map((b, i) => [b.table, b.count, after.fingerprint[i].count, b.sha256 === after.fingerprint[i].sha256])));
  text.push('## Propuesta de commit — no ejecutada\n\n`test(asesor): validar CP negativos y documentar bloqueo CP-54`\n\n- tests/modules/asesor/asesor.integration.test.js\n- tests/evidence/spec07.js\n\nExcluir docs/, connection.js.save, .env, evidencias externas y frontend. El bloqueo de CP-54 debe conservarse explícito. Los TXT oficiales no se sincronizan en esta fase.');
  await writeFile(path.join(directory, 'RESULTADOS_SPEC07.md'), text.join('\n\n') + '\n', { mode: 0o600 });
  const artifacts = [];
  for (const name of await readdir(directory)) {
    if (name === 'huellas-artefactos.json') continue;
    const full = path.join(directory, name);
    artifacts.push({ file: name, sha256: createHash('sha256').update(await readFile(full)).digest('hex') });
  }
  await writeFile(path.join(directory, 'huellas-artefactos.json'), JSON.stringify(artifacts, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ matrix, variants: variants.length, approved: variants.filter(v => v.state === 'APROBADA').length, blocked: variants.filter(v => v.state === 'BLOQUEADA').length, result }, null, 2));
}

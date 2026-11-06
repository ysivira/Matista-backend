/** SPEC-08: ejecuta SOLO historia.pdf.integration.test.js, sin migraciones ni conexiones externas.
 * node tests/evidence/spec08.js <directorio-nuevo> <directorio-fase-A>
 * No importa ni ejecuta las suites previas; conserva sus archivos mediante huellas.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../helpers/spec08.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [out, inspection] = process.argv.slice(2);
assert.ok(out && inspection && path.isAbsolute(out) && path.isAbsolute(inspection));
const base = '/home/yurlian/proyectos/MATISTA-DOC/evidencias-pruebas';
assert.equal(path.dirname(out), base);
assert.equal(path.dirname(inspection), base);
assert.notEqual(out, inspection);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const head = git('rev-parse', 'HEAD').trim();
assert.equal(head, 'b226a48d6abd2c808a5cea4014f5d2be3a8e926d');
assert.equal(git('diff', '--cached', '--name-only'), '');
const load = file => readFile(file, 'utf8').then(JSON.parse);
const initialInspection = await load(path.join(inspection, 'control-inicial.json'));
for (const entry of initialInspection.protectedHashes) assert.equal(sha256(await readFile(entry.file)), entry.sha256, entry.file);
const isolation = await load(path.join(inspection, 'aislamiento-temporal-verificado.json'));
assert.equal(isolation.records.length, 13);
assert.equal(isolation.records.reduce((sum, record) => sum + record.checkCountPreserved, 0), 58);
const protectedFiles = new Set(initialInspection.protectedHashes.map(entry => entry.file));
async function includeFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await includeFiles(full);
    else if (entry.isFile()) protectedFiles.add(full);
  }
}
await includeFiles(base);
const protectedHashes = await Promise.all([...protectedFiles].sort().map(async file => ({ file, sha256: sha256(await readFile(file)) })));
const frontend = '/home/yurlian/proyectos/Matista/Matista-frontend';
const frontendStatus = () => execFileSync('git', ['status', '--short'], { cwd: frontend, encoding: 'utf8' });
assert.equal(frontendStatus(), '');
await mkdir(out, { recursive: false, mode: 0o700 });
const save = (name, value) => writeFile(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
await save('control-inicial.json', { head, status: git('status', '--short'), staged: '', protectedHashes, inspection });
const file = 'tests/modules/asesor/historia.pdf.integration.test.js';
const sources = [file, 'tests/helpers/spec08.js', 'tests/evidence/spec08.js', 'tests/helpers/evidence.js', 'tests/helpers/http.js', 'tests/evidence/reporter.js'];
await save('fuentes-ejecutadas.json', await Promise.all(sources.map(async file => {
  const content = await readFile(path.join(root, file), 'utf8');
  return { file, sha256: sha256(content), content };
})));
const env = { ...process.env, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '3306', DB_NAME: 'matista_test', DB_SSL: 'false', DB_CONNECTION_LIMIT: '4',
  FRONTEND_ORIGIN: 'http://localhost:5173', RUN_SPEC08: '1', RUN_DB_TESTS: '0', RUN_AUTH_DB_TESTS: '0', RUN_INSTALL_DB_TESTS: '0', RUN_PDF_TESTS: '1',
  VERCEL: '', TMPDIR: '/tmp/opencode', CHROME_BIN: '/usr/bin/google-chrome',
  SPEC08_EVIDENCE_DIR: out, MATISTA_EVIDENCE_FILE: path.join(out, 'escenarios.jsonl') };
const dependencies = [];
for (const args of [[process.execPath, '--version'], ['/usr/bin/google-chrome', '--version'], ['pdfinfo', '-v'], ['pdftotext', '-v'], ['pdftoppm', '-v']]) {
  const result = spawnSync(args[0], args.slice(1), { env, encoding: 'utf8', timeout: 15000 });
  dependencies.push({ args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.status, 0, `Dependencia no disponible: ${args[0]}; no sustituir por mock`);
}
await save('dependencias.json', dependencies);
const args = ['--test', '--test-concurrency=1', '--test-reporter=tap', '--test-reporter-destination=stdout',
  '--test-reporter=./tests/evidence/reporter.js', `--test-reporter-destination=${path.join(out, 'eventos.jsonl')}`, file];
const publicKeys = ['NODE_ENV', 'DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_SSL', 'DB_CONNECTION_LIMIT', 'FRONTEND_ORIGIN', 'RUN_SPEC08', 'RUN_DB_TESTS', 'RUN_AUTH_DB_TESTS', 'RUN_INSTALL_DB_TESTS', 'RUN_PDF_TESTS', 'VERCEL', 'TMPDIR', 'CHROME_BIN', 'SPEC08_EVIDENCE_DIR', 'MATISTA_EVIDENCE_FILE'];
await save('comando.json', { executable: process.execPath, args, cwd: root, environment: Object.fromEntries(publicKeys.map(key => [key, env[key]])),
  credentials: 'Solo credenciales locales desde entorno/.env; nunca se guardan sus valores', inspection });
const started = new Date().toISOString();
const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
await writeFile(path.join(out, 'resultado.tap'), result.stdout ?? '', { mode: 0o600 });
await writeFile(path.join(out, 'stderr.txt'), result.stderr ?? '', { mode: 0o600 });
const altered = [];
for (const entry of protectedHashes) if (sha256(await readFile(entry.file)) !== entry.sha256) altered.push(entry.file);
const final = { head: git('rev-parse', 'HEAD').trim(), staged: git('diff', '--cached', '--name-only'), status: git('status', '--short'),
  frontendStatus: frontendStatus(), protectedFilesUnchanged: protectedHashes.length - altered.length, alteredProtectedFiles: altered };
await save('control-final.json', final);
await save('resultado.json', { started, ended: new Date().toISOString(), exit: result.status, signal: result.signal, error: result.error?.code ?? null,
  priorFilesUnchanged: altered.length === 0, mode: 'HTTP, SQL y Chromium reales; DML solo en tablas TEMPORARY, sin FKs, con CHECK e índices' });
const artifacts = [];
for (const name of (await readdir(out)).sort()) artifacts.push({ file: name, sha256: sha256(await readFile(path.join(out, name))) });
await save('huellas-artefactos.json', artifacts);
assert.deepEqual(altered, []);
assert.equal(final.head, head); assert.equal(final.staged, ''); assert.equal(final.frontendStatus, '');
console.log(result.stdout);
console.log(JSON.stringify({ directory: out, exit: result.status, protectedFilesUnchanged: final.protectedFilesUnchanged }));
if (result.status !== 0) process.exitCode = 1;

/**
 * ============================================================
 * MATISTA | PRUEBAS MYSQL AUTH
 * ============================================================
 *
 * Archivo: auth.repository.integration.test.js
 * Módulo: Pruebas de autenticación
 *
 * Responsabilidad:
 * Comprobar persistencia y atomicidad de correo, sesiones y
 * credenciales; requiere habilitar expresamente RUN_AUTH_DB_TESTS.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createDatabasePool, verifyDatabaseConnection } from '../../src/infrastructure/database/connection.js';
import { assertTestDatabase, loadDatabaseConfig } from '../../src/infrastructure/database/config.js';
import { loadSecurityConfig } from '../../src/infrastructure/security/config.js';
import { hashPassword, verifyPassword } from '../../src/infrastructure/security/password.js';
import { verifyAccessToken } from '../../src/infrastructure/security/jwt.js';
import * as repository from '../../src/modules/auth/auth.repository.js';
import * as service from '../../src/modules/auth/auth.service.js';
import { createApp } from '../../src/app.js';
import { startTestServer } from '../helpers/http.js';
import { evidence } from '../helpers/evidence.js';

// Suite separada: no se incluye en test:auth ni en test:auth-infra. Requiere autorización humana previa.
const enabled = process.env.RUN_AUTH_DB_TESTS === '1';
const ownedLegajos = new Set();
const notices = [];
const incidents = [];
let pool;
let config;
let context;

/** Valida entorno y base real antes de cualquier DML; comprueba esquema existente sin aplicar migraciones. */
before(async () => {
  if (!enabled) return;
  await import('dotenv/config');
  config = loadDatabaseConfig();
  assertTestDatabase(config);
  pool = createDatabasePool({ ...config, connectionLimit: Math.max(2, config.connectionLimit) });
  await verifyDatabaseConnection(pool, 'matista_test');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN
     ('empleados', 'empleados_correos', 'auth_tokens', 'auth_sesiones', 'empleados_auditoria', 'schema_migrations')`,
    ['matista_test'],
  );
  assert.equal(rows.length, 6, 'Se requiere el esquema AUTH ya aplicado; esta suite no ejecuta migraciones.');
  const security = loadSecurityConfig({ NODE_ENV: 'test', PASSWORD_MIN_LENGTH: '4',
    JWT_SECRET: randomBytes(32).toString('base64url') });
  context = { pool, repository, security,
    dummyPasswordHash: await hashPassword(randomBytes(54).toString('base64url'), security),
    /** Devuelve el reloj real UTC sin modificar tiempos del servidor MySQL. */
    now: () => new Date(),
    /** Captura entrega exclusivamente en memoria: nunca SMTP real. */
    async notify(notice) { notices.push(notice); },
    /** Captura códigos seguros sin registrar destinatarios o tokens. */
    reportIncident(incident) { incidents.push(incident); },
  };
});

/**
 * Limpia solamente identidades creadas exitosamente por esta suite, respetando FK y sin DDL.
 * Revalida SELECT DATABASE() antes de borrar y revierte la limpieza si alguna sentencia falla.
 */
after(async () => {
  if (!pool) return;
  try {
    if (!ownedLegajos.size) return;
    assertTestDatabase(config);
    const connection = await pool.getConnection();
    let started = false;
    try {
      const [selected] = await connection.query('SELECT DATABASE() AS name');
      assert.equal(selected[0].name, 'matista_test');
      await connection.beginTransaction();
      started = true;
      const legajos = [...ownedLegajos];
      const placeholders = legajos.map(() => '?').join(', ');
      // Los nombres son constantes internas; solo los DNI propios se usan como parámetros.
      for (const table of ['empleados_auditoria', 'auth_tokens', 'auth_sesiones', 'empleados_correos', 'empleados']) {
        await connection.execute(`DELETE FROM ${table} WHERE legajo IN (${placeholders})`, legajos);
      }
      await connection.commit();
      started = false;
      for (const table of ['empleados', 'empleados_correos', 'auth_tokens', 'auth_sesiones', 'empleados_auditoria']) {
        const [remaining] = await connection.execute(
          `SELECT COUNT(*) AS total FROM ${table} WHERE legajo IN (${placeholders})`, legajos,
        );
        assert.equal(Number(remaining[0].total), 0, 'La suite debe limpiar todos sus datos.');
      }
    } catch (error) {
      if (started) await connection.rollback();
      throw error;
    } finally { connection.release(); }
  } finally { await pool.end(); }
});

/** Genera datos sintéticos de registro sin claves ADMIN ni datos personales reales. */
function accountData(overrides = {}) {
  return { legajo: String(randomInt(1_000_000_000, 9_999_999_999)), nombre: 'Prueba', apellido: 'AUTH',
    email: `auth-${randomBytes(10).toString('hex')}@example.test`, password: '1234', ...overrides };
}

/** Registra una identidad y la incorpora a la lista de limpieza solo después del commit exitoso. */
async function registerOwned(data = accountData()) {
  await service.register(data, context);
  ownedLegajos.add(data.legajo);
  const notice = notices.findLast((entry) => entry.type === 'VERIFY_EMAIL' && entry.to === service.normalizeEmail(data.email));
  return { data, token: notice.token };
}

/**
 * Prepara cuenta activa solo como fixture de integración; no constituye una funcionalidad ADMIN.
 * @returns {Promise<object>} Identidad sintética, JWT, claims y perfil para pruebas posteriores.
 */
async function activeAccount() {
  const { data, token } = await registerOwned();
  await service.confirmAddress(token, false, context);
  await repository.withConnection(pool,
    /** Cambia estado de la identidad propia del fixture después de verificar el correo. */
    async (connection) => {
      await repository.findEmployee(connection, data.legajo, true);
      await connection.execute("UPDATE empleados SET estado = 'ACTIVO' WHERE legajo = ?", [data.legajo]);
    }, { transaction: true });
  const signed = await service.login({ email: data.email, password: data.password }, context);
  return { data, signed, claims: await verifyAccessToken(signed.token, context.security) };
}

/** Confirma que dos consumos concurrentes no dupliquen la transición ni su auditoría. */
test('MySQL: verificación concurrente es atómica y no activa la cuenta', { skip: !enabled }, async () => {
  const { data, token } = await registerOwned();
  const results = await Promise.allSettled([
    service.confirmAddress(token, false, context), service.confirmAddress(token, false, context),
  ]);
  assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'fulfilled']);
  assert.deepEqual(results.map((result) => result.value.code).sort(), ['EMAIL_ALREADY_VERIFIED', 'EMAIL_VERIFIED']);
  const employee = await repository.withConnection(pool, (connection) => repository.findEmployee(connection, data.legajo));
  assert.equal(employee.estado, 'PENDIENTE');
  const [audit] = await pool.execute(
    "SELECT COUNT(*) AS total FROM empleados_auditoria WHERE legajo = ? AND evento = 'EMAIL_VERIFICADO'", [data.legajo],
  );
  assert.equal(Number(audit[0].total), 1);
});

/** Comprueba unicidad global de correo entre registros concurrentes y rollback del perdedor. */
test('MySQL: duplicidad concurrente de correo no deja empleados parciales', { skip: !enabled }, async () => {
  const first = accountData();
  const second = accountData({ email: first.email.toUpperCase() });
  const results = await Promise.allSettled([registerOwned(first), registerOwned(second)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'IDENTITY_CONFLICT');
  const [rows] = await pool.execute('SELECT legajo FROM empleados WHERE legajo IN (?, ?)', [first.legajo, second.legajo]);
  assert.equal(rows.length, 1);
});

/** Reenvía luego de vencimiento sin dejar dos tokens abiertos ni perder la reserva de correo. */
test('MySQL: reemplaza un token vencido abierto y conserva el registro ante fallo SMTP', { skip: !enabled }, async () => {
  const { data, token } = await registerOwned();
  const original = await repository.withConnection(pool,
    (connection) => repository.findReservedEmail(connection, data.email));
  const futureContext = { ...context,
    /** Simula 25 horas de avance sin cambiar el reloj ni las restricciones de la base. */
    now: () => new Date(Date.now() + 25 * 60 * 60 * 1000) };
  await service.resendVerification({ email: data.email }, futureContext);
  await assert.rejects(service.confirmAddress(token, false, futureContext), { code: 'TOKEN_INVALID' });
  const [tokens] = await pool.execute(
    "SELECT consumed_at, revoked_at FROM auth_tokens WHERE legajo = ? AND tipo = 'VERIFICAR_EMAIL'", [data.legajo],
  );
  assert.equal(tokens.length, 2);
  assert.equal(tokens.filter((entry) => !entry.consumed_at && !entry.revoked_at).length, 1);
  const failedContext = { ...futureContext,
    /** Simula rechazo SMTP, sin red ni credenciales externas. */
    async notify() { throw new Error('Fallo SMTP simulado.'); } };
  await service.resendVerification({ email: data.email }, failedContext);
  const current = await repository.withConnection(pool, (connection) => repository.findReservedEmail(connection, data.email));
  assert.equal(String(current.id), String(original.id));
});

/** Usa constraints y rollback reales cuando un cambio de correo intenta tomar una reserva ajena. */
test('MySQL: cambio de correo conserva el actual, revierte conflicto y confirma una sola vez', { skip: !enabled }, async () => {
  const first = await activeAccount();
  const other = await activeAccount();
  const pendingEmail = accountData().email;
  await service.changeEmail(first.claims, { email: pendingEmail, currentPassword: '1234' }, context);
  const token = notices.findLast((notice) => notice.type === 'CHANGE_EMAIL' && notice.to === pendingEmail).token;
  await assert.rejects(service.changeEmail(first.claims, { email: other.data.email, currentPassword: '1234' }, context), { code: 'IDENTITY_CONFLICT' });
  assert.equal((await service.getProfile(first.claims, context)).user.email, first.data.email);
  const confirmed = await service.confirmAddress(token, true, context);
  assert.equal(confirmed.code, 'EMAIL_CHANGED');
  await assert.rejects(service.confirmAddress(token, true, context), { code: 'TOKEN_INVALID' });
  await assert.rejects(service.authenticateToken(first.signed.token, context), { code: 'SESSION_INVALID' });
  const emails = await repository.withConnection(pool, (connection) => repository.findEmails(connection, first.data.legajo));
  assert.equal(emails.find((email) => email.estado === 'ACTUAL').email, pendingEmail);
  assert.equal(emails.find((email) => email.estado === 'ANTERIOR').email, first.data.email);
});

/** Comprueba consumo único de reset entre dos conexiones y auditoría de contraseña sin valores. */
test('MySQL: reset concurrente modifica hash una vez y revoca sesiones', { skip: !enabled }, async () => {
  const account = await activeAccount();
  await service.forgotPassword({ email: account.data.email }, context);
  const token = notices.findLast((notice) => notice.type === 'RESET_PASSWORD' && notice.to === account.data.email).token;
  const results = await Promise.allSettled([
    service.resetPassword({ token, newPassword: '5678' }, context),
    service.resetPassword({ token, newPassword: '9012' }, context),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'TOKEN_INVALID');
  await assert.rejects(service.authenticateToken(account.signed.token, context), { code: 'SESSION_INVALID' });
  const [audit] = await pool.execute(
    "SELECT valor_anterior, valor_nuevo FROM empleados_auditoria WHERE legajo = ? AND evento = 'PASSWORD_CAMBIADA'", [account.data.legajo],
  );
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0], { valor_anterior: null, valor_nuevo: null });
});

/** Verifica lectura real del estado por request, persistencia de perfil y cierre individual de sesión. */
test('MySQL: perfil persiste, logout es individual y cuenta desactivada no usa JWT anterior', { skip: !enabled }, async t => {
  const account = await activeAccount();
  const observation = evidence('ESC-02');
  const origin = 'http://localhost:5173';
  const request = await startTestServer(t, createApp({ env: { NODE_ENV: 'test', FRONTEND_ORIGIN: origin }, authContext: context }));
  const credentials = { email: account.data.email, password: '1234' };
  const login = observation.http('POST', '/api/auth/login', credentials,
    await request('/api/auth/login', { method: 'POST', headers: { origin }, body: JSON.stringify(credentials) }));
  assert.equal(login.status, 200);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const sessions = phase => observation.sql(pool, phase,
    'SELECT legajo, issued_at, expires_at, revoked_at, revocation_reason FROM auth_sesiones WHERE legajo=? ORDER BY issued_at, jti', [account.data.legajo]);
  const initial = await sessions('antes');
  assert.equal(initial.length, 2);
  assert.ok(initial.every(row => row.revoked_at === null));
  await service.editProfile(account.claims, { telefono: '11111111', segundo_nombre: null }, context);
  assert.equal((await service.getProfile(account.claims, context)).user.telefono, '11111111');
  const out = observation.http('POST', '/api/auth/logout', {},
    await request('/api/auth/logout', { method: 'POST', headers: { origin, cookie }, body: '{}' }));
  assert.equal(out.status, 204);
  assert.match(out.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  const replay = observation.http('GET', '/api/auth/me', undefined, await request('/api/auth/me', { headers: { cookie } }));
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'SESSION_INVALID');
  const final = await sessions('despues');
  assert.equal(final.filter(row => row.revoked_at !== null && row.revocation_reason === 'LOGOUT').length, 1);
  assert.equal(final.filter(row => row.revoked_at === null).length, 1);
  assert.equal((await service.authenticateToken(account.signed.token, context)).user.legajo, account.data.legajo);
  observation.accepted('La cookie original recibe HTTP 401 tras logout; MySQL conserva una sesión LOGOUT y otra sesión válida.');
  await pool.execute("UPDATE empleados SET estado = 'INACTIVO' WHERE legajo = ?", [account.data.legajo]);
  await assert.rejects(service.authenticateToken(account.signed.token, context), { code: 'SESSION_INVALID' });
});

/** Coordina login y cambio de estado con plazo acotado; libera barrera y espera operaciones aun ante fallos. */
test('MySQL: login revalida estado modificado concurrentemente después de bcrypt', { skip: !enabled }, async () => {
  const account = await activeAccount();
  let observed;
  let proceed;
  let paused = false;
  const read = new Promise((resolve) => { observed = resolve; });
  const gate = new Promise((resolve) => { proceed = resolve; });
  const connections = new Set();
  const timeoutError = new Error('La coordinación concurrente del login superó 30 segundos.');
  let timedOut = false;
  let timer;
  const deadline = new Promise((resolve, reject) => {
    /** Libera la barrera e interrumpe las consultas de esta fase al vencer el plazo. */
    timer = setTimeout(() => {
      timedOut = true;
      proceed();
      for (const connection of connections) connection.destroy();
      reject(timeoutError);
    }, 30_000);
  });
  const racePool = {
    /**
     * Registra conexiones del pool real usadas por la fase concurrente para poder cancelarlas.
     * @returns {Promise<object>} Conexión real, sin cambiar su configuración o métodos.
     * @throws {Error} Si vence el plazo, incluso mientras se esperaba obtener la conexión.
     */
    async getConnection() {
      if (timedOut) throw timeoutError;
      const connection = await pool.getConnection();
      if (timedOut) {
        connection.destroy();
        throw timeoutError;
      }
      connections.add(connection);
      return connection;
    },
  };
  const raceContext = { ...context, pool: racePool, repository: { ...repository,
    /** Pausa después de liberar la conexión inicial para ordenar la carrera sin sleeps ni bloqueos artificiales SQL. */
    async withConnection(injectedPool, operation, options) {
      const result = await repository.withConnection(injectedPool, operation, options);
      if (!options?.transaction && !paused) {
        paused = true;
        observed();
        await gate;
      }
      return result;
    },
  } };
  const attempt = service.login({ email: account.data.email, password: '1234' }, raceContext);
  // Gestiona el rechazo desde el inicio, aunque el login falle antes de señalar la lectura.
  const loginSettled = Promise.allSettled([attempt]);
  const operations = [attempt];
  let results;
  try {
    await Promise.race([
      read,
      loginSettled.then(
        /** Propaga el fallo temprano o detecta que el login no respetó la pausa esperada. */
        ([result]) => {
          if (result.status === 'rejected') throw result.reason;
          throw new Error('El login finalizó sin alcanzar la barrera de lectura.');
        }),
      deadline,
    ]);
    const stateChange = repository.withConnection(racePool,
      /** Simula modificación externa de estado antes del bloqueo final del login. */
      async (connection) => {
        await repository.findEmployee(connection, account.data.legajo, true);
        await connection.execute("UPDATE empleados SET estado = 'INACTIVO' WHERE legajo = ?", [account.data.legajo]);
      }, { transaction: true });
    operations.push(stateChange);
    await Promise.race([stateChange, deadline]);
  } finally {
    proceed();
    // No se abandona ninguna operación: allSettled espera commit/rollback incluso ante rechazo.
    try { results = await Promise.allSettled(operations); } finally { clearTimeout(timer); }
  }
  if (timedOut) throw timeoutError;
  assert.equal(results[1].status, 'fulfilled');
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[0].reason.code, 'ACCOUNT_NOT_ACTIVE');
});

/** Prueba persistencia efectiva del cambio y que un fallo intermedio revierte contraseña, sesiones y auditoría. */
test('MySQL: cambio de contraseña es persistente y rollback restaura todos sus efectos', { skip: !enabled }, async () => {
  const account = await activeAccount();
  const failing = { ...context, repository: { ...repository,
    /** Fuerza un error posterior al cambio de hash y revocación, antes de confirmar la transacción. */
    async audit() { throw new Error('Fallo de auditoría simulado.'); },
  } };
  await assert.rejects(service.changePassword(account.claims, { currentPassword: '1234', newPassword: '5678' }, failing), /simulado/);
  const before = await repository.withConnection(pool, (connection) => repository.findEmployee(connection, account.data.legajo));
  assert.equal(await verifyPassword('1234', before.password_hash), true);
  assert.equal((await service.authenticateToken(account.signed.token, context)).user.legajo, account.data.legajo);
  await service.changePassword(account.claims, { currentPassword: '1234', newPassword: '5678' }, context);
  const after = await repository.withConnection(pool, (connection) => repository.findEmployee(connection, account.data.legajo));
  assert.equal(await verifyPassword('5678', after.password_hash), true);
  await assert.rejects(service.authenticateToken(account.signed.token, context), { code: 'SESSION_INVALID' });
});

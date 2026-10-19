// Pruebas de integracion HTTP del modulo ADMIN de empleados (SL-1) sobre
// matista_test con el stack real (pool mysql2, migraciones, JWT y
// cookie de AUTH). Solo lectura del catalogo permanente; las cuentas que
// las pruebas crean usan el prefijo 99 y se eliminan al terminar, sin
// tocar el ADMIN permanente 0000000001 ni datos de SIGEC.
// Requieren RUN_DB_TESTS=1 y la carga inicial aplicada (commit E2).

import 'dotenv/config';

import assert from 'node:assert/strict';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApp } from '../../../src/app.js';
import { loadAuthHttpPolicy } from '../../../src/modules/auth/auth.constants.js';
import * as repositorioAuth from '../../../src/modules/auth/auth.repository.js';
import { loadSecurityConfig } from '../../../src/infrastructure/security/config.js';
import { hashPassword } from '../../../src/infrastructure/security/password.js';
import { signAccessToken } from '../../../src/infrastructure/security/jwt.js';
import {
  createDatabasePool, verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase, loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';
import { startTestServer } from '../../../tests/helpers/http.js';

const enabled = process.env.RUN_DB_TESTS === '1';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');
const PREFIJO = '99';
const ORIGIN = 'http://localhost:5173';

let pool;
let api;
let security;
let sessionCounter = 0;

before(async (t) => {
  if (!enabled) return;

  const config = loadDatabaseConfig(process.env, { purpose: 'migration' });
  assertTestDatabase(config);
  pool = createDatabasePool(config);
  await verifyDatabaseConnection(pool, 'matista_test');
  await runMigrations({ pool, config, migrationsDirectory });

  security = loadSecurityConfig(process.env);
  const context = {
    pool,
    repository: repositorioAuth,
    security,
    dummyPasswordHash: await hashPassword(randomBytes(54).toString('base64url'), security),
    now: () => new Date(),
    notify: async () => true,
    reportIncident: () => {},
  };
  const app = createApp({ env: process.env, authContext: context });
  const request = await startTestServer(t, app);
  api = async (ruta, { method = 'GET', data, cookie, origin = ORIGIN, headers = {} } = {}) =>
    request(ruta, {
      method,
      body: data === undefined ? undefined : JSON.stringify(data),
      headers: { ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers },
    });
});

after(async () => {
  if (pool) {
    await pool.end();
  }
});

/** Limpia exclusivamente las filas creadas por las pruebas (prefijo 99). */
async function limpiarCuentasDePrueba() {
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      'DELETE FROM empleados_auditoria WHERE legajo LIKE ? OR actor_legajo LIKE ?',
      [`${PREFIJO}%`, `${PREFIJO}%`]);
    await connection.execute('DELETE FROM auth_tokens WHERE legajo LIKE ?', [`${PREFIJO}%`]);
    await connection.execute('DELETE FROM auth_sesiones WHERE legajo LIKE ?', [`${PREFIJO}%`]);
    await connection.execute('DELETE FROM empleados_correos WHERE legajo LIKE ?', [`${PREFIJO}%`]);
    await connection.execute('DELETE FROM empleados WHERE legajo LIKE ?', [`${PREFIJO}%`]);
  } finally {
    connection.release();
  }
}

/** Crea una cuenta de prueba con correo ACTUAL verificado, rol y estado pedidos.
 *
 * - Parametros: `datos` con rol, estado y email opcional; usa hash de una
 *   clave fija de pruebas (nunca credenciales reales).
 * - Retorna: el legajo creado.
 */
async function cuentaProbe({ rol = 'ASESOR', estado = 'PENDIENTE', email = null } = {}) {
  const legajo = `${PREFIJO}${String(Date.now()).slice(-6)}${sessionCounter++}`.slice(0, 10);
  const passwordHash = await hashPassword('clave-de-prueba', security);
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `INSERT INTO empleados (legajo, nombre, apellido, password_hash, rol, estado)
       VALUES (?, 'Probe', 'De Test', ?, ?, ?)`,
      [legajo, passwordHash, rol, estado]);
    const correo = email ?? `${legajo}@probe.test`;
    const fecha = new Date();
    await connection.execute(
      `INSERT INTO empleados_correos (legajo, email, estado, verificado_at)
       VALUES (?, ?, 'ACTUAL', ?)`,
      [legajo, correo, fecha]);
    return legajo;
  } finally {
    connection.release();
  }
}

/** Crea la cuenta ADMIN ACTIVO que opera el directorio en cada prueba. */
function cuentaAdminProbe() {
  return cuentaProbe({ rol: 'ADMIN', estado: 'ACTIVO' });
}

/** Emite un JWT real de la cookie AUTH y registra la sesion en la base.
 *
 * - Parametros: `legajo` cuenta probe con sesion abierta.
 * - Retorna: el valor del cookie (token firmado).
 */
async function cookieAutenticada(legajo) {
  const signed = await signAccessToken({ legajo }, security, new Date());
  const connection = await pool.getConnection();
  try {
    await connection.execute(
      `INSERT INTO auth_sesiones (jti, legajo, issued_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [signed.jti, legajo, signed.issuedAt, signed.expiresAt, signed.issuedAt]);
  } finally {
    connection.release();
  }
  return `matista_session=${signed.token}`;
}

describe('ADMIN empleados: rutas HTTP (SL-1)', { skip: !enabled }, () => {
  after(async () => {
    await limpiarCuentasDePrueba();
    // Defensa final: el catalogo permanente queda intacto.
    const connection = await pool.getConnection();
    try {
      const [permanentes] = await connection.execute(
        "SELECT rol, estado FROM empleados WHERE legajo = '0000000001'");
      assert.deepEqual(permanentes, [{ rol: 'ADMIN', estado: 'ACTIVO' }]);
      const [residuos] = await connection.execute(
        "SELECT COUNT(*) AS total FROM empleados WHERE legajo LIKE '99%'");
      assert.equal(residuos[0].total, 0);
    } finally {
      connection.release();
    }
  });

  test('rechaza peticiones sin sesion, de ASESOR y con ruta inexistente', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const legajoAsesor = await cuentaProbe({ rol: 'ASESOR', estado: 'ACTIVO' });
    const cookieAdmin = await cookieAutenticada(legajoAdmin);
    const cookieAsesor = await cookieAutenticada(legajoAsesor);

    assert.equal((await api('/api/admin/employees')).status, 401,
      'sin cookie no hay directorio');
    // TC-ADM-01: un ASESOR con sesion valida no ve el directorio.
    const prohibido = await api('/api/admin/employees', { cookie: cookieAsesor });
    assert.equal(prohibido.status, 403);
    assert.equal(prohibido.body.error.code, 'ROLE_FORBIDDEN');

    const respuesta = await api('/api/admin/employees', { cookie: cookieAdmin });
    assert.equal(respuesta.status, 200);
    assert.ok(Array.isArray(respuesta.body.empleados));
    assert.equal(respuesta.headers['cache-control'], 'no-store');
    assert.ok(!respuesta.body.empleados.some((f) => 'password_hash' in f));

    assert.equal((await api('/api/admin/no-existe', { cookie: cookieAdmin })).status, 404);
  });

  test('lista con filtros y detalle publica el correo ACTUAL', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const cookie = await cookieAutenticada(legajoAdmin);
    const objetivo = await cuentaProbe({ estado: 'ACTIVO', email: 'activado-zz@probe.test' });

    const activos = await api('/api/admin/employees?estado=ACTIVO', { cookie });
    assert.ok(activos.body.empleados.some((f) => f.legajo === objetivo));
    assert.ok(activos.body.empleados.every((f) => f.estado === 'ACTIVO'));

    const porBusqueda = await api('/api/admin/employees?busqueda=activado-zz@probe.test', { cookie });
    assert.deepEqual(porBusqueda.body.empleados.map((f) => f.legajo), [objetivo]);
    assert.equal(porBusqueda.body.empleados[0].email, 'activado-zz@probe.test');

    const detalle = await api(`/api/admin/employees/${objetivo}`, { cookie });
    assert.equal(detalle.status, 200);
    assert.equal(detalle.body.empleado.legajo, objetivo);
    assert.ok(!('password_hash' in detalle.body.empleado));

    const inexistente = await api('/api/admin/employees/9000000999', { cookie });
    assert.equal(inexistente.status, 404);
    assert.equal(inexistente.body.error.code, 'ADMIN_NO_ENCONTRADO');

    assert.equal((await api('/api/admin/employees?estado=LOCAL', { cookie })).status, 400);
  });

  // TC-ADM-02..05: ciclo estado y rol con auditoria y revocacion real.
  test('activa, revoca al desactivar y audita los cambios de estado', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const cookie = await cookieAutenticada(legajoAdmin);
    const objetivo = await cuentaProbe({ estado: 'PENDIENTE' });

    const activacion = await api(`/api/admin/employees/${objetivo}/estado`,
      { method: 'PATCH', cookie, data: { estado: 'ACTIVO' } });
    assert.equal(activacion.status, 200);
    assert.equal(activacion.body.empleado.estado, 'ACTIVO');

    // TC-ADM-02/06: la cuenta activada puede autenticarse con la clave de pruebas.
    const correo = `${objetivo}@probe.test`;
    const sesionActivada = await api('/api/auth/login', {
      method: 'POST', data: { email: correo, password: 'clave-de-prueba' } });
    assert.equal(sesionActivada.status, 200);
    const cookieObjetivo = sesionActivada.headers['set-cookie'][0].split(';')[0];

    const desactivada = await api(`/api/admin/employees/${objetivo}/estado`,
      { method: 'PATCH', cookie, data: { estado: 'INACTIVO' } });
    assert.equal(desactivada.status, 200);

    // ADM-001/TC-ADM-06: la desactivacion revoco la sesion abierta y el
    // login vuelve a ser rechazado mientras la cuenta no opera.
    assert.equal((await api('/api/auth/me', { cookie: cookieObjetivo })).status, 401);
    const loginDesactivado = await api('/api/auth/login',
      { method: 'POST', data: { email: correo, password: 'clave-de-prueba' } });
    assert.equal(loginDesactivado.status, 403);
    assert.equal(loginDesactivado.body.error.code, 'ACCOUNT_NOT_ACTIVE');

    const transicion = await api(`/api/admin/employees/${objetivo}/estado`,
      { method: 'PATCH', cookie, data: { estado: 'ACTIVO' } });
    assert.equal(transicion.status, 200);
    // La sesion revocada no revive con la reactivacion; se vuelve a iniciar sesion.
    assert.equal((await api('/api/auth/me', { cookie: cookieObjetivo })).status, 401);
    const reactivado = await api('/api/auth/login',
      { method: 'POST', data: { email: correo, password: 'clave-de-prueba' } });
    assert.equal(reactivado.status, 200);
    assert.ok(reactivado.headers['set-cookie']);

    // Auditoria real: tres ESTADO_CAMBIADO del legajo con el actor ADMIN probe.
    const connection = await pool.getConnection();
    try {
      const [filas] = await connection.execute(
        `SELECT evento, campo, valor_anterior, valor_nuevo, actor_legajo
           FROM empleados_auditoria WHERE legajo = ? ORDER BY id`,
        [objetivo]);
      assert.deepEqual(filas.map((f) => `${f.evento}:${f.campo}:${f.valor_anterior}->${f.valor_nuevo}`),
        ['ESTADO_CAMBIADO:ESTADO:PENDIENTE->ACTIVO',
          'ESTADO_CAMBIADO:ESTADO:ACTIVO->INACTIVO',
          'ESTADO_CAMBIADO:ESTADO:INACTIVO->ACTIVO']);
      assert.ok(filas.every((f) => f.actor_legajo === legajoAdmin));
    } finally {
      connection.release();
    }
  });

  // TC-ADM-04: prohibicion de auto-operacion via HTTP. TC-ADM-05 (ultimo
  // ADMIN) queda cubierto por las pruebas unitarias del servicio: con el
  // fixture permanente el guardia es inalcanzable por HTTP (el actor
  // ADMIN activo siempre cuenta como otro ADMIN) y un intento HTTP real
  // mutaria la cuenta permanente, lo que no se permite.
  test('TC-ADM-04: prohibe auto-operacion y deja intacto el ADMIN permanente', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const cookie = await cookieAutenticada(legajoAdmin);

    const propia = await api(`/api/admin/employees/${legajoAdmin}/estado`,
      { method: 'PATCH', cookie, data: { estado: 'INACTIVO' } });
    assert.equal(propia.status, 409);
    assert.equal(propia.body.error.code, 'OPERACION_PROPIA_NO_PERMITIDA');

    const propiaRol = await api(`/api/admin/employees/${legajoAdmin}/rol`,
      { method: 'PATCH', cookie, data: { rol: 'ASESOR' } });
    assert.equal(propiaRol.status, 409);
    assert.equal(propiaRol.body.error.code, 'OPERACION_PROPIA_NO_PERMITIDA');

    // El ADMIN permanente queda intacto: sigue ACTIVO y con su rol.
    const listado = await api('/api/admin/employees?rol=ADMIN&estado=ACTIVO', { cookie });
    const permanente = listado.body.empleados.find((f) => f.legajo === '0000000001');
    assert.ok(permanente, 'el ADMIN permanente sigue listado');
    assert.equal(permanente.rol, 'ADMIN');
    assert.equal(permanente.estado, 'ACTIVO');
  });

  test('cambia rol con auditoria y sin tocar el ADMIN permanente (TC-ADM-07/08)', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const cookie = await cookieAutenticada(legajoAdmin);
    const objetivo = await cuentaProbe({ estado: 'ACTIVO' });

    const promocion = await api(`/api/admin/employees/${objetivo}/rol`,
      { method: 'PATCH', cookie, data: { rol: 'ADMIN' } });
    assert.equal(promocion.status, 200);
    assert.equal(promocion.body.empleado.rol, 'ADMIN');

    const degradacion = await api(`/api/admin/employees/${objetivo}/rol`,
      { method: 'PATCH', cookie, data: { rol: 'ASESOR' } });
    assert.equal(degradacion.status, 200);
    assert.equal(degradacion.body.empleado.rol, 'ASESOR');

    // Roles solo para cuentas ACTIVO y valores encuadrados.
    const pendiente = await cuentaProbe({ estado: 'PENDIENTE' });
    const rechazoPendiente = await api(`/api/admin/employees/${pendiente}/rol`,
      { method: 'PATCH', cookie, data: { rol: 'ADMIN' } });
    assert.equal(rechazoPendiente.status, 409);
    assert.equal(rechazoPendiente.body.error.code, 'ADMIN_ESTADO');

    const rechazoValor = await api(`/api/admin/employees/${objetivo}/rol`,
      { method: 'PATCH', cookie, data: { rol: 'SUPERVISOR' } });
    assert.equal(rechazoValor.status, 400);

    const connection = await pool.getConnection();
    try {
      const [filas] = await connection.execute(
        `SELECT valor_anterior, valor_nuevo FROM empleados_auditoria
          WHERE legajo = ? AND evento = 'ROL_CAMBIADO' ORDER BY id`,
        [objetivo]);
      assert.deepEqual(filas.map((f) => `${f.valor_anterior}->${f.valor_nuevo}`),
        ['ASESOR->ADMIN', 'ADMIN->ASESOR']);
    } finally {
      connection.release();
    }
  });

  test('el guardia de negocio deja al ADMIN permanente en el listado', { skip: !enabled }, async (t) => {
    const legajoAdmin = await cuentaAdminProbe();
    const cookie = await cookieAutenticada(legajoAdmin);

    const listado = await api('/api/admin/employees?rol=ADMIN&estado=ACTIVO', { cookie });
    assert.ok(listado.body.empleados.some((f) => f.legajo === '0000000001'),
      'el ADMIN permanente sigue listado y activo');
  });
});

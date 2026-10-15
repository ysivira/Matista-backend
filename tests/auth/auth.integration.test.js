import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../src/app.js';
import { loadAuthHttpPolicy } from '../../src/modules/auth/auth.constants.js';
import { startTestServer } from '../helpers/http.js';
import { memoryContext, fixtureSession, registration, localEnv } from './fixtures.js';
import { securityConfig } from '../helpers/security.js';

/**
 * Monta HTTP real en loopback con persistencia y correo simulados, sin cargar .env.
 * @param {object} t Contexto de prueba para cerrar el puerto efímero.
 * @param {object} fixture Estado y dependencias sintéticas.
 * @param {object} env Política HTTP de prueba; producción usa solo origen HTTPS explícito.
 * @returns {Promise<Function>} Cliente local que permite sustituir Origin y cookie.
 */
async function startApi(t, fixture, env = localEnv) {
  const request = await startTestServer(t, createApp({ env, authContext: fixture.context }));
  /** Envía una solicitud AUTH local, con JSON, Origin y cookie explícitos por caso de prueba. */
  return async function api(path, { method = 'GET', data, cookie, origin = env.FRONTEND_ORIGIN, headers = {} } = {}) {
    return request(path, { method, body: data === undefined ? undefined : JSON.stringify(data), headers: {
      ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}), ...headers,
    } });
  };
}

/** Comprueba flujo HTTP de registro y verificación sin confundir la activación administrativa con AUTH. */
test('registro → verificación → fixture de aprobación → login → perfil → logout', async (t) => {
  const f = memoryContext({ seed: false });
  const api = await startApi(t, f);
  const data = registration();
  const registered = await api('/api/auth/register', { method: 'POST', data });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.estado, 'PENDIENTE');
  assert.equal(registered.headers['set-cookie'], undefined);
  const token = f.notices[0].token;
  const verified = await api('/api/auth/verify-email', { method: 'POST', data: { token } });
  assert.equal(verified.body.code, 'EMAIL_VERIFIED');
  const pending = await api('/api/auth/login', { method: 'POST', data: { email: data.email, password: data.password } });
  assert.equal(pending.status, 403);
  assert.equal(pending.body.error.code, 'ACCOUNT_PENDING_APPROVAL');
  assert.equal(pending.headers['set-cookie'], undefined);
  f.state.employees[0].estado = 'ACTIVO'; // Fixture, no endpoint ni implementación ADMIN.
  const logged = await api('/api/auth/login', { method: 'POST', data: { email: data.email, password: data.password } });
  assert.equal(logged.status, 200);
  assert.equal(Object.hasOwn(logged.body, 'token'), false);
  assert.match(logged.headers['set-cookie'][0], /HttpOnly/);
  assert.match(logged.headers['set-cookie'][0], /SameSite=Strict/);
  assert.match(logged.headers['set-cookie'][0], /Path=\/api/);
  assert.equal(logged.headers['set-cookie'][0].includes('Secure'), false);
  const cookie = logged.headers['set-cookie'][0].split(';')[0];
  const profile = await api('/api/auth/me', { cookie });
  assert.equal(profile.status, 200);
  assert.equal(profile.body.user.email, data.email);
  assert.equal(profile.headers['cache-control'], 'no-store');
  assert.equal(Object.hasOwn(profile.body.user, 'password_hash'), false);
  const edited = await api('/api/auth/me', { method: 'PATCH', cookie, data: { telefono: '11111111', segundo_nombre: null } });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.user.telefono, '11111111');
  const out = await api('/api/auth/logout', { method: 'POST', cookie, data: {} });
  assert.equal(out.status, 204);
  assert.match(out.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  assert.equal((await api('/api/auth/me', { cookie })).status, 401);
  assert.equal((await api('/api/auth/logout', { method: 'POST', cookie, data: {} })).status, 204);
});

/** Verifica que campos desconocidos no se transformen en asignación masiva al registrar o editar perfil. */
test('validadores rechazan rol, estado, DNI o credenciales fuera de su contrato', async (t) => {
  const f = memoryContext();
  f.state.employees[0].segundo_nombre = 'Segundo';
  f.state.employees[0].telefono = '11111111';
  const api = await startApi(t, f);
  const signed = await fixtureSession(f);
  const cookie = `matista_session=${signed.token}`;
  for (const data of [{ rol: 'ADMIN' }, { estado: 'ACTIVO' }, { legajo: '87654321' }, { password_hash: 'no' },
    { telefono: '123', rol: 'ADMIN' }, {}, []]) {
    const response = await api('/api/auth/me', { method: 'PATCH', cookie, data });
    assert.equal(response.status, 400);
  }
  const forbidden = await api('/api/auth/register', { method: 'POST', data: registration({ rol: 'ADMIN' }) });
  assert.equal(forbidden.status, 400);
  assert.equal(f.state.employees.length, 1);
  assert.equal(f.state.employees[0].rol, 'ASESOR');
  const cleared = await api('/api/auth/me', { method: 'PATCH', cookie, data: { segundo_nombre: null } });
  assert.equal(cleared.status, 200);
  assert.equal(f.state.employees[0].segundo_nombre, null);
  assert.equal(f.state.employees[0].telefono, '11111111');
  assert.equal(f.state.employees[0].nombre, 'Persona');
  const bearer = await api('/api/auth/me', { headers: { authorization: `Bearer ${signed.token}` } });
  assert.equal(bearer.status, 401);
});

/** CORS no sustituye Origin: las escrituras sin cabecera o con origen distinto siempre se rechazan. */
test('desarrollo exige Origin exacto en todas las operaciones mutables y CORS no permite comodines', async (t) => {
  const f = memoryContext();
  const api = await startApi(t, f);
  for (const origin of [null, 'null', 'http://evil.example', 'http://localhost:5173.evil.example', 'http://127.0.0.1:5173']) {
    const response = await api('/api/auth/login', { method: 'POST', origin, data: { email: 'fixture@example.test', password: '1234' } });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const allowed = await api('/api/health');
  assert.equal(allowed.headers['access-control-allow-origin'], localEnv.FRONTEND_ORIGIN);
  assert.equal(allowed.headers['access-control-allow-credentials'], 'true');
  const preflight = await api('/api/auth/login', { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], localEnv.FRONTEND_ORIGIN);
  assert.equal(f.state.sessions.length, 0);
});

/** Producción exige HTTPS y cookies Secure; no admite origen faltante, rutas o comodines configurados. */
test('producción aplica cookies seguras y configuración restrictiva sin modificar políticas de B', async (t) => {
  const f = memoryContext();
  f.context.security = securityConfig({ NODE_ENV: 'production' });
  const env = { NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://matista.example' };
  const api = await startApi(t, f, env);
  const logged = await api('/api/auth/login', { method: 'POST', data: { email: 'fixture@example.test', password: '1234' } });
  assert.equal(logged.status, 200);
  assert.match(logged.headers['set-cookie'][0], /Secure/);
  assert.match(logged.headers['set-cookie'][0], /HttpOnly/);
  assert.match(logged.headers['set-cookie'][0], /SameSite=Strict/);
  assert.equal(logged.headers['set-cookie'][0].includes('Domain='), false);
  const cookie = logged.headers['set-cookie'][0].split(';')[0];
  const missing = await api('/api/auth/logout', { method: 'POST', cookie, origin: null, data: {} });
  assert.equal(missing.status, 403);
  const logout = await api('/api/auth/logout', { method: 'POST', cookie, data: {} });
  assert.match(logout.headers['set-cookie'][0], /Secure/);
  assert.match(logout.headers['set-cookie'][0], /Path=\/api/);
  const reduced = await api('/api/auth/register', { method: 'POST', data: registration() });
  assert.equal(reduced.status, 400);
  assert.equal(reduced.body.error.code, 'PASSWORD_INVALID');
  assert.equal((await api('/api/auth/register', { method: 'POST', data: registration({ password: '1234567890' }) })).status, 201);
  for (const FRONTEND_ORIGIN of [undefined, 'http://matista.example', '*', 'https://*.example',
    'https://matista.example/', 'https://user:password@matista.example', 'https://matista.example?next=x']) {
    assert.throws(() => loadAuthHttpPolicy({ NODE_ENV: 'production', FRONTEND_ORIGIN }), /FRONTEND_ORIGIN/);
  }
  assert.throws(() => loadAuthHttpPolicy({ NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://remote.example' }), /FRONTEND_ORIGIN/);
});

/** Reenvío HTTP sustituye tokens y aplica la política de tres solicitudes por hora de B. */
test('reenvío HTTP es neutro y está limitado independientemente del login', async (t) => {
  const f = memoryContext({ seed: false });
  const api = await startApi(t, f);
  const data = registration();
  await api('/api/auth/register', { method: 'POST', data });
  const firstToken = f.notices[0].token;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await api('/api/auth/resend-verification', { method: 'POST', data: { email: data.email } });
    assert.equal(response.status, 200);
    assert.equal(response.body.code, 'VERIFICATION_REQUEST_ACCEPTED');
  }
  assert.equal((await api('/api/auth/resend-verification', { method: 'POST', data: { email: data.email } })).status, 429);
  assert.equal((await api('/api/auth/verify-email', { method: 'POST', data: { token: firstToken } })).status, 400);
  const lastToken = f.notices.at(-1).token;
  assert.equal((await api('/api/auth/verify-email', { method: 'POST', data: { token: lastToken } })).status, 200);
});

/** Cambio de contraseña HTTP verifica la actual y elimina cookie solo después de confirmar el cambio. */
test('cambio de contraseña HTTP revoca la sesión y exige nueva autenticación', async (t) => {
  const f = memoryContext();
  const api = await startApi(t, f);
  const signed = await fixtureSession(f);
  const cookie = `matista_session=${signed.token}`;
  const wrong = await api('/api/auth/change-password', { method: 'POST', cookie,
    data: { currentPassword: '0000', newPassword: '5678' } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.headers['set-cookie'], undefined);
  const changed = await api('/api/auth/change-password', { method: 'POST', cookie,
    data: { currentPassword: '1234', newPassword: '5678' } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.code, 'PASSWORD_CHANGED');
  assert.match(changed.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  assert.equal((await api('/api/auth/me', { cookie })).status, 401);
});

/** Confirma cambio de correo en su endpoint propio y verifica que el anterior conserve acceso hasta entonces. */
test('POST confirm-email-change consume token, sustituye correo y elimina cookie', async (t) => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  const cookie = `matista_session=${signed.token}`;
  const api = await startApi(t, f);
  const requested = await api('/api/auth/change-email', { method: 'POST', cookie,
    data: { email: 'nuevo@example.test', currentPassword: '1234' } });
  assert.equal(requested.status, 200);
  assert.equal((await api('/api/auth/me', { cookie })).body.user.email, 'fixture@example.test');
  const token = f.notices[0].token;
  const confirmed = await api('/api/auth/confirm-email-change', { method: 'POST', data: { token } });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.code, 'EMAIL_CHANGED');
  assert.match(confirmed.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  assert.equal((await api('/api/auth/me', { cookie })).status, 401);
  assert.equal((await api('/api/auth/confirm-email-change', { method: 'POST', data: { token } })).status, 400);
});

/** La recuperación HTTP no distingue correo existente, desconocido ni fallo de correo simulado. */
test('recuperación y reset HTTP mantienen neutralidad y consumen una sola vez', async (t) => {
  const f = memoryContext();
  const api = await startApi(t, f);
  const known = await api('/api/auth/forgot-password', { method: 'POST', data: { email: 'fixture@example.test' } });
  const token = f.notices[0].token;
  const unknown = await api('/api/auth/forgot-password', { method: 'POST', data: { email: 'no@example.test' } });
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.body, unknown.body);
  const reset = await api('/api/auth/reset-password', { method: 'POST', data: { token, newPassword: '5678' } });
  assert.equal(reset.status, 200);
  assert.equal((await api('/api/auth/reset-password', { method: 'POST', data: { token, newPassword: '9012' } })).status, 400);
  f.context.notify = async () => { throw new Error('SMTP interno privado.'); };
  const failed = await api('/api/auth/forgot-password', { method: 'POST', data: { email: 'fixture@example.test' } });
  assert.deepEqual(failed.body, unknown.body);
  assert.equal((await api('/api/auth/forgot-password', { method: 'POST', data: { email: 'fixture@example.test' } })).status, 429);
});

/** Montaje real reutiliza límites B y no crea superficies paralelas de AUTH o ADMIN. */
test('login tiene límite 5/15 minutos, errores seguros y no monta endpoints legacy', async (t) => {
  const f = memoryContext();
  const api = await startApi(t, f);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await api('/api/auth/login', { method: 'POST', data: { email: 'fixture@example.test', password: '0000' } });
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'INVALID_CREDENTIALS');
  }
  const limited = await api('/api/auth/login', { method: 'POST', data: { email: 'fixture@example.test', password: '0000' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMIT_EXCEEDED');
  const health = await api('/api/health');
  assert.deepEqual(health.body, { status: 'ok', application: 'MATISTA', service: 'backend' });
  assert.equal((await api('/api/auth/login', { method: 'GET' })).status, 404);
  f.context.repository.withConnection = async () => { throw new Error('SQL privado.'); };
  const failed = await api('/api/auth/forgot-password', { method: 'POST', data: { email: 'fixture@example.test' } });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' } });
});

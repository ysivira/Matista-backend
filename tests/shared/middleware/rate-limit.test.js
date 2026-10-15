import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { MemoryStore } from 'express-rate-limit';
import { createAuthRateLimiter } from '../../../src/shared/middleware/rate-limit.js';
import { errorHandler } from '../../../src/shared/errors/error-handler.js';
import { startTestServer } from '../../helpers/http.js';

/** Comprueba límites reales, aislamiento por IP/operación/instancia y recuperación con reloj simulado. */
test('limita operaciones independientemente con 429, cabeceras y recuperación de ventana', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T12:00:00Z') });
  const app = express();
  // Solo el servidor loopback de pruebas actúa como proxy; no cambia la aplicación real.
  app.set('trust proxy', 'loopback');
  for (const [path, operation] of [['/login', 'login'], ['/other-login', 'login'],
    ['/recovery', 'passwordRecovery'], ['/resend', 'verificationResend']]) {
    const store = new MemoryStore();
    /** Libera el temporizador del almacén de esta instancia. */
    t.after(() => store.shutdown());
    app.get(path, createAuthRateLimiter(operation, { store }),
      /** Respuesta de infraestructura, únicamente en aplicación de prueba. */
      (req, res) => res.json({ ok: true }));
  }
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const headers = { 'x-forwarded-for': '192.0.2.1' };
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request('/login', { headers })).status, 200);
  }
  const blocked = await request('/login', { headers });
  assert.equal(blocked.status, 429);
  assert.deepEqual(blocked.body, { error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Demasiadas solicitudes. Intente más tarde.' } });
  assert.match(blocked.headers.ratelimit, /limit=5, remaining=0/);
  assert.equal(blocked.headers['ratelimit-policy'], '5;w=900');
  assert.equal(blocked.headers['retry-after'], '900');
  assert.equal(blocked.headers['x-ratelimit-limit'], undefined);
  assert.equal((await request('/other-login', { headers })).status, 200);
  assert.equal((await request('/login', { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 200);
  for (const path of ['/recovery', '/resend']) {
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal((await request(path, { headers })).status, 200);
    }
    assert.equal((await request(path, { headers })).status, 429);
  }
  t.mock.timers.tick(900000);
  assert.equal((await request('/login', { headers })).status, 200);
  assert.equal((await request('/recovery', { headers })).status, 429);
  t.mock.timers.tick(2700000);
  assert.equal((await request('/recovery', { headers })).status, 200);
  assert.equal((await request('/resend', { headers })).status, 200);
});

/** Verifica configuración explícita y rechazo de máximos o ventanas inválidos. */
test('admite parámetros propios y rechaza configuraciones inválidas', async (t) => {
  for (const options of [{ limit: 0 }, { limit: 1.2 }, { windowMs: 0 }, { windowMs: Infinity }]) {
    assert.throws(() => createAuthRateLimiter('login', options), /inválidos/);
  }
  assert.throws(() => createAuthRateLimiter('unknown'), /inválida/);
  const store = new MemoryStore();
  /** Libera el almacén configurable de prueba. */
  t.after(() => store.shutdown());
  const app = express();
  app.get('/fixture', createAuthRateLimiter('login', { limit: 1, windowMs: 1000, store }),
    /** Confirma que una solicitud permitida continúa normalmente. */
    (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  assert.equal((await request('/fixture')).status, 200);
  assert.equal((await request('/fixture')).status, 429);
});

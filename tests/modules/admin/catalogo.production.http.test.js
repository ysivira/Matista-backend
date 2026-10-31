/**
 * ============================================================
 * MATISTA | CATÁLOGO CON BASE PRODUCTIVA DE NOMBRE HISTÓRICO
 * ============================================================
 *
 * Archivo: catalogo.production.http.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Verificar la inicialización real y el rechazo sin sesión con
 * production/matista_dev, sin conectar a ninguna base de datos.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../../../src/app.js';
import { initializeRuntime } from '../../../src/modules/auth/auth.routes.js';
import { loadAuthHttpPolicy } from '../../../src/modules/auth/auth.constants.js';
import { startTestServer } from '../../helpers/http.js';

test('production/matista_dev inicializa el runtime y catalogo sin cookie responde 401 sin conexiones MySQL', async (t) => {
  const env = {
    NODE_ENV: 'production',
    DB_NAME: 'matista_dev',
    DB_HOST: 'matista-synthetic.invalid',
    DB_PORT: '1',
    DB_USER: 'matista_prueba',
    DB_PASSWORD: 'sin-conexion-real',
    JWT_SECRET: randomBytes(32).toString('base64url'),
    FRONTEND_ORIGIN: 'https://frontend.example',
  };
  let runtime;
  t.after(async () => { await runtime?.pool.end(); });
  // Sin authContext inyectado: la petición debe ejecutar initializeRuntime de verdad.
  const request = await startTestServer(t, createApp({ env }));
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok', application: 'MATISTA', service: 'backend' });

  const first = await request('/api/catalogo/planes');
  runtime = await initializeRuntime(env, loadAuthHttpPolicy(env));
  assert.equal(runtime.security.nodeEnv, 'production');
  assert.equal(runtime.security.password.minLength, 10);
  assert.match(runtime.dummyPasswordHash, /^\$2[aby]\$12\$/);
  assert.equal(runtime.pool.pool.config.connectionConfig.database, 'matista_dev');

  for (const response of [first, await request('/api/catalogo/planes')]) {
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, {
      error: { code: 'SESSION_REQUIRED', message: 'Debe iniciar sesión para continuar.' },
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(runtime.pool.pool._allConnections.length, 0);
});

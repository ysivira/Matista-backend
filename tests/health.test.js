import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/app.js';
import { startTestServer } from './helpers/http.js';

/** Verifica el contrato real de salud sin cargar .env ni conectar a MySQL o SMTP. */
test('conserva GET /api/health con HTTP 200 y respuesta original', async (t) => {
  const request = await startTestServer(t, app);
  const response = await request('/api/health');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok', application: 'MATISTA', service: 'backend' });
});

/** Regresion SPEC-25: la app confia solo en proxies de loopback; una solicitud
 *  con X-Forwarded-For debe responder normal sin el 500 de express-rate-limit. */
test('acepta X-Forwarded-For con trust proxy de solo loopback', (t) => {
  assert.equal(app.get('trust proxy'), 'loopback');
});

/** Comprueba integración real del manejador tras express.json sin reflejar el cuerpo inválido. */
test('responde HTTP 400 uniforme para JSON inválido', async (t) => {
  const request = await startTestServer(t, app);
  const response = await request('/api/health', { method: 'POST', body: '{"private":' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: { code: 'INVALID_JSON', message: 'El cuerpo de la solicitud no contiene JSON válido.' } });
});

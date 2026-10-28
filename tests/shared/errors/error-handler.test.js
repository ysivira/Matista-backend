/**
 * ============================================================
 * MATISTA | PRUEBAS DE ERRORES HTTP
 * ============================================================
 *
 * Archivo: error-handler.test.js
 * Módulo: Pruebas compartidas
 *
 * Responsabilidad:
 * Verificar errores públicos, parser y ocultamiento de datos
 * internos mediante endpoints locales de prueba.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import { createAppError } from '../../../src/shared/errors/app-error.js';
import { errorHandler } from '../../../src/shared/errors/error-handler.js';
import { startTestServer } from '../../helpers/http.js';

/** Comprueba el contrato operativo y la exclusión de propiedades adicionales de sus detalles. */
test('devuelve errores operativos uniformes con detalles públicos', async (t) => {
  const app = express();
  /** Genera un error de prueba sin montar rutas funcionales AUTH. */
  app.get('/fixture', (req, res, next) => next(createAppError('INPUT_INVALID', 'Revise los datos.', 400,
    [{ field: 'email', message: 'Correo inválido.', value: 'no-publicar', sql: 'no-publicar' }])));
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const response = await request('/fixture');
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: { code: 'INPUT_INVALID', message: 'Revise los datos.',
    details: [{ field: 'email', message: 'Correo inválido.' }] } });
});

/** Un error de biblioteca no adquiere carácter público por tener status o code. */
test('oculta stack, SQL, secretos y propiedades de errores inesperados', async (t) => {
  const app = express();
  const sensitive = randomBytes(24).toString('hex');
  const registros = [];
  t.mock.method(console, 'error', (...argumentos) => registros.push(argumentos));
  /** Simula un error interno con datos privados sin exponerlos ni registrarlos. */
  app.get('/fixture', (req, res, next) => {
    const error = Object.assign(new Error(sensitive), { code: 'MYSQL_FAILURE', status: 400, sql: sensitive });
    next(error);
  });
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const response = await request('/fixture');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' } });
  assert.equal(JSON.stringify(response.body).includes(sensitive), false);
  assert.equal(JSON.stringify(registros).includes(sensitive), false);
  assert.deepEqual(registros[0], [
    '[matista] error 500 no controlado',
    { method: 'GET', path: '/fixture', errorName: 'Error' },
  ]);
});

/** Delega el error original sin intentar escribir una segunda respuesta. */
test('respeta headersSent y valida el contrato de errores operativos', () => {
  const error = new Error('fixture');
  let delegated;
  errorHandler(error, {}, { headersSent: true }, (received) => { delegated = received; });
  assert.equal(delegated, error);
  assert.throws(() => createAppError('invalid code', 'Público', 400), /Contrato/);
  assert.throws(() => createAppError('INVALID', 'Público', 200), /Contrato/);
});

/** Verifica respuestas seguras ante errores reales de JSON, tamaño y codificaciones del parser. */
test('conserva HTTP 400, 413 y 415 para errores conocidos del parser Express', async (t) => {
  const app = express();
  app.use(express.json({ limit: 128 }));
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const cases = [
    { body: '{"private":', status: 400, code: 'INVALID_JSON', message: 'El cuerpo de la solicitud no contiene JSON válido.' },
    { body: JSON.stringify({ private: 'a'.repeat(200) }), status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'El cuerpo de la solicitud supera el tamaño permitido.' },
    { body: '{}', headers: { 'content-encoding': 'unsupported' }, status: 415, code: 'UNSUPPORTED_CONTENT', message: 'La codificación o el tipo de contenido no es compatible con el parser.' },
    { body: '{}', headers: { 'content-type': 'application/json; charset=iso-8859-1' }, status: 415, code: 'UNSUPPORTED_CONTENT', message: 'La codificación o el tipo de contenido no es compatible con el parser.' },
  ];
  for (const fixture of cases) {
    const response = await request('/fixture', { method: 'POST', body: fixture.body, headers: fixture.headers });
    assert.equal(response.status, fixture.status);
    assert.deepEqual(response.body, { error: { code: fixture.code, message: fixture.message } });
  }
});

/** Evita confiar en estados HTTP arbitrarios o parejas tipo/estado inconsistentes. */
test('mantiene HTTP 500 para errores desconocidos aunque declaren un status de cliente', async (t) => {
  const app = express();
  /** Produce errores de prueba fuera de la lista explícita de tipos y estados admitidos. */
  app.get('/fixture/:kind', (req, res, next) => next(Object.assign(new Error('Información interna.'),
    req.params.kind === 'unknown' ? { type: 'unknown', status: 415 } : { type: 'entity.too.large', status: 400 })));
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  for (const path of ['/fixture/unknown', '/fixture/mismatch']) {
    const response = await request(path);
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' } });
  }
});

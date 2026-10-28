/**
 * ============================================================
 * MATISTA | PRUEBAS DE MENSAJES DE VALIDACIÓN
 * ============================================================
 *
 * Archivo: validation-result.test.js
 * Módulo: Pruebas compartidas
 *
 * Responsabilidad:
 * Verificar publicación de mensajes marcados y ocultamiento de
 * excepciones o valores internos de validadores personalizados.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import express from 'express';
import { body } from 'express-validator';
import { handleValidationResult, publicValidationMessage } from '../../../src/shared/validators/validation-result.js';
import { errorHandler } from '../../../src/shared/errors/error-handler.js';
import { startTestServer } from '../../helpers/http.js';

/** Verifica cadenas reales de express-validator con mensajes públicos y sin los valores recibidos. */
test('adapta campos inválidos y continúa si la entrada es válida', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/fixture', body('email').isEmail().withMessage(publicValidationMessage('Ingrese un correo válido.')),
    body('password').isLength({ min: 4 }).withMessage(publicValidationMessage('Ingrese al menos cuatro caracteres.')),
    handleValidationResult,
    /** Responde solo cuando la validación de prueba permite continuar. */
    (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const invalid = await request('/fixture', { method: 'POST', body: JSON.stringify({ email: 'inválido', password: 'abc' }) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: { code: 'VALIDATION_FAILED', message: 'Revise los campos indicados.', details: [
    { field: 'email', message: 'Ingrese un correo válido.' },
    { field: 'password', message: 'Ingrese al menos cuatro caracteres.' },
  ] } });
  assert.equal(JSON.stringify(invalid.body).includes('abc'), false);
  const valid = await request('/fixture', { method: 'POST', body: JSON.stringify({ email: 'fixture@example.test', password: '1234' }) });
  assert.deepEqual(valid.body, { ok: true });
});

/** Evita serializar objetos usados accidentalmente como mensajes de validación. */
test('reemplaza mensajes no textuales por un mensaje seguro', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/fixture', body('email').isEmail().withMessage({ private: 'no-publicar' }),
    handleValidationResult);
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const response = await request('/fixture', { method: 'POST', body: '{}' });
  assert.deepEqual(response.body.error.details, [{ field: 'email', message: 'Valor inválido.' }]);
});

/** Comprueba que una excepción interna textual nunca se publique como mensaje de validación. */
test('oculta excepciones internas y cadenas sin marcar de validadores personalizados', async (t) => {
  const sensitive = randomBytes(24).toString('hex');
  const app = express();
  app.use(express.json());
  app.post('/fixture', body('password').custom(
    /** Simula un fallo interno con SQL y un dato sensible, sin acceder a ninguna base. */
    () => { throw new Error(`SQL interno: ${sensitive}`); }),
  body('email').isEmail().withMessage(`Información interna: ${sensitive}`),
  handleValidationResult);
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const response = await request('/fixture', { method: 'POST', body: JSON.stringify({ password: sensitive, email: sensitive }) });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body, { error: { code: 'VALIDATION_FAILED', message: 'Revise los campos indicados.', details: [
    { field: 'password', message: 'Valor inválido.' },
    { field: 'email', message: 'Valor inválido.' },
  ] } });
  assert.equal(JSON.stringify(response.body).includes(sensitive), false);
  assert.equal(JSON.stringify(response.body).includes('SQL interno'), false);
});

/** Conserva mensajes públicos esperados en validaciones personalizadas sin propagar su excepción. */
test('conserva un mensaje público explícito y rechaza declaraciones inválidas', async (t) => {
  const app = express();
  app.use(express.json());
  app.post('/fixture', body('email').custom(
    /** Simula una validación personalizada fallida; su mensaje interno no es público. */
    () => { throw new Error('Fallo interno del fixture.'); })
    .withMessage(publicValidationMessage('El correo no está disponible.')), handleValidationResult);
  app.use(errorHandler);
  const request = await startTestServer(t, app);
  const response = await request('/fixture', { method: 'POST', body: '{}' });
  assert.equal(response.status, 400);
  assert.deepEqual(response.body.error.details, [{ field: 'email', message: 'El correo no está disponible.' }]);
  assert.throws(() => publicValidationMessage(' '), /texto no vacío/);
  assert.throws(() => publicValidationMessage({ message: 'No marcado' }), /texto no vacío/);
});

/** Pruebas del observador de evidencia: sin MySQL, sin secretos ni archivos externos. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { evidence, redactEvidence } from '../helpers/evidence.js';

test('SPEC06 evidencia oculta secretos incluso dentro de JSON y distingue contactos sin publicarlos', () => {
  const redacted = redactEvidence({ password: 'secreto', token: 'jwt', cookie: 'sesión', jti: 'id-sesion',
    solicitud: JSON.stringify({ cliente: { nombres: 'Persona', dni: '12345678', email: 'persona@example.test' } }),
    contacto: JSON.stringify({ telefono: '1111111' }) });
  const text = JSON.stringify(redacted);
  for (const secret of ['secreto', 'jwt', 'sesión', 'id-sesion', 'Persona', '12345678', 'persona@example.test', '1111111']) assert.ok(!text.includes(secret));
  assert.notDeepEqual(redactEvidence({ telefono: '1111111' }), redactEvidence({ telefono: '2222222' }));
});

test('SPEC06 consultas de evidencia rechazan escrituras y sentencias múltiples antes de conectar', async () => {
  const pool = { execute() { assert.fail('No debe ejecutar SQL rechazado'); } };
  for (const sql of ['UPDATE clientes SET revision=2', 'DELETE FROM clientes', 'SELECT 1; DELETE FROM clientes']) {
    await assert.rejects(evidence('CONTROL').sql(pool, 'control', sql));
  }
});

test('SPEC06 observación conserva filas originales sin convertirlas en valores redactados', async () => {
  const rows = [{ id: 7, telefono: '1111111' }];
  const returned = await evidence('CONTROL').sql({ async execute(sql, args) {
    assert.equal(sql, 'SELECT id, telefono FROM clientes WHERE id=?'); assert.deepEqual(args, [7]);
    return [rows];
  } }, 'control', 'SELECT id, telefono FROM clientes WHERE id=?', [7]);
  assert.equal(returned, rows); assert.equal(rows[0].telefono, '1111111');
});

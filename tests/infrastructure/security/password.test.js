/**
 * ============================================================
 * MATISTA | PRUEBAS DE CONTRASEÑAS
 * ============================================================
 *
 * Archivo: password.test.js
 * Módulo: Pruebas de seguridad
 *
 * Responsabilidad:
 * Comprobar política bcrypt, sal aleatoria y límites UTF-8,
 * conservando espacios y Unicode en las credenciales sintéticas.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import bcrypt from 'bcryptjs';
import { hashPassword, verifyPassword } from '../../../src/infrastructure/security/password.js';
import { securityConfig } from '../../helpers/security.js';

/** Usa contraseñas ficticias de cuatro dígitos únicamente para probar la política local. */
test('permite cuatro caracteres locales, genera sal aleatoria y usa costo 12', async () => {
  const config = securityConfig();
  const first = await hashPassword('1234', config);
  const second = await hashPassword('1234', securityConfig({ NODE_ENV: 'development' }));
  assert.notEqual(first, second);
  assert.equal(bcrypt.getRounds(first), 12);
  assert.equal(await verifyPassword('1234', first), true);
  assert.equal(await verifyPassword('4321', first), false);
  assert.notEqual(first, '1234');
});

/** Impone diez caracteres al crear en producción sin impedir comparar hashes anteriores. */
test('aplica el mínimo al crear o cambiar y no al comparar un hash existente', async () => {
  const production = securityConfig({ NODE_ENV: 'production' });
  await assert.rejects(hashPassword('1234', production), { code: 'PASSWORD_INVALID' });
  await assert.rejects(hashPassword('123456789', production), { code: 'PASSWORD_INVALID' });
  const hash = await hashPassword('1234567890', production);
  assert.equal(await verifyPassword('1234567890', hash), true);
  const legacy = await bcrypt.hash('123', 4);
  assert.equal(await verifyPassword('123', legacy), true);
});

/** Verifica bytes UTF-8 y evita equivalencias por truncamiento de bcrypt. */
test('acepta exactamente 72 bytes y rechaza excesos ASCII o multibyte', async () => {
  const config = securityConfig();
  const exact = 'á'.repeat(36);
  const hash = await hashPassword(exact, config);
  assert.equal(await verifyPassword(exact, hash), true);
  for (const password of ['a'.repeat(73), exact + 'a', '😀'.repeat(19), null, '123']) {
    await assert.rejects(hashPassword(password, config), { code: 'PASSWORD_INVALID' });
  }
  assert.equal(await verifyPassword(exact + 'a', hash), false);
});

/** Asegura que espacios y Unicode no sufran normalización silenciosa. */
test('conserva espacios y Unicode y rechaza entradas de comparación inválidas', async () => {
  const hash = await hashPassword(' áé ', securityConfig());
  assert.equal(await verifyPassword(' áé ', hash), true);
  assert.equal(await verifyPassword('áé', hash), false);
  assert.equal(await verifyPassword(' a\u0301é ', hash), false);
  assert.equal(await verifyPassword(null, hash), false);
  assert.equal(await verifyPassword('1234', 'hash inválido'), false);
});

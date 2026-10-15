import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSecurityConfig, RATE_LIMIT_POLICIES } from '../../../src/infrastructure/security/config.js';
import { securityConfig } from '../../helpers/security.js';

/** Comprueba mínimos por entorno y que producción nunca acepte la política reducida. */
test('separa las políticas de desarrollo, pruebas y producción', () => {
  assert.equal(securityConfig({ NODE_ENV: 'development', PASSWORD_MIN_LENGTH: '4' }).password.minLength, 4);
  assert.equal(securityConfig({ PASSWORD_MIN_LENGTH: '4' }).password.minLength, 4);
  assert.equal(securityConfig({ NODE_ENV: 'production' }).password.minLength, 10);
  for (const value of ['4', '9', '', '10.5', '73', 'abc']) {
    assert.throws(() => securityConfig({ NODE_ENV: 'production', PASSWORD_MIN_LENGTH: value }), /PASSWORD_MIN_LENGTH/);
  }
  assert.equal(securityConfig({ NODE_ENV: 'production', PASSWORD_MIN_LENGTH: '12' }).password.minLength, 12);
});

/** Rechaza secretos ausentes, débiles por longitud, no canónicos y entornos desconocidos. */
test('valida configuración sin revelar el secreto ni aceptar valores silenciosos', () => {
  for (const JWT_SECRET of [undefined, '', 'breve', 'a'.repeat(42), 'no válido', 'a'.repeat(43) + '=']) {
    assert.throws(() => securityConfig({ JWT_SECRET }), /JWT_SECRET/);
  }
  assert.throws(() => securityConfig({ NODE_ENV: 'staging' }), /NODE_ENV/);
  assert.throws(() => loadSecurityConfig({}), /NODE_ENV/);
  assert.throws(() => securityConfig({ JWT_ISSUER: ' ' }), /emisor/);
  assert.throws(() => securityConfig({ JWT_AUDIENCE: '' }), /audiencia/);
});

/** Verifica duraciones, algoritmo y límites aprobados en un único contrato inmutable. */
test('conserva parámetros aprobados y estructuras congeladas', () => {
  const config = securityConfig();
  assert.deepEqual(config.password, { minLength: 4, maxBytes: 72, cost: 12 });
  assert.equal(config.jwt.algorithm, 'HS256');
  assert.equal(config.jwt.durationSeconds, 7200);
  assert.deepEqual(config.tokens, { VERIFICAR_EMAIL: 86400, RESET_PASSWORD: 1800 });
  assert.deepEqual(RATE_LIMIT_POLICIES.login, { limit: 5, windowMs: 900000 });
  assert.deepEqual(RATE_LIMIT_POLICIES.passwordRecovery, { limit: 3, windowMs: 3600000 });
  assert.deepEqual(RATE_LIMIT_POLICIES.verificationResend, { limit: 3, windowMs: 3600000 });
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.password) && Object.isFrozen(config.jwt));
});

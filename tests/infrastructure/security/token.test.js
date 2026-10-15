import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createTemporaryToken, hashTemporaryToken } from '../../../src/infrastructure/security/token.js';
import { securityConfig } from '../../helpers/security.js';

/** Comprueba tamaño aleatorio, hash binario determinista y caducidades aprobadas con reloj fijo. */
test('genera tokens y hashes BINARY(32) con caducidades de 24 horas y 30 minutos', () => {
  const config = securityConfig();
  const now = new Date('2026-10-15T12:00:00Z');
  for (const [type, duration] of Object.entries(config.tokens)) {
    const result = createTemporaryToken(type, config, now);
    assert.match(result.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(result.token, 'base64url').length, 32);
    assert.equal(Buffer.isBuffer(result.tokenHash), true);
    assert.equal(result.tokenHash.length, 32);
    assert.deepEqual(result.tokenHash, createHash('sha256').update(result.token).digest());
    assert.deepEqual(hashTemporaryToken(result.token), result.tokenHash);
    assert.equal(result.expiresAt.getTime() - now.getTime(), duration * 1000);
    assert.notEqual(result.token, createTemporaryToken(type, config, now).token);
  }
});

/** Evita propósitos desconocidos, duraciones inválidas y desbordamiento de fechas. */
test('rechaza duraciones, vencimientos y formatos inválidos sin incluir el token', () => {
  const config = securityConfig();
  assert.throws(() => createTemporaryToken('otro', config), /inválidos/);
  for (const duration of [0, -1, 1.5, Infinity]) {
    assert.throws(() => createTemporaryToken('RESET_PASSWORD', { tokens: { RESET_PASSWORD: duration } }), /inválidos/);
  }
  assert.throws(() => createTemporaryToken('RESET_PASSWORD', config, new Date('invalid')), /inválidos/);
  assert.throws(() => createTemporaryToken('RESET_PASSWORD', config, new Date(8640000000000000)), /Vencimiento/);
  for (const value of [null, '', 'token-inválido', 'a'.repeat(43)]) {
    assert.throws(() => hashTemporaryToken(value), { message: 'Formato de token temporal inválido.' });
  }
});

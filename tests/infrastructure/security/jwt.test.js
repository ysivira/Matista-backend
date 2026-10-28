/**
 * ============================================================
 * MATISTA | PRUEBAS CRIPTOGRÁFICAS JWT
 * ============================================================
 *
 * Archivo: jwt.test.js
 * Módulo: Pruebas de seguridad
 *
 * Responsabilidad:
 * Probar firma, claims, tiempos y rechazos de JWT manipulados
 * o inválidos con claves y relojes de prueba.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken } from '../../../src/infrastructure/security/jwt.js';
import { securityConfig } from '../../helpers/security.js';

const now = new Date('2026-10-15T12:00:00.123Z');

/**
 * Genera JWT firmados de prueba con claims alterables para verificar rechazos reales de jose.
 * @param {object} config Configuración con secreto efímero, emisor y audiencia de prueba.
 * @param {object} overrides Claims que se sustituyen u omiten en la prueba.
 * @param {string} algorithm Algoritmo que se desea incluir en la firma de prueba.
 * @returns {Promise<string>} JWT firmado exclusivamente para el caso de prueba.
 * @throws {Error} Si jose rechaza el algoritmo o la clave del fixture.
 */
async function signedFixture(config, overrides = {}, algorithm = 'HS256') {
  const issued = Math.floor(now.getTime() / 1000);
  const payload = { sub: '12345678', jti: randomUUID(), iat: issued, exp: issued + 7200,
    iss: config.jwt.issuer, aud: config.jwt.audience, ...overrides };
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm })
    .sign(Buffer.from(config.jwt.secret, 'base64url'));
}

/** Comprueba firma, UUID y fechas exactas para persistir la sesión sin perder precisión de exp. */
test('firma y verifica claims obligatorios con duración de dos horas', async () => {
  const config = securityConfig();
  const signed = await signAccessToken({ legajo: '12345678' }, config, now);
  const payload = await verifyAccessToken(signed.token, config, now);
  assert.equal(payload.sub, '12345678');
  assert.equal(payload.jti, signed.jti);
  assert.equal(payload.exp - payload.iat, 7200);
  assert.equal(signed.issuedAt.getTime(), payload.iat * 1000);
  assert.equal(signed.expiresAt.getTime(), payload.exp * 1000);
  assert.equal(payload.iss, config.jwt.issuer);
  assert.equal(payload.aud, config.jwt.audience);
});

/** Rechaza firmas incorrectas, tokens manipulados, algoritmos ajenos y vencimiento exacto. */
test('rechaza firma, algoritmo, manipulación y expiración sin filtrar detalles', async () => {
  const config = securityConfig();
  const { token, expiresAt } = await signAccessToken({ legajo: '12345678' }, config, now);
  await assert.rejects(verifyAccessToken(token, config, expiresAt), { code: 'ACCESS_TOKEN_INVALID', status: 401 });
  await assert.rejects(verifyAccessToken(token, securityConfig(), now), { code: 'ACCESS_TOKEN_INVALID' });
  const parts = token.split('.');
  const originalPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  const modifiedPayload = { ...originalPayload, sub: '87654321' };
  // Solo cambia un legajo válido: todos los demás claims y la firma original se conservan.
  parts[1] = Buffer.from(JSON.stringify(modifiedPayload)).toString('base64url');
  assert.deepEqual(modifiedPayload, { ...await verifyAccessToken(token, config, now), sub: '87654321' });
  assert.equal(parts[2], token.split('.')[2]);
  await assert.rejects(verifyAccessToken(parts.join('.'), config, now), { code: 'ACCESS_TOKEN_INVALID' });
  const wrongAlgorithm = await signedFixture(config, {}, 'HS384');
  await assert.rejects(verifyAccessToken(wrongAlgorithm, config, now), { code: 'ACCESS_TOKEN_INVALID' });
  await assert.rejects(verifyAccessToken('no-es-jwt', config, now), { message: 'La sesión no es válida o ha vencido.' });
});

/** Omite cada claim obligatorio y comprueba tipos, identidad, audiencia y tiempos inválidos. */
test('exige claims válidos, emisor y audiencia exactos y emisión no futura', async () => {
  const config = securityConfig();
  for (const claim of ['sub', 'jti', 'iat', 'exp', 'iss', 'aud']) {
    const token = await signedFixture(config, { [claim]: undefined });
    await assert.rejects(verifyAccessToken(token, config, now), { code: 'ACCESS_TOKEN_INVALID' });
  }
  const issued = Math.floor(now.getTime() / 1000);
  for (const overrides of [
    { sub: 12345678 }, { sub: 'otro' }, { jti: '' }, { jti: 123 },
    { iss: 'otro-emisor' }, { aud: 'otra-audiencia' }, { aud: [config.jwt.audience] },
    { iat: issued + 1, exp: issued + 7201 }, { iat: issued + 0.5 }, { exp: issued + 7201 },
  ]) {
    await assert.rejects(verifyAccessToken(await signedFixture(config, overrides), config, now), { code: 'ACCESS_TOKEN_INVALID' });
  }
});

/** Impide firmar identidades o fechas que la persistencia no puede representar. */
test('valida identidad y fecha antes de emitir', async () => {
  const config = securityConfig();
  for (const identity of [{ legajo: 'x' }, { legajo: 12345678 }, { legajo: '12345678', jti: 'x' }]) {
    await assert.rejects(signAccessToken(identity, config, now), /inválida/);
  }
  await assert.rejects(signAccessToken({ legajo: '12345678' }, config, new Date('invalid')), /inválida/);
});

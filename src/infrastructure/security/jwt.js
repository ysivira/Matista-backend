/**
 * Emite y verifica tokens de acceso con la configuración de seguridad.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { loadSecurityConfig } from './config.js';
import { createAppError } from '../../shared/errors/app-error.js';

const LEGAJO_PATTERN = /^[0-9]{7,10}$/;
const JTI_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/**
 * Firma un JWT de acceso y devuelve los tiempos que deberá persistir la etapa C.
 * @param {object} identity Legajo y jti UUID opcional; por defecto genera un UUID.
 * @param {object} config Configuración validada, con secreto base64url.
 * @param {Date} now Instante de emisión sustituible en pruebas.
 * @returns {Promise<object>} token, jti, issuedAt y expiresAt compatibles con auth_sesiones.
 * @throws {Error} Si la identidad o fecha no cumple el contrato.
 */

export async function signAccessToken(
  { legajo, jti = randomUUID() },
  config = loadSecurityConfig(),
  now = new Date()
) {
  if (
    typeof legajo !== 'string' ||
    !LEGAJO_PATTERN.test(legajo) ||
    typeof jti !== 'string' ||
    !JTI_PATTERN.test(jti) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new Error('Identidad o fecha de emisión JWT inválida.');
  }

  const issued = Math.floor(now.getTime() / 1000);
  const expires = issued + config.jwt.durationSeconds;
  const token = await new SignJWT({})
    .setProtectedHeader({
      alg: config.jwt.algorithm,
      typ: 'JWT'
    })
    .setSubject(legajo)
    .setJti(jti)
    .setIssuedAt(issued)
    .setExpirationTime(expires)
    .setIssuer(config.jwt.issuer)
    .setAudience(config.jwt.audience)
    .sign(Buffer.from(config.jwt.secret, 'base64url'));
  return {
    token,
    jti,
    issuedAt: new Date(issued * 1000),
    expiresAt: new Date(expires * 1000)
  };
}

/**
 * Verifica firma, claims y tiempos; no consulta sesión, revocación ni empleado.
 * @param {string} token JWT recibido.
 * @param {object} config Configuración de seguridad validada.
 * @param {Date} now Reloj de validación sustituible en pruebas.
 * @returns {Promise<object>} Claims verificados; aún requieren autorización en etapa C.
 * @throws {Error} ACCESS_TOKEN_INVALID con mensaje público uniforme.
 */

export async function verifyAccessToken(token, config = loadSecurityConfig(), now = new Date()) {
  try {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('Fecha inválida.');
    }
    const { payload } = await jwtVerify(token, Buffer.from(config.jwt.secret, 'base64url'), {
      algorithms: [config.jwt.algorithm],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      currentDate: now,
      requiredClaims: ['sub', 'jti', 'iat', 'exp', 'iss', 'aud']
    });

    if (
      payload.iss !== config.jwt.issuer ||
      payload.aud !== config.jwt.audience ||
      typeof payload.sub !== 'string' ||
      !LEGAJO_PATTERN.test(payload.sub) ||
      typeof payload.jti !== 'string' ||
      !JTI_PATTERN.test(payload.jti) ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat > Math.floor(now.getTime() / 1000) ||
      payload.exp - payload.iat !== config.jwt.durationSeconds
    ) {
      throw new Error('Claims inválidos.');
    }
    return payload;
  } catch {
    throw createAppError('ACCESS_TOKEN_INVALID', 'La sesión no es válida o ha vencido.', 401);
  }
}

/**
 * ============================================================
 * MATISTA | TOKENS TEMPORALES
 * ============================================================
 *
 * Archivo: token.js
 * Módulo: Infraestructura de seguridad
 *
 * Responsabilidad:
 * Generar tokens aleatorios y hashes SHA-256 para verificar
 * correos o restablecer contraseñas con vencimiento controlado.
 *
 * ============================================================
 */
import { createHash, randomBytes } from 'node:crypto';
import { loadSecurityConfig } from './config.js';

/**
 * Calcula SHA-256 de un token temporal emitido por MATISTA.
 * @param {string} token Representación base64url de 32 bytes aleatorios.
 * @returns {Buffer} Digest de 32 bytes compatible con BINARY(32).
 * @throws {Error} Si el formato no es canónico; el error no incluye el token.
 */

export function hashTemporaryToken(token) {
  if (
    typeof token !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token, 'base64url').toString('base64url') !==
      token
  ) {
    throw new Error('Formato de token temporal inválido.');
  }
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Genera un token y su hash; el servicio AUTH persiste únicamente el hash.
 * @param {'VERIFICAR_EMAIL'|'RESET_PASSWORD'} type Propósito del token.
 * @param {object} config Configuración con duraciones aprobadas, en segundos.
 * @param {Date} now Instante de emisión sustituible en pruebas.
 * @returns {object} token crudo para entrega, tokenHash y expiresAt; nunca los registra.
 * @throws {Error} Si el propósito, duración o vencimiento no es válido.
 */

export function createTemporaryToken(type, config = loadSecurityConfig(), now = new Date()) {
  const duration = Object.hasOwn(config.tokens, type) ? config.tokens[type] : undefined;
  if (
    !Number.isSafeInteger(duration) ||
    duration <= 0 ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new Error('Propósito, duración o fecha de token temporal inválidos.');
  }

  const expiresAt = new Date(now.getTime() + duration * 1000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) {
    throw new Error('Vencimiento de token temporal inválido.');
  }

  const token = randomBytes(32).toString('base64url');
  return {
    token,
    tokenHash: hashTemporaryToken(token),
    expiresAt
  };
}

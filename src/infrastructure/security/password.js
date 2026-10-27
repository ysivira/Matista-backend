/**
 * Genera y verifica hashes de contraseñas con bcrypt.
 */
import bcrypt from 'bcryptjs';
import { loadSecurityConfig, PASSWORD_MAX_BYTES } from './config.js';
import { createAppError } from '../../shared/errors/app-error.js';

/**
 * Valida y genera un hash bcrypt para una contraseña nueva, sin modificar su contenido.
 * @param {string} password Contraseña a crear o cambiar.
 * @param {object} config Configuración de seguridad validada.
 * @returns {Promise<string>} Hash con sal aleatoria y costo 12.
 * @throws {Error} PASSWORD_INVALID si incumple longitud o límite UTF-8.
 */

export async function hashPassword(password, config = loadSecurityConfig()) {
  if (
    typeof password !== 'string' ||
    [...password].length < config.password.minLength ||
    Buffer.byteLength(password, 'utf8') > config.password.maxBytes
  ) {
    throw createAppError(
      'PASSWORD_INVALID',
      `La contraseña requiere al menos ${config.password.minLength} caracteres y admite hasta 72 bytes UTF-8.`,
      400
    );
  }
  return bcrypt.hash(password, config.password.cost);
}

/**
 * Compara una contraseña con un hash existente sin imponer el mínimo de creación actual.
 * @param {string} password Contraseña exacta recibida; no se recorta ni normaliza.
 * @param {string} hash Hash bcrypt persistido.
 * @returns {Promise<boolean>} Coincidencia; false ante entradas inválidas o mayores a 72 bytes.
 */

export async function verifyPassword(password, hash) {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES ||
    typeof hash !== 'string' ||
    !/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)
  ) {
    return false;
  }
  return bcrypt.compare(password, hash);
}

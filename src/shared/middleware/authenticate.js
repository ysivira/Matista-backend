/**
 * ============================================================
 * MATISTA | AUTENTICACIÓN HTTP
 * ============================================================
 *
 * Archivo: authenticate.js
 * Módulo: Middleware compartido
 *
 * Responsabilidad:
 * Autenticar la cookie JWT y recargar la sesión y la cuenta
 * antes de adjuntar la identidad a la solicitud.
 *
 * ============================================================
 */
import { authenticateToken } from '../../modules/auth/auth.service.js';
import { AUTH_COOKIE_NAME } from '../../modules/auth/auth.constants.js';
import { createAppError } from '../errors/app-error.js';

/**
 * Autentica exclusivamente la cookie JWT y recarga sesión/cuenta; no acepta Bearer alternativo.
 * @param {object} req Solicitud con cookies y dependencias AUTH inyectadas.
 * @param {object} res Respuesta Express.
 * @param {Function} next Continúa con req.auth o propaga un error público de autenticación.
 * @returns {Promise<unknown>} Resultado de next; errores async gestionados por Express 5.
 */
export async function authenticate(req, res, next) {
  const token = req.cookies?.[AUTH_COOKIE_NAME];
  if (typeof token !== 'string' || !token) {
    throw createAppError('SESSION_REQUIRED', 'Debe iniciar sesión para continuar.', 401);
  }
  req.auth = await authenticateToken(token, req.authContext);
  return next();
}

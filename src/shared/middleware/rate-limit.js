/**
 * Limita solicitudes por ventana temporal con almacenamiento acotado.
 */
import { rateLimit } from 'express-rate-limit';
import { RATE_LIMIT_POLICIES } from '../../infrastructure/security/config.js';
import { createAppError } from '../errors/app-error.js';

/**
 * Crea un limitador independiente para una operación futura, sin montarlo en rutas.
 * @param {'login'|'passwordRecovery'|'verificationResend'} operation Política aprobada.
 * @param {object} overrides Ventana y máximo opcionales; store sustituible en pruebas/despliegue.
 * @returns {Function} Middleware Express con almacén independiente por instancia.
 * @throws {Error} Si la operación, ventana o límite son inválidos.
 */
export function createAuthRateLimiter(operation, overrides = {}) {
  if (!Object.hasOwn(RATE_LIMIT_POLICIES, operation)) {
    throw new Error('Operación de rate limiting inválida.');
  }
  const { windowMs, limit } = {
    ...RATE_LIMIT_POLICIES[operation],
    ...overrides
  };
  if (
    !Number.isInteger(windowMs) ||
    windowMs < 1 ||
    windowMs > 2_147_483_647 ||
    !Number.isSafeInteger(limit) ||
    limit < 1
  ) {
    throw new Error('Ventana o límite de solicitudes inválidos.');
  }
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...(overrides.store
      ? {
          store: overrides.store
        }
      : {}),
    /** Entrega un error público uniforme; req/res/options pertenecen al middleware. */
    handler(req, res, next) {
      next(
        createAppError('RATE_LIMIT_EXCEEDED', 'Demasiadas solicitudes. Intente más tarde.', 429)
      );
    }
  });
}

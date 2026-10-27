/**
 * Restringe la solicitud a los roles autorizados.
 */
import { createAppError } from '../errors/app-error.js';

/**
 * Construye una política de roles sobre la identidad recién consultada por authenticate.
 * @param {...string} roles Roles permitidos por la ruta; no se reciben desde el cliente.
 * @returns {Function} Middleware que exige autenticación y rol actual, con HTTP 401/403.
 */
export function authorize(...roles) {
  /** Comprueba req.auth.user y continúa sin utilizar claims JWT para decidir permisos. */
  return function authorizeCurrentRole(req, res, next) {
    if (!req.auth?.user)
      return next(createAppError('SESSION_REQUIRED', 'Debe iniciar sesión para continuar.', 401));
    if (!roles.includes(req.auth.user.rol))
      return next(createAppError('ROLE_FORBIDDEN', 'No tiene permisos para esta operación.', 403));
    return next();
  };
}

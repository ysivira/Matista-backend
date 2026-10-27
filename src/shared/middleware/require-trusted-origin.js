/**
 * Exige un origen confiable en las solicitudes protegidas.
 */
import { createAppError } from '../errors/app-error.js';

/**
 * Exige Origin exacto en operaciones mutables, incluidas login y confirmaciones públicas.
 * @param {object} req Solicitud Express con authHttp.origin validado por la composición.
 * @param {object} res Respuesta Express.
 * @param {Function} next Continúa o entrega ORIGIN_NOT_ALLOWED/403 sin confiar en Host o Referer.
 * @returns {unknown} Resultado de next.
 */
export function requireTrustedOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers.origin !== req.authHttp.origin) {
    return next(
      createAppError('ORIGIN_NOT_ALLOWED', 'El origen de la solicitud no está permitido.', 403)
    );
  }
  return next();
}

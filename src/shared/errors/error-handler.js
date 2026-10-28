/**
 * ============================================================
 * MATISTA | RESPUESTAS DE ERROR
 * ============================================================
 *
 * Archivo: error-handler.js
 * Módulo: Errores compartidos
 *
 * Responsabilidad:
 * Traducir errores operativos y del parser a respuestas HTTP,
 * sin publicar datos internos de excepciones desconocidas.
 *
 * ============================================================
 */
import { isAppError } from './app-error.js';

const PARSER_ERRORS = Object.freeze({
  'entity.parse.failed': {
    status: 400,
    code: 'INVALID_JSON',
    message: 'El cuerpo de la solicitud no contiene JSON válido.'
  },
  'entity.too.large': {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'El cuerpo de la solicitud supera el tamaño permitido.'
  },
  'encoding.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_CONTENT',
    message: 'La codificación o el tipo de contenido no es compatible con el parser.'
  },
  'charset.unsupported': {
    status: 415,
    code: 'UNSUPPORTED_CONTENT',
    message: 'La codificación o el tipo de contenido no es compatible con el parser.'
  }
});

/**
 * Responde errores operativos y tipos conocidos del parser; los demás producen HTTP 500.
 * @param {Error} error Error recibido desde Express o componentes compartidos.
 * @param {object} req Solicitud Express.
 * @param {object} res Respuesta Express.
 * @param {Function} next Delega si ya se enviaron cabeceras.
 * @returns {object|undefined} Respuesta JSON o delegación al manejador siguiente.
 */
export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }
  if (isAppError(error)) {
    const body = {
      code: error.code,
      message: error.message
    };
    if (error.details !== undefined) body.details = error.details;
    return res.status(error.status).json({
      error: body
    });
  }
  // Se exige una pareja tipo/estado conocida: un status aislado nunca se considera confiable.
  const parserError =
    typeof error?.type === 'string' && Object.hasOwn(PARSER_ERRORS, error.type)
      ? PARSER_ERRORS[error.type]
      : undefined;
  if (parserError && error.status === parserError.status) {
    return res.status(parserError.status).json({
      error: {
        code: parserError.code,
        message: parserError.message
      }
    });
  }
  // El registro conserva contexto operativo mínimo sin serializar el error,
  // su stack, SQL, query string ni propiedades que puedan contener secretos.
  const path = typeof req.originalUrl === 'string' ? req.originalUrl.split('?')[0] : undefined;
  console.error('[matista] error 500 no controlado', {
    method: req.method,
    path,
    errorName: typeof error?.name === 'string' ? error.name : 'Error'
  });
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Ocurrió un error interno.'
    }
  });
}

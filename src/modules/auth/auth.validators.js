/**
 * ============================================================
 * MATISTA | VALIDADORES DE CUENTA
 * ============================================================
 *
 * Archivo: auth.validators.js
 * Módulo: Autenticación
 *
 * Responsabilidad:
 * Construir validaciones por operación AUTH y rechazar campos
 * desconocidos o actualizaciones de perfil vacías.
 *
 * ============================================================
 */
import { body, checkExact } from 'express-validator';
import { publicValidationMessage } from '../../shared/validators/validation-result.js';
import { PROFILE_FIELDS } from './auth.constants.js';
import { createAppError } from '../../shared/errors/app-error.js';

/** Rechaza un PATCH vacío o no objetual sin registrar el cuerpo completo como campo validado. */
function requireProfileChanges(req, res, next) {
  if (
    !req.body ||
    typeof req.body !== 'object' ||
    Array.isArray(req.body) ||
    !Object.keys(req.body).length
  ) {
    return next(
      createAppError('VALIDATION_FAILED', 'Debe indicar datos personales para actualizar.', 400)
    );
  }
  return next();
}

/**
 * Construye cadenas de entrada por operación; no duplica políticas de contraseña de B.
 * @param {string} operation Nombre interno de la ruta AUTH.
 * @returns {Array} Validaciones y comprobación de campos desconocidos sin exponer sus valores.
 */
export function authValidators(operation) {
  const fields = [];
  const publicMessage = publicValidationMessage;
  if (operation === 'register') {
    fields.push(
      body('legajo')
        .isString()
        .bail()
        .matches(/^[0-9]{7,10}$/)
        .withMessage(publicMessage('El DNI debe contener entre 7 y 10 dígitos.'))
    );
  }
  if (['register', 'editProfile'].includes(operation)) {
    for (const field of PROFILE_FIELDS) {
      const required = ['nombre', 'apellido'].includes(field);
      const max = field === 'telefono' ? 20 : field === 'direccion' ? 255 : 100;
      let chain = body(field);
      if (operation === 'editProfile' || !required)
        chain = chain.optional({
          values: required ? 'undefined' : 'null'
        });
      fields.push(
        chain
          .isString()
          .withMessage(publicMessage('Debe ingresar texto.'))
          .bail()
          .trim()
          .isLength({
            min: required ? 1 : 0,
            max
          })
          .withMessage(
            publicMessage(`El campo admite ${required ?
              'entre 1 y' :
              'hasta'} ${max} caracteres.`)
          )
      );
    }
    if (operation === 'editProfile') {
      fields.push(requireProfileChanges);
    }
  }
  if (
    ['register', 'login', 'resendVerification', 'forgotPassword', 'changeEmail'].includes(operation)
  ) {
    fields.push(
      body('email')
        .isString()
        .withMessage(publicMessage('Ingrese un correo válido.'))
        .bail()
        .trim()
        .isLength({
          max: 255
        })
        .isEmail()
        .withMessage(publicMessage('Ingrese un correo válido.'))
    );
  }
  if (['register', 'login'].includes(operation)) {
    fields.push(
      body('password')
        .isString()
        .bail()
        .notEmpty()
        .withMessage(publicMessage('Ingrese la contraseña.'))
    );
  }
  if (['changePassword', 'changeEmail'].includes(operation)) {
    fields.push(
      body('currentPassword')
        .isString()
        .bail()
        .notEmpty()
        .withMessage(publicMessage('Ingrese su contraseña actual.'))
    );
  }
  if (['changePassword', 'resetPassword'].includes(operation)) {
    fields.push(
      body('newPassword')
        .isString()
        .bail()
        .notEmpty()
        .withMessage(publicMessage('Ingrese la nueva contraseña.'))
    );
  }
  if (['verifyEmail', 'confirmEmailChange', 'resetPassword'].includes(operation)) {
    fields.push(
      body('token')
        .isString()
        .bail()
        .matches(/^[A-Za-z0-9_-]{43}$/)
        .withMessage(publicMessage('El enlace no es válido.'))
    );
  }
  return [
    ...fields,
    checkExact([], {
      locations: ['body'],
      message: publicMessage('La solicitud contiene campos no admitidos.')
    })
  ];
}

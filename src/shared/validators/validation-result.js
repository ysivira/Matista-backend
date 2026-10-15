import { validationResult } from 'express-validator';
import { createAppError } from '../errors/app-error.js';

const publicMessages = new WeakSet();

/**
 * Declara un mensaje constante del servidor como apto para el cliente.
 * Usar con .withMessage(publicValidationMessage('Mensaje público.')); nunca interpolar entradas.
 * @param {string} message Texto público explícito para una validación esperada.
 * @returns {object} Mensaje marcado que express-validator conserva sin convertir a texto.
 * @throws {Error} Si el mensaje no es un texto no vacío.
 */
export function publicValidationMessage(message) {
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('El mensaje público de validación debe ser un texto no vacío.');
  }
  const publicMessage = Object.freeze({ message });
  publicMessages.add(publicMessage);
  return publicMessage;
}

/**
 * Adapta validaciones sin valores originales y publica solo mensajes marcados explícitamente.
 * Las excepciones y los mensajes sin marcar se sustituyen por un texto genérico seguro.
 * @param {object} req Solicitud con resultados de express-validator.
 * @param {object} res Respuesta Express.
 * @param {Function} next Continúa o entrega VALIDATION_FAILED al manejador central.
 * @returns {unknown} Resultado de next.
 */
export function handleValidationResult(req, res, next) {
  const result = validationResult(req);
  if (result.isEmpty()) return next();
  const details = result.array({ onlyFirstError: true }).map((error) => ({
    field: error.type === 'field' ? error.path : 'entrada',
    message: publicMessages.has(error.msg) ? error.msg.message : 'Valor inválido.',
  }));
  return next(createAppError('VALIDATION_FAILED', 'Revise los campos indicados.', 400, details));
}

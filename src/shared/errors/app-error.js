const operationalErrors = new WeakSet();

/**
 * Crea un error operativo con datos públicos seguros definidos por el servidor.
 * @param {string} code Código estable, sin datos recibidos del usuario.
 * @param {string} message Mensaje público; nunca incluir secretos ni valores recibidos.
 * @param {number} status Estado HTTP entre 400 y 599.
 * @param {Array<{field: string, message: string}>} [details] Campos y mensajes públicos.
 * @returns {Error} Error reconocible por el manejador centralizado.
 */
export function createAppError(code, message, status, details) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(code) || typeof message !== 'string'
      || !Number.isInteger(status) || status < 400 || status > 599) {
    throw new Error('Contrato de error operativo inválido.');
  }
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) {
    // Solo se conservan campos públicos; no se serializa el objeto de validación original.
    error.details = details.map(({ field, message: detailMessage }) => ({
      field: typeof field === 'string' ? field : 'entrada',
      message: typeof detailMessage === 'string' ? detailMessage : 'Valor inválido.',
    }));
  }
  operationalErrors.add(error);
  return error;
}

/**
 * Comprueba el origen del error para no publicar errores de bibliotecas por coincidencia de propiedades.
 * @param {unknown} error Error recibido.
 * @returns {boolean} Si fue creado por createAppError.
 */
export function isAppError(error) {
  return operationalErrors.has(error);
}

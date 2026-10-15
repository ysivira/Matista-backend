export const PASSWORD_MAX_BYTES = 72;
export const BCRYPT_COST = 12;

export const RATE_LIMIT_POLICIES = Object.freeze({
  login: Object.freeze({ limit: 5, windowMs: 15 * 60 * 1000 }),
  passwordRecovery: Object.freeze({ limit: 3, windowMs: 60 * 60 * 1000 }),
  verificationResend: Object.freeze({ limit: 3, windowMs: 60 * 60 * 1000 }),
});

/**
 * Lee la configuración de seguridad desde el entorno indicado, sin conectarse a servicios.
 * @param {object} env Variables de entorno; por defecto process.env.
 * @returns {object} Parámetros de contraseña, JWT y tokens temporales.
 * @throws {Error} Si el entorno, la política o el secreto son inválidos.
 */
export function loadSecurityConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV;
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error('NODE_ENV debe ser development, test o production.');
  }

  const minimum = nodeEnv === 'production' ? 10 : 4;
  const passwordMinLength = Number(env.PASSWORD_MIN_LENGTH ?? minimum);
  if (!Number.isInteger(passwordMinLength)
      || passwordMinLength < minimum || passwordMinLength > PASSWORD_MAX_BYTES) {
    throw new Error(`PASSWORD_MIN_LENGTH debe ser un entero entre ${minimum} y 72.`);
  }

  // Base64url permite medir los bytes reales de la clave, no su representación textual.
  const secret = env.JWT_SECRET;
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]+$/.test(secret)
      || Buffer.from(secret, 'base64url').length < 32
      || Buffer.from(secret, 'base64url').toString('base64url') !== secret) {
    throw new Error('JWT_SECRET debe contener al menos 32 bytes aleatorios en base64url sin relleno.');
  }
  const issuer = env.JWT_ISSUER ?? 'matista-backend';
  const audience = env.JWT_AUDIENCE ?? 'matista-frontend';
  if (typeof issuer !== 'string' || !issuer.trim()
      || typeof audience !== 'string' || !audience.trim()) {
    throw new Error('El emisor y la audiencia JWT son obligatorios.');
  }

  return Object.freeze({
    nodeEnv,
    password: Object.freeze({ minLength: passwordMinLength, maxBytes: PASSWORD_MAX_BYTES, cost: BCRYPT_COST }),
    jwt: Object.freeze({
      algorithm: 'HS256', secret, issuer, audience, durationSeconds: 2 * 60 * 60,
    }),
    tokens: Object.freeze({ VERIFICAR_EMAIL: 24 * 60 * 60, RESET_PASSWORD: 30 * 60 }),
  });
}

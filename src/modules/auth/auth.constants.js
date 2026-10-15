export const AUTH_COOKIE_NAME = 'matista_session';
export const AUTH_COOKIE_PATH = '/api';
export const AUTH_ROLES = Object.freeze(['ADMIN', 'ASESOR']);
export const PROFILE_FIELDS = Object.freeze([
  'nombre', 'segundo_nombre', 'apellido', 'segundo_apellido', 'telefono', 'direccion',
]);
export const NEUTRAL_RECOVERY = Object.freeze({
  code: 'RECOVERY_REQUEST_ACCEPTED',
  message: 'Si la cuenta es elegible, recibirá instrucciones para recuperar el acceso.',
});
export const NEUTRAL_VERIFICATION = Object.freeze({
  code: 'VERIFICATION_REQUEST_ACCEPTED',
  message: 'Si corresponde, recibirá un enlace de verificación.',
});

/**
 * Valida el origen exacto y define cookies por entorno sin depender de secretos JWT ni de MySQL.
 * @param {object} env NODE_ENV y FRONTEND_ORIGIN; solo desarrollo/pruebas tienen origen local por defecto.
 * @returns {object} Origen canónico y opciones compartidas para establecer y eliminar cookies.
 * @throws {Error} Si producción no tiene HTTPS o el origen incluye comodines, rutas o credenciales.
 */
export function loadAuthHttpPolicy(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('NODE_ENV HTTP inválido.');
  const configured = env.FRONTEND_ORIGIN ?? (nodeEnv === 'production' ? '' : 'http://localhost:5173');
  let url;
  try { url = new URL(configured); } catch { throw new Error('FRONTEND_ORIGIN debe ser un origen HTTP(S) explícito.'); }
  if (url.origin !== configured || url.username || url.password || url.hostname.includes('*')
      || !['http:', 'https:'].includes(url.protocol)
      || (nodeEnv === 'production' && url.protocol !== 'https:')
      || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('FRONTEND_ORIGIN no cumple la política de origen y HTTPS.');
  }
  return Object.freeze({
    origin: url.origin,
    cookie: Object.freeze({ httpOnly: true, sameSite: 'strict', secure: url.protocol === 'https:', path: AUTH_COOKIE_PATH }),
  });
}

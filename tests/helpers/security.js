import { randomBytes } from 'node:crypto';
import { loadSecurityConfig } from '../../src/infrastructure/security/config.js';

/**
 * Genera configuración aislada con secreto efímero; nunca lee credenciales reales.
 * @param {object} overrides Variables ficticias que se desea probar.
 * @returns {object} Configuración validada para la prueba.
 */
export function securityConfig(overrides = {}) {
  return loadSecurityConfig({ NODE_ENV: 'test', JWT_SECRET: randomBytes(32).toString('base64url'), ...overrides });
}

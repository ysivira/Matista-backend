import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { createDatabasePool } from '../../infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../../infrastructure/database/config.js';
import { loadSecurityConfig } from '../../infrastructure/security/config.js';
import { hashPassword } from '../../infrastructure/security/password.js';
import { handleValidationResult } from '../../shared/validators/validation-result.js';
import { createAuthRateLimiter } from '../../shared/middleware/rate-limit.js';
import { requireTrustedOrigin } from '../../shared/middleware/require-trusted-origin.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import * as repository from './auth.repository.js';
import * as controller from './auth.controller.js';
import { sendAuthNotice } from './auth.email.js';
import { AUTH_ROLES } from './auth.constants.js';
import { authValidators } from './auth.validators.js';
import { createAppError } from '../../shared/errors/app-error.js';

/**
 * Compone el único router AUTH con dependencias explícitas para pruebas y creación diferida en ejecución.
 * @param {object} options Entorno, política HTTP validada y contexto opcional con dobles.
 * @returns {object} Router Express; importarlo o consultar health no crea pool ni transporte SMTP.
 */
export function createAuthRouter({ env, httpPolicy, context }) {
  const router = Router();
  let runtime;
  router.use(cookieParser());
  /** Asigna política HTTP y evita caché de respuestas personales o errores de sesión. */
  router.use((req, res, next) => {
    req.authHttp = httpPolicy;
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireTrustedOrigin);
  /** Resuelve dependencias una sola vez; la prueba puede suministrar contexto sin servicios externos. */
  router.use(async (req, res, next) => {
    if (context) {
      req.authContext = context;
    } else {
      if (!runtime) runtime = initializeRuntime(env, httpPolicy);
      try { req.authContext = await runtime; } catch (error) { runtime = undefined; throw error; }
    }
    next();
  });

  const policies = { login: createAuthRateLimiter('login'), forgotPassword: createAuthRateLimiter('passwordRecovery'),
    resendVerification: createAuthRateLimiter('verificationResend') };
  const publicRoutes = [
    ['/register', 'register'], ['/verify-email', 'verifyEmail'], ['/confirm-email-change', 'confirmEmailChange'],
    ['/resend-verification', 'resendVerification'], ['/login', 'login'], ['/logout', 'logout'],
    ['/forgot-password', 'forgotPassword'], ['/reset-password', 'resetPassword'],
  ];
  for (const [path, operation] of publicRoutes) {
    router.post(path, ...(policies[operation] ? [policies[operation]] : []),
      ...authValidators(operation), handleValidationResult, controller[operation]);
  }
  router.get('/me', authenticate, authorize(...AUTH_ROLES), controller.getProfile);
  router.patch('/me', authenticate, authorize(...AUTH_ROLES), ...authValidators('editProfile'), handleValidationResult, controller.editProfile);
  router.post('/change-password', authenticate, authorize(...AUTH_ROLES), ...authValidators('changePassword'), handleValidationResult, controller.changePassword);
  router.post('/change-email', authenticate, authorize(...AUTH_ROLES), ...authValidators('changeEmail'), handleValidationResult, controller.changeEmail);
  /** Responde rutas AUTH inexistentes con JSON seguro, sin crear alias legacy. */
  router.use((req, res, next) => next(createAppError('AUTH_ROUTE_NOT_FOUND', 'La ruta AUTH no existe.', 404)));
  return router;
}

/**
 * Inicializa configuración de A/B y pool reutilizable al primer acceso AUTH, sin consultar bases al importar.
 * Exportada también para módulos que requieran el contexto AUTH idéntico (ADMIN, SPEC-03),
 * sin duplicar dependencias ni alterar el comportamiento aprobado.
 * @param {object} env Entorno del proceso, con secretos fuera del código.
 * @param {object} httpPolicy Origen exacto para enlaces.
 * @returns {Promise<object>} Dependencias usadas por funciones de servicio, sin factories por capa.
 */
export async function initializeRuntime(env, httpPolicy) {
  const security = loadSecurityConfig(env);
  const database = loadDatabaseConfig(env);
  const dummyPasswordHash = await hashPassword(randomBytes(54).toString('base64url'), security);
  return {
    pool: createDatabasePool(database), repository, security, dummyPasswordHash,
    /** Devuelve UTC del reloj del proceso; las pruebas inyectan su propio reloj. */
    now: () => new Date(),
    /** Reutiliza el envío de B con mensaje funcional y configuración propia de MATISTA. */
    notify: (notice) => sendAuthNotice(notice, { origin: httpPolicy.origin, env }),
    /** Registra únicamente código y tipo de incidente, nunca errores SMTP ni datos personales. */
    reportIncident: (incident) => console.warn('Incidente AUTH:', incident.code, incident.operation),
  };
}

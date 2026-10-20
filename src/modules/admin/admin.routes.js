// Router agregador de SPEC-03 ADMIN: comparte infraestructura AUTH entre los
// slices y conserva un unico fallback despues de todas las rutas conocidas.

import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { loadAuthHttpPolicy } from '../auth/auth.constants.js';
import { initializeRuntime } from '../auth/auth.routes.js';
import { requireTrustedOrigin } from '../../shared/middleware/require-trusted-origin.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { createEmployeesRouter } from './employees.routes.js';
import { createTarifarioRouter } from './tarifario.routes.js';

/**
 * Compone las rutas ADMIN con una unica politica HTTP y un runtime diferido.
 * @param {object} options Entorno y contexto AUTH opcional para pruebas.
 * @returns {object} Router ADMIN con empleados, planes, tarifario y fallback JSON.
 * @throws {Error} Si falla la inicializacion compartida de las dependencias AUTH.
 */
export function createAdminRouter({ env, context } = {}) {
  const router = Router();
  const httpPolicy = loadAuthHttpPolicy(env);
  let runtime;

  router.use(cookieParser());
  router.use((req, res, next) => {
    req.authHttp = httpPolicy;
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireTrustedOrigin);
  router.use(async (req, res, next) => {
    if (context) {
      req.authContext = context;
    } else {
      if (!runtime) runtime = initializeRuntime(env, httpPolicy);
      try {
        req.authContext = await runtime;
      } catch (error) {
        runtime = undefined;
        throw error;
      }
    }
    next();
  });

  router.use(createEmployeesRouter());
  router.use(createTarifarioRouter());
  router.use((req, res, next) => next(createAppError(
    'ADMIN_ROUTE_NOT_FOUND',
    'La ruta ADMIN no existe.',
    404,
  )));
  return router;
}

// Rutas ADMIN de gestion de empleados (SL-1, SPEC-03 ADMIN).
// Endpoints aprobados en el plan §0: listado, detalle, estado y rol,
// exclusivamente para cuentas con rol ADMIN y sesion revalidada en cada
// acceso por el middleware AUTH existente (authenticate + authorize).
// El runtime de dependencias se reutiliza de AUTH sin duplicarlo.

import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { loadAuthHttpPolicy } from '../auth/auth.constants.js';
import { initializeRuntime } from '../auth/auth.routes.js';
import { requireTrustedOrigin } from '../../shared/middleware/require-trusted-origin.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import { createAppError } from '../../shared/errors/app-error.js';
import {
  gestionarListado, gestionarDetalle, gestionarEstado, gestionarRol,
} from './employees.service.js';

/**
 * Responde el listado de empleados con los filtros aprobados por query.
 * @param {object} req Solicitud con contexto AUTH y actor ya autenticado.
 * @param {object} res Respuesta Express.
 * @returns {object} JSON { empleados: [...] } con respuesta sin almacenamiento.
 */
export async function listar(req, res) {
  const empleados = await gestionarListado(req.authContext.pool, {
    estado: req.query.estado && req.query.estado !== 'todos' ? String(req.query.estado) : null,
    rol: req.query.rol && req.query.rol !== 'todos' ? String(req.query.rol) : null,
    busqueda: typeof req.query.busqueda === 'string' && req.query.busqueda.trim()
      ? req.query.busqueda : null,
  });
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ empleados });
}

/**
 * Responde el detalle publico de un empleado.
 * @param {object} req Solicitud con legajo en params.
 * @param {object} res Respuesta Express.
 * @returns {object} JSON { empleado } o 404 cuando no existe.
 */
export async function detalle(req, res) {
  const empleado = await gestionarDetalle(req.authContext.pool, req.params.legajo);
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ empleado });
}

/**
 * Aplica el cambio de estado y responde el estado final de la cuenta.
 * @param {object} req Solicitud con { estado } en el cuerpo y actor en la sesion.
 * @param {object} res Respuesta Express.
 * @returns {object} JSON { empleado: { legajo, estado, rol } }.
 */
export async function cambiarEstado(req, res) {
  const resultado = await gestionarEstado(
    req.authContext.pool,
    req.auth.user.legajo,
    req.params.legajo,
    req.body?.estado,
    req.authContext.now(),
  );
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ empleado: resultado });
}

/**
 * Aplica el cambio de rol y responde el rol final de la cuenta.
 * @param {object} req Solicitud con { rol } en el cuerpo y actor en la sesion.
 * @param {object} res Respuesta Express.
 * @returns {object} JSON { empleado: { legajo, estado, rol } }.
 */
export async function cambiarRol(req, res) {
  const resultado = await gestionarRol(
    req.authContext.pool,
    req.auth.user.legajo,
    req.params.legajo,
    req.body?.rol,
    req.authContext.now(),
  );
  res.set('Cache-Control', 'no-store');
  return res.status(200).json({ empleado: resultado });
}

/**
 * Compone el router ADMIN de empleados con dependencias y guardias AUTH.
 * Reutiliza el runtime AUTH (pool, security, reloj) y el mismo contexto
 * de pruebas; importar o consultar health no crea pool ni transporte.
 * @param {object} options Entorno del proceso y contexto opcional con dobles.
 * @returns {object} Router Express con guardias de rol y errores JSON.
 */
export function createEmployeesRouter({ env, context } = {}) {
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
      try { req.authContext = await runtime; } catch (error) { runtime = undefined; throw error; }
    }
    next();
  });

  // El actor llega siempre de la sesion real; ninguna decision usa claims JWT.
  router.get('/employees', authenticate, authorize('ADMIN'), listar);
  router.get('/employees/:legajo', authenticate, authorize('ADMIN'), detalle);
  router.patch('/employees/:legajo/estado', authenticate, authorize('ADMIN'), cambiarEstado);
  router.patch('/employees/:legajo/rol', authenticate, authorize('ADMIN'), cambiarRol);

  router.use((req, res, next) => next(createAppError('ADMIN_ROUTE_NOT_FOUND',
    'La ruta ADMIN no existe.', 404)));
  return router;
}

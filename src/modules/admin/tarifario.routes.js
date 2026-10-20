// Endpoints de solo lectura para RF-D06/D07; la infraestructura compartida
// de cookie, contexto y fallback pertenece al router agregador ADMIN.

import { Router } from 'express';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import { gestionarPlanes, gestionarTarifario } from './tarifario.service.js';

/**
 * Responde el catalogo de planes activos.
 * @param {object} req Solicitud con contexto AUTH ya inicializado.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ planes }`.
 */
export async function listarPlanes(req, res) {
  const planes = await gestionarPlanes(req.authContext.pool);
  return res.status(200).json({ planes });
}

/**
 * Responde las tarifas vigentes del plan y modalidad solicitados.
 * @param {object} req Solicitud con parametros y reloj AUTH confiable.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON del contrato de matriz vigente.
 */
export async function consultarTarifario(req, res) {
  const resultado = await gestionarTarifario(
    req.authContext.pool,
    req.params,
    req.authContext.now(),
  );
  return res.status(200).json(resultado);
}

/**
 * Compone las dos rutas GET de consulta ADMIN protegidas por rol actual.
 * @returns {object} Router sin infraestructura ni fallback propios.
 */
export function createTarifarioRouter() {
  const router = Router();
  router.get('/planes', authenticate, authorize('ADMIN'), listarPlanes);
  router.get(
    '/tarifario/planes/:planId/:tipoIngreso',
    authenticate,
    authorize('ADMIN'),
    consultarTarifario,
  );
  return router;
}

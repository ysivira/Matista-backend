/**
 * ============================================================
 * MATISTA | RUTAS DEL CATÁLOGO
 * ============================================================
 *
 * Archivo: catalogo.routes.js
 * Módulo: Catálogo compartido
 *
 * Responsabilidad:
 * Exponer consultas y documentos del catálogo para ADMIN y
 * ASESOR sin montar operaciones de escritura administrativa.
 *
 * ============================================================
 */
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { loadAuthHttpPolicy } from '../auth/auth.constants.js';
import { initializeRuntime } from '../auth/auth.routes.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { gestionarTarifario, gestionarPlanes } from './tarifario.service.js';
import { listarPlanes, consultarTarifario } from './tarifario.routes.js';
import { consultarCondiciones } from './catalogo.service.js';
import { imprimirHtmlPdf } from '../../infrastructure/pdf/html-pdf.js';
import { documentoCatalogoHtml } from './catalogo.impresion.js';
import { listaCsv } from './catalogo.documentos.js';
import { validarIdVersion } from './tarifario.validators.js';

/**
 * Expone únicamente lecturas compartidas de ADMIN para ambos roles, sin rutas de gestión comercial.
 * @param {object} options Entorno y contexto AUTH opcional de pruebas.
 * @returns {object} Router protegido de catálogo, listas, políticas y documentos reales.
 */
export function createCatalogoRouter({ env, context } = {}) {
  const router = Router();
  const httpPolicy = loadAuthHttpPolicy(env);
  router.use(cookieParser());
  /** Reutiliza la sesión y el pool AUTH sin habilitar escrituras por este router. */
  router.use(async (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.authContext = context ?? (await initializeRuntime(env, httpPolicy));
    next();
  });
  router.use(authenticate, authorize('ADMIN', 'ASESOR'));
  router.get('/planes', listarPlanes);
  router.get('/tarifario/planes/:planId/:tipoIngreso', consultarTarifario);
  /** Descarga ficha completa de un plan activo, conservando el contenido de ADMIN. */
  router.get('/planes/:id/:formato', async (req, res) => {
    if (!['pdf', 'impresion'].includes(req.params.formato))
      throw createAppError('CATALOGO_NO_ENCONTRADO', 'Formato no disponible.', 404);
    validarIdVersion(req.params.id);
    const planes = await gestionarPlanes(req.authContext.pool);
    const plan = planes.find(p => String(p.id) === req.params.id);
    if (!plan) throw createAppError('CATALOGO_NO_ENCONTRADO', 'El plan no está disponible.', 404);
    const documento = await documentoCatalogoHtml(plan, 'plan', req.params.formato === 'impresion');
    if (req.params.formato === 'impresion') return res.type('html').send(documento);
    return res
      .attachment('matista-detalle-plan.pdf')
      .type('application/pdf')
      .send(await imprimirHtmlPdf(documento));
  });
  /** Documenta precios reales vigentes; no aplica aportes ni descuentos. */
  router.get('/listas/:planId/:tipoIngreso/:formato', async (req, res) => {
    if (!['pdf', 'csv', 'impresion'].includes(req.params.formato))
      throw createAppError('CATALOGO_NO_ENCONTRADO', 'Formato no disponible.', 404);
    const lista = await gestionarTarifario(req.authContext.pool, req.params, req.authContext.now());
    if (req.params.formato === 'csv')
      return res.attachment('matista-lista-precios.csv').type('text/csv').send(listaCsv(lista));
    const documento = await documentoCatalogoHtml(
      lista,
      'precios',
      req.params.formato === 'impresion'
    );
    if (req.params.formato === 'impresion') return res.type('html').send(documento);
    return res
      .attachment('matista-lista-precios.pdf')
      .type('application/pdf')
      .send(await imprimirHtmlPdf(documento));
  });
  /** Consulta política y aportes publicados mediante los contratos existentes. */
  router.get('/condiciones', async (req, res) =>
    res.json(await consultarCondiciones(req.authContext.pool))
  );
  /** Rechaza métodos o rutas sin contrato con el mismo formato JSON que AUTH/ADMIN. */
  router.use((req, res, next) =>
    next(createAppError('CATALOGO_ROUTE_NOT_FOUND', 'La ruta de consulta no existe.', 404))
  );
  return router;
}

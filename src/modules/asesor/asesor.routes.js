/**
 * Compone las rutas del asesor con autenticación y autorización.
 */
import { Router } from 'express';
import cookieParser from 'cookie-parser';
import { loadAuthHttpPolicy } from '../auth/auth.constants.js';
import { initializeRuntime } from '../auth/auth.routes.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import { requireTrustedOrigin } from '../../shared/middleware/require-trusted-origin.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { listarPlanes, consultarTarifario } from '../admin/tarifario.routes.js';
import { gestionarTarifario } from '../admin/tarifario.service.js';
import * as clientes from './clientes.service.js';
import * as cotizaciones from './cotizaciones.service.js';
import { cotizacionPdf } from './documentos.js';
import { listaCsv } from '../admin/catalogo.documentos.js';
import { consultarCondiciones } from '../admin/catalogo.service.js';

/**
 * Compone ASESOR con AUTH real y lecturas ADMIN reutilizadas; ninguna escritura ADMIN se monta.
 * @param {object} options Entorno y contexto AUTH opcional de pruebas.
 * @returns {object} Router con autorización, origen exacto y respuestas no almacenables.
 */
export function createAsesorRouter({ env, context } = {}) {
  const router = Router();
  const httpPolicy = loadAuthHttpPolicy(env);
  router.use(cookieParser());
  /** Comparte las dependencias AUTH sin abrir pools alternativos. */
  router.use(async (req, res, next) => {
    req.authHttp = httpPolicy;
    res.set('Cache-Control', 'no-store');
    req.authContext = context ?? (await initializeRuntime(env, httpPolicy));
    next();
  });
  router.use(requireTrustedOrigin, authenticate, authorize('ASESOR'));
  router.get('/planes', listarPlanes);
  router.get('/tarifario/planes/:planId/:tipoIngreso', consultarTarifario);
  /** Descarga una lista real y vigente de ADMIN como CSV. */
  router.get('/listas/:planId/:tipoIngreso/exportacion', async (req, res) => {
    const lista = await gestionarTarifario(req.authContext.pool, req.params, req.authContext.now());
    res.attachment('matista-lista-precios.csv').type('text/csv').send(listaCsv(lista));
  });
  /** Proyecta condiciones publicadas y referencias de aportes sin algoritmos económicos. */
  router.get('/condiciones', async (req, res) =>
    res.json(await consultarCondiciones(req.authContext.pool))
  );
  /** Validación contextual de edición; usa límites del servidor y mantiene la autorización ASESOR. */
  router.post('/condiciones/validacion', async (req, res) =>
    res.json(await cotizaciones.validarCampana(req.authContext.pool, req.body))
  );
  /** Busca por DNI con la proyección limitada para clientes ajenos. */
  router.get('/clientes/busqueda/:dni', async (req, res) =>
    res.json(
      await clientes.buscarPorDni(req.authContext.pool, req.auth.user.legajo, req.params.dni)
    )
  );
  /** Lista clientes del actor con filtros acotados. */
  router.get('/clientes', async (req, res) =>
    res.json(
      await clientes.consultarClientes(req.authContext.pool, req.auth.user.legajo, req.query)
    )
  );
  /** Consulta exclusivamente un cliente propio. */
  router.get('/clientes/:id', async (req, res) =>
    res.json(
      await clientes.obtenerCliente(req.authContext.pool, req.auth.user.legajo, req.params.id)
    )
  );
  /** Registra cliente y responsable desde la sesión, nunca desde el cuerpo. */
  router.post('/clientes', async (req, res) =>
    res
      .status(201)
      .json(await clientes.guardarCliente(req.authContext.pool, req.auth.user.legajo, req.body))
  );
  /** Actualiza cliente propio con revisión optimista. */
  router.put('/clientes/:id', async (req, res) =>
    res.json(
      await clientes.guardarCliente(
        req.authContext.pool,
        req.auth.user.legajo,
        req.body,
        req.params.id
      )
    )
  );
  /** Consulta historial autorizado y paginado. */
  router.get('/cotizaciones', async (req, res) =>
    res.json(
      await cotizaciones.consultarHistorial(req.authContext.pool, req.auth.user.legajo, req.query)
    )
  );
  /** Guarda preparación independiente del motor. */
  router.post('/cotizaciones', async (req, res) =>
    res
      .status(201)
      .json(
        await cotizaciones.guardarPreparacion(req.authContext.pool, req.auth.user.legajo, req.body)
      )
  );
  /** Previsualiza con propiedad y catálogo reales, sin generar un borrador por cada edición. */
  router.post('/cotizaciones/previsualizacion', async (req, res) =>
    res.json(
      await cotizaciones.previsualizarPreparacion(
        req.authContext.pool,
        req.auth.user.legajo,
        req.body
      )
    )
  );
  /** Entrega detalle histórico propio y sus relaciones. */
  router.get('/cotizaciones/:id', async (req, res) =>
    res.json(
      await cotizaciones.obtenerDetalle(req.authContext.pool, req.auth.user.legajo, req.params.id)
    )
  );
  /** Sustituye únicamente entradas de un borrador, conservando el cliente original. */
  router.put('/cotizaciones/:id', async (req, res) =>
    res.json(
      await cotizaciones.guardarPreparacion(req.authContext.pool, req.auth.user.legajo, req.body, {
        id: req.params.id
      })
    )
  );
  /** Corrige contacto sin alterar número ni datos económicos. */
  router.patch('/cotizaciones/:id/contacto', async (req, res) =>
    res.json(
      await cotizaciones.modificarCotizacion(
        req.authContext.pool,
        req.auth.user.legajo,
        req.params.id,
        req.body
      )
    )
  );
  /** Conserva original y crea preparación relacionada con referencias actuales. */
  router.post('/cotizaciones/:id/recotizaciones', async (req, res) =>
    res.status(201).json(
      await cotizaciones.guardarPreparacion(req.authContext.pool, req.auth.user.legajo, req.body, {
        origenId: req.params.id
      })
    )
  );
  /** Anula lógicamente, con motivo y revisión obligatorios. */
  router.post('/cotizaciones/:id/anulacion', async (req, res) =>
    res.json(
      await cotizaciones.modificarCotizacion(
        req.authContext.pool,
        req.auth.user.legajo,
        req.params.id,
        req.body,
        true
      )
    )
  );
  /** Obtiene el cálculo del backend; no acepta resultados ni importes enviados por React. */
  router.post('/cotizaciones/:id/calculo', async (req, res) => {
    if (Object.keys(req.body ?? {}).length)
      throw createAppError(
        'ASESOR_VALIDACION',
        'No se aceptan importes ni resultados del cliente.',
        400
      );
    return res.json(
      await cotizaciones.calcularPreparacion(
        req.authContext.pool,
        req.auth.user.legajo,
        req.params.id
      )
    );
  });
  /** Confirma una previsualización mediante revisión y huella; vuelve a calcular dentro de la transacción. */
  router.post('/cotizaciones/:id/emision', async (req, res) =>
    res.json(
      await cotizaciones.emitirPreparacion(
        req.authContext.pool,
        req.auth.user.legajo,
        req.params.id,
        req.body
      )
    )
  );
  /** Descarga PDF únicamente desde el snapshot autorizado de una emisión válida. */
  router.get('/cotizaciones/:id/pdf', async (req, res) => {
    const { cotizacion, contexto } = await cotizaciones.obtenerDatosPdf(
      req.authContext.pool,
      req.auth.user.legajo,
      req.params.id
    );
    res
      .attachment('matista-cotizacion.pdf')
      .type('application/pdf')
      .send(await cotizacionPdf(cotizacion, contexto));
  });
  /** Hace explícito el esquema pendiente sin filtrar SQL ni confundirlo con un fallo económico. */
  router.use((error, req, res, next) => {
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.warn('[matista] ASESOR: esquema pendiente', {
        mysqlCode: error.code
      });
      return next(
        createAppError(
          'ASESOR_ESQUEMA_PENDIENTE',
          'El esquema de ASESOR requiere aplicar las migraciones pendientes. Contacta al administrador.',
          503
        )
      );
    }
    return next(error);
  });
  /** Mantiene un fallback propio sin ampliar los permisos ADMIN. */
  router.use((req, res, next) =>
    next(createAppError('ASESOR_ROUTE_NOT_FOUND', 'La ruta ASESOR no existe.', 404))
  );
  return router;
}

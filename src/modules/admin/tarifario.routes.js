// Endpoints de solo lectura para RF-D06/D07; la infraestructura compartida
// de cookie, contexto y fallback pertenece al router agregador ADMIN.

import { Router } from 'express';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { authorize } from '../../shared/middleware/authorize.js';
import {
  activarVersionTarifario,
  aumentarVersionTarifario,
  crearBorradorDesdeHistorica,
  crearBorradorTarifario,
  descartarVersionTarifario,
  deshacerUltimoCambioEconomico,
  reanudarEdicionVersion,
  editarTarifaVersion,
  finalizarVersionTarifario,
  gestionarPlanes,
  gestionarTarifario,
  listarTarifasDeLaVersion,
  listarVersionesTarifario,
  obtenerDetalleVersion,
  reconstruirTarifarioHistorico,
  resumirEventosDeVersion,
} from './tarifario.service.js';
import {
  actualizarPoliticaComercial,
  cancelarProgramacionPoliticaComercial,
  listarEventosPoliticaComercial,
  listarHistorialPoliticaComercial,
  obtenerDetallePoliticaComercial,
  obtenerPoliticaComercial,
  recuperarPoliticaComercial,
} from './politica-comercial.service.js';

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
 * Responde el historial cronologico de versiones del tarifario.
 * @param {object} req Solicitud con contexto AUTH ya inicializado.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ versiones }`.
 */
export async function listarVersiones(req, res) {
  const resultado = await listarVersionesTarifario(req.authContext.pool);
  return res.status(200).json(resultado);
}

/**
 * Responde el detalle de una version del tarifario.
 * @param {object} req Solicitud con el id de version en la ruta.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ version }`; 404 si no existe.
 */
export async function consultarDetalleVersion(req, res) {
  const resultado = await obtenerDetalleVersion(req.authContext.pool, req.params);
  return res.status(200).json(resultado);
}

/**
 * Responde la lista completa de tarifas de una version (activas e inactivas).
 * @param {object} req Solicitud con el id de version en la ruta.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ version, tarifas }`.
 */
export async function consultarTarifasVersion(req, res) {
  const resultado = await listarTarifasDeLaVersion(
    req.authContext.pool,
    req.params,
  );
  return res.status(200).json(resultado);
}

/**
 * Responde el resumen de cambios de una version, construido sobre los
 * eventos de auditoria reales registrados (migracion 014).
 * @param {object} req Solicitud con `id` de version en la ruta.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ version, eventos }`.
 */
export async function consultarEventosVersion(req, res) {
  const resultado = await resumirEventosDeVersion(
    req.authContext.pool,
    req.params,
  );
  return res.status(200).json(resultado);
}

/**
 * Deshace el ultimo cambio economico de un borrador en PREPARACION.
 * La revision optimista viaja en el cuerpo para evitar perdida de
 * actualizaciones concurrentes.
 * @param {object} req Solicitud con `id` en la ruta y `revision` en el cuerpo.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ filas, revision, evento }`.
 */
export async function deshacerUltimoCambio(req, res) {
  const resultado = await deshacerUltimoCambioEconomico(
    req.authContext.pool,
    req.params,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Responde el tarifario efectivo de la version que rigio en la fecha pedida.
 * @param {object} req Solicitud con `fecha` en el query string.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ fecha, version, tarifas }`.
 */
export async function reconstruirTarifario(req, res) {
  const resultado = await reconstruirTarifarioHistorico(
    req.authContext.pool,
    req.query,
  );
  return res.status(200).json(resultado);
}

/**
 * Responde la política comercial actualmente vigente.
 * @param {object} req Solicitud con contexto AUTH ya inicializado.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON con la política comercial.
 */
export async function consultarPolitica(req, res) {
  const politica = await obtenerPoliticaComercial(req.authContext.pool);
  return res.status(200).json(politica);
}

/**
 * Actualiza la política comercial vigente.
 * @param {object} req Solicitud con el id de la política en la ruta y los datos en el cuerpo.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON con la política comercial actualizada.
 */
export async function actualizarPolitica(req, res) {
  const resultado = await actualizarPoliticaComercial(
    req.authContext.pool,
    req.params.id,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Responde el historial completo de políticas y sus porcentajes.
 * @param {object} req Solicitud con contexto AUTH ya inicializado.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ historial }` ordenado desde el más reciente.
 */
export async function consultarHistorialPolitica(req, res) {
  const resultado = await listarHistorialPoliticaComercial(req.authContext.pool);
  return res.status(200).json(resultado);
}

/**
 * Responde una versión de política con su snapshot de porcentajes.
 * @param {object} req Solicitud con el id de política en la ruta.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON con el detalle completo de la versión.
 */
export async function consultarDetallePolitica(req, res) {
  const resultado = await obtenerDetallePoliticaComercial(
    req.authContext.pool,
    req.params.id,
  );
  return res.status(200).json(resultado);
}

/**
 * Recupera una política histórica creando una nueva versión vigente o programada.
 * @param {object} req Solicitud con id histórico, activación opcional y actor autenticado.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON con el nuevo snapshot recuperado.
 */
export async function recuperarPolitica(req, res) {
  const resultado = await recuperarPoliticaComercial(
    req.authContext.pool,
    req.params.id,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(201).json(resultado);
}

/**
 * Cancela la única programación pendiente con revisión optimista y motivo.
 * @param {object} req Solicitud con id de la programación, revision y motivo.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON con la versión cancelada y su evento.
 */
export async function cancelarProgramacionPolitica(req, res) {
  const resultado = await cancelarProgramacionPoliticaComercial(
    req.authContext.pool,
    req.params.id,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Responde los eventos de ciclo de vida registrados para una versión.
 * @param {object} req Solicitud con el id de política en la ruta.
 * @param {object} res Respuesta Express sin almacenamiento.
 * @returns {Promise<object>} JSON `{ eventos }` desde el más reciente.
 */
export async function consultarEventosPolitica(req, res) {
  const eventos = await listarEventosPoliticaComercial(
    req.authContext.pool,
    req.params.id,
  );
  return res.status(200).json({ eventos });
}

/**
 * Crea el borrador de edicion de precios copiando la version ACTIVA.
 * Responde 201 con `{ version }` o 409 si ya existe un borrador abierto.
 */
export async function crearBorrador(req, res) {
  const resultado = await crearBorradorTarifario(
    req.authContext.pool,
    { legajo: req.auth.user.legajo },
  );
  return res.status(201).json(resultado);
}

/**
 * Crea un borrador de edicion copiando una version HISTORICA elegida
 * (recuperacion funcional). Responde 201 con `{ version }` o 409 si ya
 * existe un borrador abierto o el origen no es una version historica.
 */
export async function recuperarVersion(req, res) {
  const resultado = await crearBorradorDesdeHistorica(
    req.authContext.pool,
    req.params,
    { legajo: req.auth.user.legajo },
  );
  return res.status(201).json(resultado);
}

/**
 * Aplica un aumento masivo de porcentaje a la version en preparacion.
 * Responde 200 con `{ evento, porcentaje, filas, revision }`.
 */
export async function aumentarVersion(req, res) {
  const resultado = await aumentarVersionTarifario(
    req.authContext.pool,
    req.params,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Cambia el precio de una tarifa individual del borrador.
 * Responde 200 con `{ tarifa, revision }`.
 */
export async function editarTarifa(req, res) {
  const resultado = await editarTarifaVersion(
    req.authContext.pool,
    req.params,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Finaliza la edicion (PREPARACION -> LISTA_PARA_ACTIVAR).
 * Responde 200 con `{ version }`.
 */
export async function finalizarVersion(req, res) {
  const resultado = await finalizarVersionTarifario(
    req.authContext.pool,
    req.params,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Reabre la edicion ("Volver a edicion"): LISTA_PARA_ACTIVAR ->
 * PREPARACION conservando precios y auditoria. Responde 200 con
 * `{ version, evento }` o 409 si el estado no lo permite.
 */
export async function reanudarVersion(req, res) {
  const resultado = await reanudarEdicionVersion(
    req.authContext.pool,
    req.params,
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Activa manualmente la version finalizada reemplazando la vigente.
 * Responde 200 con `{ version, versionReemplazada, evento }`.
 */
export async function activarVersion(req, res) {
  const resultado = await activarVersionTarifario(
    req.authContext.pool,
    req.params,
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Descarta una version que nunca fue activada (PREPARACION o
 * LISTA_PARA_ACTIVAR) con revision optimista y motivo de negocio; la
 * version pasa a 'CANCELADA' (presentada como 'Descartada' en la
 * pantalla) con evento DESCARTE auditado. Responde 200 con
 * `{ version, evento }`, 409 por estado o revision desfasada.
 */
export async function descartarVersion(req, res) {
  const resultado = await descartarVersionTarifario(
    req.authContext.pool,
    req.params,
    req.body ?? {},
    { legajo: req.auth.user.legajo },
  );
  return res.status(200).json(resultado);
}

/**
 * Compone las rutas GET de consulta ADMIN protegidas por rol actual.
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
  router.get('/tarifario/versiones', authenticate, authorize('ADMIN'), listarVersiones);
  router.get(
    '/tarifario/versiones/:id',
    authenticate,
    authorize('ADMIN'),
    consultarDetalleVersion,
  );
  router.get(
    '/tarifario/versiones/:id/tarifas',
    authenticate,
    authorize('ADMIN'),
    consultarTarifasVersion,
  );
  router.get(
    '/tarifario/versiones/:id/eventos',
    authenticate,
    authorize('ADMIN'),
    consultarEventosVersion,
  );
  router.get('/tarifario', authenticate, authorize('ADMIN'), reconstruirTarifario);
  router.post('/tarifario/versiones', authenticate, authorize('ADMIN'), crearBorrador);
  router.post(
    '/tarifario/versiones/:id/recuperacion',
    authenticate,
    authorize('ADMIN'),
    recuperarVersion,
  );
  router.post(
    '/tarifario/versiones/:id/deshacer',
    authenticate,
    authorize('ADMIN'),
    deshacerUltimoCambio,
  );
  router.post(
    '/tarifario/versiones/:id/aumentos',
    authenticate,
    authorize('ADMIN'),
    aumentarVersion,
  );
  router.patch(
    '/tarifario/versiones/:id/tarifas/:tarifaId',
    authenticate,
    authorize('ADMIN'),
    editarTarifa,
  );
  router.post(
    '/tarifario/versiones/:id/finalizacion',
    authenticate,
    authorize('ADMIN'),
    finalizarVersion,
  );
  router.post(
    '/tarifario/versiones/:id/reanudacion',
    authenticate,
    authorize('ADMIN'),
    reanudarVersion,
  );
  router.post(
    '/tarifario/versiones/:id/activacion',
    authenticate,
    authorize('ADMIN'),
    activarVersion,
  );
  router.post(
    '/tarifario/versiones/:id/descarte',
    authenticate,
    authorize('ADMIN'),
    descartarVersion,
  );
  router.get('/politica-comercial', authenticate, authorize('ADMIN'), consultarPolitica);
  router.get(
    '/politica-comercial/historial',
    authenticate,
    authorize('ADMIN'),
    consultarHistorialPolitica,
  );
  router.get(
    '/politica-comercial/:id',
    authenticate,
    authorize('ADMIN'),
    consultarDetallePolitica,
  );
  router.put(
    '/politica-comercial/:id',
    authenticate,
    authorize('ADMIN'),
    actualizarPolitica,
  );
  router.post(
    '/politica-comercial/:id/recuperacion',
    authenticate,
    authorize('ADMIN'),
    recuperarPolitica,
  );
  router.post(
    '/politica-comercial/:id/cancelacion',
    authenticate,
    authorize('ADMIN'),
    cancelarProgramacionPolitica,
  );
  router.get(
    '/politica-comercial/:id/eventos',
    authenticate,
    authorize('ADMIN'),
    consultarEventosPolitica,
  );
  return router;
}

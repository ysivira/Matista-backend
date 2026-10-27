/**
 * Prepara, calcula y consulta cotizaciones autorizadas del asesor.
 */
import { withConnection } from '../auth/auth.repository.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { activarPoliticasProgramadas } from '../admin/politica-comercial.service.js';
import {
  obtenerPoliticaComercialVigente,
  listarPorcentajesDePoliticas
} from '../admin/politica-comercial.repository.js';
import { resolverVersionVigente } from '../admin/admin.vigencia.js';
import { obtenerPlanPorId, listarTarifasActivas } from '../admin/tarifario.repository.js';
import * as repo from './asesor.repository.js';
import { exigirPropio, exigirRevision, filtroClientes } from './clientes.service.js';
import {
  campos,
  invalidar,
  validarContacto,
  validarId,
  validarPreparacion
} from './asesor.validation.js';
import { solicitarCalculo } from './motor.contract.js';
import { createHash } from 'node:crypto';
import { erroresDescuentos } from '../../domain/comercial/descuentos.validation.js';

/**
 * Construye una solicitud usando las mismas tablas/repositorios ADMIN, en la conexión de guardado.
 * Comprueba propiedad, catálogo y acumulación incluida Joven; conserva la edad declarada sin
 * sustituirla por el nacimiento.
 */
async function prepararEnConexion(c, actor, entrada) {
  const cliente = exigirPropio(await repo.buscarCliente(c, entrada.cliente_id, actor, true));
  // La edad se valida en el contrato de preparación y se captura en su familia/snapshot.
  // Una fecha histórica del cliente se conserva como identidad, nunca sobrescribe esta declaración.
  const plan = await obtenerPlanPorId(c, entrada.plan_id);
  if (!plan || Number(plan.activa) !== 1)
    throw createAppError('ASESOR_ESTADO', 'El plan no está disponible.', 409);
  const version = await resolverVersionVigente(
    c,
    new Date().toISOString().replace('T', ' ').replace('Z', '')
  );
  const politica = await obtenerPoliticaComercialVigente(c, {
    forUpdate: true
  });
  if (!version || !politica)
    throw createAppError('ASESOR_ESTADO', 'No hay tarifa o política vigente.', 409);
  const tarifas = await listarTarifasActivas(c, {
    versionId: version.id,
    planId: entrada.plan_id,
    tipoIngreso: entrada.modalidad === 'Monotributo' ? 'Obligatorio' : entrada.modalidad
  });
  if (!tarifas.length)
    throw createAppError('ASESOR_ESTADO', 'No hay lista de precios disponible.', 409);
  const porcentajes = await listarPorcentajesDePoliticas(c, [politica.id]);
  const errores = erroresDescuentos(entrada.condiciones, politica, porcentajes, entrada.familia);
  if (errores.length) throw createAppError('COTIZACION_REGLA', errores[0].message, 422, errores);
  const { actor_nombre, actor_apellido, actor_legajo, ...parametros } = politica;
  const contexto = await repo.contextoDocumento(c, entrada.plan_id, actor);
  return {
    cliente,
    solicitud: {
      version_contrato: 1,
      entrada,
      cliente: {
        id: String(cliente.id),
        dni: cliente.dni,
        nombres: cliente.nombres,
        apellidos: cliente.apellidos,
        fecha_nacimiento: cliente.fecha_nacimiento,
        provincia: cliente.provincia,
        localidad: cliente.localidad
      },
      plan: {
        id: String(plan.id),
        nombre: plan.nombre,
        detalles: contexto.plan?.detalles ?? null,
        condiciones_generales: contexto.plan?.condiciones_generales ?? null
      },
      asesor: contexto.asesor,
      referencias: {
        tarifa_version_id: String(version.id),
        politica_id: String(politica.id)
      },
      catalogo: {
        tarifas,
        politica: parametros,
        porcentajes
      },
      validacion_economica: 'PENDIENTE_CALCULO'
    }
  };
}

/**
 * Calcula una vista previa autorizada sin persistir clientes, borradores, resultados ni auditorías.
 * @param {object} datos Entradas declarativas del mismo contrato de preparación.
 * @returns {Promise<object>} Resultado real del motor; no sirve como confirmación de emisión.
 */
export async function previsualizarPreparacion(pool, actor, datos) {
  const entrada = validarPreparacion(datos);
  return withConnection(
    pool,
    async c => {
      const { solicitud } = await prepararEnConexion(c, actor, entrada);
      return {
        resultado: await solicitarCalculo(solicitud)
      };
    },
    {
      transaction: true
    }
  );
}

/** Valida campaña parcial con familia opcional para Joven; reutiliza política/motor y conserva clientes anteriores sin familia. */
export async function validarCampana(pool, datos) {
  campos(datos, ['condiciones', 'familia']);
  return withConnection(pool, async c => {
    const politica = await obtenerPoliticaComercialVigente(c);
    if (!politica) throw createAppError('ASESOR_ESTADO', 'No hay política comercial vigente.', 409);
    const porcentajes = await listarPorcentajesDePoliticas(c, [politica.id]);
    return {
      politica_id: String(politica.id),
      errores: erroresDescuentos(datos.condiciones, politica, porcentajes, datos.familia)
    };
  });
}

/** Guarda/actualiza borrador o prepara recotización vinculada sin alterar el origen. */
export async function guardarPreparacion(pool, actor, datos, { id = null, origenId = null } = {}) {
  const entrada = validarPreparacion(datos);
  if (id) validarId(id);
  if (origenId) validarId(origenId);
  // Reutiliza el activador ADMIN antes de fijar referencias en la nueva transacción.
  await activarPoliticasProgramadas(pool);
  return withConnection(
    pool,
    async c => {
      const { cliente, solicitud } = await prepararEnConexion(c, actor, entrada);
      const anterior = id ? exigirPropio(await repo.buscarCotizacion(c, id, actor, true)) : null;
      if (anterior) {
        exigirRevision(anterior, datos.revision);
        if (anterior.estado !== 'BORRADOR')
          throw createAppError(
            'ASESOR_ESTADO',
            'Los cambios económicos requieren una recotización.',
            409
          );
        if (String(anterior.cliente_id) !== entrada.cliente_id)
          invalidar('El cliente del borrador no se sustituye.');
      }
      if (origenId) {
        const origen = exigirPropio(await repo.buscarCotizacion(c, origenId, actor, true));
        if (String(origen.cliente_id) !== entrada.cliente_id)
          invalidar('La recotización debe conservar el cliente.');
        if (origen.estado === 'ANULADA')
          throw createAppError(
            'ASESOR_ESTADO',
            'Una cotización anulada no admite recotización.',
            409
          );
      }
      const contacto = anterior?.contacto ?? {
        email: cliente.email,
        telefono: cliente.telefono,
        direccion: cliente.direccion
      };
      const guardadoId = await repo.guardarBorrador(
        c,
        id,
        actor,
        solicitud.entrada,
        solicitud,
        contacto,
        origenId
      );
      await repo.auditar(
        c,
        actor,
        cliente.id,
        guardadoId,
        origenId ?
          'RECOTIZACION_PREPARADA' :
          anterior ? 'BORRADOR_EDITADO' : 'BORRADOR_CREADO',
        anterior?.solicitud ?? null,
        solicitud
      );
      return repo.buscarCotizacion(c, guardadoId, actor);
    },
    {
      transaction: true
    }
  );
}

/** Lista historial propio con fecha de preparación/emisión, filtros y vigencia persistida. */
export async function consultarHistorial(pool, actor, query) {
  const filtro = {
    ...filtroClientes(query),
    cliente: query.cliente ?? '',
    estado: query.estado ?? '',
    desde: query.desde ?? '',
    hasta: query.hasta ?? ''
  };
  filtro.plan = query.plan ? validarId(query.plan) : '';
  if (typeof filtro.cliente !== 'string' ||
    filtro.cliente.length > 100)
    invalidar('Filtro de cliente inválido.');
  if (!['', 'BORRADOR', 'EMITIDA', 'ANULADA'].includes(filtro.estado)) invalidar();
  for (const fecha of [filtro.desde, filtro.hasta])
    if (fecha !== '' &&
      !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) invalidar();
  return withConnection(pool, async c => ({
    cotizaciones: await repo.listarCotizaciones(c, actor, filtro)
  }));
}

/** Devuelve snapshots y trazabilidad propios sin consultar maestros para recalcular historia. */
export async function obtenerDetalle(pool, actor, id) {
  validarId(id);
  return withConnection(pool, async c => {
    const fila = exigirPropio(await repo.buscarCotizacion(c, id, actor));
    return {
      ...fila,
      ...(await repo.detalleRelacionado(c, id, actor)),
      vencida: fila.vence_at ? new Date(fila.vence_at) < new Date() : false
    };
  });
}

/** Entrega el snapshot y respaldo oficial solo para metadatos documentales no capturados; no modifica historia. */
export async function obtenerDatosPdf(pool, actor, id) {
  const cotizacion = await obtenerDetalle(pool, actor, id);
  const contexto =
    Object.hasOwn(cotizacion.solicitud.plan, 'condiciones_generales') &&
    Object.hasOwn(cotizacion.solicitud.plan, 'detalles') &&
    cotizacion.solicitud.asesor
      ? {}
      : await withConnection(pool, c => repo.contextoDocumento(c, cotizacion.plan_id, actor));
  return {
    cotizacion,
    contexto
  };
}

/** Edita únicamente contacto o anula, con revisión, auditoría y sin borrar cotizaciones. */
export async function modificarCotizacion(pool, actor, id, datos, anular = false) {
  validarId(id);
  campos(datos, anular ? ['revision', 'motivo'] : ['revision', 'contacto']);
  if (
    anular &&
    (typeof datos.motivo !== 'string' || !datos.motivo.trim() ||
      datos.motivo.length > 255)
  )
    invalidar('Indica el motivo de anulación.');
  const contacto = anular ? null : validarContacto(datos.contacto);
  return withConnection(
    pool,
    async c => {
      const referencia = exigirPropio(await repo.buscarCotizacion(c, id, actor));
      // Mismo orden que guardarPreparacion: cliente antes de cotización para no invertir locks.
      exigirPropio(await repo.buscarCliente(c, referencia.cliente_id, actor, true));
      const fila = exigirPropio(await repo.buscarCotizacion(c, id, actor, true));
      exigirRevision(fila, datos.revision);
      if (fila.estado === 'ANULADA')
        throw createAppError('ASESOR_ESTADO', 'La cotización está anulada.', 409);
      await repo.modificarCotizacion(
        c,
        id,
        actor,
        contacto ?? fila.contacto,
        anular ?
          'ANULADA' :
          fila.estado
      );
      await repo.auditar(
        c,
        actor,
        fila.cliente_id,
        id,
        anular ?
          'COTIZACION_ANULADA' :
          'CONTACTO_EDITADO',
        {
          contacto: fila.contacto,
          estado: fila.estado
        },
        {
          contacto: contacto ?? fila.contacto,
          estado: anular ? 'ANULADA' : fila.estado,
          ...(anular
            ? {
                motivo: datos.motivo.trim()
              }
            : {})
        }
      );
      return repo.buscarCotizacion(c, id, actor);
    },
    {
      transaction: true
    }
  );
}

/** Calcula siempre con las referencias vigentes, propiedad transaccional y una huella para confirmar emisión. */
export async function calcularPreparacion(pool, actor, id) {
  validarId(id);
  await activarPoliticasProgramadas(pool);
  return withConnection(
    pool,
    async c => {
      const referencia = exigirPropio(await repo.buscarCotizacion(c, id, actor));
      const { solicitud } = await prepararEnConexion(c, actor, referencia.solicitud.entrada);
      const detalle = exigirPropio(await repo.buscarCotizacion(c, id, actor, true));
      if (detalle.estado !== 'BORRADOR')
        throw createAppError('ASESOR_ESTADO', 'Solo se calcula una preparación en borrador.', 409);
      if (detalle.revision !== referencia.revision)
        throw createAppError(
          'ASESOR_CONCURRENCIA',
          'La preparación cambió. Actualiza antes de calcular.',
          409
        );
      const resultado = await solicitarCalculo(solicitud);
      return {
        resultado,
        solicitud,
        revision: detalle.revision,
        huella: huellaCalculo(resultado, solicitud.entrada)
      };
    },
    {
      transaction: true
    }
  );
}

/** Ordena claves JSON de forma recursiva para que MySQL no cambie la huella al releer el snapshot. */
function ordenarClaves(clave, valor) {
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    return Object.fromEntries(
      Object.keys(valor)
        .sort()
        .map(k => [k, valor[k]])
    );
  }
  return valor;
}

/** Identifica los datos y resultados confirmados sin confiar en importes enviados por React. */
function huellaCalculo(resultado, entrada) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        {
          resultado,
          entrada
        },
        ordenarClaves
      )
    )
    .digest('hex');
}

/**
 * Emite con recálculo autoritativo, número único, vigencia de 15 días y auditoría en una
 * transacción.
 * @param {object} datos Revisión y huella de la previsualización; jamás importes del navegador.
 * @returns {Promise<object>} Cotización emitida; un reintento conserva la misma emisión.
 */
export async function emitirPreparacion(pool, actor, id, datos) {
  validarId(id);
  campos(datos, ['revision', 'huella']);
  if (!Number.isInteger(datos.revision) ||
    !/^[a-f0-9]{64}$/.test(datos.huella ?? ''))
    invalidar('Calcula y revisa la cotización antes de emitir.');
  await activarPoliticasProgramadas(pool);
  return withConnection(
    pool,
    async c => {
      const referencia = exigirPropio(await repo.buscarCotizacion(c, id, actor));
      // Un reintento idéntico consulta su snapshot sin depender de maestros que pudieron cambiar.
      if (referencia.estado === 'EMITIDA') {
        exigirPropio(await repo.buscarCliente(c, referencia.cliente_id, actor, true));
        const emitida = exigirPropio(await repo.buscarCotizacion(c, id, actor, true));
        if (
          emitida.estado === 'EMITIDA' &&
          Number(emitida.revision) === datos.revision + 1 &&
          huellaCalculo(emitida.resultado, emitida.solicitud.entrada) === datos.huella
        )
          return emitida;
        throw createAppError(
          'ASESOR_CONCURRENCIA',
          'La emisión ya cambió. Consulta su detalle.',
          409
        );
      }
      const { solicitud } = await prepararEnConexion(c, actor, referencia.solicitud.entrada);
      const fila = exigirPropio(await repo.buscarCotizacion(c, id, actor, true));
      if (
        fila.estado === 'EMITIDA' &&
        Number(fila.revision) === datos.revision + 1 &&
        huellaCalculo(fila.resultado, fila.solicitud.entrada) === datos.huella
      )
        return fila;
      if (fila.estado !== 'BORRADOR')
        throw createAppError('ASESOR_ESTADO', 'La cotización no admite emisión.', 409);
      exigirRevision(fila, datos.revision);
      const resultado = await solicitarCalculo(solicitud);
      if (huellaCalculo(resultado, solicitud.entrada) !==
        datos.huella)
        throw createAppError(
          'ASESOR_CONCURRENCIA',
          'Las tarifas o condiciones cambiaron. Vuelve a calcular antes de emitir.',
          409
        );
      solicitud.validacion_economica = 'CALCULADA_MOTOR';
      await repo.emitirCotizacion(c, fila, solicitud, resultado);
      await repo.auditar(
        c,
        actor,
        fila.cliente_id,
        id,
        'COTIZACION_EMITIDA',
        {
          estado: fila.estado
        },
        {
          resultado,
          referencias: solicitud.referencias
        }
      );
      return repo.buscarCotizacion(c, id, actor);
    },
    {
      transaction: true
    }
  );
}

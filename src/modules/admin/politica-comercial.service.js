/**
 * ============================================================
 * MATISTA | CICLO DE POLÍTICAS COMERCIALES
 * ============================================================
 *
 * Archivo: politica-comercial.service.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Validar y versionar condiciones comerciales, coordinar su
 * programación o activación y preservar el historial auditado.
 *
 * ============================================================
 */
import { withConnection } from '../auth/auth.repository.js';
import {
  activarPoliticaProgramada,
  actualizarPoliticaProgramada,
  cancelarPoliticaProgramada,
  cerrarPoliticaVigente,
  insertarEventoPolitica,
  insertarPoliticaComercial,
  insertarPorcentajesComerciales,
  listarEventosPolitica,
  listarPoliticasComerciales,
  listarPorcentajesDePoliticas,
  obtenerPoliticaComercialPorId,
  obtenerPoliticaComercialProgramada,
  obtenerPoliticaComercialVigente,
  obtenerSnapshotActor,
  reemplazarPorcentajesProgramados
} from './politica-comercial.repository.js';
import {
  errorConcurrencia,
  errorEstado,
  errorNoEncontrado,
  errorValidacion,
  mapearErrorIntegridad
} from './admin.errors.js';
import { withAdminTransaction } from './admin.transaction.js';
import { esImporteValido } from './admin.money.js';

const CAMPOS_POLITICA = Object.freeze([
  'porcentaje_aporte_reconocido',
  'tope_sueldo_bruto',
  'joven_porcentaje',
  'comercial_fijo_max_pct',
  'comercial_fijo_meses_max',
  'comercial_escalonado_max_pct',
  'comercial_escalonado_tramos_max',
  'comercial_escalonado_total_meses_max',
  'primer_tramo_50_meses_max',
  'tdc_pct',
  'tdc_habilitado',
  'tope_comercial_tdc_pct',
  'afinidad_pct',
  'aporte_monotributo',
  'aporte_adherente',
  'iva_voluntario_pct'
]);

/**
 * Convierte una fecha válida al DATETIME(6) UTC usado por MySQL.
 * @param {Date} fecha Instante validado.
 * @returns {string} Fecha UTC con microsegundos.
 */
function fechaMysqlUtc(fecha) {
  return fecha.toISOString().replace('T', ' ').replace('Z', '000');
}

/**
 * Interpreta un instante guardado por mysql2: Date nativo o string
 * DATETIME(6) UTC de MySQL (`YYYY-MM-DD HH:MM:SS(.ffffff)`).
 * @param {Date|string} valor Instante leído de la base o del proceso.
 * @returns {Date} Fecha comparable.
 * @throws {TypeError} Cuando el valor no representa un instante válido.
 */
function instanteDe(valor) {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) {
      throw new TypeError('El instante leído no es una fecha válida.');
    }
    return valor;
  }
  if (typeof valor === 'string') {
    const fecha = new Date(valor.includes('T') ? valor : `${valor.replace(' ', 'T')}Z`);
    if (!Number.isNaN(fecha.getTime())) return fecha;
  }
  throw new TypeError('El instante leído no es una fecha válida.');
}

/**
 * Convierte y valida un identificador de versión de política.
 * @param {string|number} valor Identificador recibido por HTTP.
 * @returns {number} Entero positivo.
 * @throws {Error} ADMIN_VALIDACION cuando el valor no es válido.
 */
function validarPoliticaId(valor) {
  const id = Number(valor);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw errorValidacion('El identificador de política comercial es inválido.', [
      {
        field: 'id',
        message: 'Debe ser un entero positivo.'
      }
    ]);
  }
  return id;
}

/**
 * Valida la revisión optimista exigida al editar o cancelar una programación.
 * @param {unknown} valor Revisión enviada por el cliente.
 * @returns {number} Revisión entera no negativa.
 * @throws {Error} ADMIN_VALIDACION para valores ausentes o inválidos.
 */
function validarRevision(valor) {
  const revision = Number(valor);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw errorValidacion('La revisión de la programación es inválida.', [
      {
        field: 'revision',
        message: 'Debe ser un entero no negativo.'
      }
    ]);
  }
  return revision;
}

/**
 * Valida los parámetros comerciales y rechaza campos ajenos al contrato.
 * @param {object} datos Cuerpo comercial parcial.
 * @returns {void}
 * @throws {Error} ADMIN_VALIDACION con el detalle de campos inválidos.
 */
function validarDatosPoliticaComercial(datos) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) {
    throw errorValidacion('Datos de política comercial inválidos.');
  }
  const errores = [];
  const camposPermitidos = new Set([...CAMPOS_POLITICA, 'porcentajes_comerciales']);
  for (const campo of Object.keys(datos)) {
    if (!camposPermitidos.has(campo)) {
      errores.push({
        field: campo,
        message: 'El campo no pertenece a la política comercial.'
      });
    }
  }

  /**
   * Valida un campo numérico presente sin exigirlo en actualizaciones parciales.
   * @param {string} campo Nombre contractual.
   * @param {(valor: number) => boolean} condicion Regla de dominio.
   * @param {string} mensaje Mensaje público.
   * @returns {void}
   */
  const validarNumero = (campo, condicion, mensaje) => {
    if (!Object.hasOwn(datos, campo)) return;
    const valor = datos[campo];
    const numero = valor === null || valor === '' ? Number.NaN : Number(valor);
    if (!Number.isFinite(numero) || !condicion(numero))
      errores.push({
        field: campo,
        message: mensaje
      });
  };
  validarNumero(
    'porcentaje_aporte_reconocido',
    v => v > 0 && v < 100,
    'Debe ser mayor que 0 y menor que 100.'
  );
  validarNumero('tope_sueldo_bruto', v => v > 0, 'Debe ser un número positivo.');
  validarNumero('joven_porcentaje', v => v >= 0 && v <= 100, 'Debe estar entre 0 y 100.');
  validarNumero(
    'comercial_fijo_max_pct',
    v => v > 0 && v <= 100,
    'Debe ser mayor que 0 y menor o igual que 100.'
  );
  validarNumero(
    'comercial_fijo_meses_max',
    v => Number.isInteger(v) && v >= 1 && v <= 12,
    'Debe ser un entero entre 1 y 12.'
  );
  validarNumero(
    'comercial_escalonado_max_pct',
    v => v > 0 && v <= 100,
    'Debe ser mayor que 0 y menor o igual que 100.'
  );
  validarNumero(
    'comercial_escalonado_tramos_max',
    v => Number.isInteger(v) && v >= 1 && v <= 4,
    'Debe ser un entero entre 1 y 4.'
  );
  validarNumero(
    'comercial_escalonado_total_meses_max',
    v => Number.isInteger(v) && v >= 1 &&
      v <= 12,
    'Debe ser un entero entre 1 y 12.'
  );
  validarNumero(
    'primer_tramo_50_meses_max',
    v => Number.isInteger(v) && v >= 1 && v <= 12,
    'Debe ser un entero entre 1 y 12.'
  );
  validarNumero('tdc_pct', v => v >= 0 && v <= 100, 'Debe estar entre 0 y 100.');
  validarNumero(
    'tdc_habilitado',
    v => Number.isInteger(v) && (v === 0 || v === 1),
    'Debe ser 0 o 1.'
  );
  validarNumero(
    'tope_comercial_tdc_pct',
    v => v > 0 && v <= 100,
    'Debe ser mayor que 0 y menor o igual que 100.'
  );

  // El aporte de monotributo es un importe en pesos que debe caber en
  // DECIMAL(12,2); se reutiliza la validación monetaria compartida de ADMIN.
  validarNumero(
    'aporte_monotributo',
    v =>
      esImporteValido(v, {
        maximo: '9999999999.99',
        decimales: 2
      }),
    'Debe ser un importe positivo con hasta dos decimales.'
  );
  if (Object.hasOwn(datos, 'iva_voluntario_pct') && datos.iva_voluntario_pct !== null) {
    validarNumero(
      'iva_voluntario_pct',
      v =>
        esImporteValido(v, {
          maximo: '100.00',
          decimales: 2
        }),
      'Debe ser un porcentaje entre 0 y 100 o null.'
    );
  }
  if (Object.hasOwn(datos, 'aporte_adherente') && datos.aporte_adherente !== null) {
    validarNumero(
      'aporte_adherente',
      v =>
        esImporteValido(v, {
          maximo: '9999999999.99',
          decimales: 2
        }),
      'Debe ser un importe no negativo con hasta dos decimales o null.'
    );
  }
  if (Object.hasOwn(datos, 'afinidad_pct') && datos.afinidad_pct !== null) {
    const valor = datos.afinidad_pct === '' ? Number.NaN : Number(datos.afinidad_pct);
    if (!Number.isFinite(valor) || valor < 0 || valor > 100) {
      errores.push({
        field: 'afinidad_pct',
        message: 'Debe estar entre 0 y 100 o ser null.'
      });
    }
  }
  if (errores.length > 0) throw errorValidacion('Datos de política comercial inválidos.', errores);
}

/**
 * Normaliza un catálogo numérico y rechaza valores inválidos o duplicados.
 * @param {unknown} valores Array de números recibido por HTTP.
 * @returns {string[]} Porcentajes únicos, descendentes y con dos decimales.
 * @throws {Error} ADMIN_VALIDACION cuando el contrato no se cumple.
 */
function normalizarPorcentajes(valores) {
  if (!Array.isArray(valores)) {
    throw errorValidacion('El catálogo de porcentajes comerciales es inválido.', [
      {
        field: 'porcentajes_comerciales',
        message: 'Debe ser un array de números.'
      }
    ]);
  }
  const errores = [];
  const vistos = new Set();
  valores.forEach((valor, indice) => {
    const centesimos =
      typeof valor === 'number' && Number.isFinite(valor) ?
        Math.round(valor * 100) :
        Number.NaN;
    if (
      !Number.isFinite(centesimos) ||
      valor <= 0 ||
      valor > 100 ||
      Math.abs(valor * 100 - centesimos) > 1e-8
    ) {
      errores.push({
        field: `porcentajes_comerciales.${indice}`,
        message: 'Debe ser un número mayor que 0, menor o igual que 100 y con hasta dos decimales.'
      });
      return;
    }
    if (vistos.has(centesimos)) {
      errores.push({
        field: `porcentajes_comerciales.${indice}`,
        message: 'El porcentaje está duplicado en el catálogo.'
      });
    }
    vistos.add(centesimos);
  });
  if (errores.length > 0) {
    throw errorValidacion('El catálogo de porcentajes comerciales es inválido.', errores);
  }
  return [...vistos].sort((a, b) => b - a).map(valor => (valor / 100).toFixed(2));
}

/**
 * Valida la opción de activación inmediata o futura.
 * @param {unknown} valor Configuración `{ modo, fecha }` recibida.
 * @param {Date} ahora Reloj confiable de la operación.
 * @returns {{modo: 'INMEDIATA'|'PROGRAMADA', fecha: Date}}
 * @throws {Error} ADMIN_VALIDACION si la fecha no es futura o carece de zona horaria.
 */
function validarActivacion(valor, ahora) {
  if (valor === undefined)
    return {
      modo: 'INMEDIATA',
      fecha: ahora
    };
  if (
    !valor ||
    typeof valor !== 'object' ||
    Array.isArray(valor) ||
    !['INMEDIATA', 'PROGRAMADA'].includes(valor.modo)
  ) {
    throw errorValidacion('La modalidad de activación es inválida.', [
      {
        field: 'activacion.modo',
        message: 'Debe ser INMEDIATA o PROGRAMADA.'
      }
    ]);
  }
  if (valor.modo === 'INMEDIATA')
    return {
      modo: 'INMEDIATA',
      fecha: ahora
    };
  if (typeof valor.fecha !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(valor.fecha)) {
    throw errorValidacion('La fecha programada es inválida.', [
      {
        field: 'activacion.fecha',
        message: 'Debe incluir fecha, hora y zona horaria.'
      }
    ]);
  }
  const fecha = new Date(valor.fecha);
  if (Number.isNaN(fecha.getTime()) || fecha.getTime() <= ahora.getTime()) {
    throw errorValidacion('La fecha programada debe ser futura.', [
      {
        field: 'activacion.fecha',
        message: 'Indicá una fecha y hora posteriores al momento actual.'
      }
    ]);
  }
  return {
    modo: 'PROGRAMADA',
    fecha
  };
}

/**
 * Separa los metadatos del ciclo de los valores comerciales del PUT.
 * @param {object} cuerpo Cuerpo HTTP completo.
 * @returns {{datos: object, activacion: unknown, revision: unknown}}
 * @throws {Error} ADMIN_VALIDACION para campos de nivel superior desconocidos.
 */
function separarCuerpo(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) {
    throw errorValidacion('Datos de política comercial inválidos.');
  }
  const { activacion, revision, ...datos } = cuerpo;
  validarDatosPoliticaComercial(datos);
  return {
    datos,
    activacion,
    revision
  };
}

/**
 * Agrega a cada política sus porcentajes sin duplicar filas antiguas enlazadas.
 * @param {object[]} politicas Versiones recuperadas.
 * @param {object[]} porcentajes Filas vinculadas.
 * @returns {object[]} Snapshots completos.
 */
function componerSnapshots(politicas, porcentajes) {
  const porPolitica = new Map();
  for (const fila of porcentajes) {
    const clave = String(fila.politica_comercial_id);
    if (!porPolitica.has(clave)) porPolitica.set(clave, new Map());
    const valor = Number(fila.porcentaje).toFixed(2);
    if (!porPolitica.get(clave).has(valor)) porPolitica.get(clave).set(valor, fila.porcentaje);
  }
  return politicas.map(politica => ({
    ...politica,
    porcentajes_comerciales: [...(porPolitica.get(String(politica.id))?.values() ?? [])]
  }));
}

/**
 * Completa campos omitidos desde la versión base sin aplicar valores cero implícitos.
 * @param {object} base Snapshot persistido.
 * @param {object} datos Campos parciales validados.
 * @returns {object} Política comercial completa.
 */
function completarPolitica(base, datos) {
  return Object.fromEntries(
    CAMPOS_POLITICA.map(campo => [
      campo,
      Object.hasOwn(datos, campo) ?
        datos[campo] : (
        base[campo] ?? null)
    ])
  );
}

/**
 * Compara dos contenidos comerciales normalizando decimales y orden de descuentos.
 * @param {object} izquierda Primer snapshot.
 * @param {string[]} porcentajesIzquierda Catálogo normalizado.
 * @param {object} derecha Segundo snapshot.
 * @param {string[]} porcentajesDerecha Catálogo normalizado.
 * @returns {boolean} true cuando no existe ningún cambio comercial real.
 */
function contenidosIguales(izquierda, porcentajesIzquierda, derecha, porcentajesDerecha) {
  const camposIguales = CAMPOS_POLITICA.every(campo => {
    const a = izquierda[campo];
    const b = derecha[campo];
    if (a === null || b === null) return a === b;
    return Number(a) === Number(b);
  });
  if (!camposIguales || porcentajesIzquierda.length !== porcentajesDerecha.length) return false;
  return porcentajesIzquierda.every(
    (valor, indice) => Number(valor) === Number(porcentajesDerecha[indice])
  );
}

/**
 * Obtiene un snapshot completo dentro de una conexión existente.
 * @param {object} connection Conexión mysql2 activa.
 * @param {number} politicaId Identificador validado.
 * @returns {Promise<object|undefined>} Snapshot o undefined.
 */
async function obtenerSnapshotPorId(connection, politicaId) {
  const politica = await obtenerPoliticaComercialPorId(connection, politicaId);
  if (!politica) return undefined;
  const porcentajes = await listarPorcentajesDePoliticas(connection, [politicaId]);
  return componerSnapshots([politica], porcentajes)[0];
}

/**
 * Convierte filas de auditoría a un contrato JSON estable.
 * @param {object[]} eventos Filas de politica_comercial_eventos.
 * @returns {object[]} Eventos con identificadores textuales y fecha ISO.
 */
function presentarEventos(eventos) {
  return eventos.map(evento => ({
    ...evento,
    id: String(evento.id),
    politica_comercial_id: String(evento.politica_comercial_id),
    evento_en: evento.evento_en ? instanteDe(evento.evento_en).toISOString() : null
  }));
}

/**
 * Registra un evento tomando el nombre y apellido reales desde empleados.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {number} politicaId Versión afectada.
 * @param {string} tipoEvento Tipo cerrado del ciclo.
 * @param {string} actorLegajo Responsable de la operación.
 * @param {string} detalle Explicación auditable.
 * @returns {Promise<number>} Identificador del evento.
 */
async function auditar(connection, politicaId, tipoEvento, actorLegajo, detalle) {
  const actor = await obtenerSnapshotActor(connection, actorLegajo);
  return insertarEventoPolitica(connection, {
    politicaId,
    tipoEvento,
    actor,
    detalle
  });
}

/**
 * Cancela la programación anterior al ser reemplazada por otra decisión.
 * @param {object} connection Conexión transaccional mysql2.
 * @param {object|undefined} pendiente Programación bloqueada.
 * @param {string} actorLegajo Responsable del reemplazo.
 * @param {string} motivo Motivo persistido y mostrado.
 * @returns {Promise<void>} Finaliza aunque no exista programación previa.
 */
async function sustituirProgramacion(connection, pendiente, actorLegajo, motivo) {
  if (!pendiente) return;
  await cancelarPoliticaProgramada(connection, pendiente.id, {
    actorLegajo,
    motivo
  });
  await auditar(connection, pendiente.id, 'CANCELACION', actorLegajo, motivo);
}

/**
 * Activa la programación vencida, cerrando la vigente en una sola transacción.
 * Puede invocarse desde el scheduler o de forma preventiva antes de una lectura.
 * @param {object} pool Pool MySQL compartido.
 * @param {Date} ahora Reloj UTC de referencia.
 * @returns {Promise<object|null>} Versión activada o null si aún no corresponde.
 */
export async function activarPoliticasProgramadas(pool, ahora = new Date()) {
  return withAdminTransaction(pool, async connection => {
    const pendiente = await obtenerPoliticaComercialProgramada(connection, {
      forUpdate: true
    });
    if (!pendiente || instanteDe(pendiente.fecha_vigencia).getTime() > ahora.getTime()) return null;
    const vigente = await obtenerPoliticaComercialVigente(connection, {
      forUpdate: true
    });
    if (!vigente) throw errorEstado('No existe una política vigente para sustituir.');
    const fechaEfectiva = fechaMysqlUtc(instanteDe(pendiente.fecha_vigencia));
    await cerrarPoliticaVigente(connection, vigente.id, fechaEfectiva);
    if ((await activarPoliticaProgramada(connection, pendiente.id)) !==
      1)
      throw errorConcurrencia();
    await auditar(
      connection,
      pendiente.id,
      'ACTIVACION',
      pendiente.actor_legajo,
      `Activación automática de la versión ${pendiente.id}, que reemplazó a la versión ${vigente.id}.`
    );
    return obtenerSnapshotPorId(connection, pendiente.id);
  }).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

/**
 * Retorna la vigente e informa, sin mezclarla, la programación pendiente.
 * @param {object} pool Pool MySQL compartido.
 * @param {Date} ahora Reloj usado para resolver activaciones vencidas.
 * @returns {Promise<object>} Vigente con `programacion_pendiente` opcional.
 */
export async function obtenerPoliticaComercial(pool, ahora = new Date()) {
  await activarPoliticasProgramadas(pool, ahora);
  return withConnection(
    pool,
    async connection => {
      const vigente = await obtenerPoliticaComercialVigente(connection);
      if (!vigente) throw errorNoEncontrado('No existe una política comercial vigente.');
      const pendiente = await obtenerPoliticaComercialProgramada(connection);
      const politicas = pendiente ? [vigente, pendiente] : [vigente];
      const porcentajes = await listarPorcentajesDePoliticas(
        connection,
        politicas.map(politica => politica.id)
      );
      const [snapshotVigente, snapshotPendiente] = componerSnapshots(politicas, porcentajes);
      return {
        ...snapshotVigente,
        programacion_pendiente: snapshotPendiente ?? null
      };
    },
    {
      transaction: true
    }
  );
}

/**
 * Lista todas las versiones con responsable completo y descuentos.
 * @param {object} pool Pool MySQL compartido.
 * @param {Date} ahora Reloj usado para activar pendientes vencidas.
 * @returns {Promise<{historial: object[]}>} Historial completo.
 */
export async function listarHistorialPoliticaComercial(pool, ahora = new Date()) {
  await activarPoliticasProgramadas(pool, ahora);
  return withConnection(
    pool,
    async connection => {
      const politicas = await listarPoliticasComerciales(connection);
      const porcentajes = await listarPorcentajesDePoliticas(
        connection,
        politicas.map(politica => politica.id)
      );
      return {
        historial: componerSnapshots(politicas, porcentajes)
      };
    },
    {
      transaction: true
    }
  );
}

/**
 * Lista la auditoría de ciclo de vida de una versión.
 * @param {object} pool Pool MySQL compartido.
 * @param {string|number} politicaId Versión consultada.
 * @returns {Promise<object[]>} Eventos con responsable y fecha ISO.
 */
export async function listarEventosPoliticaComercial(pool, politicaId) {
  const id = validarPoliticaId(politicaId);
  return withConnection(
    pool,
    async connection => {
      const eventos = await listarEventosPolitica(connection, id);
      if (eventos.length === 0 && !(await obtenerPoliticaComercialPorId(connection, id))) {
        throw errorNoEncontrado('La política comercial indicada no existe.');
      }
      return presentarEventos(eventos);
    },
    {
      transaction: true
    }
  );
}

/**
 * Obtiene el detalle completo de una versión de política.
 * @param {object} pool Pool MySQL compartido.
 * @param {string|number} politicaId Identificador recibido por ruta.
 * @returns {Promise<object>} Detalle completo con `eventos`.
 * @throws {Error} ADMIN_VALIDACION o ADMIN_NO_ENCONTRADO según corresponda.
 */
export async function obtenerDetallePoliticaComercial(pool, politicaId) {
  const id = validarPoliticaId(politicaId);
  return withConnection(
    pool,
    async connection => {
      const snapshot = await obtenerSnapshotPorId(connection, id);
      if (!snapshot) throw errorNoEncontrado('La política comercial indicada no existe.');
      const eventos = await listarEventosPolitica(connection, id);
      return {
        ...snapshot,
        eventos: presentarEventos(eventos)
      };
    },
    {
      transaction: true
    }
  );
}

/**
 * ============================================================
 * ACTUALIZAR POLITICA COMERCIAL
 * ============================================================
 *
 * Crea o edita una versión, con activación inmediata o programada.
 * @param {object} pool Pool MySQL compartido.
 * @param {string|number} politicaId Vigente o programación que se edita.
 * @param {object} cuerpo Parámetros, descuentos, activación y revisión opcional.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @param {Date} ahora Reloj UTC confiable.
 * @returns {Promise<object>} Snapshot creado o editado.
 */
export async function actualizarPoliticaComercial(
  pool,
  politicaId,
  cuerpo,
  actor,
  ahora = new Date()
) {
  const id = validarPoliticaId(politicaId);
  const { datos, activacion: activacionCruda, revision: revisionCruda } = separarCuerpo(cuerpo);
  const activacion = validarActivacion(activacionCruda, ahora);
  const porcentajesSolicitados = Object.hasOwn(datos, 'porcentajes_comerciales')
    ? normalizarPorcentajes(datos.porcentajes_comerciales)
    : undefined;
  return withAdminTransaction(pool, async connection => {
    // Orden de bloqueo compartido con el activador programado (scheduler):
    // primero la programacion y despues la vigente. Tomarlas en el orden
    // inverso generaria ciclos de bloqueo con las activaciones vencidas.
    const pendiente = await obtenerPoliticaComercialProgramada(connection, {
      forUpdate: true
    });
    const vigente = await obtenerPoliticaComercialVigente(connection, {
      forUpdate: true
    });
    if (!vigente) throw errorNoEncontrado('No existe una política comercial vigente.');
    const objetivo = Number(pendiente?.id) === id ? pendiente : vigente;
    if (Number(objetivo.id) !== id) throw errorConcurrencia();
    const revision = objetivo.estado === 'PROGRAMADA' ? validarRevision(revisionCruda) : null;
    if (revision !== null && Number(objetivo.revision) !== revision) throw errorConcurrencia();
    const porcentajesObjetivo = (
      await listarPorcentajesDePoliticas(connection, [objetivo.id], {
        forUpdate: true
      })
    ).map(fila => Number(fila.porcentaje).toFixed(2));
    const porcentajesVigentes =
      objetivo.estado === 'VIGENTE'
        ? porcentajesObjetivo
        : (
            await listarPorcentajesDePoliticas(connection, [vigente.id], {
              forUpdate: true
            })
          ).map(fila => Number(fila.porcentaje).toFixed(2));
    const politicaNueva = completarPolitica(objetivo, datos);
    const porcentajesNuevos = porcentajesSolicitados ?? porcentajesObjetivo;
    if (
      objetivo.estado === 'PROGRAMADA' &&
      contenidosIguales(objetivo, porcentajesObjetivo, politicaNueva, porcentajesNuevos) &&
      instanteDe(objetivo.fecha_vigencia).getTime() === activacion.fecha.getTime()
    ) {
      throw errorEstado('No hay cambios para guardar en la programación.');
    }
    if (contenidosIguales(vigente, porcentajesVigentes, politicaNueva, porcentajesNuevos)) {
      throw errorEstado('La política no contiene cambios respecto de la versión vigente.');
    }
    const fechaVigencia = fechaMysqlUtc(activacion.fecha);
    if (objetivo.estado === 'PROGRAMADA') {
      if (
        (await actualizarPoliticaProgramada(connection, objetivo.id, politicaNueva, {
          revision,
          fechaVigencia,
          actorLegajo: actor.legajo
        })) !== 1
      )
        throw errorConcurrencia();
      await reemplazarPorcentajesProgramados(connection, objetivo.id, porcentajesNuevos, {
        actorLegajo: actor.legajo,
        fechaVigencia
      });
      await auditar(
        connection,
        objetivo.id,
        'MODIFICACION',
        actor.legajo,
        `Modificación de la programación de la versión ${objetivo.id}.`
      );
      if (activacion.modo === 'INMEDIATA') {
        await cerrarPoliticaVigente(connection, vigente.id, fechaVigencia);
        if ((await activarPoliticaProgramada(connection, objetivo.id)) !==
          1)
          throw errorConcurrencia();
        await auditar(
          connection,
          objetivo.id,
          'ACTIVACION',
          actor.legajo,
          `Activación inmediata de la versión ${objetivo.id}, que reemplazó a la versión ${vigente.id}.`
        );
      }
      return obtenerSnapshotPorId(connection, objetivo.id);
    }
    await sustituirProgramacion(
      connection,
      pendiente,
      actor.legajo,
      `Programación reemplazada por una nueva decisión sobre la versión vigente ${vigente.id}.`
    );
    if (activacion.modo === 'INMEDIATA') {
      await cerrarPoliticaVigente(connection, vigente.id, fechaVigencia);
    }
    const estado = activacion.modo === 'INMEDIATA' ? 'VIGENTE' : 'PROGRAMADA';
    const nuevaId = await insertarPoliticaComercial(connection, politicaNueva, {
      estado,
      fechaVigencia,
      actorLegajo: actor.legajo,
      versionBaseId: vigente.id
    });
    await insertarPorcentajesComerciales(connection, nuevaId, porcentajesNuevos, {
      actorLegajo: actor.legajo,
      fechaVigencia
    });
    await auditar(
      connection,
      nuevaId,
      estado === 'VIGENTE' ? 'CREACION' : 'PROGRAMACION',
      actor.legajo,
      estado === 'VIGENTE'
        ? `Creación y activación inmediata de la versión ${nuevaId}; reemplazó a la versión ${vigente.id}.`
        : `Programación de la versión ${nuevaId} para ${activacion.fecha.toISOString()}.`
    );
    return obtenerSnapshotPorId(connection, nuevaId);
  }).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

/**
 * Cancela la única programación sin afectar la política vigente.
 * @param {object} pool Pool MySQL compartido.
 * @param {string|number} politicaId Programación solicitada.
 * @param {{revision: unknown, motivo: unknown}} cuerpo Datos de cancelación.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @returns {Promise<object>} Snapshot cancelado y evento.
 */
export async function cancelarProgramacionPoliticaComercial(pool, politicaId, cuerpo, actor) {
  const id = validarPoliticaId(politicaId);
  const revision = validarRevision(cuerpo?.revision);
  const motivo = typeof cuerpo?.motivo === 'string' ? cuerpo.motivo.trim() : '';
  if (motivo.length < 1 || motivo.length > 200) {
    throw errorValidacion('El motivo de cancelación es inválido.', [
      {
        field: 'motivo',
        message: 'Debe tener entre 1 y 200 caracteres.'
      }
    ]);
  }
  return withAdminTransaction(pool, async connection => {
    const pendiente = await obtenerPoliticaComercialPorId(connection, id, {
      forUpdate: true
    });
    if (!pendiente) throw errorNoEncontrado('La programación indicada no existe.');
    if (pendiente.estado !== 'PROGRAMADA') {
      throw errorEstado('Solo una política programada puede cancelarse.');
    }
    if (Number(pendiente.revision) !== revision) throw errorConcurrencia();
    if (
      (await cancelarPoliticaProgramada(connection, id, {
        actorLegajo: actor.legajo,
        motivo,
        revision
      })) !== 1
    )
      throw errorConcurrencia();
    const eventoId = await auditar(
      connection,
      id,
      'CANCELACION',
      actor.legajo,
      `Cancelación de la programación ${id}. Motivo: ${motivo}`
    );
    return {
      version: await obtenerSnapshotPorId(connection, id),
      evento: {
        id: String(eventoId),
        tipo: 'CANCELACION'
      }
    };
  }).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

/**
 * Recupera una histórica creando una copia inmediata o programada.
 * @param {object} pool Pool MySQL compartido.
 * @param {string|number} politicaId Versión histórica fuente.
 * @param {object} cuerpo Configuración de activación opcional.
 * @param {{legajo: string}} actor ADMIN responsable.
 * @param {Date} ahora Reloj UTC confiable.
 * @returns {Promise<object>} Nueva copia independiente.
 */
export async function recuperarPoliticaComercial(
  pool,
  politicaId,
  cuerpo,
  actor,
  ahora = new Date()
) {
  const id = validarPoliticaId(politicaId);
  const activacion = validarActivacion(cuerpo?.activacion, ahora);
  const camposExtra = Object.keys(cuerpo ?? {}).filter(campo => campo !== 'activacion');
  if (camposExtra.length > 0) {
    throw errorValidacion(
      'La recuperación contiene campos no permitidos.',
      camposExtra.map(field => ({
        field,
        message: 'El campo no pertenece a la recuperación.'
      }))
    );
  }
  return withAdminTransaction(pool, async connection => {
    // Mismo orden de bloqueo que actualizarPoliticaComercial y el activador:
    // primero la programacion, despues la vigente y por ultimo la fuente,
    // evitando ciclos de bloqueo entre operaciones concurrentes.
    const pendiente = await obtenerPoliticaComercialProgramada(connection, {
      forUpdate: true
    });
    const vigente = await obtenerPoliticaComercialVigente(connection, {
      forUpdate: true
    });
    if (!vigente) throw errorNoEncontrado('No existe una política comercial vigente.');
    const fuente = await obtenerPoliticaComercialPorId(connection, id, {
      forUpdate: true
    });
    if (!fuente) throw errorNoEncontrado('La política comercial histórica indicada no existe.');
    if (fuente.estado !== 'HISTORICA') {
      throw errorEstado('La recuperación requiere una versión histórica.');
    }
    const porcentajesFuente = (await listarPorcentajesDePoliticas(connection, [fuente.id])).map(
      fila => Number(fila.porcentaje).toFixed(2)
    );
    const porcentajesVigentes = (await listarPorcentajesDePoliticas(connection, [vigente.id])).map(
      fila => Number(fila.porcentaje).toFixed(2)
    );
    if (contenidosIguales(vigente, porcentajesVigentes, fuente, porcentajesFuente)) {
      throw errorEstado('La versión histórica es idéntica a la política vigente.');
    }
    await sustituirProgramacion(
      connection,
      pendiente,
      actor.legajo,
      `Programación reemplazada por la recuperación de la versión ${fuente.id}.`
    );
    const fechaVigencia = fechaMysqlUtc(activacion.fecha);
    if (activacion.modo === 'INMEDIATA') {
      await cerrarPoliticaVigente(connection, vigente.id, fechaVigencia);
    }
    const estado = activacion.modo === 'INMEDIATA' ? 'VIGENTE' : 'PROGRAMADA';
    const nuevaId = await insertarPoliticaComercial(connection, fuente, {
      estado,
      fechaVigencia,
      actorLegajo: actor.legajo,
      versionBaseId: fuente.id
    });
    await insertarPorcentajesComerciales(connection, nuevaId, porcentajesFuente, {
      actorLegajo: actor.legajo,
      fechaVigencia
    });
    await auditar(
      connection,
      nuevaId,
      'RECUPERACION',
      actor.legajo,
      `Recuperación de la versión histórica ${fuente.id} como versión ${nuevaId} ${estado.toLowerCase()}.`
    );
    return obtenerSnapshotPorId(connection, nuevaId);
  }).catch(error => {
    throw mapearErrorIntegridad(error);
  });
}

import { withConnection } from '../auth/auth.repository.js';
import {
  errorConcurrencia,
  errorEstado,
  errorNoEncontrado,
  errorTransicion,
} from './admin.errors.js';
import {
  aplicarPorcentaje,
  centavosAImporte,
  compararImportes,
  esImporteValido,
  importeACentavos,
} from './admin.money.js';
import { obtenerEmpleado } from './employees.repository.js';
import {
  aumentarPrecios,
  actualizarEstadoVersion,
  actualizarPrecioTarifa,
  bloquearBorradorAbierto,
  bloquearTarifa,
  bloquearVersion,
  bloquearVersionActiva,
  copiarTarifas,
  contarTarifasDeVersion,
  incrementarRevision,
  insertarBorrador,
  insertarEvento,
  listarEventosDeVersion,
  listarPlanesActivos,
  listarTarifasActivas,
  listarTarifasDeVersion,
  listarVersiones,
  obtenerPlanPorId,
  obtenerVersionConResponsable,
  obtenerVersionPorId,
  resolverTarifaPorClave,
  resolverVersionVigente,
} from './tarifario.repository.js';
import {
  validarFechaVersion,
  validarIdVersion,
  validarModalidadOpcional,
  validarMotivoDescarte,
  validarParametrosTarifario,
  validarPorcentajeAumento,
  validarPrecioEdicion,
  validarRevision,
} from './tarifario.validators.js';

const CLAVES_EN_ORDEN = Object.freeze([
  '0-25', '26-35', '36-40', '41-50', '51-60', '61-65', '66+',
  'FAMILIAR A CARGO',
  'HIJO 0-1', 'HIJO 2-20', 'HIJO 21-29', 'HIJO 30-39', 'HIJO 40-49',
  'MAT 0-25', 'MAT 26-35', 'MAT 36-40', 'MAT 41-50', 'MAT 51-60',
  'MAT 61-65', 'MAT 66-00',
]);
const POSICION_CLAVE = new Map(CLAVES_EN_ORDEN.map((clave, indice) => [clave, indice]));

const DEPENDENCIAS_DEFECTO = Object.freeze({
  withConnection,
  obtenerEmpleado,
  listarPlanesActivos,
  obtenerPlanPorId,
  listarTarifasActivas,
  resolverVersionVigente,
  listarVersiones,
  obtenerVersionPorId,
  listarTarifasDeVersion,
  contarTarifasDeVersion,
  listarEventosDeVersion,
  bloquearVersionActiva,
  bloquearBorradorAbierto,
  insertarBorrador,
  copiarTarifas,
  bloquearVersion,
  bloquearTarifa,
  actualizarPrecioTarifa,
  aumentarPrecios,
  actualizarEstadoVersion,
  incrementarRevision,
  insertarEvento,
  obtenerVersionConResponsable,
  resolverTarifaPorClave,
});

/**
 * Convierte el reloj del proceso al formato DATETIME(6) UTC esperado por MySQL.
 * @param {Date} fecha Instante de referencia de la consulta.
 * @returns {string} Fecha `YYYY-MM-DD HH:mm:ss.ffffff` en UTC.
 * @throws {TypeError} Si el reloj no entrega una fecha valida.
 */
function fechaMysqlUtc(fecha) {
  if (!(fecha instanceof Date) || Number.isNaN(fecha.getTime())) {
    throw new TypeError('La consulta de vigencia requiere una fecha valida.');
  }
  return fecha.toISOString().replace('T', ' ').replace('Z', '000');
}

/**
 * Ordena las tarifas segun la matriz aprobada sin descartar claves futuras.
 * @param {object[]} tarifas Filas activas obtenidas del repositorio.
 * @returns {object[]} Copia ordenada; las claves desconocidas quedan al final.
 */
function ordenarTarifas(tarifas) {
  return [...tarifas].sort((a, b) => {
    const posicionA = POSICION_CLAVE.get(a.rango_clave) ?? Number.MAX_SAFE_INTEGER;
    const posicionB = POSICION_CLAVE.get(b.rango_clave) ?? Number.MAX_SAFE_INTEGER;
    return posicionA - posicionB || a.rango_clave.localeCompare(b.rango_clave, 'es');
  });
}

/**
 * Proyecta la cabecera vigente al contrato HTTP sin perder el BIGINT del id.
 * @param {object} version Fila devuelta por resolverVersionVigente.
 * @returns {object} Metadatos publicos con fecha ISO UTC.
 */
function presentarVersion(version) {
  return {
    id: String(version.id),
    tipo: version.tipo,
    estado: version.estado,
    fecha_activacion: new Date(version.fecha_activacion).toISOString(),
  };
}

/**
 * Proyecta una tarifa manteniendo precio decimal, etiqueta original y nota.
 * @param {object} tarifa Fila activa de la version vigente.
 * @returns {object} Tarifa publica del contrato SL-2.
 */
function presentarTarifa(tarifa) {
  return {
    rango_clave: tarifa.rango_clave,
    rango_etario: tarifa.rango_etario,
    rango_nota: tarifa.rango_nota ?? null,
    precio: String(tarifa.precio),
  };
}

/**
 * Consulta el catalogo de planes activos de RF-D06.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {object} dependencias Repositorio sustituible para pruebas unitarias.
 * @returns {Promise<object[]>} Catalogo publico, posiblemente vacio.
 */
export async function gestionarPlanes(pool, dependencias = DEPENDENCIAS_DEFECTO) {
  return dependencias.withConnection(
    pool,
    (connection) => dependencias.listarPlanesActivos(connection),
  );
}

/**
 * Consulta la matriz activa de la version vigente para un plan y modalidad.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{planId: unknown, tipoIngreso: unknown}} parametros Segmentos HTTP.
 * @param {Date} fechaReferencia Reloj UTC inyectado por el contexto AUTH.
 * @param {object} dependencias Repositorio y resolver sustituibles para pruebas.
 * @returns {Promise<object>} Plan, modalidad, version vigente y tarifas ordenadas.
 * @throws {Error} Validacion 400, plan 404, plan inactivo o falta de version 409.
 */
export async function gestionarTarifario(
  pool,
  parametros,
  fechaReferencia,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const filtro = validarParametrosTarifario(parametros);

  return dependencias.withConnection(pool, async (connection) => {
    const plan = await dependencias.obtenerPlanPorId(connection, filtro.planId);
    if (!plan) {
      throw errorNoEncontrado('El plan indicado no existe.');
    }
    if (Number(plan.activa) !== 1) {
      throw errorEstado('El plan indicado esta inactivo.');
    }

    const version = await dependencias.resolverVersionVigente(
      connection,
      fechaMysqlUtc(fechaReferencia),
    );
    if (!version) {
      throw errorEstado('No existe una version vigente del tarifario.');
    }

    const tarifas = await dependencias.listarTarifasActivas(connection, {
      versionId: version.id,
      ...filtro,
    });

    return {
      plan: { id: plan.id, nombre: plan.nombre },
      tipo_ingreso: filtro.tipoIngreso,
      version: presentarVersion(version),
      tarifas: ordenarTarifas(tarifas).map(presentarTarifa),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// SL-3 · Consultas de versiones (historial, detalle, lista completa y
// reconstrucción historica). Solo lectura; el id es identificador
// tecnico y el orden historico es cronologico por created_at.
// ─────────────────────────────────────────────────────────────────────

/**
 * Proyecta una cabecera de version al contrato SL-3 con responsable e
 * instancias BIGINT como texto decimal (sin conversion numerica).
 * @param {object} fila Fila de listarVersiones/obtenerVersionPorId.
 * @returns {object} Cabecera publica con las fechas en ISO UTC o null.
 */
function presentarVersionHistoria(fila) {
  return {
    id: String(fila.id),
    tipo: fila.tipo,
    estado: fila.estado,
    // Revision optimista visible para la pantalla: el AUTH de escritura
    // SL-4 la exige en el cuerpo y 409 de concurrencia pide releerla.
    revision: fila.revision == null ? null : Number(fila.revision),
    fecha_activacion: fila.fecha_activacion
      ? new Date(fila.fecha_activacion).toISOString()
      : null,
    version_base_id: fila.version_base_id == null
      ? null
      : String(fila.version_base_id),
    created_at: fila.created_at ? new Date(fila.created_at).toISOString() : null,
    actor_legajo: fila.actor_legajo ?? null,
    actor_nombre: fila.nombre ?? null,
    actor_apellido: fila.apellido ?? null,
  };
}

/**
 * Ordena el snapshot completo de una version: plan, modalidad y luego la
 * posición comercial de la clave de rango; las claves desconocidas van al
 * final para no descartar filas nuevas.
 * @param {object[]} tarifas Filas crudas del repositorio.
 * @returns {object[]} Copia ordenada de forma estable.
 */
function ordenarTarifasDeVersion(tarifas) {
  return [...tarifas].sort((a, b) =>
    (Number(a.plan_id) - Number(b.plan_id))
    || a.tipo_ingreso.localeCompare(b.tipo_ingreso, 'es')
    || ((POSICION_CLAVE.get(a.rango_clave) ?? Number.MAX_SAFE_INTEGER)
      - (POSICION_CLAVE.get(b.rango_clave) ?? Number.MAX_SAFE_INTEGER))
    || a.rango_clave.localeCompare(b.rango_clave, 'es'));
}

/**
 * Proyecta una tarifa del historial: precio decimal como texto, plan
 * identificado y bandera activa como booleano contractual.
 * @param {object} tarifa Fila del snapshot de la version.
 * @returns {object} Tarifa publica del contrato SL-3.
 */
function presentarTarifaVersion(tarifa) {
  return {
    // Identificador tecnico de la fila: la pantalla lo usa para abordar
    // el PATCH de precio individual dentro del borrador (SL-4).
    id: String(tarifa.id),
    plan_id: String(tarifa.plan_id),
    plan_nombre: tarifa.plan_nombre,
    tipo_ingreso: tarifa.tipo_ingreso,
    rango_clave: tarifa.rango_clave,
    rango_etario: tarifa.rango_etario,
    rango_nota: tarifa.rango_nota ?? null,
    precio: String(tarifa.precio),
    activa: Number(tarifa.activa) === 1,
  };
}

/**
 * Consulta el historial de versiones del tarifario (ascendente por creacion).
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {object} dependencias Repositorio sustituible para pruebas unitarias.
 * @returns {Promise<object>} `{ versiones }`; historial vacio es 200 valido.
 */
export async function listarVersionesTarifario(
  pool,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  return dependencias.withConnection(
    pool,
    async (connection) => ({
      versiones: (await dependencias.listarVersiones(connection))
        .map(presentarVersionHistoria),
    }),
  );
}

/**
 * Consulta el detalle de una version: cabecera, estado y trazabilidad.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmentos HTTP con el id pedido.
 * @param {object} dependencias Repositorio sustituible para pruebas unitarias.
 * @returns {Promise<object>} `{ version }` con responsable y fechas.
 * @throws {Error} 400 si el id no es un entero valido; 404 si no existe.
 */
export async function obtenerDetalleVersion(
  pool,
  parametros,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);

  return dependencias.withConnection(pool, async (connection) => {
    const fila = await dependencias.obtenerVersionPorId(connection, id);
    if (!fila) {
      throw errorNoEncontrado('La version indicada no existe.');
    }
    return { version: presentarVersionHistoria(fila) };
  });
}

/**
 * Consulta la lista completa de tarifas de una version, incluyendo las
 * filas inactivas (decision O-1: el historial muestra el snapshot entero).
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmentos HTTP con el id pedido.
 * @param {object} dependencias Repositorio sustituible para pruebas unitarias.
 * @returns {Promise<object>} `{ version, tarifas }` con el orden comercial.
 * @throws {Error} 400 id invalido; 404 version inexistente.
 */
export async function listarTarifasDeLaVersion(
  pool,
  parametros,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);

  return dependencias.withConnection(pool, async (connection) => {
    const fila = await dependencias.obtenerVersionPorId(connection, id);
    if (!fila) {
      throw errorNoEncontrado('La version indicada no existe.');
    }

    const tarifas = await dependencias.listarTarifasDeVersion(connection, id);
    return {
      version: {
        id: String(fila.id),
        tipo: fila.tipo,
        estado: fila.estado,
      },
      tarifas: ordenarTarifasDeVersion(tarifas).map(presentarTarifaVersion),
    };
  });
}

/**
 * Identifica la version que rigio el tarifario en la fecha pedida y
 * devuelve el tarifario efectivo de esa referencia. La consulta nunca
 * activa ni modifica estados; una fecha posterior a la ultima activacion
 * responde la version vigente actual, y una fecha anterior a toda
 * activacion es 409.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{fecha: unknown}} consulta Parametro de query HTTP.
 * @param {object} dependencias Repositorio y resolver sustituibles para pruebas.
 * @returns {Promise<object>} Fecha normalizada, version resuelta y tarifas efectivas.
 * @throws {Error} 400 fecha ausente/invalida; 409 sin version vigente a esa fecha.
 */
export async function reconstruirTarifarioHistorico(
  pool,
  consulta,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const fecha = validarFechaVersion(consulta.fecha);

  return dependencias.withConnection(pool, async (connection) => {
    const version = await dependencias.resolverVersionVigente(
      connection,
      fechaMysqlUtc(fecha),
    );
    if (!version) {
      throw errorEstado(
        'No existia una version del tarifario activa en la fecha pedida.',
      );
    }

    const tarifas = await dependencias.listarTarifasDeVersion(
      connection,
      version.id,
      { soloActivas: true },
    );

    return {
      fecha: fecha.toISOString(),
      version: presentarVersion(version),
      tarifas: ordenarTarifasDeVersion(tarifas).map(presentarTarifaVersion),
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// SL-4 · Escritura en borradores (modelo "copia completa"). La única
// ruta con conceso relajada es la activación (SL-5): toda edición
// revisa `revision` de forma optimista y excribe dentro de una
// transaccion; la exclusividad de borrador vive en los guardas UNIQUE
// de la migracion 015, no en banderas de la aplicacion.
// ─────────────────────────────────────────────────────────────────────

/** Estados del ciclo de vida que admiten ediciones de precio. */
const ESTADOS_EDITABLES = Object.freeze(['PREPARACION']);

/**
 * Formatea la fecha de iniciacion de un borrador para el mensaje de
 * exclusividad, siempre en horario de Buenos Aires (pantalla del 409).
 * @param {Date} created_at Fecha persistida de la cabecera del borrador.
 * @returns {string} "dd/mm/yyyy HH:mm" en zona America/Argentina/Buenos_Aires.
 */
function formatearFechaBuenosAires(created_at) {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(created_at)).replace(', ', ' ');
}

/**
 * Construye el error 409 de exclusividad con el texto de negocio y la
 * informacion del responsable del borrador ya abierto (nombre, apellido,
 * legajo y fecha de iniciacion) para la pantalla del ADMIN.
 * @param {object} borrador Fila del borrador abierto con su responsable.
 * @returns {Error} ADMIN_ESTADO 409 con detalles estructurales.
 */
function errorBorradorExistente(borrador) {
  return errorEstado(
    'Ya existe una version de precios en preparacion, iniciada por '
    + `${borrador.nombre ?? ''} ${borrador.apellido ?? ''}, `
    + `legajo ${borrador.actor_legajo ?? 'desconocido'}, con fecha y hora `
    + `${formatearFechaBuenosAires(borrador.created_at)}.`,
    [{
      field: 'version',
      message: 'La version existente debe ser activada o descartada '
        + 'antes de iniciar otra.',
    }],
  );
}

/**
 * Lee la identidad del actor de la tabla empleados y la transforma en el
 * snapshot del evento: el nombre y apellido viajan a la tabla de
 * auditoria tal como estaban al momento de la operacion, incluso si
 * luego cambian o el empleado sale del directorio.
 * @param {object} connection Conexion transaccional de la unidad de trabajo.
 * @param {string} actorLegajo Legajo del ADMIN responsable.
 * @returns {Promise<{legajo: string, nombre: string, apellido: string}>}
 *   Snapshot de identidad; nombre y apellido vacios si el legajo ya no existe.
 */
async function snapshotActor(dependencias, connection, actorLegajo) {
  const empleado = await dependencias.obtenerEmpleado(connection, actorLegajo);
  return {
    legajo: actorLegajo,
    nombre: empleado?.nombre ?? '',
    apellido: empleado?.apellido ?? '',
  };
}

/**
 * Crea un borrador tipo EDICION_LISTA copiando integramente el snapshot
 * de la version ACTIVA (caso A del cierre funcional). Se declara la
 * exclusividad a la ley direccion: si el borrador ya existe (o gana la
 * carrera otro ADMIN), responde 409 con nombre, apellido, legajo y
 * fecha de iniciacion del que empezo primero.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: string, legajo: string}} actor Identidad del creador.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version }` del borrador creado (PREPARACION).
 * @throws {Error} 409 sin version activa, borrador existente o carrera 1062.
 */
export async function crearBorradorTarifario(
  pool,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  return dependencias.withConnection(
    pool,
    async (connection) => {
      const versionActiva = await dependencias.bloquearVersionActiva(connection);
      if (!versionActiva) {
        throw errorEstado('No hay una version activa del tarifario de la cual copiar.');
      }
      const borrador = await dependencias.bloquearBorradorAbierto(connection);
      if (borrador) {
        throw errorBorradorExistente(borrador);
      }
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const observacion = 'Copia de la version vigente '
        + `${versionActiva.id} al crear el borrador.`;
      let versionId;
      try {
        versionId = await dependencias.insertarBorrador(connection, {
          versionBaseId: Number(versionActiva.id),
          actorLegajo: actor.legajo,
          observacion,
        });
      } catch (error) {
        // Carrera concurrente contra uq_guard_borrador_version: recupera
        // la data del ganador y marca el lanzamiento para el 409 del
        // contrato, en lugar de fallar con un error de MySQL confuso.
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
          const ganador = await dependencias.bloquearBorradorAbierto(connection);
          if (ganador) {
            throw errorBorradorExistente(ganador);
          }
          throw errorEstado(
            'Otro administrador creo una version de precios al mismo tiempo. '
            + 'Recarga el historial antes de continuar.',
          );
        }
        throw error;
      }
      const filasCopiadas = await dependencias.copiarTarifas(connection, {
        origenId: versionActiva.id,
        destinoId: versionId,
      });
      const eventoId = await dependencias.insertarEvento(connection, {
        versionId,
        tipoEvento: 'CREACION',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Copia de la version vigente ${versionActiva.id} `
          + `con ${filasCopiadas} filas de tarifas.`,
      });

      return {
        version: {
          id: String(versionId),
          tipo: 'EDICION_LISTA',
          estado: 'PREPARACION',
          version_base_id: String(versionActiva.id),
          actor_legajo: actor.legajo,
          evento: { id: String(eventoId), tipo: 'CREACION' },
        },
      };
  }, { transaction: true });
}

/**
 * Valida el estado de la cabecera bloqueada para operaciones de edicion
 * (B/C): solo PREPARACION acepta cambios; LISTA_PARA_ACTIVAR ya quedo
 * cerrada y el resto de los estados es historial o vigente.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @param {object} connection Conexion transaccional de la operacion.
 * @param {number|string} id Id enviado por el cliente para contexto de error.
 * @param {number} revision Revision optimista recibida del cliente.
 * @param {{incrementar?: boolean}} opciones Permite validar sin incrementar
 *   cuando la operacion necesita comprobar primero si existe un cambio real.
 * @returns {Promise<object>} Cabecera bloqueada y validada.
 * @throws {Error} 404 si la version no existe; 409 ADMIN_TRANSICION si el
 *   estado no permite edicion; 409 ADMIN_CONCURRENCIA si la revision no
 *   coincide.
 */
async function validarEdicionDeVersion(
  dependencias,
  connection,
  id,
  revision,
  { incrementar = true } = {},
) {
  const version = await dependencias.bloquearVersion(connection, id);
  if (!version) {
    throw errorNoEncontrado('La version indicada no existe.');
  }
  if (!ESTADOS_EDITABLES.includes(version.estado)) {
    throw errorTransicion(
      version.estado === 'LISTA_PARA_ACTIVAR'
        ? 'La version ya esta lista para activar y ya no acepta ediciones.'
        : `La version en estado ${version.estado} no acepta ediciones.`,
    );
  }
  if (Number(version.revision) !== revision) {
    throw errorConcurrencia();
  }
  if (incrementar
    && (await dependencias.incrementarRevision(connection, { id, revision })) === 0) {
    throw errorConcurrencia();
  }
  return version;
}

/**
 * Calculo economico puro del aumento masivo: es la UNICA implementacion de
 * importes, usada por la previsualizacion y por la aplicacion definitiva.
 * El incremento de cada fila es el resultado HALF-UP de aplicarPorcentaje
 * (money.js) y el precio nuevo es precio + incremento exacto en centavos.
 * No lee ni escribe datos: recibe las filas ya consultadas.
 * @param {object[]} filas Filas de tarifas (id, tipo_ingreso, rango_clave, precio).
 * @param {string} porcentaje Porcentaje ya validado por validarPorcentajeAumento.
 * @returns {{id: number, antes: string, nuevo: string, aumento: string}[]} Importes por fila.
 * @throws {Error} 409 cuando alguna fila excederia el tope DECIMAL de la columna.
 */
export function calcularImportesAumento(filas, porcentaje) {
  // Calculo previo de todos los importes con aritmetica exacta: si una
  // fila excede DECIMAL(10,2), se aborta antes de escribir cualquier cosa.
  return filas.map((fila) => {
    const aumento = aplicarPorcentaje(fila.precio, porcentaje);
    const precioNuevo = centavosAImporte(
      importeACentavos(fila.precio) + importeACentavos(aumento),
    );
    if (!esImporteValido(precioNuevo, { maximo: '99999999.99', decimales: 2 })) {
      throw errorEstado(
        'El aumento excede el tope del esquema en alguna fila.',
        [{
          field: 'porcentaje',
          message: `La fila ${Number(fila.id)} `
            + `(${fila.tipo_ingreso}, rango ${fila.rango_clave}) pasaria de `
            + `${fila.precio} a ${precioNuevo}, fuera del tope de la columna.`,
        }],
      );
    }
    return { id: Number(fila.id), antes: String(fila.precio), nuevo: precioNuevo, aumento };
  });
}

/**
 * Aplica un aumento masivo (modulo conservado A) de porcentaje sobre las
 * filas de una modalidad (o de ambas). Los precios se calculan en centavos
 * con HALF-UP por aplicarPorcentaje; el evento AUMENTO_MASIVO queda como
 * cabezal y por cada fila se registra PRECIO con su valor anterior y nuevo.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{porcentaje: unknown, tipoIngreso: unknown, revision: unknown}} cuerpo
 *   Cuerpo de la peticion (porcentaje 0<p<100).
 * @param {{legajo: string}} actor Responsable del aumento.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} Resumen del evento: revision nueva, filas y porcentaje.
 * @throws {Error} 400, 404, 409 por estado/revision o por tope de columna.
 */
export async function aumentarVersionTarifario(
  pool,
  parametros,
  cuerpo,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const porcentaje = validarPorcentajeAumento(cuerpo.porcentaje);
  const tipoIngreso = validarModalidadOpcional(cuerpo.tipoIngreso);
  const revision = validarRevision(cuerpo.revision);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      await validarEdicionDeVersion(dependencias, connection, id, revision);
      // Lee el snapshot de la version por el repositorio (mismo acceso que la
      // previsualizacion de solo lectura) y filtra la modalidad pedida en JS;
      // el calculo de importes no depende del orden de las filas.
      const tarifas = await dependencias.listarTarifasDeVersion(connection, id);
      const filas = tipoIngreso
        ? tarifas.filter((tarifa) => tarifa.tipo_ingreso === tipoIngreso)
        : tarifas;
      if (filas.length === 0) {
        throw errorEstado(
          tipoIngreso
            ? `La version no tiene filas de la modalidad ${tipoIngreso}.`
            : 'La version no tiene filas de tarifas para aumentar.',
        );
      }
      // Cada fila guarda su valor anterior ANTES de cualquier escritura
      // para que la auditoria registre el precio que tenia; los importes
      // provienen de la unica funcion economica del aumento.
      const importes = calcularImportesAumento(filas, porcentaje);
      const cambios = importes.filter(
        (calculo) => compararImportes(calculo.antes, calculo.nuevo) !== 0,
      );
      if (cambios.length === 0) {
        throw errorEstado(
          'El porcentaje indicado no modifica ningun precio despues del redondeo monetario.',
          [{
            field: 'porcentaje',
            message: 'Indica un porcentaje que produzca al menos un cambio de un centavo.',
          }],
        );
      }

      const filasAfectadas = await dependencias.aumentarPrecios(
        connection,
        {
          versionId: id,
          importes: cambios.map((calculo) => [calculo.id, calculo.nuevo]),
          tipoIngreso,
        },
      );
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const alcance = tipoIngreso ?? 'Obligatorio y Voluntario';
      const agrupadorId = await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'MODIFICACION',
        tipoOperacion: 'AUMENTO_MASIVO',
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Aumento del ${porcentaje}% aplicado a ${filasAfectadas} `
          + `filas (modalidad: ${alcance}).`,
      });
      // Los hijos PRECIO usan los valores ya capturados antes de escribir
      // e identifican la fila con plan/modalidad/rango (CHECK de 014).
      for (const calculo of cambios) {
        const filaReferencia = filas.find((fila) => Number(fila.id) === calculo.id);
        await dependencias.insertarEvento(connection, {
          versionId: id,
          tipoEvento: 'MODIFICACION',
          tipoOperacion: 'PRECIO',
          agrupadorId,
          planId: Number(filaReferencia.plan_id),
          tipoIngreso: filaReferencia.tipo_ingreso,
          rangoClave: filaReferencia.rango_clave,
          valorAnterior: calculo.antes,
          valorNuevo: calculo.nuevo,
          actorLegajo: actorInfo.legajo,
          actorNombre: actorInfo.nombre,
          actorApellido: actorInfo.apellido,
          detalle: `Aumento del ${porcentaje}% aplicado a la fila ${calculo.id}: `
            + `${calculo.antes} -> ${calculo.nuevo}.`,
        });
      }

      return {
        evento: { id: String(agrupadorId), tipo: 'AUMENTO_MASIVO' },
        porcentaje,
        filas: filasAfectadas,
        revision: revision + 1,
      };
  }, { transaction: true });
}

/**
 * Previsualiza el aumento masivo de una version SIN escribir datos: usa la
 * misma funcion economica (calcularImportesAumento) que la aplicacion
 * definitiva y devuelve los importes por fila en el orden comercial del
 * snapshot. Solo consulta: no crea versiones, no modifica precios ni
 * vigencias y no registra eventos de auditoria.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{porcentaje: unknown, tipoIngreso: unknown}} consulta Query HTTP.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version, porcentaje, tipo_ingreso, filas }`;
 *   cada fila trae precio_anterior, precio_nuevo e incremento como DECIMAL.
 * @throws {Error} 400 parametros invalidos; 404 version inexistente;
 *   409 sin filas de la modalidad o tope de columna excedido.
 */
export async function previsualizarAumentoVersion(
  pool,
  parametros,
  consulta,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const porcentaje = validarPorcentajeAumento(consulta.porcentaje);
  const tipoIngreso = validarModalidadOpcional(consulta.tipoIngreso);

  return dependencias.withConnection(pool, async (connection) => {
    const fila = await dependencias.obtenerVersionPorId(connection, id);
    if (!fila) {
      throw errorNoEncontrado('La version indicada no existe.');
    }

    // Reutiliza la lectura del snapshot del repositorio, sin SQL propio:
    // las filas y su orden comercial coinciden con el detalle de pantalla.
    const tarifas = await dependencias.listarTarifasDeVersion(connection, id);
    const filas = ordenarTarifasDeVersion(tarifas)
      .filter((tarifa) => !tipoIngreso || tarifa.tipo_ingreso === tipoIngreso);
    if (filas.length === 0) {
      throw errorEstado(
        tipoIngreso
          ? `La version no tiene filas de la modalidad ${tipoIngreso}.`
          : 'La version no tiene filas de tarifas para aumentar.',
      );
    }

    const importes = calcularImportesAumento(filas, porcentaje);
    return {
      version: { id: String(fila.id), estado: fila.estado },
      porcentaje,
      tipo_ingreso: tipoIngreso,
      filas: importes.map((calculo) => {
        const filaReferencia = filas.find(
          (tarifa) => Number(tarifa.id) === calculo.id,
        );
        return {
          id: String(calculo.id),
          plan_id: String(filaReferencia.plan_id),
          plan_nombre: filaReferencia.plan_nombre,
          tipo_ingreso: filaReferencia.tipo_ingreso,
          rango_clave: filaReferencia.rango_clave,
          rango_nota: filaReferencia.rango_nota ?? null,
          precio_anterior: calculo.antes,
          precio_nuevo: calculo.nuevo,
          incremento: calculo.aumento,
        };
      }),
    };
  });
}

/**
 * Cambia el precio de una tarifa individual del borrador (caso B). El
 * rollback no es necesario: la revision optimista garantiza que solo el
 * primero de dos escritores simultaneos gana; el segundo recibe 409.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown, tarifaId: unknown}} parametros Segmentos HTTP.
 * @param {{precio: unknown, revision: unknown}} cuerpo Cuerpo de la peticion.
 * @param {{legajo: string}} actor Responsable de la edicion.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} Tarifa modificada y revision nueva del borrador.
 * @throws {Error} 400, 404 (version o tarifa), 409 estado o revision.
 */
export async function editarTarifaVersion(
  pool,
  parametros,
  cuerpo,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const tarifaId = validarIdVersion(parametros.tarifaId);
  const precio = validarPrecioEdicion(cuerpo.precio);
  const revision = validarRevision(cuerpo.revision);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      await validarEdicionDeVersion(
        dependencias,
        connection,
        id,
        revision,
        { incrementar: false },
      );
      const tarifa = await dependencias.bloquearTarifa(connection, { versionId: id, tarifaId });
      if (!tarifa) {
        throw errorNoEncontrado('La tarifa indicada no existe dentro de la version.');
      }
      // Valor anterior capturado antes de la escritura (auditoria fiel).
      const precioAnterior = String(tarifa.precio);
      if (compararImportes(precioAnterior, precio) === 0) {
        throw errorEstado(
          'El precio nuevo es igual al precio vigente de la tarifa.',
          [{
            field: 'precio',
            message: 'Indica un importe diferente para registrar el cambio.',
          }],
        );
      }
      if ((await dependencias.incrementarRevision(connection, { id, revision })) === 0) {
        throw errorConcurrencia();
      }
      await dependencias.actualizarPrecioTarifa(connection, { tarifaId, precio });
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'MODIFICACION',
        tipoOperacion: 'PRECIO',
        agrupadorId: null,
        planId: Number(tarifa.plan_id),
        tipoIngreso: tarifa.tipo_ingreso,
        rangoClave: tarifa.rango_clave,
        valorAnterior: precioAnterior,
        valorNuevo: precio,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Cambio de precio manual de ${filaDescripcion(tarifa)}: `
          + `${precioAnterior} -> ${precio}.`,
      });

      return {
        tarifa: {
          id: String(tarifa.id),
          plan_id: String(tarifa.plan_id),
          tipo_ingreso: tarifa.tipo_ingreso,
          rango_clave: tarifa.rango_clave,
          precio: String(precio),
        },
        revision: revision + 1,
      };
  }, { transaction: true });
}

/**
 * Descripcion operativa de una fila de tarifa para los textos de auditoria.
 * @param {object} tarifa Fila de la base.
 * @returns {string} Etiqueta legible "plan/modalidad/rango".
 */
function filaDescripcion(tarifa) {
  return `${tarifa.plan_id}/${tarifa.tipo_ingreso}/${tarifa.rango_clave}`;
}

/**
 * Finaliza la edicion de precios: PREPARACION -> LISTA_PARA_ACTIVAR
 * (caso C). No activa nada por si sola; el ADMIN debe ejecutar la
 * activacion manual en un evento posterior (SL-5).
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{revision: unknown}} cuerpo Revision vigente del borrador.
 * @param {{legajo: string}} actor Responsable de la finalizacion.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} Cabecera finalizada con revision actual.
 * @throws {Error} 400, 404, 409 por transicion o revision en desfase.
 */
export async function finalizarVersionTarifario(
  pool,
  parametros,
  cuerpo,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const revision = validarRevision(cuerpo.revision);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      const version = await validarEdicionDeVersion(dependencias, connection, id, revision);
      await dependencias.actualizarEstadoVersion(connection, {
        id,
        estado: 'LISTA_PARA_ACTIVAR',
      });
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'FINALIZACION',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Finalizacion de la edicion de precios de la version ${id}: `
          + 'quedo lista para activacion manual.',
      });

      return {
        version: {
          id: String(id),
          tipo: version.tipo,
          estado: 'LISTA_PARA_ACTIVAR',
          revision: revision + 1,
        },
      };
  }, { transaction: true });
}

// ─────────────────────────────────────────────────────────────────────
// SL-5 · Activacion manual transaccional (caso D). Es el unico evento
// que sedes sostiene la garantia "una sola ACTIVA": bloquea la fila del
// borrador, valida integridad del snapshot, convierte la ACTIVA en
// HISTORICA y estampa fecha_activacion NOW(6) en la nueva; cualquier
// fallo hace rollback dejando la vigencia anterior intacta.
// ─────────────────────────────────────────────────────────────────────

/**
 * Activa manualmente un borrador finalizado (LISTA_PARA_ACTIVAR,
 * caso D). En una única transaccion: bloquea la cabecera, valida que el
 * snapshot tenga filas (los UNIQUE, CHECK de precio y FK de planes
 * garantizan integridad a nivel esquema; los planes desactivados no
 * generan falso error), convierte la ACTIVA en HISTORICA y marca la
 * nueva como ACTIVA con fecha_activacion NOW(6). Un fallo hace rollback
 * y deja la vigencia anterior en pie.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version a activar.
 * @param {{legajo: string}} actor Responsable de la activacion.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version, versionReemplazada, evento }`.
 * @throws {Error} 400 id invalido, 404 version inexistente, 409 por estado,
 *   snapshot vacio o falta de version activa a reemplazar.
 */
export async function activarVersionTarifario(
  pool,
  parametros,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      // Orden de bloqueo consistente con crearBorradorTarifario: primero la
      // fila de la version ACTIVA y despues el borrador finalizado. Si la
      // activacion tomara las filas en el orden inverso, una creacion de
      // borrador y una activacion concurrentes podrian generar un ciclo de
      // bloqueo (deadlock) que llegaria como error 500 generico.
      const versionActiva = await dependencias.bloquearVersionActiva(connection);
      const version = await dependencias.bloquearVersion(connection, id);
      if (!version) {
        throw errorNoEncontrado('La version indicada no existe.');
      }
      if (version.estado !== 'LISTA_PARA_ACTIVAR') {
        throw errorEstado(
          'Solo una version lista para activar (LISTA_PARA_ACTIVAR) '
          + 'puede ser activada manualmente.',
        );
      }
      // Integridad de activacion: no se activa un borrador sin filas; el
      // resto de las garantias (uniques, CHECK de precio positivo, FK a
      // planes y a la matriz de claves) las impone el propio esquema en
      // el UPDATE, y un plan inactivo no impide la activacion (decisión
      // del cierre funcional: sin falsos errores de cobertura).
      if (await dependencias.contarTarifasDeVersion(connection, id) === 0) {
        throw errorEstado(
          'La version indicada no tiene filas de tarifas para activar.',
        );
      }
      if (!versionActiva) {
        throw errorEstado(
          'No hay una version activa vigente que reemplazar por la edicion.',
        );
      }
      await dependencias.actualizarEstadoVersion(connection, {
        id: Number(versionActiva.id),
        estado: 'HISTORICA',
      });
      await dependencias.actualizarEstadoVersion(connection, {
        id,
        estado: 'ACTIVA',
        activar: true,
      });
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const eventoId = await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'ACTIVACION',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Activacion manual de la version ${id}, que reemplaza `
          + `a la version ${Number(versionActiva.id)}.`,
      });
      const activada = await dependencias.obtenerVersionConResponsable(connection, id);

      return {
        version: presentarVersionHistoria(activada),
        versionReemplazada: String(versionActiva.id),
        evento: { id: String(eventoId), tipo: 'ACTIVACION' },
      };
  }, { transaction: true });
}

// ─────────────────────────────────────────────────────────────────────
// Reapertura de edicion (correccion integral Versiones): una version
// finalizada por error vuelve a preparacion sin perder precios ni
// auditoria, con la exclusividad y la concurrencia del ciclo intactas.
// El evento queda auditado con el tipo REANUDACION (migracion 016):
// nunca reactiva ACTIVA/HISTORICA ni crea versiones nuevas.
// ─────────────────────────────────────────────────────────────────────

/**
 * Reabre la edicion: LISTA_PARA_ACTIVAR -> PREPARACION ("Volver a
 * edicion"). Conserva todos los precios, la revision y la auditoria
 * existente; registra un evento REANUDACION del ciclo de vida en la
 * misma transaccion. Las versiones ACTIVA o HISTORICA siguen protegidas
 * y responden 409; el borrador nunca deja de ser unico (las columnas
 * generadas de la 015 lo garantizan a nivel esquema).
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{legajo: string}} actor Responsable de la reapertura.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version, evento }` con la version en preparacion.
 * @throws {Error} 400 id invalido, 404 version inexistente, 409
 *   ADMIN_TRANSICION para estados distintos de LISTA_PARA_ACTIVAR.
 */
export async function reanudarEdicionVersion(
  pool,
  parametros,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      const version = await dependencias.bloquearVersion(connection, id);
      if (!version) {
        throw errorNoEncontrado('La version indicada no existe.');
      }
      if (version.estado !== 'LISTA_PARA_ACTIVAR') {
        throw errorTransicion(
          'Solo una version lista para activar (LISTA_PARA_ACTIVAR) '
          + 'puede volver a edicion; las versiones ACTIVA o HISTORICA '
          + 'no se modifican directamente.',
        );
      }
      await dependencias.actualizarEstadoVersion(connection, {
        id,
        estado: 'PREPARACION',
      });
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const eventoId = await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'REANUDACION',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `La version ${id} volvio a preparacion (reapertura `
          + 'de la edicion de precios) sin perder precios ni auditoria.',
      });

      return {
        version: {
          id: String(id),
          tipo: version.tipo,
          estado: 'PREPARACION',
          revision: version.revision,
        },
        evento: { id: String(eventoId), tipo: 'REANUDACION' },
      };
  }, { transaction: true });
}

// ─────────────────────────────────────────────────────────────────────
// Descarte de versiones no activadas (ronda de correcciones del ciclo
// de vida): el ADMIN retira del ciclo una version que nunca fue
// activada conservando fisicamente sus precios, su numeracion y su
// auditoria. Internamente el estado es 'CANCELADA' (valor heredado del
// modelo 013 sin productor propio; en pantalla se muestra 'Descartada',
// no hay estados redundantes en el negocio); liberar la exclusividad de
// borradores lo resuelven solo las guardas generadas de la 015. El
// descarte queda auditado con el tipo DESCARTE, el responsable y el
// motivo; muy importante: la version activa vigente no se toca.
// ─────────────────────────────────────────────────────────────────────

/**
 * Descarta una version que nunca fue activada (PREPARACION o
 * LISTA_PARA_ACTIVAR): cambia el estado a 'CANCELADA', registra un
 * evento DESCARTE con el responsable y el motivo y conserva intachables
 * las filas de tarifas y la numeracion (no hay borrados ni renumerados
 * en ninguna parte del flujo). La revision optimista del cuerpo evita
 * descartar por encima de una edicion o activacion concurrente.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{revision: unknown, motivo: unknown}} cuerpo Revision vigente
 *   y motivo de negocio (1..200 caracteres) del descarte.
 * @param {{legajo: string}} actor Responsable del descarte.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version, evento }` con la version en
 *   'CANCELADA' y el tipo de evento 'DESCARTE'.
 * @throws {Error} 400 por motivo o revision invalidos, 404 version
 *   inexistente, 409 ADMIN_TRANSICION para ACTIVA/HISTORICA y
 *   versiones ya descartadas, 409 ADMIN_CONCURRENCIA por revision
 *   desfasada frente a como concurrente.
 */
export async function descartarVersionTarifario(
  pool,
  parametros,
  cuerpo,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const revision = validarRevision(cuerpo.revision);
  const motivo = validarMotivoDescarte(cuerpo.motivo);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      const version = await dependencias.bloquearVersion(connection, id);
      if (!version) {
        throw errorNoEncontrado('La version indicada no existe.');
      }
      if (version.estado !== 'PREPARACION'
        && version.estado !== 'LISTA_PARA_ACTIVAR') {
        throw errorTransicion(
          'Solo una version en preparacion o lista para activar puede '
          + 'descartarse; las versiones ACTIVA o HISTORICA no se '
          + 'modifican y la vigencia queda intacta.',
        );
      }
      // La revision optimista protege el descarte de carreras con una
      // edicion de precios o una activacion en curso sobre la misma fila.
      if (Number(version.revision) !== revision) {
        throw errorConcurrencia();
      }
      await dependencias.actualizarEstadoVersion(connection, {
        id,
        estado: 'CANCELADA',
      });
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const eventoId = await dependencias.insertarEvento(connection, {
        versionId: id,
        tipoEvento: 'DESCARTE',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Descarte de la version ${id}. Motivo: ${motivo}`,
      });

      return {
        version: {
          id: String(id),
          tipo: version.tipo,
          estado: 'CANCELADA',
          revision,
        },
        evento: { id: String(eventoId), tipo: 'DESCARTE' },
      };
  }, { transaction: true });
}

// ─────────────────────────────────────────────────────────────────────
// Trazabilidad y control de borradores (mejoras de usabilidad de la
// SPEC-03): lectura del resumen de auditoria real y deshacer del ultimo
// cambio economico de un borrador en PREPARACION. Todo se apoya en los
// eventos guardados; nunca se recalcula desde diferencias de snapshots.
// ─────────────────────────────────────────────────────────────────────

/**
 * Proyecta una fila real de auditoria al contrato publico del resumen.
 * Los montos DECIMAL viajan como string con dos decimales y los
 * identificadores BIGINT como string decimal. Solo los eventos
 * agrupadores de aumento masivo reportan la cantidad de filas hijas.
 * @param {object} evento Fila de tarifario_versiones_eventos.
 * @param {Map<string, number>} hijosPorAgrupador Conteo real de hijos por agrupador.
 * @returns {object} Evento publico del resumen.
 */
function presentarEventoAuditoria(evento, hijosPorAgrupador) {
  return {
    id: String(evento.id),
    tipo_evento: evento.tipo_evento,
    tipo_operacion: evento.tipo_operacion ?? null,
    agrupador: evento.agrupador_id == null ? null : String(evento.agrupador_id),
    filas_agrupadas: evento.tipo_operacion === 'AUMENTO_MASIVO'
      ? Number(hijosPorAgrupador.get(String(evento.id)) ?? 0)
      : undefined,
    entidad: evento.plan_id == null ? null : {
      plan_id: String(evento.plan_id),
      tipo_ingreso: evento.tipo_ingreso,
      rango_clave: evento.rango_clave,
    },
    valor_anterior: evento.valor_anterior == null ? null : String(evento.valor_anterior),
    valor_nuevo: evento.valor_nuevo == null ? null : String(evento.valor_nuevo),
    detalle: evento.detalle ?? null,
    actor_legajo: evento.actor_legajo ?? null,
    actor_nombre: evento.actor_nombre ?? null,
    actor_apellido: evento.actor_apellido ?? null,
    evento_en: evento.evento_en ? new Date(evento.evento_en).toISOString() : null,
  };
}

/**
 * Lee el resumen de cambios de una version construido SOBRE LOS EVENTOS
 * REALES de auditoria (migracion 014): cada operacion registrada aparece
 * con su responsable, fecha, entidad y valores anteriores y nuevos; un
 * aumento masivo suma la cantidad real de sus filas hijas. No se
 * reconstruye nada desde diferencias de snapshots.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version pedida.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version, eventos }`, mas recientes primero.
 * @throws {Error} 400 id invalido, 404 version inexistente.
 */
export async function resumirEventosDeVersion(
  pool,
  parametros,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);

  return dependencias.withConnection(pool, async (connection) => {
    const fila = await dependencias.obtenerVersionPorId(connection, id);
    if (!fila) {
      throw errorNoEncontrado('La version indicada no existe.');
    }
    const eventos = await dependencias.listarEventosDeVersion(connection, id);
    // Conteo real de hijos por agrupador: cada parent recibe la cantidad
    // de eventos PRECIO que se le asignaron al momento del aumento.
    const hijosPorAgrupador = new Map();
    for (const evento of eventos) {
      if (evento.agrupador_id == null) continue;
      const clave = String(evento.agrupador_id);
      hijosPorAgrupador.set(clave, (hijosPorAgrupador.get(clave) ?? 0) + 1);
    }
    return {
      version: presentarVersionHistoria(fila),
      eventos: eventos
        .map((evento) => presentarEventoAuditoria(evento, hijosPorAgrupador))
        .reverse(),
    };
  });
}

/**
 * Detecta eventos generados por el deshacer: su detalle por convencion
 * arranca con el prefijo "DESHACE:".
 * @param {object} evento Evento real de la auditoria.
 * @returns {boolean} true si el evento proviene de un deshacer previo.
 */
function esEventoDeDeshacer(evento) {
  return typeof evento.detalle === 'string'
    && evento.detalle.startsWith('DESHACE');
}

/**
 * Obtiene el tipo de operacion del evento tolerando camelCase (los
 * eventos grabados en memoria por los entornos de prueba usan las claves
 * del argumento del repositorio, no las de la fila real).
 * @param {object} evento Evento de auditoria en cualquiera de las dos formas.
 * @returns {string|null} Tipo de operacion o null si es un evento generico.
 */
function operacionDe(evento) {
  return evento.tipo_operacion ?? evento.tipoOperacion ?? null;
}

/**
 * Igual que `operacionDe` pero para el agrupador del evento.
 * @param {object} evento Evento de auditoria en cualquiera de las dos formas.
 * @returns {number|string|null} Id del agrupador o null si es suelto.
 */
function agrupadorDe(evento) {
  return evento.agrupador_id ?? evento.agrupadorId ?? null;
}

/**
 * Identifica el ultimo cambio economico AUN VIGENTE para una version a
 * partir de los eventos: la operacion de precio mas reciente que no haya
 * sido ya revertida por un deshacer. Ignora los eventos DESHACE (sus
 * reversiones no se des-deshacen: propondria precios ya invalidados) y
 * los cambios manuales cuyas filas fueron restauradas por un deshacer
 * posterior. Mantiene una pila de operaciones para distinguir cambios
 * consecutivos sobre una misma tarifa; si el candidato es agrupado, el
 * objetivo es el aumento masivo completo.
 * @param {object[]} eventos Eventos en orden cronologico ascendente de la version.
 * @returns {{datos: object[], esGrupo: boolean, agrupador: string|undefined}
 *   |null} Objetivo del deshacer o null si no queda ningun cambio vigente.
 */
function ultimoCambioEconomico(eventos) {
  const operacionesVigentes = [];
  const gruposRegistrados = new Set();

  for (const evento of eventos) {
    const operacion = operacionDe(evento);
    if (esEventoDeDeshacer(evento)) {
      // Cada deshacer se registra como una operacion economica inversa. El
      // encabezado revierte un grupo entero y una fila suelta revierte una
      // edicion individual; los hijos DESHACE del grupo no vuelven a sacar
      // elementos de la pila.
      if (operacion === 'AUMENTO_MASIVO'
        || (operacion === 'PRECIO' && agrupadorDe(evento) == null)) {
        operacionesVigentes.pop();
      }
      continue;
    }

    if (operacion !== 'PRECIO') continue;
    if (agrupadorDe(evento) == null) {
      operacionesVigentes.push({ datos: [evento], esGrupo: false });
      continue;
    }

    const agrupador = String(agrupadorDe(evento));
    if (gruposRegistrados.has(agrupador)) continue;
    gruposRegistrados.add(agrupador);
    const datos = eventos.filter(
      (hijo) => String(agrupadorDe(hijo) ?? '') === agrupador
        && operacionDe(hijo) === 'PRECIO'
        && !esEventoDeDeshacer(hijo),
    );
    operacionesVigentes.push({ datos, esGrupo: true, agrupador });
  }

  return operacionesVigentes.at(-1) ?? null;
}

/**
 * Deshace el ULTIMO cambio economico de un borrador en PREPARACION
 * (edicion individual o aumento masivo): restaura los precios guardados
 * en la auditoria como valor_anterior, dentro de una unica transaccion,
 * con revision optimista y generando su propia auditoria (eventos con
 * detalle 'DESHACE: ...'). Nunca toca versiones ACTIVA o HISTORICA y no
 * reverte activaciones: solo precios de borradores abiertos.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version.
 * @param {{revision: unknown}} cuerpo Revision optimista validada.
 * @param {{legajo: string}} actor Responsable del deshacer.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ filas, revision, evento }` del deshacer.
 * @throws {Error} 400 revision invalida, 404 version inexistente, 409
 *   ADMIN_TRANSICION (estado no editable), ADMIN_CONCURRENCIA (revision
 *   desfasada) o ADMIN_ESTADO (sin cambios previos, fila inconsistente o
 *   precio actual distinto del valor registrado).
 */
export async function deshacerUltimoCambioEconomico(
  pool,
  parametros,
  cuerpo,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const id = validarIdVersion(parametros.id);
  const revision = validarRevision(cuerpo.revision);

  return dependencias.withConnection(
    pool,
    async (connection) => {
      await validarEdicionDeVersion(dependencias, connection, id, revision);
      const eventos = await dependencias.listarEventosDeVersion(connection, id);
      const objetivo = ultimoCambioEconomico(eventos);
      if (!objetivo) {
        throw errorEstado(
          'La version no registra cambios economicos para deshacer.',
        );
      }

      // Resuelve cada fila por la clave de negocio del evento (la misma
      // que formo el hijo del aumento) y la bloquea para escribirla.
      const restauradas = [];
      for (const evento of objetivo.datos) {
        const tarifa = await dependencias.resolverTarifaPorClave(connection, {
          versionId: id,
          planId: Number(evento.plan_id),
          tipoIngreso: evento.tipo_ingreso,
          rangoClave: evento.rango_clave,
        });
        if (!tarifa) {
          throw errorEstado(
            `La fila ${evento.plan_id}/${evento.tipo_ingreso}/`
              + `${evento.rango_clave} del evento ${evento.id} ya no existe `
              + 'en la version; el deshacer se aborta sin aplicar nada.',
          );
        }
        // Integridad con la auditoria: el precio actual debe ser el valor
        // nuevo del evento a deshacer; si alguien cambio la fila por otra
        // via (o una reversion previa no registrada), se refuse el cambio.
        if (String(tarifa.precio) !== String(evento.valor_nuevo)) {
          throw errorEstado(
            `La fila ${evento.plan_id}/${evento.tipo_ingreso}/`
              + `${evento.rango_clave} tiene el precio `
              + `${String(tarifa.precio)} distinto del valor registrado `
              + `(${String(evento.valor_nuevo)}); el deshacer se aborta `
              + 'sin aplicar nada.',
          );
        }
        restauradas.push({ evento, tarifa });
      }

      // Auditoria propia del deshacer: convencion de detalle 'DESHACE: ...'
      // para que el resumen identifique la operacion sin ambigüedad.
      let grupoId = null;
      if (objetivo.esGrupo) {
        const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
        grupoId = await dependencias.insertarEvento(connection, {
          versionId: id,
          tipoEvento: 'MODIFICACION',
          tipoOperacion: 'AUMENTO_MASIVO',
          agrupadorId: null,
          actorLegajo: actorInfo.legajo,
          actorNombre: actorInfo.nombre,
          actorApellido: actorInfo.apellido,
          detalle: `DESHACE: restablece los precios previos del ultimo `
            + `aumento masivo aplicado a la version ${id}.`,
        });
      }

      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const eventosNuevos = [];
      for (const { evento, tarifa } of restauradas) {
        const precioRestaurado = String(evento.valor_anterior);
        await dependencias.actualizarPrecioTarifa(connection, {
          tarifaId: tarifa.id,
          precio: precioRestaurado,
        });
        const idEventoNuevo = await dependencias.insertarEvento(connection, {
          versionId: id,
          tipoEvento: 'MODIFICACION',
          tipoOperacion: 'PRECIO',
          agrupadorId: objetivo.esGrupo ? grupoId : null,
          planId: Number(evento.plan_id),
          tipoIngreso: evento.tipo_ingreso,
          rangoClave: evento.rango_clave,
          valorAnterior: String(evento.valor_nuevo),
          valorNuevo: precioRestaurado,
          actorLegajo: actorInfo.legajo,
          actorNombre: actorInfo.nombre,
          actorApellido: actorInfo.apellido,
          detalle: `DESHACE: restablece el precio previo de `
            + `${descripcionDeFila(evento)}: `
            + `${String(evento.valor_nuevo)} -> ${precioRestaurado}.`,
        });
        eventosNuevos.push(idEventoNuevo);
      }

      return {
        filas: restauradas.length,
        revision: revision + 1,
        evento: objetivo.esGrupo
          ? { id: String(grupoId), tipo: 'DESHACER_GRUPO' }
          : { id: String(eventosNuevos[0]), tipo: 'DESHACER_EDICION' },
      };
  }, { transaction: true });
}

/**
 * Descripcion de la fila afectada por un evento PRECIO para los textos
 * de auditoria del deshacer.
 * @param {object} evento Evento PRECIO real de la auditoria.
 * @returns {string} Etiqueta legible "plan/modalidad/rango".
 */
function descripcionDeFila(evento) {
  return `${evento.plan_id}/${evento.tipo_ingreso}/${evento.rango_clave}`;
}

// ─────────────────────────────────────────────────────────────────────
// Recuperacion funcional: crear un borrador nuevo a partir de una
// version HISTORICA elegida del historial. Conserva el origen en
// version_base_id, copia sus tarifas fila a fila y deja la activacion
// posterior al procedimiento normal (caso D): nunca reactiva ni borra
// versiones cerradas desde la interfaz.
// ─────────────────────────────────────────────────────────────────────

/**
 * Crea un borrador de edicion copiando una version HISTORICA (recuperacion
 * funcional): la nueva EDICION_LISTA nace PREPARACION con
 * `version_base_id` igual a la version historica de origen y su snapshot
 * completo de tarifas. Reaprovecha la exclusividad de borrador abierto
 * (uq_guard_borrador_version) y el caso D para activacion posterior.
 * @param {object} pool Pool MySQL compartido por ADMIN.
 * @param {{id: unknown}} parametros Segmento HTTP con la version historica.
 * @param {{legajo: string}} actor Responsable de la recuperacion.
 * @param {object} dependencias Repositorio sustituible para pruebas.
 * @returns {Promise<object>} `{ version: { id, ..., version_base_id, evento } }`.
 * @throws {Error} 400 id invalido, 404 version inexistente, 409
 *   ADMIN_TRANSICION (origen no HISTORICA) o ADMIN_ESTADO (borrador abierto).
 */
export async function crearBorradorDesdeHistorica(
  pool,
  parametros,
  actor,
  dependencias = DEPENDENCIAS_DEFECTO,
) {
  const idOrigen = validarIdVersion(parametros.id);
  return dependencias.withConnection(
    pool,
    async (connection) => {
      const historica = await dependencias.bloquearVersion(connection, idOrigen);
      if (!historica) {
        throw errorNoEncontrado('La version indicada no existe.');
      }
      // Solo el historial cerrado se recupera: la ACTIVA se copia con el
      // caso normal y una LISTA_PARA_ACTIVAR propia del borrador abierto.
      if (historica.estado !== 'HISTORICA') {
        throw errorTransicion(
          'Solo una version HISTORICA puede recuperarse como borrador. '
          + 'La version ACTIVA se copia con el flujo habitual de creacion.',
        );
      }
      const borrador = await dependencias.bloquearBorradorAbierto(connection);
      if (borrador) {
        throw errorBorradorExistente(borrador);
      }
      const actorInfo = await snapshotActor(dependencias, connection, actor.legajo);
      const observacion = 'Recuperacion de la version historica '
        + `${idOrigen} al crear el borrador.`;
      let versionId;
      try {
        versionId = await dependencias.insertarBorrador(connection, {
          versionBaseId: Number(idOrigen),
          actorLegajo: actor.legajo,
          observacion,
        });
      } catch (error) {
        // Misma carrera concurrente que el caso regular: reporta al
        // ganador con el contrato de exclusividad (409 ADMIN_ESTADO).
        if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
          const ganador = await dependencias.bloquearBorradorAbierto(connection);
          if (ganador) {
            throw errorBorradorExistente(ganador);
          }
          throw errorEstado(
            'Otro administrador creo una version de precios al mismo tiempo. '
            + 'Recarga el historial antes de continuar.',
          );
        }
        throw error;
      }
      const filasCopiadas = await dependencias.copiarTarifas(connection, {
        origenId: idOrigen,
        destinoId: versionId,
      });
      const eventoId = await dependencias.insertarEvento(connection, {
        versionId,
        tipoEvento: 'CREACION',
        tipoOperacion: null,
        agrupadorId: null,
        actorLegajo: actorInfo.legajo,
        actorNombre: actorInfo.nombre,
        actorApellido: actorInfo.apellido,
        detalle: `Recuperacion de la version historica ${idOrigen} `
          + `con ${filasCopiadas} filas de tarifas.`,
      });

      return {
        version: {
          id: String(versionId),
          tipo: 'EDICION_LISTA',
          estado: 'PREPARACION',
          version_base_id: String(idOrigen),
          actor_legajo: actor.legajo,
          evento: { id: String(eventoId), tipo: 'CREACION' },
        },
      };
  }, { transaction: true });
}

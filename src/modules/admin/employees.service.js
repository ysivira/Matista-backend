/**
 * Gestiona empleados y protege las restricciones de administración de cuentas.
 */

/*
 * Servicio ADMIN de gestion de empleados (SL-1, SPEC-03 ADMIN).
 * Reglas vigentes: las cuentas se registran por si mismas con AUTH y
 * quedan PENDIENTE; un ADMIN activa, desactiva, da de baja o reactiva
 * cuentas ajenas y cambia roles. Transiciones aprobadas:
 *   PENDIENTE -> ACTIVO (activacion; RF-D03)
 *   ACTIVO -> INACTIVO | BAJA (desactivacion y baja logica; RF-D04)
 *   INACTIVO -> ACTIVO | BAJA (reactivacion y baja; RF-D03/D04)
 *   BAJA: estado terminal, no admite reactivacion (RF-D04).
 * Reutiliza contratos de AUTH (withConnection, findEmployee con lock,
 * revokeSessions y audit) y los scripts propios del repositorio ADMIN,
 * sin duplicar el comportamiento AUTH. Las funciones reciben un
 * repositorio sustituible (parametro opcional) para pruebas sin base.
 */
import * as repositorioAuth from '../auth/auth.repository.js';
import * as repositorioAdmin from './employees.repository.js';
import {
  errorEstado,
  errorNoEncontrado,
  errorOperacionPropia,
  errorTransicion,
  errorUltimoAdmin,
  errorValidacion
} from './admin.errors.js';

/** Bolsa de dependencias por defecto del servicio: combina la bolsa AUTH y
 *  los scripts ADMIN; las pruebas sustituyen esta bolsa por sus propios dobles. */
const REPOSITORIO_DEFECTO = Object.freeze({
  ...repositorioAuth,
  ...repositorioAdmin
});
const ESTADOS_ADMITIDOS = Object.freeze(['PENDIENTE', 'ACTIVO', 'INACTIVO', 'BAJA']);
const ROLES_ADMITIDOS = Object.freeze(['ADMIN', 'ASESOR']);

/** Estados destino por estado actual (matriz de transiciones aprobada). */
const TRANSICIONES = Object.freeze({
  PENDIENTE: Object.freeze(['ACTIVO']),
  ACTIVO: Object.freeze(['INACTIVO', 'BAJA']),
  INACTIVO: Object.freeze(['ACTIVO', 'BAJA']),
  BAJA: Object.freeze([])
});

/** Estados que exigen revocar todas las sesiones de la cuenta (ADM-001). */
const ESTADOS_QUE_REVOCAN = Object.freeze(['INACTIVO', 'BAJA']);

/** Motivo estable de la revocacion, compartido con AUTH. */
const MOTIVO_REVOCACION = 'ACCOUNT_DISABLED';

/** Comprueba una transicion de estado contra la matriz aprobada (usada
 *  internamente y expuesta para pruebas unitarias de la matriz).
 *
 * - Parametros: `estadoActual` y `estadoNuevo`, valores del esquema.
 * - Retorna: true solo si la transicion figura en la matriz.
 */
export function permitirTransicion(estadoActual, estadoNuevo) {
  return TRANSICIONES[estadoActual]?.includes(estadoNuevo) ?? false;
}

/** Impide dejar el sistema sin un ADMIN activo (guardia del diseno).
 *
 * - Parametros: `repositorio` bolsa con contarAdminsActivos; `connection`
 *   transaccion viva; `objetivo` fila interna; `estadoNuevo` destino.
 * - Error: ULTIMO_ADMIN_PROTEGIDO si el objetivo es el unico ADMIN activo
 *   y su estado pasaria a INACTIVO o BAJA.
 */
async function guardiaUltimoAdmin(repositorio, connection, objetivo, estadoNuevo) {
  if (objetivo.rol !== 'ADMIN' || objetivo.estado !== 'ACTIVO' || estadoNuevo === 'ACTIVO') {
    return;
  }
  const otrosAdminsActivos = await repositorio.contarAdminsActivos(connection, objetivo.legajo);
  if (otrosAdminsActivos === 0) {
    throw errorUltimoAdmin();
  }
}

/**
 * Lista empleados con filtros de estado, rol y busqueda libre.
 *
 * - Parametros: `pool` del backend; `filtros` con `estado`, `rol` y
 *   `busqueda` opcionales (valores invalidos producen ADMIN_VALIDACION);
 *   `repositorio` sustituible para pruebas.
 * - Retorna: array de perfiles publicos con email vigente.
 * - Error: ADMIN_VALIDACION si un filtro encuadrable llega malformado.
 */
export async function gestionarListado(pool, filtros = {}, repositorio = REPOSITORIO_DEFECTO) {
  const estado = filtros.estado ?? null;
  const rol = filtros.rol ?? null;
  const busqueda = filtros.busqueda ?? null;
  if (estado !== null && !ESTADOS_ADMITIDOS.includes(estado)) {
    throw errorValidacion('El filtro de estado no es admitido.');
  }
  if (rol !== null && !ROLES_ADMITIDOS.includes(rol)) {
    throw errorValidacion('El filtro de rol no es admitido.');
  }
  const patronBusqueda = busqueda === null ? null : repositorio.escaparBusqueda(busqueda);
  return repositorio.withConnection(pool, async connection =>
    repositorio.listarEmpleados(connection, {
      estado,
      rol,
      busqueda: patronBusqueda
    })
  );
}

/**
 * Devuelve el detalle publico de un empleado (sin hash de contrasena).
 *
 * - Parametros: `pool` del backend; `legajo` cuenta solicitada;
 *   `repositorio` sustituible para pruebas.
 * - Retorna: objeto con datos personales, email ACTUAL, rol y estado.
 * - Error: ADMIN_NO_ENCONTRADO si el legajo no existe (404).
 */
export async function gestionarDetalle(pool, legajo, repositorio = REPOSITORIO_DEFECTO) {
  return repositorio.withConnection(pool, async connection => {
    const fila = await repositorio.obtenerEmpleado(connection, String(legajo));
    if (!fila) {
      throw errorNoEncontrado('El empleado indicado no existe.');
    }
    return fila;
  });
}

/**
 * Cambia el estado de una cuenta ajena con guardias, revocacion y
 * auditoria dentro de la MISMA transaccion.
 *
 * - Parametros: `pool`; `actorLegajo` legajo real del ADMIN operante;
 *   `legajoTarget` cuenta objetivo; `estadoNuevo` destino encuadrado;
 *   `now` fecha del sistema para audit y revocaciones; `repositorio`
 *   sustituible para pruebas.
 * - Retorna: { legajo, estado, rol } actualizado.
 * - Errores: OPERACION_PROPIA_NO_PERMITIDA (auto-operacion), ADMIN_VALIDACION
 *   (valor), ADMIN_NO_ENCONTRADO (404), ADMIN_TRANSICION y
 *   ULTIMO_ADMIN_PROTEGIDO; el rollback deshace UPDATE, revocaciones y
 *   auditoria si algo falla.
 */
export async function gestionarEstado(
  pool,
  actorLegajo,
  legajoTarget,
  estadoNuevo,
  now = new Date(),
  repositorio = REPOSITORIO_DEFECTO
) {
  const destino = String(estadoNuevo);
  if (String(actorLegajo) === String(legajoTarget)) {
    throw errorOperacionPropia();
  }
  if (!ESTADOS_ADMITIDOS.includes(destino)) {
    throw errorValidacion('El estado solicitado no es admitido por el sistema.');
  }
  return repositorio.withConnection(
    pool,
    async connection => {
      // Guardia del ultimo ADMIN a prueba de carreras: se bloquea primero el
      // conjunto completo de ADMIN activos y recien despues la cuenta
      // objetivo, de modo que dos operaciones concurrentes se serializan
      // sobre el mismo conjunto y no pueden aprobarse mutuamente dejando
      // cero administradores activos.
      await repositorio.bloquearAdminsActivos(connection);
      // findEmployee con lock FOR UPDATE evita carreras al decidir guardias.
      const objetivo = await repositorio.findEmployee(connection, String(legajoTarget), true);
      if (!objetivo) {
        throw errorNoEncontrado('El empleado indicado no existe.');
      }
      if (!permitirTransicion(objetivo.estado, destino)) {
        const destinoValido = TRANSICIONES[objetivo.estado]?.join(' o ') ?? 'ninguno';
        throw errorTransicion(
          `No se puede pasar de ${objetivo.estado} a ${destino}: ` +
            `destinos admisibles: ${destinoValido}.`
        );
      }
      await guardiaUltimoAdmin(repositorio, connection, objetivo, destino);
      await repositorio.actualizarEstado(connection, objetivo.legajo, destino);
      if (ESTADOS_QUE_REVOCAN.includes(destino)) {
        // Obligatorio: una cuenta no operativa no conserva sesiones vivas.
        await repositorio.revokeSessions(connection, objetivo.legajo, MOTIVO_REVOCACION, now);
      }
      await repositorio.audit(
        connection,
        objetivo.legajo,
        String(actorLegajo),
        'ESTADO_CAMBIADO',
        'ESTADO',
        objetivo.estado,
        destino,
        now
      );
      return {
        legajo: objetivo.legajo,
        estado: destino,
        rol: objetivo.rol
      };
    },
    {
      transaction: true
    }
  );
}

/**
 * Cambia el rol de una cuenta ajena exclusivamente entre ADMIN y ASESOR.
 * Solo cuentas ACTIVO cambian de rol: una cuenta pendiente se activa
 * primero; la baja de rol del ultimo ADMIN esta prohibida.
 *
 * - Parametros: `pool`; `actorLegajo` ADMIN operante; `legajoTarget`
 *   objetivo; `rolNuevo` ADMIN|ASESOR; `now` fecha del sistema;
 *   `repositorio` sustituible para pruebas.
 * - Retorna: { legajo, rol, estado } final.
 * - Errores: operacion propia (409), rol invalido (400), cuenta
 *   inexistente (404), cuenta no activa o mismo rol (409 estado) y
 *   ULTIMO_ADMIN_PROTEGIDO cuando no existe otro ADMIN activo.
 */
export async function gestionarRol(
  pool,
  actorLegajo,
  legajoTarget,
  rolNuevo,
  now = new Date(),
  repositorio = REPOSITORIO_DEFECTO
) {
  const destino = String(rolNuevo);
  if (String(actorLegajo) === String(legajoTarget)) {
    throw errorOperacionPropia();
  }
  if (!ROLES_ADMITIDOS.includes(destino)) {
    throw errorValidacion('El rol solicitado no es admitido por el sistema.');
  }
  return repositorio.withConnection(
    pool,
    async connection => {
      // Mismo orden de bloqueo que gestionarEstado: primero el conjunto de
      // ADMIN activos y despues la cuenta objetivo, para que la degradacion
      // de rol del ultimo administrador no gane la carrera contra otra
      // reduccion concurrente.
      await repositorio.bloquearAdminsActivos(connection);
      const objetivo = await repositorio.findEmployee(connection, String(legajoTarget), true);
      if (!objetivo) {
        throw errorNoEncontrado('El empleado indicado no existe.');
      }
      if (objetivo.estado !== 'ACTIVO') {
        throw errorEstado(
          'Solo una cuenta ACTIVO puede cambiar de rol; active la ' + 'cuenta primero.'
        );
      }
      if (objetivo.rol === destino) {
        throw errorValidacion(`La cuenta ya tiene el rol ${destino}.`);
      }
      if (objetivo.rol === 'ADMIN' && destino === 'ASESOR') {
        const otrosAdminsActivos = await repositorio.contarAdminsActivos(
          connection,
          objetivo.legajo
        );
        if (otrosAdminsActivos === 0) {
          throw errorUltimoAdmin();
        }
      }
      await repositorio.actualizarRol(connection, objetivo.legajo, destino);
      await repositorio.audit(
        connection,
        objetivo.legajo,
        String(actorLegajo),
        'ROL_CAMBIADO',
        'ROL',
        objetivo.rol,
        destino,
        now
      );
      return {
        legajo: objetivo.legajo,
        rol: destino,
        estado: objetivo.estado
      };
    },
    {
      transaction: true
    }
  );
}

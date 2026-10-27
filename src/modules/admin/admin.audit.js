/**
 * Registra eventos administrativos en la conexión de la operación.
 */

/*
 * Auditoria transaccional compartida de SPEC-03 ADMIN.
 * Los eventos VERSION_* del tarifario se escriben en la tabla
 * empleados_auditoria existente (infraestructura AUTH), respetando el
 * CHECK incorporado por la migracion 012. La fila se inserta con la
 * MISMA conexion de la operacion administrativa: si la auditoria falla,
 * la operacion no se confirma. Convencion reservada para TARIFARIO:
 * legajo = actor_legajo (referencia propia coherente con el patron AUTH,
 * porque la entidad afectada es una version y no un empleado).
 */
import { errorValidacion } from './admin.errors.js';

// Eventos VERSION_* admitidos por el CHECK de la migracion 012; el
// campo es siempre TARIFARIO (un evento fuera de esta lista rechaza la
// operacion antes de tocar la base).
export const EVENTOS_VERSION = Object.freeze([
  'VERSION_CREADA',
  'VERSION_PROGRAMADA',
  'VERSION_CANCELADA',
  'VERSION_REACTIVADA',
  'VERSION_REVERTIDA'
]);

/**
 * Construye la etiqueta canonica de version para los valores de
 * auditoria: "version#<id>:<estado>".
 *
 * - Parametros: `versionId` identificador de tarifario_versiones;
 *   `estado` estado por el que pasa la version.
 * - Retorna: string determinista, apto para valor_anterior/valor_nuevo.
 */
export function etiquetaVersion(versionId, estado) {
  return `version#${versionId}:${estado}`;
}

/**
 * Registra un evento administrativo de tarifario en la misma
 * transaccion que la operacion auditada.
 *
 * - Parametros: `connection` conexion compartida de la unidad
 *   transaccional; `evento` uno de EVENTOS_VERSION; `actorLegajo`
 *   legajo real del ADMIN (usado como legajo y actor de la fila);
 *   `valorAnterior`/`valorNuevo` etiquetas de version o null;
 *   `fechaLocalizada` string UTC para created_at.
 * - Retorna: nada; el INSERT se hace dentro de la transaccion viva.
 * - Errores: ADMIN_VALIDACION ante evento desconocido (evita chocar el
 *   CHECK en runtime); el error original de la base si falla el INSERT,
 *   que abortara la operacion en curso (auditoria obligatoria).
 */
export async function registrarAuditoriaVersion(
  connection,
  evento,
  actorLegajo,
  valorAnterior,
  valorNuevo,
  fechaLocalizada
) {
  if (!EVENTOS_VERSION.includes(evento)) {
    throw errorValidacion(`Evento de auditoria ADMIN no permitido: ${evento}`);
  }
  await connection.execute(
    `INSERT INTO empleados_auditoria
      (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
     VALUES (?, ?, ?, 'TARIFARIO', ?, ?, ?)`,
    [actorLegajo, actorLegajo, evento, valorAnterior, valorNuevo, fechaLocalizada]
  );
}

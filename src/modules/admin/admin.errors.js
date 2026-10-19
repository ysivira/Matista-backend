// Errores de dominio de SPEC-03 ADMIN sobre el mecanismo existente
// de createAppError: mismos contratos que AUTH (codigo estable, mensaje
// publico y estado HTTP 400-599); sin infraestructura paralela.

import { createAppError } from '../../shared/errors/app-error.js';

// Catalogo publico de codigos ADMIN, clasificados por la semantica de
// la respuesta: validacion (400), estado/concurrencia/integridad (409)
// y recursos inexistentes (404).
export const ERRORES_ADMIN = Object.freeze({
  VALIDACION: 'ADMIN_VALIDACION',
  ESTADO: 'ADMIN_ESTADO',
  FECHA_VERSION_OCUPADA: 'VERSION_DATE_TAKEN',
  CONFLICTO_CRONOLOGICO: 'CONFLICTO_CRONOLOGICO',
  DEPENDENCIA_RECHAZADA: 'DEPENDENCIA_RECHAZADA',
  COLA_OCUPADA: 'VERSION_QUEUE_REJECTED',
  CONFLICTO_PRECIO: 'PRICE_VERSION_CONFLICT',
  TRANSICION_NO_PERMITIDA: 'ADMIN_TRANSICION',
  ULTIMO_ADMIN_PROTEGIDO: 'ULTIMO_ADMIN_PROTEGIDO',
  OPERACION_PROPIA_NO_PERMITIDA: 'OPERACION_PROPIA_NO_PERMITIDA',
  NO_ENCONTRADO: 'ADMIN_NO_ENCONTRADO',
  CONCURRENCIA: 'ADMIN_CONCURRENCIA',
  INTEGRIDAD: 'ADMIN_INTEGRIDAD',
});

/** Crea un error de validacion de negocio ADMIN (HTTP 400).
 *
 *  - Parametros: `mensaje` publico y estable; `detalles` opcionales.
 *  - Retorna: error operativo reconocible por el errorHandler central.
 */
export function errorValidacion(mensaje, detalles) {
  return createAppError(ERRORES_ADMIN.VALIDACION, mensaje, 400, detalles);
}

/** Crea un error de estado no aceptado para la operacion pedida (409). */
export function errorEstado(mensaje, detalles) {
  return createAppError(ERRORES_ADMIN.ESTADO, mensaje, 409, detalles);
}

/** Crea el error de fecha de activacion ya ocupada (orden por fecha, no id). */
export function errorFechaOcupada(mensaje = 'La fecha de activacion pedida ya '
  + 'esta ocupada por otra version.') {
  return createAppError(ERRORES_ADMIN.FECHA_VERSION_OCUPADA, mensaje, 409);
}

/** Crea un error de conflicto cronologico de versiones (409). */
export function errorConflictoCronologico(mensaje) {
  return createAppError(ERRORES_ADMIN.CONFLICTO_CRONOLOGICO, mensaje, 409);
}

/** Crea un error cuando se rechaza operar sobre versiones dependientes (409). */
export function errorDependenciaRechazada(mensaje) {
  return createAppError(ERRORES_ADMIN.DEPENDENCIA_RECHAZADA, mensaje, 409);
}

/** Crea el error de cola exclusiva: existe una version ACTIVA en la cola (409). */
export function errorColaOcupada() {
  return createAppError(
    ERRORES_ADMIN.COLA_OCUPADA,
    'Existe una version pendiente en la cola; cancele o reactivela antes '
    + 'de crear otra.',
    409,
  );
}

/** Crea el error de conflicto de precio concurrente sobre una misma clave (409). */
export function errorConflictoPrecio() {
  return createAppError(ERRORES_ADMIN.CONFLICTO_PRECIO, 'El precio de la '
    + 'version cambio durante la operacion; reintente con el estado '
    + 'recargado.', 409);
}

/** Crea el error de transicion de estado no permitida (409). */
export function errorTransicion(mensaje = 'La transicion de estado '
  + 'solicitada no esta permitida.') {
  return createAppError(ERRORES_ADMIN.TRANSICION_NO_PERMITIDA, mensaje, 409);
}

/** Crea el error de proteccion del ultimo ADMIN activo del sistema (409). */
export function errorUltimoAdmin(mensaje = 'La operacion dejaria el sistema '
  + 'sin un ADMIN activo; prohibida por el diseno.') {
  return createAppError(ERRORES_ADMIN.ULTIMO_ADMIN_PROTEGIDO, mensaje, 409);
}

/** Crea el error de no operar la propia cuenta desde el directorio (409). */
export function errorOperacionPropia() {
  return createAppError(ERRORES_ADMIN.OPERACION_PROPIA_NO_PERMITIDA,
    'No se permite administrar la propia cuenta; use Mi perfil.',
    409);
}

/** Crea el error de recurso inexistente (404). */
export function errorNoEncontrado(mensaje = 'El recurso administrativo '
  + 'solicitado no existe.') {
  return createAppError(ERRORES_ADMIN.NO_ENCONTRADO, mensaje, 404);
}

/** Crea el error de concurrencia sin bloqueo adquirido (409). */
export function errorConcurrencia() {
  return createAppError(ERRORES_ADMIN.CONCURRENCIA, 'Otra operacion '
    + 'administrativa esta en curso; reintente en unos segundos.', 409);
}

/** Clasifica errores de MySQL como conflicto de integridad ADMIN (409).
 *
 *  - Parametros: `error` capturado por el servicio.
 *  - Retorna: el error original si no es de integridad; el error
 *    operativo ADMIN cuando es duplicado, FK o CHECK de esquema.
 *  - Uso: unica conversion centralizada; el servicio llama y retorna.
 */
export function mapearErrorIntegridad(error) {
  const integridad = error?.code === 'ER_DUP_ENTRY'
    || error?.code === 'ER_CHECK_CONSTRAINT_VIOLATED'
    || error?.code === 'ER_ROW_IS_REFERENCED_2'
    || error?.code === 'ER_NO_REFERENCED_ROW_2';

  if (!integridad) {
    return error;
  }

  return createAppError(
    ERRORES_ADMIN.INTEGRIDAD,
    'La operacion viola una regla de integridad del esquema.',
    409,
  );
}

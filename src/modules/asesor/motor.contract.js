/**
 * ============================================================
 * MATISTA | CONTRATO DEL MOTOR
 * ============================================================
 *
 * Archivo: motor.contract.js
 * Módulo: Asesor
 *
 * Responsabilidad:
 * Validar el contrato de entrada del motor y la forma mínima
 * de resultados históricos utilizados en la presentación.
 *
 * ============================================================
 */
import { createAppError } from '../../shared/errors/app-error.js';
import { calcularCotizacion } from '../../domain/comercial/cotizacion.engine.js';
import { REGLAS_COMERCIALES } from '../../domain/comercial/reglas.confirmadas.js';

/**
 * Puerto único del motor comercial. Recibe solicitud v1 construida por el servidor.
 * @param {object} solicitud Cliente, familia, modalidad, plan, referencias y opciones declaradas.
 * @returns {Promise<object>} Resultado económico autoritativo calculado con centavos exactos.
 * @throws {Error} Si hay datos inválidos, parámetros ausentes o decisiones comerciales pendientes.
 */
export async function solicitarCalculo(solicitud) {
  if (
    solicitud?.version_contrato !== 1 ||
    !solicitud.catalogo?.politica ||
    !Array.isArray(solicitud.catalogo.tarifas) ||
    !Array.isArray(solicitud.catalogo.porcentajes) ||
    !solicitud.entrada?.familia ||
    !solicitud.referencias
  )
    throw createAppError('ASESOR_VALIDACION', 'Contrato de cálculo inválido.', 400);
  return calcularCotizacion(solicitud, REGLAS_COMERCIALES);
}

/**
 * Comprueba la forma mínima de un resultado histórico; no ejecuta reglas económicas.
 * Respuesta v1 esperada: motor_version, precio_base, aportes[], beneficios[], tramos[],
 * total, advertencias[], referencias {tarifa_version_id, politica_id}.
 * Los importes son strings decimales. Solo el motor del servidor produce los resultados oficiales.
 * @returns {boolean} Si el snapshot cumple la forma de presentación requerida.
 */
export function esResultadoEconomico(resultado) {
  const importe = /^\d+\.\d{2}$/;
  return (
    resultado?.version_contrato === 1 &&
    typeof resultado.motor_version === 'string' &&
    importe.test(resultado.precio_base) &&
    importe.test(resultado.total) &&
    Array.isArray(resultado.aportes) &&
    Array.isArray(resultado.beneficios) &&
    Array.isArray(resultado.tramos) &&
    Array.isArray(resultado.advertencias) &&
    !!resultado.referencias?.tarifa_version_id &&
    !!resultado.referencias?.politica_id
  );
}

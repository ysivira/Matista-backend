import { errorValidacion } from './admin.errors.js';

const TIPOS_INGRESO = Object.freeze(['Obligatorio', 'Voluntario']);

/**
 * Valida y normaliza los segmentos de la consulta de tarifario vigente.
 * @param {{planId: unknown, tipoIngreso: unknown}} parametros Segmentos recibidos por Express.
 * @returns {{planId: number, tipoIngreso: string}} Parametros encuadrados para el servicio.
 * @throws {Error} ADMIN_VALIDACION con los campos invalidos.
 */
export function validarParametrosTarifario({ planId, tipoIngreso }) {
  const detalles = [];
  const planIdTexto = typeof planId === 'string' ? planId : '';
  const planIdValido = /^[1-9][0-9]{0,4}$/.test(planIdTexto)
    && Number(planIdTexto) <= 65535;

  if (!planIdValido) {
    detalles.push({
      field: 'planId',
      message: 'Debe ser un entero entre 1 y 65535, sin signo ni ceros iniciales.',
    });
  }
  if (!TIPOS_INGRESO.includes(tipoIngreso)) {
    detalles.push({
      field: 'tipoIngreso',
      message: 'Debe ser Obligatorio o Voluntario.',
    });
  }
  if (detalles.length > 0) {
    throw errorValidacion('Los parametros de la consulta no son validos.', detalles);
  }

  return Object.freeze({ planId: Number(planIdTexto), tipoIngreso });
}

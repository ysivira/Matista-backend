/**
 * ============================================================
 * MATISTA | VALIDADORES DEL TARIFARIO
 * ============================================================
 *
 * Archivo: tarifario.validators.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Validar filtros, identificadores, fechas con zona, importes,
 * porcentajes, revisiones y motivos de descarte del tarifario.
 *
 * ============================================================
 */
import { errorValidacion } from './admin.errors.js';
import { compararImportes, esImporteValido, esPorcentajeValido } from './admin.money.js';

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
  const planIdValido = /^[1-9][0-9]{0,4}$/.test(planIdTexto) && Number(planIdTexto) <= 65535;
  if (!planIdValido) {
    detalles.push({
      field: 'planId',
      message: 'Debe ser un entero entre 1 y 65535, sin signo ni ceros iniciales.'
    });
  }
  if (!TIPOS_INGRESO.includes(tipoIngreso)) {
    detalles.push({
      field: 'tipoIngreso',
      message: 'Debe ser Obligatorio o Voluntario.'
    });
  }
  if (detalles.length > 0) {
    throw errorValidacion('Los parametros de la consulta no son validos.', detalles);
  }
  return Object.freeze({
    planId: Number(planIdTexto),
    tipoIngreso
  });
}

// Patron aceptado para la fecha historica: fecha y hora con zona
// horaria explicita (Z o desplazamiento +/-HH:MM) y hasta 3 decimales de
// fraccion, la precision maxima del reloj de JavaScript (milisegundo).
const PATRON_FECHA_VERSION = Object.freeze(
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/
);

/**
 * Valida y normaliza el identificador tecnico de una version de tarifario.
 * El id es un identificador BIGINT de MySQL, no un numero comercial de
 * version: se acepta cualquier entero positivo representable y se devuelve
 * como Number dentro del rango seguro de JavaScript.
 * @param {unknown} idValor Segmento HTTP con el identificador pedido.
 * @returns {number} Identificador encuadrado para el repositorio.
 * @throws {Error} ADMIN_VALIDACION cuando no es un entero valido.
 */
export function validarIdVersion(idValor) {
  const texto = typeof idValor === 'string' ? idValor : '';
  const valido = /^[1-9][0-9]*$/.test(texto) && Number(texto) <= Number.MAX_SAFE_INTEGER;
  if (!valido) {
    throw errorValidacion('El identificador de version no es valido.', [
      {
        field: 'id',
        message: 'Debe ser un entero positivo sin signo ni ceros iniciales.'
      }
    ]);
  }
  return Number(texto);
}

/**
 * Valida la fecha de la consulta historica y la convierte a Date UTC.
 * Exige la zona explicita para descartar ambigedades de horario local:
 * sin zona, zona malformada o fraccion mayor a milisegundo son rechazos
 * 400. La validez calendario se comprueba comparando el instante UTC
 * reconstruido contra los componentes de entrada (descarta 31-02, etc.).
 * @param {unknown} fechaValor Parametro de consulta `fecha` recibido por Express.
 * @returns {Date} Instante UTC equivalente a la zona expresada.
 * @throws {Error} ADMIN_VALIDACION cuando la fecha no cumple el contrato.
 */
export function validarFechaVersion(fechaValor) {
  if (typeof fechaValor !== 'string') {
    throw errorValidacion('La fecha de la consulta no es valida.', [
      {
        field: 'fecha',
        message:
          'Debe incluir fecha y hora con zona explicita ' + '(Z o +/-HH:MM) y hasta milisegundos.'
      }
    ]);
  }
  const captura = fechaValor.match(PATRON_FECHA_VERSION);
  if (!captura) {
    throw errorValidacion('La fecha de la consulta no es valida.', [
      {
        field: 'fecha',
        message:
          'Debe incluir fecha y hora con zona explicita ' + '(Z o +/-HH:MM) y hasta milisegundos.'
      }
    ]);
  }
  const [, año, mes, dia, hora, minuto, segundos = '0', fraccion = '', zona] = captura;
  const milisegundos = fraccion ? Number(fraccion.padEnd(3, '0')) : 0;

  // Convierte el desplazamiento declarado (+HH:MM o -HH:MM) a minutos; Z vale cero.
  let minutosZona = 0;
  if (zona !== 'Z') {
    const signo = zona.startsWith('-') ? -1 : 1;
    const [horasZona, minutosZonaTexto] = zona.slice(1).split(':');
    minutosZona = signo * (Number(horasZona) * 60 + Number(minutosZonaTexto));
  }
  const utc =
    Date.UTC(
      Number(año),
      Number(mes) - 1,
      Number(dia),
      Number(hora),
      Number(minuto),
      Number(segundos),
      milisegundos
    ) -
    minutosZona * 60000;
  const fecha = new Date(utc);

  // La comparacion redondeada descarta fechas inexistentes (31-02, 24:00 sin
  // segundos validos, etc.) que Date.UTC rollea silenciosamente. Se compara
  // el reloj de pared de la zona declarada -- instante UTC devuelto a la
  // zona del pedido -- contra los componentes tal como los escribio el
  // cliente, para no penalizar zonas distintas de UTC.
  const relojPared = new Date(utc + minutosZona * 60000);
  const validaCalendario =
    relojPared.getUTCFullYear() === Number(año) &&
    relojPared.getUTCMonth() + 1 === Number(mes) &&
    relojPared.getUTCDate() === Number(dia) &&
    relojPared.getUTCHours() === Number(hora) &&
    relojPared.getUTCMinutes() === Number(minuto) &&
    relojPared.getUTCSeconds() === Number(segundos) &&
    relojPared.getUTCMilliseconds() === milisegundos;
  if (!validaCalendario) {
    throw errorValidacion('La fecha de la consulta no es valida.', [
      {
        field: 'fecha',
        message: 'La fecha indicada no existe o excede la precision aceptada.'
      }
    ]);
  }
  return fecha;
}

/**
 * Valida el contador de revision para ediciones optimistas de borradores.
 * Exige un entero sin signo representable en la columna INT UNSIGNED
 * (migracion 013); los ceros iniciales son rechazo de contrato, no revision 0.
 * @param {unknown} revisionValor Campo `revision` del cuerpo HTTP.
 * @returns {number} Revision encuadrada para la comparacion optimista.
 * @throws {Error} ADMIN_VALIDACION cuando falta, no es entero o excede rango.
 */
export function validarRevision(revisionValor) {
  const texto =
    typeof revisionValor === 'string' || typeof revisionValor === 'number'
      ? String(revisionValor)
      : '';
  const valido = /^[0-9]+$/.test(texto) && !/^0[0-9]/.test(texto) && Number(texto) <= 4294967295;
  if (!valido) {
    throw errorValidacion('La revision enviada no es valida.', [
      {
        field: 'revision',
        message: 'Debe ser el contador de revision actual de la version (entero sin signo).'
      }
    ]);
  }
  return Number(texto);
}

/**
 * Valida el precio nuevo de una edicion individual contra DECIMAL(10,2),
 * positivo y con hasta dos decimales, sin conversion de punto flotante.
 * @param {unknown} precioValor Campo `precio` del cuerpo HTTP (string o numero).
 * @returns {string} Representacion textual usada por MySQL sin reescala.
 * @throws {Error} ADMIN_VALIDACION cuando excede la columna o es invalido.
 */
export function validarPrecioEdicion(precioValor) {
  const texto = String(precioValor ?? '');
  if (
    !esImporteValido(texto, {
      maximo: '99999999.99',
      decimales: 2
    }) ||
    compararImportes(texto, '0') !== 1
  ) {
    throw errorValidacion('El precio enviado no es valido.', [
      {
        field: 'precio',
        message: 'Debe ser un importe positivo con hasta dos decimales.'
      }
    ]);
  }
  return texto;
}

/**
 * Valida el porcentaje de aumento masivo: positivo y dentro del
 * máximo 99.99 admitido por esPorcentajeValido.
 * @param {unknown} porcentajeValor Campo `porcentaje` del cuerpo HTTP.
 * @returns {string} Representacion textual para el detalle de auditoria.
 * @throws {Error} ADMIN_VALIDACION cuando excede la columna o es invalido.
 */
export function validarPorcentajeAumento(porcentajeValor) {
  const texto = String(porcentajeValor ?? '');
  if (!esPorcentajeValido(texto) || compararImportes(texto, '0') !== 1) {
    throw errorValidacion('El porcentaje de aumento no es valido.', [
      {
        field: 'porcentaje',
        message:
          'Debe ser un porcentaje positivo mayor a cero y menor a 100 con hasta dos decimales.'
      }
    ]);
  }
  return texto;
}

/**
 * Valida la modalidad opcional del aumento masivo; `null` o ausente
 * aplican a ambas modalidades Obligatorio y Voluntario.
 * @param {unknown} tipoIngresoValor Campo `tipoIngreso` opcional del cuerpo.
 * @returns {string|null} Modalidad encuadrada o null para ambas.
 * @throws {Error} ADMIN_VALIDACION con modalidades desconocidas.
 */
export function validarModalidadOpcional(tipoIngresoValor) {
  if (tipoIngresoValor === undefined || tipoIngresoValor === null || tipoIngresoValor === '') {
    return null;
  }
  if (TIPOS_INGRESO.includes(tipoIngresoValor)) {
    return tipoIngresoValor;
  }
  throw errorValidacion('La modalidad del aumento no es valida.', [
    {
      field: 'tipoIngreso',
      message: 'Debe ser Obligatorio, Voluntario o omitirse para aplicar a ambas.'
    }
  ]);
}

/**
 * Valida el motivo del descarte de una version no activada: texto de
 * negocio obligatorio que queda registrado dentro del detalle del evento
 * 'DESCARTE' de la auditoria (columna `detalle`, VARCHAR(500); el
 * prefijo descriptivo del servicio deja margen holgado).
 * @param {unknown} motivoValor Campo `motivo` del cuerpo HTTP.
 * @returns {string} Motivo recortado en los extremos.
 * @throws {Error} ADMIN_VALIDACION con el motivo vacio, no textual o
 *   por exceder 200 caracteres.
 */
export function validarMotivoDescarte(motivoValor) {
  const texto = typeof motivoValor === 'string' ? motivoValor.trim() : '';
  if (texto.length === 0 || texto.length > 200) {
    throw errorValidacion('El motivo del descarte no es valido.', [
      {
        field: 'motivo',
        message: 'Debe explicar en texto breve (maximo 200 caracteres) la razon del descarte.'
      }
    ]);
  }
  return texto;
}

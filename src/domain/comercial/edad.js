/**
 * Cálculo de edad a partir de la fecha de nacimiento del cliente (SPEC-UI-02).
 * La edad no es un atributo persistente del cliente: se deriva de su fecha real
 * y los snapshots de cotizaciones conservan la edad efectivamente utilizada.
 */

/** Convierte 'DD/MM/AAAA' o 'AAAA-MM-DD' en partes numéricas sin interpretar husos horarios. */
function partesFechaTextual(valor) {
  if (typeof valor !== 'string') return null;
  const normalizado = /^\d{4}-\d{2}-\d{2}$/.test(valor) ? valor
    : (/^\d{2}\/\d{2}\/\d{4}$/.test(valor) ? valor.slice(6) + '-' + valor.slice(3, 5) + '-' + valor.slice(0, 2) : null);
  if (!normalizado) return null;
  const [año, mes, día] = normalizado.split('-').map(Number);
  // Descarta fechas imposibles: el constructor de Date salta al mes siguiente ante día inexistente.
  const fecha = new Date(Date.UTC(año, mes - 1, día));
  if (fecha.getUTCFullYear() !== año || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== día) return null;
  return fecha;
}

/**
 * Convierte una fecha de nacimiento admitida (Date, 'YYYY-MM-DD' o 'DD/MM/AAAA') a su Date UTC.
 * @returns {Date|null} Fecha UTC normalizada o null si la fecha es imposible.
 */
function aFechaUTC(valor) {
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return new Date(Date.UTC(valor.getUTCFullYear(), valor.getUTCMonth(), valor.getUTCDate()));
  }
  return partesFechaTextual(valor);
}

/** Devuelve un Date a medianoche UTC del instante dado como referencia del dominio. */
export function hoyUTC(hoy = new Date()) {
  return new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate()));
}

/**
 * Calcula los años cumplidos de una fecha de nacimiento respecto de una fecha de referencia UTC.
 * @param {Date|string|null} fechaNacimiento Fecha real (acepta nacimiento un 29 de febrero).
 * @param {Date} [hoy] Instante de referencia; por defecto el momento actual.
 * @returns {integer|null} Edad en años cumplidos, o null si la fecha es imposible o futura.
 */
export function calcularEdad(fechaNacimiento, hoy = new Date()) {
  const nacimiento = aFechaUTC(fechaNacimiento);
  if (!nacimiento || Number.isNaN(hoy.getTime())) return null;
  const referencia = hoyUTC(hoy);
  if (nacimiento > referencia) return null;
  let años = referencia.getUTCFullYear() - nacimiento.getUTCFullYear();
  const cumpleañosNoOcurrido = nacimiento.getUTCMonth() > referencia.getUTCMonth()
    || (nacimiento.getUTCMonth() === referencia.getUTCMonth() && nacimiento.getUTCDate() > referencia.getUTCDate());
  // Un nacimiento el 29/02 cumple años el 1/3 de los años no bisiestos: la comparación (mes, día) lo resuelve.
  if (cumpleañosNoOcurrido) años -= 1;
  return años;
}

// Utilidades monetarias compartidas de SPEC-03 ADMIN.
// Todo calculo monetario se hace con BigInt sobre enteros escalados
// (sin punto flotante) y con redondeo HALF-UP, criterio aprobado para
// importes y porcentajes del tarifario. Las conversiones MySQL/servicio
// usan siempre strings DECIMAL tal como entrega mysql2.

import { errorValidacion } from './admin.errors.js';

const PATRON_DECIMAL = /^(-?)(\d+)(\.(\d+))?$/;

/**
 * Convierte un valor monetario (string DECIMAL o numero) a su
 * representacion escalar: { mantisa: BigInt, escala: number, negativo }.
 *
 * - Parametros: `valor` acepta string "123.45", "-7.5" o number finito.
 * - Retorna: objeto interno de calculo; nunca expone punto flotante.
 * - Error: ADMIN_VALIDACION si el valor no es un decimal finito.
 */
export function parseDecimal(valor) {
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) {
      throw errorValidacion('El valor monetario no es un numero finito.');
    }
    valor = String(valor);
  }
  if (typeof valor !== 'string' || !PATRON_DECIMAL.test(valor)) {
    throw errorValidacion('El valor monetario no tiene formato decimal.');
  }
  const negativo = valor.startsWith('-');
  const limpio = negativo ? valor.slice(1) : valor;
  const [parteEntera, parteDecimal = ''] = limpio.split('.');
  return {
    mantisa: BigInt(parteEntera + parteDecimal),
    escala: parteDecimal.length,
    negativo,
  };
}

/**
 * Divide dos BigInts redondeando HALF-UP (0.5 se aleja de cero) sobre
 * valores absolutos; el signo se aplica afuera.
 *
 * - Parametros: numerador y denominador BigInt positivos.
 * - Retorna: BigInt del cociente redondeado HALF-UP.
 * - Error: ADMIN_VALIDACION si el denominador es cero.
 */
export function dividirHalfUp(numerador, denominador) {
  if (denominador === 0n) {
    throw errorValidacion('Division monetaria por cero.');
  }
  const cociente = numerador / denominador;
  const resto = numerador % denominador;
  // Dos restos equivalen o superan la mitad: se redondea hacia arriba.
  return resto * 2n >= denominador ? cociente + 1n : cociente;
}

/**
 * Convierte un importe a centavos exactos (escala 2), con redondeo
 * HALF-UP solo si trae mas decimales que la escala destino.
 *
 * - Parametros: `importe` string/number decimal.
 * - Retorna: BigInt de centavos (puede ser negativo).
 * - Error: ADMIN_VALIDACION si el formato es invalido.
 */
export function importeACentavos(importe) {
  const { mantisa, escala, negativo } = parseDecimal(importe);
  const valor = escala <= 2
    ? mantisa * 10n ** BigInt(2 - escala)
    : dividirHalfUp(mantisa, 10n ** BigInt(escala - 2));
  return negativo ? -valor : valor;
}

/**
 * Convierte centavos (BigInt) a la representacion canonica de importe
 * para servicios y respuestas: string con dos decimales fijos.
 *
 * - Parametros: `centavos` BigInt con signo.
 * - Retorna: string tipo "-12.30" (formato DECIMAL(), listo para SQL).
 */
export function centavosAImporte(centavos) {
  const negativo = centavos < 0n;
  const absoluto = negativo ? -centavos : centavos;
  const enteros = absoluto / 100n;
  const fraccion = absoluto % 100n;
  const cuerpo = `${enteros}.${String(fraccion).padStart(2, '0')}`;
  return negativo && absoluto !== 0n ? `-${cuerpo}` : cuerpo;
}

/**
 * Redondea un importe a dos decimales con HALF-UP y lo devuelve como
 * string canonico (formato aceptado por columnas DECIMAL de MySQL).
 *
 * - Parametros: `importe` string DECIMAL de MySQL o numero JS.
 * - Retorna: string "x.yy"; "x.yy0" entradas ya redondeadas se
 *   normalizan a dos decimales fijos.
 * - Error: ADMIN_VALIDACION si el formato es invalido.
 */
export function redondearImporte(importe) {
  return centavosAImporte(importeACentavos(importe));
}

/**
 * Calcula un porcentaje aplicado a un importe: importe * porcentaje / 100,
 * almacenando el calculo completo en enteros y redondeando HALF-UP solo
 * al final (evita el redondeo compuesto y el punto flotante).
 *
 * - Parametros: `importe` y `porcentaje` string/number decimal
 *   (porcentaje 7.00 significa 7%).
 * - Retorna: string importe "x.yy" con el resultado.
 * - Error: ADMIN_VALIDACION si alguno de los valores es invalido.
 */
export function aplicarPorcentaje(importe, porcentaje) {
  const centavosImporte = importeACentavos(importe);
  const { mantisa: mantisaPorcentaje, escala, negativo } = parseDecimal(porcentaje);
  if (negativo) {
    throw errorValidacion('El porcentaje no puede ser negativo.');
  }
  // cents = (importe_en_cents * mantisaPct / 10^escala) en valor real;
  // el producto se calcula entero^n, se ajusta la escala de ambos
  // factores (2 del importe + escala del porcentaje) y se redondea una vez.
  const producto = centavosImporte < 0n ? -centavosImporte : centavosImporte;
  const escalaTotal = BigInt(2 + escala);
  let centavosResultado = dividirHalfUp(producto * mantisaPorcentaje, 10n ** escalaTotal);
  if (centavosImporte < 0n) {
    centavosResultado = -centavosResultado;
  }
  return centavosAImporte(centavosResultado);
}

/**
 * Compara dos importes exactos (sin conversion a punto flotante).
 *
 * - Parametros: `a` y `b` string/number decimal.
 * - Retorna: -1 si a < b, 0 si iguales, 1 si a > b.
 * - Error: ADMIN_VALIDACION si alguno es invalido.
 */
export function compararImportes(a, b) {
  const centavosA = importeACentavos(a);
  const centavosB = importeACentavos(b);
  if (centavosA < centavosB) return -1;
  if (centavosA > centavosB) return 1;
  return 0;
}

/**
 * Valida que un importe quepa en DECIMAL(10,2) positivo con a lo suma
 * `decimales` decimales significativos (las columnas del tarifario
 * admiten 2; rechazar mas evita redondeos implicitos de MySQL).
 *
 * - Parametros: `importe` valor a validar; opciones con `maximo`
 *   (string, por defecto 99999999.99) y `decimales` (2).
 * - Retorna: true si es valido para el esquema; false en caso contrario.
 */
export function esImporteValido(importe, { maximo = '99999999.99', decimales = 2 } = {}) {
  let contenido;
  try {
    contenido = parseDecimal(importe);
  } catch {
    return false;
  }
  if (contenido.escala > decimales) {
    return false;
  }
  const centavos = importeACentavos(importe);
  return centavos >= 0n && centavos <= importeACentavos(maximo);
}

/**
 * Valida que un porcentaje sea positivo y quepa en DECIMAL(5,2)
 * (columna `porcentaje` de tarifario_versiones y aporte de monotributo).
 *
 * - Parametros: `porcentaje` valor a validar; `maximo` por defecto 99.99.
 * - Retorna: true si es un porcentaje admisible; false en caso contrario.
 */
export function esPorcentajeValido(porcentaje, { maximo = '99.99' } = {}) {
  let contenido;
  try {
    contenido = parseDecimal(porcentaje);
  } catch {
    return false;
  }
  if (contenido.negativo) {
    return false;
  }
  const centavos = importeACentavos(porcentaje);
  return centavos >= 0n && centavos <= importeACentavos(maximo);
}

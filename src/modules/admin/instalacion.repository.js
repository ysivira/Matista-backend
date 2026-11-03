/**
 * ============================================================
 * MATISTA | PERSISTENCIA DE LA INSTALACIÓN AUTÓNOMA
 * ============================================================
 *
 * Archivo: instalacion.repository.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Leer la fuente versionada del catálogo E2 aprobado (reemplazo
 * local de SIGEC para instalaciones sin conexión al origen).
 *
 * Consideraciones técnicas:
 * - Los INSERT y el estado del catálogo destino se delegan en
 *   carga-inicial.repository.js: no se duplica SQL de escritura.
 * - Este módulo NO consulta sigec_db ni ninguna base externa.
 *
 * ============================================================
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Huella del recorte comercial cotejado; cambiarla requiere una nueva verificación.
const FUENTE_SHA256 = 'c4091816077059241b7f735aa066b2d1c649735ccdf785ebc4f66aab0653c1cd';

/** Estructura esperada de la fuente versionada. */
const CAMPOS_REQUERIDOS = Object.freeze([
  'metadatos',
  'planes',
  'tarifas',
  'aportes_monotributo'
]);

/** Lee y valida la forma del catalogo E2 versionado en disco.
 *
 *  - Parametros: `archivo` ruta absoluta al JSON versionado.
 *  - Retorna `{ metadatos, planes, tarifas, aportes_monotributo }`
 *    congelado. La validacion de CONTENIDO (cantidades, importes,
 *    matriz aprobada) es responsabilidad del servicio.
 *  - Errores: si el archivo falta o la estructura no es la esperada
 *    se lanza un error descriptivo antes de escribir nada.
 */
export async function leerFuenteVersionada(archivo) {
  let contenido;
  try {
    contenido = await readFile(archivo, 'utf8');
  } catch (error) {
    throw new Error(
      `No se puede leer la fuente versionada del catalogo (${archivo}): ` +
        `${error.code ?? error.message}.`
    );
  }
  let catalogo;
  try {
    catalogo = JSON.parse(contenido);
  } catch (error) {
    throw new Error(
      `La fuente versionada del catalogo no es JSON valido (${archivo}).`
    );
  }
  if (catalogo === null || typeof catalogo !== 'object') {
    throw new Error('La fuente versionada del catalogo no es un objeto JSON.');
  }
  const faltantes = CAMPOS_REQUERIDOS.filter(campo => !(campo in catalogo));
  if (faltantes.length > 0) {
    throw new Error(
      `La fuente versionada del catalogo carece de los campos: ` +
        `${faltantes.join(', ')}.`
    );
  }
  if (createHash('sha256').update(contenido).digest('hex') !== FUENTE_SHA256) {
    throw new Error('La fuente versionada no coincide con el catálogo verificado; no se carga.');
  }
  return Object.freeze({
    metadatos: Object.freeze(catalogo.metadatos),
    planes: Object.freeze(catalogo.planes),
    tarifas: Object.freeze(catalogo.tarifas),
    aportes_monotributo: Object.freeze(catalogo.aportes_monotributo)
  });
}

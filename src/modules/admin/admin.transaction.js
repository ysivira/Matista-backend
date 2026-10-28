/**
 * ============================================================
 * MATISTA | TRANSACCIONES ADMINISTRATIVAS
 * ============================================================
 *
 * Archivo: admin.transaction.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Ejecutar unidades de trabajo MySQL y coordinar el bloqueo
 * exclusivo del tarifario sobre una única conexión.
 *
 * Consideraciones técnicas:
 * - Negocio y auditoría utilizan la conexión recibida.
 * - Las operaciones no deben abrir transacciones anidadas.
 * - withAdminVersionLock adquiere "matista_tarifario" antes de escribir.
 * - Las conexiones adquiridas se liberan en finally.
 *
 * ============================================================
 */
import { errorConcurrencia } from './admin.errors.js';

/** Nombre del bloqueo exclusivo de versiones del tarifario. */
export const NOMBRE_LOCK_TARIFARIO = 'matista_tarifario';

/** Timeout por defecto del bloqueo, en segundos. */
export const TIMEOUT_LOCK_TARIFARIO_SEGUNDOS = 5;

/**
 * ============================================================
 * WITH ADMIN TRANSACTION
 * ============================================================
 *
 * Propósito:
 * Ejecutar una unidad de trabajo administrativa en transacción propia.
 *
 * Funcionamiento:
 * Obtener una conexión, fijar UTC, iniciar la transacción y ejecutar
 * la operación; confirmar o intentar rollback y liberar la conexión.
 *
 * Es la version ADMIN del patron withConnection de AUTH: la misma
 * conexion sirve para escrituras de negocio y de auditoria, garantizando
 * que ambas se confirmen (o deshagan) juntas. No soporta transacciones
 * anidadas: la operacion recibida debe usar solo esa conexion.
 *
 * - Parametros: `pool` de mysql2; `operacion` funcion async que recibe
 *   la conexion y retorna el resultado de la unidad de trabajo.
 * - Retorna: el resultado de `operacion` tras el commit exitoso.
 * - Error: el error original capturado; hace rollback completo y
 *   libera la conexion en finally en todos los escenarios.
 *
 * @param {object} pool - Pool MySQL de la operación.
 * @param {Function} operacion - Operación asíncrona que recibe la conexión.
 * @returns {Promise<*>} Resultado tras confirmar la transacción.
 * @throws {Error} Error de adquisición, ejecución o cierre transaccional.
 *
 * ============================================================
 */
export async function withAdminTransaction(pool, operacion) {
  const connection = await pool.getConnection();
  let iniciada = false;
  try {
    // Zona horaria UTC consistente con las columnas DATETIME del esquema.
    await connection.query("SET time_zone = '+00:00'");
    await connection.beginTransaction();
    iniciada = true;
    const resultado = await operacion(connection);
    await connection.commit();
    return resultado;
  } catch (error) {
    if (iniciada) {
      await connection.rollback();
    }
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Convierte el valor retornado por mysql2 para GET_LOCK a un resultado
 * semantico: 1 = adquirido, 0 = timeout de espera, null = error de
 * llamada. mysql2 puede entregar el numero como number o string.
 *
 * - Parametros: `valor` fila o celda cruda de GET_LOCK.
 * - Retorna: 1, 0 o null.
 *
 * @param {*} valor - Celda devuelta por GET_LOCK.
 * @returns {number|null} Uno, cero o null según el resultado.
 */
export function interpretarGetLock(valor) {
  if (valor === 1 || valor === '1') return 1;
  if (valor === 0 || valor === '0') return 0;
  return null;
}

/**
 * ============================================================
 * WITH ADMIN VERSION LOCK
 * ============================================================
 *
 * Ejecuta una operación administrativa protegida por el bloqueo
 * exclusivo del tarifario y con transaccion propia, en la MISMA
 * conexion. El bloqueo evita que dos operaciones concurrentes generen
 * versiones incompatibles o modificaciones parciales; la transaccion
 * solo se abre si el bloqueo fue adquirido, y se libera siempre.
 *
 * - Parametros: `pool` de mysql2; `operacion` recibe
 *   (connection, { bloqueoAdquirido: true }); `timeoutSegundos`
 *   espera maxima del GET_LOCK (por defecto 5).
 * - Retorna: { resultado, bloqueoAdquirido: true, liberacionOk }
 *   donde liberacionOk indica si RELEASE_LOCK confirmo la liberacion.
 * - Error: ADMIN_CONCURRENCIA si no se obtuvo el bloqueo (timeout o
 *   error); el error original de `operacion` si fallo la unidad de
 *   trabajo (con rollback completo). La conexion se libera en finally
 *   incluso si RELEASE_LOCK falla.
 *
 * @param {object} pool - Pool MySQL compartido.
 * @param {Function} operacion - Recibe la conexión y el estado del bloqueo.
 * @param {object} [opciones] - Opciones de espera del bloqueo.
 * @param {number} [opciones.timeoutSegundos=5] - Espera máxima en segundos.
 * @returns {Promise<object>} Resultado, bloqueo adquirido y estado de liberación.
 * @throws {Error} Conflicto de bloqueo o fallo de conexión/transacción.
 *
 * ============================================================
 */
export async function withAdminVersionLock(
  pool,
  operacion,
  { timeoutSegundos = TIMEOUT_LOCK_TARIFARIO_SEGUNDOS } = {}
) {
  const connection = await pool.getConnection();
  let bloqueoAdquirido = false;
  let liberacionOk = false;
  let resultadoOperacion;
  try {
    await connection.query("SET time_zone = '+00:00'");
    const [filas] = await connection.execute('SELECT GET_LOCK(?, ?) AS resultado', [
      NOMBRE_LOCK_TARIFARIO,
      timeoutSegundos
    ]);
    // Interpretacion del contrato de GET_LOCK: 1 adquirido, 0 timeout
    // de espera agotado, null error de la llamada al bloqueo.
    const adquirido = interpretarGetLock(filas?.[0]?.resultado);
    if (adquirido !== 1) {
      throw errorConcurrencia();
    }
    bloqueoAdquirido = true;
    await connection.beginTransaction();
    try {
      resultadoOperacion = await operacion(connection, {
        bloqueoAdquirido: true
      });
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    if (bloqueoAdquirido) {
      // El fallo de RELEASE_LOCK nunca impide liberar la conexion: se
      // registra en el resultado cuando la operacion termino con exito
      // y se ignora en la ruta de error para no tapar el fallo real.
      try {
        const [filas] = await connection.execute('SELECT RELEASE_LOCK(?) AS liberado', [
          NOMBRE_LOCK_TARIFARIO
        ]);
        const valor = filas?.[0]?.liberado;
        liberacionOk = valor === 1 || valor === '1';
      } catch {
        liberacionOk = false;
      }
    }
    connection.release();
  }

  // El resultado se arma despues del finally de modo que refleje la
  // liberacion real del bloqueo, no su estado previo.
  return {
    resultado: resultadoOperacion,
    bloqueoAdquirido: true,
    liberacionOk
  };
}

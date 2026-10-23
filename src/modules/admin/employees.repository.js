// Repositorio ADMIN de gestion de empleados (SL-1, SPEC-03).
// Consultas y escrituras sobre las tablas AUTH existentes (empleados y
// empleados_correos); las sesiones y la auditoria se gestionan con los
// primitivos de AUTH reutilizados por el servicio. Ningun DDL nuevo.

/**
 * Lista empleados con su correo ACTUAL y filtros opcionales ya validados
 * por el servicio.
 *
 * - Parametros: `connection` conexion mysql2; `filtros` objeto con
 *   `estado` (PENDIENTE|ACTIVO|INACTIVO|BAJA|null), `rol`
 *   (ADMIN|ASESOR|null) y `busqueda` (string|null, texto a coincidir en
 *   legajo, nombres, apellidos o email).
 * - Retorna: array de filas publicas
 *   { legajo, nombre, segundo_nombre, apellido, segundo_apellido,
 *   telefono, rol, estado, email }; sin credenciales.
 */
export async function listarEmpleados(connection, { estado, rol, busqueda } = {}) {
  const condiciones = [];
  const valores = [];

  if (estado) {
    condiciones.push('e.estado = ?');
    valores.push(estado);
  }
  if (rol) {
    condiciones.push('e.rol = ?');
    valores.push(rol);
  }
  if (busqueda) {
    // Coincidencia parcial case-insensitive; el servicio ya escapo % _ y \\.
    const patron = `%${busqueda}%`;
    condiciones.push(
      '(e.legajo LIKE ? OR e.nombre LIKE ? OR e.segundo_nombre LIKE ?'
      + ' OR e.apellido LIKE ? OR e.segundo_apellido LIKE ? OR c.email LIKE ?)',
    );
    valores.push(patron, patron, patron, patron, patron, patron);
  }

  const donde = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const [filas] = await connection.query(
    `SELECT e.legajo, e.nombre, e.segundo_nombre, e.apellido, e.segundo_apellido,
            e.telefono, e.rol, e.estado, c.email
       FROM empleados e
         LEFT JOIN (
              SELECT legajo, email
                FROM empleados_correos
               WHERE estado = 'ACTUAL'
         ) c ON c.legajo = e.legajo
       ${donde}
      ORDER BY e.apellido, e.nombre, e.legajo`,
    valores,
  );
  return filas;
}

/**
 * Devuelve la fila publica de un empleado con su correo ACTUAL.
 *
 * - Parametros: `connection` conexion mysql2; `legajo` de la cuenta pedida.
 * - Retorna: fila publica sin credenciales, o undefined si no existe.
 * - Nota: el servicio convierte la ausencia en ADMIN_NO_ENCONTRADO.
 */
export async function obtenerEmpleado(connection, legajo) {
  const [filas] = await connection.query(
    `SELECT e.legajo, e.nombre, e.segundo_nombre, e.apellido, e.segundo_apellido,
            e.telefono, e.direccion, e.rol, e.estado, c.email
       FROM empleados e
         LEFT JOIN (
              SELECT legajo, email
                FROM empleados_correos
               WHERE estado = 'ACTUAL'
         ) c ON c.legajo = e.legajo
      WHERE e.legajo = ?`,
    [legajo],
  );
  return filas[0];
}

/**
 * Cuenta los ADMIN activos del sistema excepto el legajo excluido; usada
 * para el guardia de ultimo ADMIN.
 *
 * - Parametros: `connection` conexion mysql2; `legajoExcluido` cuenta que
 *   se esta operando.
 * - Retorna: number de ADMIN activos restantes.
 */
export async function contarAdminsActivos(connection, legajoExcluido) {
  const [filas] = await connection.query(
    `SELECT COUNT(*) AS total
       FROM empleados
      WHERE rol = 'ADMIN' AND estado = 'ACTIVO' AND legajo <> ?`,
    [legajoExcluido],
  );
  return Number(filas[0].total);
}

/**
 * Bloquea en bloque el conjunto completo de ADMIN activos (FOR UPDATE).
 *
 * La guardia del ultimo ADMIN exige serializar las operaciones que pueden
 * reducir administradores: bloquear unicamente la fila objetivo permite que
 * dos transacciones concurrentes se aprueben mutuamente (cada una ve al
 * otro ADMIN todavia activo) y dejen el sistema sin ningun ADMIN activo.
 * Bloquear el conjunto con orden estable por legajo ANTES de leer la cuenta
 * objetivo elimina esa carrera; todas las operaciones de estado/rol toman
 * primero este conjunto, por lo que no se generan ciclos de bloqueo.
 *
 * - Parametros: `connection` transaccion viva de la unidad de trabajo.
 * - Retorna: nada; los bloqueos se liberan al commit o rollback del servicio.
 */
export async function bloquearAdminsActivos(connection) {
  await connection.query(
    `SELECT legajo
       FROM empleados
      WHERE rol = 'ADMIN' AND estado = 'ACTIVO'
      ORDER BY legajo
      FOR UPDATE`,
  );
}

/**
 * Actualiza el estado de un empleado (uso exclusivo del servicio ADMIN,
 * que ya aplico guardias, en la transaccion con auditoria y revocaciones).
 *
 * - Parametros: `connection` conexion de la unidad de trabajo;
 *   `legajo` cuenta objetivo; `estado` nuevo estado encuadrado.
 * - Retorna: nada; el UPDATE se confirma al hacer commit el servicio.
 */
export async function actualizarEstado(connection, legajo, estado) {
  await connection.execute(
    'UPDATE empleados SET estado = ? WHERE legajo = ?',
    [estado, legajo],
  );
}

/**
 * Actualiza el rol de un empleado (mismas reservas de actualizarEstado).
 *
 * - Parametros: `connection` conexion de la unidad de trabajo;
 *   `legajo` cuenta objetivo; `rol` ADMIN|ASESOR ya encuadrado.
 * - Retorna: nada; confirma al hacer el commit del servicio.
 */
export async function actualizarRol(connection, legajo, rol) {
  await connection.execute(
    'UPDATE empleados SET rol = ? WHERE legajo = ?',
    [rol, legajo],
  );
}

/**
 * Escapa los comodines LIKE de la busqueda libre para evitar coincidencias
 * no deseadas (`%`, `_` y `\` son literales).
 *
 * - Parametros: `busqueda` texto sin saneo previo (se recorta el borde).
 * - Retorna: string escapado para usar dentro del patron LIKE.
 */
export function escaparBusqueda(busqueda) {
  return String(busqueda).trim().replace(/([%_\\])/g, '\\$1');
}

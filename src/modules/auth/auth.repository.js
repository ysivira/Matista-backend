import { createAppError } from '../../shared/errors/app-error.js';
import { PROFILE_FIELDS } from './auth.constants.js';

const EMPLOYEE_COLUMNS = `legajo, nombre, segundo_nombre, apellido, segundo_apellido,
  telefono, direccion, password_hash, rol, estado, password_changed_at`;

/**
 * Ejecuta una operación sobre una conexión UTC del pool existente, opcionalmente transaccional.
 * @param {object} pool Pool inyectado de mysql2; no crea conexiones globales al importar.
 * @param {Function} operation Operación que recibe la única conexión de la unidad de trabajo.
 * @param {object} options Indica si necesita begin/commit/rollback.
 * @returns {Promise<unknown>} Resultado de la operación; siempre libera la conexión.
 * @throws {Error} Conflicto de unicidad público o error original para manejo centralizado.
 */
export async function withConnection(pool, operation, { transaction = false } = {}) {
  const connection = await pool.getConnection();
  let started = false;
  try {
    await connection.query("SET time_zone = '+00:00'");
    if (transaction) {
      await connection.beginTransaction();
      started = true;
    }
    const result = await operation(connection);
    if (transaction) await connection.commit();
    return result;
  } catch (error) {
    if (started) await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
      throw createAppError('IDENTITY_CONFLICT', 'El DNI o correo ya se encuentra reservado.', 409);
    }
    throw error;
  } finally {
    connection.release();
  }
}

/** Busca identidad por DNI y opcionalmente la bloquea; retorna fila interna o undefined. */
export async function findEmployee(connection, legajo, lock = false) {
  const [rows] = await connection.execute(
    `SELECT ${EMPLOYEE_COLUMNS} FROM empleados WHERE legajo = ?${lock ? ' FOR UPDATE' : ''}`, [legajo],
  );
  return rows[0];
}

/** Busca un correo reservado y su propietario; la fila no decide si puede iniciar sesión. */
export async function findReservedEmail(connection, email) {
  const [rows] = await connection.execute(
    `SELECT id, legajo, email, estado, verificado_at FROM empleados_correos
     WHERE email_reservado = ?`, [email],
  );
  return rows[0];
}

/** Lista correos del empleado en orden estable; lock permite transiciones atómicas. */
export async function findEmails(connection, legajo, lock = false) {
  const [rows] = await connection.execute(
    `SELECT id, legajo, email, estado, verificado_at FROM empleados_correos
     WHERE legajo = ? ORDER BY id${lock ? ' FOR UPDATE' : ''}`, [legajo],
  );
  return rows;
}

/** Inserta identidad inicial con rol y estado fijados por servidor; no recibe privilegios del cliente. */
export async function insertEmployee(connection, data, passwordHash, now) {
  await connection.execute(
    `INSERT INTO empleados (legajo, nombre, segundo_nombre, apellido, segundo_apellido,
     telefono, direccion, password_hash, rol, estado, password_changed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ASESOR', 'PENDIENTE', ?, ?)`,
    [data.legajo, data.nombre, data.segundo_nombre ?? null, data.apellido,
      data.segundo_apellido ?? null, data.telefono ?? null, data.direccion ?? null, passwordHash, now, now],
  );
}

/** Inserta correo pendiente; retorna su id técnico para vincular el token de verificación. */
export async function insertEmail(connection, legajo, email, now) {
  const [result] = await connection.execute(
    `INSERT INTO empleados_correos (legajo, email, estado, created_at)
     VALUES (?, ?, 'PENDIENTE', ?)`, [legajo, email, now],
  );
  return result.insertId;
}

/** Cancela cambios pendientes sin verificación; libera su reserva y conserva historial. */
export async function cancelPendingEmails(connection, legajo, now) {
  await connection.execute(
    `UPDATE empleados_correos SET estado = 'CANCELADO', cerrado_at = ?
     WHERE legajo = ? AND estado = 'PENDIENTE'`, [now, legajo],
  );
}

/** Reemplaza primero el correo actual y luego confirma el pendiente, respetando índices UNIQUE. */
export async function confirmEmail(connection, legajo, correoId, now) {
  await connection.execute(
    `UPDATE empleados_correos SET estado = 'ANTERIOR', cerrado_at = ?
     WHERE legajo = ? AND estado = 'ACTUAL'`, [now, legajo],
  );
  await connection.execute(
    `UPDATE empleados_correos SET estado = 'ACTUAL', verificado_at = ?
     WHERE id = ? AND legajo = ? AND estado = 'PENDIENTE'`, [now, correoId, legajo],
  );
}

/** Busca hash binario de token; lock se usa después del bloqueo del empleado. */
export async function findToken(connection, tokenHash, lock = false) {
  const [rows] = await connection.execute(
    `SELECT id, legajo, correo_id, tipo, expires_at, consumed_at, revoked_at
     FROM auth_tokens WHERE token_hash = ?${lock ? ' FOR UPDATE' : ''}`, [tokenHash],
  );
  return rows[0];
}

/** Revoca tokens abiertos del propósito indicado, incluidos vencidos que aún ocupan la clave UNIQUE. */
export async function revokeTokens(connection, legajo, type, now) {
  await connection.execute(
    `UPDATE auth_tokens SET revoked_at = ? WHERE legajo = ? AND tipo = ?
     AND consumed_at IS NULL AND revoked_at IS NULL`, [now, legajo, type],
  );
}

/** Inserta exclusivamente el hash binario del token y sus referencias; jamás el token crudo. */
export async function insertToken(connection, legajo, correoId, type, generated, now) {
  await connection.execute(
    `INSERT INTO auth_tokens (legajo, correo_id, tipo, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`, [legajo, correoId, type, generated.tokenHash, generated.expiresAt, now],
  );
}

/** Marca consumo de un token previamente bloqueado y validado por el servicio. */
export async function consumeToken(connection, id, now) {
  await connection.execute('UPDATE auth_tokens SET consumed_at = ? WHERE id = ?', [now, id]);
}

/** Persiste jti y fechas exactas del JWT, sin guardar su representación firmada. */
export async function insertSession(connection, legajo, signed) {
  await connection.execute(
    `INSERT INTO auth_sesiones (jti, legajo, issued_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`, [signed.jti, legajo, signed.issuedAt, signed.expiresAt, signed.issuedAt],
  );
}

/** Busca sesión por jti y propietario para impedir asociar una sesión a otro sub del JWT. */
export async function findSession(connection, jti, legajo, lock = false) {
  const [rows] = await connection.execute(
    `SELECT jti, legajo, issued_at, expires_at, revoked_at FROM auth_sesiones
     WHERE jti = ? AND legajo = ?${lock ? ' FOR UPDATE' : ''}`, [jti, legajo],
  );
  return rows[0];
}

/** Revoca sesiones abiertas del empleado; un jti opcional limita la operación al logout actual. */
export async function revokeSessions(connection, legajo, reason, now, jti = null) {
  await connection.execute(
    `UPDATE auth_sesiones SET revoked_at = ?, revocation_reason = ?
     WHERE legajo = ? AND revoked_at IS NULL${jti ? ' AND jti = ?' : ''}`,
    jti ? [now, reason, legajo, jti] : [now, reason, legajo],
  );
}

/** Persiste hash nuevo y fecha de cambio; nunca modifica estado ni rol. */
export async function updatePassword(connection, legajo, passwordHash, now) {
  await connection.execute(
    'UPDATE empleados SET password_hash = ?, password_changed_at = ? WHERE legajo = ?',
    [passwordHash, now, legajo],
  );
}

/** Actualiza solo columnas personales permitidas; identificadores SQL proceden de una lista cerrada. */
export async function updateProfile(connection, legajo, data) {
  const fields = PROFILE_FIELDS.filter((field) => Object.hasOwn(data, field));
  if (!fields.length) return;
  await connection.execute(
    `UPDATE empleados SET ${fields.map((field) => `${field} = ?`).join(', ')} WHERE legajo = ?`,
    [...fields.map((field) => data[field]), legajo],
  );
}

/** Registra eventos admitidos por el esquema; los cambios de contraseña siempre omiten valores. */
export async function audit(connection, legajo, actor, event, field, previous, next, now) {
  await connection.execute(
    `INSERT INTO empleados_auditoria
     (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`, [legajo, actor, event, field, previous, next, now],
  );
}

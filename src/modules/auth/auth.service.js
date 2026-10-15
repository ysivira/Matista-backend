import { createAppError } from '../../shared/errors/app-error.js';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password.js';
import { signAccessToken, verifyAccessToken } from '../../infrastructure/security/jwt.js';
import { createTemporaryToken, hashTemporaryToken } from '../../infrastructure/security/token.js';
import { AUTH_ROLES, PROFILE_FIELDS, NEUTRAL_RECOVERY, NEUTRAL_VERIFICATION } from './auth.constants.js';

/** Normaliza únicamente espacios exteriores y mayúsculas del correo; retorna el identificador canónico. */
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

/** Proyecta identidad propia y correos permitidos; nunca expone filas internas ni hashes. */
export function publicProfile(employee, emails) {
  const current = emails.find((email) => email.estado === 'ACTUAL');
  const pending = emails.find((email) => email.estado === 'PENDIENTE');
  return {
    legajo: employee.legajo, rol: employee.rol, estado: employee.estado,
    ...Object.fromEntries(PROFILE_FIELDS.map((field) => [field, employee[field] ?? null])),
    email: current?.email ?? null, pendingEmail: pending?.email ?? null,
  };
}

/** Entrega un error uniforme para tokens auxiliares inválidos, revocados, vencidos o de otro propósito. */
function invalidToken() {
  return createAppError('TOKEN_INVALID', 'El enlace no es válido o ha vencido. Solicite uno nuevo.', 400);
}

/** Hashea el token recibido mediante B y traduce exclusivamente errores de formato a un error público. */
function temporaryHash(token) {
  try { return hashTemporaryToken(token); } catch { throw invalidToken(); }
}

/**
 * Envía después del commit; reporta solo un código estático ante fallo, sin datos del proveedor.
 * @param {object} notice Mensaje interno con tipo, destinatario y token opcional.
 * @param {object} context Dependencias con notify y reportIncident sustituibles.
 * @returns {Promise<boolean>} Si el proveedor aceptó el envío; nunca revierte persistencia confirmada.
 */
async function deliverNotice(notice, context) {
  try {
    await context.notify(notice);
    return true;
  } catch {
    context.reportIncident({ code: 'AUTH_EMAIL_FAILED', operation: notice.type });
    return false;
  }
}

/**
 * Verifica sesión, propietario y cuenta actuales; usa bloqueos en operaciones mutables.
 * @param {object} connection Conexión de la unidad de trabajo.
 * @param {object} claims Claims ya verificados criptográficamente por B.
 * @param {object} context Dependencias y reloj.
 * @param {boolean} lock Si debe bloquear empleado, sesión y correos.
 * @returns {Promise<object>} Identidad interna habilitada y correos.
 * @throws {Error} SESSION_INVALID/401 si la autorización efectiva dejó de ser válida.
 */
export async function readAuthorizedAccount(connection, claims, context, lock = false) {
  const repo = context.repository;
  const employee = await repo.findEmployee(connection, claims.sub, lock);
  const session = await repo.findSession(connection, claims.jti, claims.sub, lock);
  const emails = employee ? await repo.findEmails(connection, employee.legajo, lock) : [];
  if (!employee || employee.estado !== 'ACTIVO' || !AUTH_ROLES.includes(employee.rol)
      || !session || session.revoked_at || session.legajo !== claims.sub
      || session.jti !== claims.jti || new Date(session.expires_at) <= context.now()
      || new Date(session.expires_at).getTime() !== claims.exp * 1000
      || new Date(session.issued_at).getTime() !== claims.iat * 1000
      || !emails.some((email) => email.estado === 'ACTUAL' && email.verificado_at)) {
    throw createAppError('SESSION_INVALID', 'La sesión ya no autoriza esta operación.', 401);
  }
  return { employee, emails };
}

/** Valida JWT con B y recarga sesión, rol, estado y correo desde persistencia en cada solicitud protegida. */
export async function authenticateToken(token, context) {
  const claims = await verifyAccessToken(token, context.security, context.now());
  const account = await context.repository.withConnection(context.pool,
    /** Consulta autorización sin bloquear para una lectura normal. */
    (connection) => readAuthorizedAccount(connection, claims, context));
  return { claims, user: publicProfile(account.employee, account.emails) };
}

/**
 * Registra ASESOR/PENDIENTE y correo/token/auditoría atómicamente; envía correo después del commit.
 * @param {object} data Datos públicos validados del registro.
 * @param {object} context Dependencias inyectadas, sin acceso global a servicios.
 * @returns {Promise<object>} Resultado público y estado de entrega recuperable.
 */
export async function register(data, context) {
  const passwordHash = await hashPassword(data.password, context.security);
  const now = context.now();
  const generated = createTemporaryToken('VERIFICAR_EMAIL', context.security, now);
  const email = normalizeEmail(data.email);
  const repo = context.repository;
  await repo.withConnection(context.pool,
    /** Inserta las cuatro piezas del registro en la misma conexión y transacción. */
    async (connection) => {
      await repo.insertEmployee(connection, data, passwordHash, now);
      const correoId = await repo.insertEmail(connection, data.legajo, email, now);
      await repo.insertToken(connection, data.legajo, correoId, 'VERIFICAR_EMAIL', generated, now);
      await repo.audit(connection, data.legajo, null, 'REGISTRO', 'CUENTA', null, 'PENDIENTE', now);
    }, { transaction: true });
  const sent = await deliverNotice({ type: 'VERIFY_EMAIL', to: email, token: generated.token }, context);
  return { code: 'ACCOUNT_REGISTERED', estado: 'PENDIENTE', verificationDelivery: sent ? 'ACCEPTED' : 'RETRY_REQUIRED' };
}

/**
 * Emite sesión solo para correo actual verificado y cuenta habilitada, revalidando bajo bloqueo.
 * @param {object} input Correo y contraseña; la respuesta de credenciales incorrectas es uniforme.
 * @param {object} context Repositorio, pool, seguridad, hash ficticio para comparación neutra y reloj.
 * @returns {Promise<object>} JWT interno para cookie y perfil público; el controlador no serializa el JWT.
 */
export async function login({ email, password }, context) {
  const repo = context.repository;
  const normalized = normalizeEmail(email);
  const snapshot = await repo.withConnection(context.pool,
    /** Recupera identidad candidata sin mantener bloqueos durante bcrypt. */
    async (connection) => {
      const address = await repo.findReservedEmail(connection, normalized);
      return address ? repo.findEmployee(connection, address.legajo) : undefined;
    });
  const matches = await verifyPassword(password, snapshot?.password_hash ?? context.dummyPasswordHash);
  if (!snapshot || !matches) throw createAppError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.', 401);
  return repo.withConnection(context.pool,
    /** Serializa emisión contra cambios de contraseña, correo y estado del mismo empleado. */
    async (connection) => {
      const employee = await repo.findEmployee(connection, snapshot.legajo, true);
      const emails = await repo.findEmails(connection, snapshot.legajo, true);
      if (!employee || employee.password_hash !== snapshot.password_hash) {
        throw createAppError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.', 401);
      }
      const current = emails.find((address) => address.estado === 'ACTUAL');
      if (current && current.email !== normalized) {
        throw createAppError('INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.', 401);
      }
      if (!current?.verificado_at) {
        throw createAppError('EMAIL_VERIFICATION_REQUIRED', 'Debe verificar su correo antes de continuar.', 403);
      }
      if (employee.estado === 'PENDIENTE') {
        throw createAppError('ACCOUNT_PENDING_APPROVAL', 'La cuenta está pendiente de aprobación.', 403);
      }
      if (employee.estado !== 'ACTIVO' || !AUTH_ROLES.includes(employee.rol)) {
        throw createAppError('ACCOUNT_NOT_ACTIVE', 'La cuenta no está habilitada para operar.', 403);
      }
      const signed = await signAccessToken({ legajo: employee.legajo }, context.security, context.now());
      await repo.insertSession(connection, employee.legajo, signed);
      return { ...signed, user: publicProfile(employee, emails) };
    }, { transaction: true });
}

/** Cierra únicamente el jti presentado; sin token válido es idempotente y no consulta MySQL. */
export async function logout(token, context) {
  let claims;
  try { claims = await verifyAccessToken(token, context.security, context.now()); } catch (error) {
    if (error.code === 'ACCESS_TOKEN_INVALID') return;
    throw error;
  }
  const repo = context.repository;
  await repo.withConnection(context.pool,
    /** Mantiene el orden de bloqueo de empleado antes de revocar su sesión. */
    async (connection) => {
      if (await repo.findEmployee(connection, claims.sub, true)) {
        await repo.revokeSessions(connection, claims.sub, 'LOGOUT', context.now(), claims.jti);
      }
    }, { transaction: true });
}

/**
 * Reenvía una verificación pendiente sin revelar existencia ni estado de la cuenta.
 * @param {object} input Correo pendiente solicitado.
 * @param {object} context Dependencias y reloj.
 * @returns {Promise<object>} Respuesta neutra incluso si falla SMTP.
 */
export async function resendVerification({ email }, context) {
  const repo = context.repository;
  const normalized = normalizeEmail(email);
  const notice = await repo.withConnection(context.pool,
    /** Relee el correo bajo bloqueo del propietario antes de sustituir su token. */
    async (connection) => {
      const candidate = await repo.findReservedEmail(connection, normalized);
      if (!candidate) return null;
      const employee = await repo.findEmployee(connection, candidate.legajo, true);
      if (!employee || employee.estado === 'BAJA') return null;
      const emails = await repo.findEmails(connection, employee.legajo, true);
      const pending = emails.find((address) => address.estado === 'PENDIENTE' && address.email === normalized);
      if (!pending) return null;
      const current = emails.find((address) => address.estado === 'ACTUAL');
      if (current && employee.estado !== 'ACTIVO') return null;
      const now = context.now();
      const generated = createTemporaryToken('VERIFICAR_EMAIL', context.security, now);
      await repo.revokeTokens(connection, employee.legajo, 'VERIFICAR_EMAIL', now);
      await repo.insertToken(connection, employee.legajo, pending.id, 'VERIFICAR_EMAIL', generated, now);
      return { type: current ? 'CHANGE_EMAIL' : 'VERIFY_EMAIL', to: pending.email, token: generated.token };
    }, { transaction: true });
  if (notice) await deliverNotice(notice, context);
  return NEUTRAL_VERIFICATION;
}

/**
 * Confirma registro o cambio de correo según el endpoint; no intercambia ambos propósitos funcionales.
 * @param {string} token Token de un solo uso vinculado a un correo del mismo empleado.
 * @param {boolean} change Si confirma cambio de correo (true) o registro (false).
 * @param {object} context Dependencias y reloj.
 * @returns {Promise<object>} Resultado público; el registro verificado sigue pendiente de aprobación.
 */
export async function confirmAddress(token, change, context) {
  const tokenHash = temporaryHash(token);
  const repo = context.repository;
  const result = await repo.withConnection(context.pool,
    /** Descubre propietario, bloquea empleado, relee token y aplica transición atómica. */
    async (connection) => {
      const candidate = await repo.findToken(connection, tokenHash);
      if (!candidate || candidate.tipo !== 'VERIFICAR_EMAIL') throw invalidToken();
      const employee = await repo.findEmployee(connection, candidate.legajo, true);
      const stored = await repo.findToken(connection, tokenHash, true);
      if (!employee || employee.estado === 'BAJA' || !stored || stored.revoked_at
          || stored.legajo !== employee.legajo || stored.tipo !== 'VERIFICAR_EMAIL') throw invalidToken();
      const emails = await repo.findEmails(connection, employee.legajo, true);
      const target = emails.find((address) => String(address.id) === String(stored.correo_id));
      if (!target) throw invalidToken();
      // La repetición de la verificación inicial es estable, pero no repite cambios ni emite sesión.
      if (!change && stored.consumed_at && target.estado === 'ACTUAL' && employee.estado === 'PENDIENTE') {
        return { code: 'EMAIL_ALREADY_VERIFIED' };
      }
      if (stored.consumed_at || new Date(stored.expires_at) <= context.now() || target.estado !== 'PENDIENTE') throw invalidToken();
      const current = emails.find((address) => address.estado === 'ACTUAL');
      if (Boolean(current) !== change || (change && employee.estado !== 'ACTIVO')) throw invalidToken();
      const now = context.now();
      await repo.confirmEmail(connection, employee.legajo, target.id, now);
      await repo.consumeToken(connection, stored.id, now);
      await repo.audit(connection, employee.legajo, change ? employee.legajo : null,
        change ? 'EMAIL_CAMBIADO' : 'EMAIL_VERIFICADO', 'EMAIL', current?.email ?? null, target.email, now);
      if (change) {
        await repo.revokeSessions(connection, employee.legajo, 'EMAIL_CHANGED', now);
        await repo.revokeTokens(connection, employee.legajo, 'RESET_PASSWORD', now);
      }
      return { code: change ? 'EMAIL_CHANGED' : 'EMAIL_VERIFIED', oldEmail: current?.email, newEmail: target.email };
    }, { transaction: true });
  if (change) {
    await deliverNotice({ type: 'EMAIL_CHANGED', to: result.oldEmail }, context);
    await deliverNotice({ type: 'EMAIL_CHANGED', to: result.newEmail }, context);
  }
  return { code: result.code };
}

/** Solicita recuperación para correo actual verificado de cuenta no dada de baja; siempre responde neutro. */
export async function forgotPassword({ email }, context) {
  const repo = context.repository;
  const normalized = normalizeEmail(email);
  const notice = await repo.withConnection(context.pool,
    /** Vincula un único token al empleado sin cambiar su estado ni su aprobación. */
    async (connection) => {
      const candidate = await repo.findReservedEmail(connection, normalized);
      if (!candidate) return null;
      const employee = await repo.findEmployee(connection, candidate.legajo, true);
      if (!employee || employee.estado === 'BAJA') return null;
      const emails = await repo.findEmails(connection, employee.legajo, true);
      const current = emails.find((address) => address.estado === 'ACTUAL' && address.verificado_at && address.email === normalized);
      if (!current) return null;
      const now = context.now();
      const generated = createTemporaryToken('RESET_PASSWORD', context.security, now);
      await repo.revokeTokens(connection, employee.legajo, 'RESET_PASSWORD', now);
      await repo.insertToken(connection, employee.legajo, null, 'RESET_PASSWORD', generated, now);
      return { type: 'RESET_PASSWORD', to: current.email, token: generated.token };
    }, { transaction: true });
  if (notice) await deliverNotice(notice, context);
  return NEUTRAL_RECOVERY;
}

/** Restablece contraseña y consume token atómicamente; revoca todas las sesiones sin activar la cuenta. */
export async function resetPassword({ token, newPassword }, context) {
  const tokenHash = temporaryHash(token);
  const passwordHash = await hashPassword(newPassword, context.security);
  const repo = context.repository;
  await repo.withConnection(context.pool,
    /** Serializa consumo concurrente por empleado y token antes de cambiar la credencial. */
    async (connection) => {
      const candidate = await repo.findToken(connection, tokenHash);
      if (!candidate || candidate.tipo !== 'RESET_PASSWORD') throw invalidToken();
      const employee = await repo.findEmployee(connection, candidate.legajo, true);
      const stored = await repo.findToken(connection, tokenHash, true);
      if (!employee || employee.estado === 'BAJA' || !stored || stored.tipo !== 'RESET_PASSWORD'
          || stored.legajo !== employee.legajo || stored.consumed_at || stored.revoked_at
          || new Date(stored.expires_at) <= context.now()) throw invalidToken();
      const now = context.now();
      await repo.updatePassword(connection, employee.legajo, passwordHash, now);
      await repo.consumeToken(connection, stored.id, now);
      await repo.revokeTokens(connection, employee.legajo, 'RESET_PASSWORD', now);
      // Un cambio de correo autorizado con la credencial anterior no debe sobrevivir a su recuperación.
      await repo.revokeTokens(connection, employee.legajo, 'VERIFICAR_EMAIL', now);
      await repo.cancelPendingEmails(connection, employee.legajo, now);
      await repo.revokeSessions(connection, employee.legajo, 'PASSWORD_RESET', now);
      await repo.audit(connection, employee.legajo, null, 'PASSWORD_CAMBIADA', 'PASSWORD', null, null, now);
    }, { transaction: true });
  return { code: 'PASSWORD_RESET' };
}

/** Retorna exclusivamente el perfil permitido de la sesión que sigue autorizada. */
export async function getProfile(claims, context) {
  const account = await context.repository.withConnection(context.pool,
    /** Revalida autorización actual sin efectos laterales. */
    (connection) => readAuthorizedAccount(connection, claims, context));
  return { user: publicProfile(account.employee, account.emails) };
}

/** Actualiza datos propios permitidos bajo autorización y bloqueo; no acepta privilegios ni credenciales. */
export async function editProfile(claims, data, context) {
  const repo = context.repository;
  return repo.withConnection(context.pool,
    /** Aplica solo campos personales y devuelve la proyección pública posterior. */
    async (connection) => {
      const { employee, emails } = await readAuthorizedAccount(connection, claims, context, true);
      await repo.updateProfile(connection, employee.legajo, data);
      const updated = await repo.findEmployee(connection, employee.legajo);
      return { user: publicProfile(updated, emails) };
    }, { transaction: true });
}

/** Comprueba contraseña actual fuera del bloqueo; retorna una instantánea para revalidación transaccional. */
async function passwordSnapshot(claims, password, context) {
  const snapshot = await context.repository.withConnection(context.pool,
    /** Recupera únicamente la identidad asociada al sujeto autenticado. */
    (connection) => context.repository.findEmployee(connection, claims.sub));
  if (!snapshot || !await verifyPassword(password, snapshot.password_hash)) {
    throw createAppError('CURRENT_PASSWORD_INVALID', 'La contraseña actual es incorrecta.', 400);
  }
  return snapshot;
}

/** Rechaza operaciones sensibles si otra transacción cambió la contraseña durante bcrypt. */
function assertUnchangedPassword(employee, snapshot) {
  if (employee.password_hash !== snapshot.password_hash) {
    throw createAppError('CREDENTIALS_CHANGED', 'Las credenciales cambiaron. Inicie sesión nuevamente.', 409);
  }
}

/** Cambia contraseña con la actual y revoca sesiones y tokens reset en la misma transacción. */
export async function changePassword(claims, { currentPassword, newPassword }, context) {
  const snapshot = await passwordSnapshot(claims, currentPassword, context);
  const passwordHash = await hashPassword(newPassword, context.security);
  const repo = context.repository;
  await repo.withConnection(context.pool,
    /** Revalida la sesión y credencial bajo bloqueo antes del cambio persistente. */
    async (connection) => {
      const { employee } = await readAuthorizedAccount(connection, claims, context, true);
      assertUnchangedPassword(employee, snapshot);
      const now = context.now();
      await repo.updatePassword(connection, employee.legajo, passwordHash, now);
      await repo.revokeSessions(connection, employee.legajo, 'PASSWORD_CHANGED', now);
      await repo.revokeTokens(connection, employee.legajo, 'RESET_PASSWORD', now);
      await repo.revokeTokens(connection, employee.legajo, 'VERIFICAR_EMAIL', now);
      await repo.cancelPendingEmails(connection, employee.legajo, now);
      await repo.audit(connection, employee.legajo, employee.legajo, 'PASSWORD_CAMBIADA', 'PASSWORD', null, null, now);
    }, { transaction: true });
  return { code: 'PASSWORD_CHANGED' };
}

/** Solicita correo nuevo sin reemplazar el actual; contraseña, reserva y sesión se revalidan bajo bloqueo. */
export async function changeEmail(claims, { email, currentPassword }, context) {
  const snapshot = await passwordSnapshot(claims, currentPassword, context);
  const normalized = normalizeEmail(email);
  const repo = context.repository;
  const generated = createTemporaryToken('VERIFICAR_EMAIL', context.security, context.now());
  await repo.withConnection(context.pool,
    /** Cancela solicitudes anteriores y emite un token ligado al nuevo correo pendiente. */
    async (connection) => {
      const { employee, emails } = await readAuthorizedAccount(connection, claims, context, true);
      assertUnchangedPassword(employee, snapshot);
      if (emails.some((address) => address.estado === 'ACTUAL' && address.email === normalized)) {
        throw createAppError('EMAIL_UNCHANGED', 'El correo nuevo debe ser diferente del actual.', 400);
      }
      const now = context.now();
      await repo.revokeTokens(connection, employee.legajo, 'VERIFICAR_EMAIL', now);
      await repo.cancelPendingEmails(connection, employee.legajo, now);
      const id = await repo.insertEmail(connection, employee.legajo, normalized, now);
      await repo.insertToken(connection, employee.legajo, id, 'VERIFICAR_EMAIL', generated, now);
    }, { transaction: true });
  const sent = await deliverNotice({ type: 'CHANGE_EMAIL', to: normalized, token: generated.token }, context);
  return { code: 'EMAIL_CHANGE_REQUESTED', verificationDelivery: sent ? 'ACCEPTED' : 'RETRY_REQUIRED' };
}

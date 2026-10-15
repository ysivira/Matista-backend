import { randomBytes } from 'node:crypto';
import { hashPassword } from '../../src/infrastructure/security/password.js';
import { signAccessToken } from '../../src/infrastructure/security/jwt.js';
import { securityConfig } from '../helpers/security.js';
import { createAppError } from '../../src/shared/errors/app-error.js';

const fixtureHash = await hashPassword('1234', securityConfig());
export const localEnv = Object.freeze({ NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173' });

/**
 * Construye un doble de repositorio con rollback y datos sintéticos, sin importar drivers ni .env.
 * @param {object} options Opciones seed, estado y rol del único empleado inicial ficticio.
 * @returns {object} Contexto de servicios, estado e incidentes observables por las pruebas.
 */
export function memoryContext({ seed = true, estado = 'ACTIVO', rol = 'ASESOR' } = {}) {
  const now = new Date('2026-10-15T12:00:00Z');
  const state = { employees: [], emails: [], tokens: [], sessions: [], audits: [] };
  const notices = [];
  const incidents = [];
  const calls = [];
  let sequence = 10;
  if (seed) {
    state.employees.push({ legajo: '12345678', nombre: 'Persona', apellido: 'Ficticia', password_hash: fixtureHash,
      rol, estado, password_changed_at: now });
    state.emails.push({ id: 1, legajo: '12345678', email: 'fixture@example.test', estado: 'ACTUAL', verificado_at: now });
  }
  const repository = {
    /** Simula una conexión única por unidad de trabajo y revierte datos ante fallos transaccionales. */
    async withConnection(pool, operation, { transaction = false } = {}) {
      const before = structuredClone(state);
      const connection = { fixture: true };
      try { return await operation(connection); } catch (error) {
        if (transaction) Object.assign(state, before);
        throw error;
      }
    },
    /** Devuelve instantánea para detectar revalidación de credenciales y registra uso de lock. */
    async findEmployee(connection, legajo, lock) {
      calls.push({ method: 'findEmployee', lock, legajo });
      return structuredClone(state.employees.find((employee) => employee.legajo === legajo));
    },
    /** Emula reserva única global de correos actuales o pendientes. */
    async findReservedEmail(connection, email) {
      return structuredClone(state.emails.find((address) => address.email === email && ['ACTUAL', 'PENDIENTE'].includes(address.estado)));
    },
    /** Devuelve solo correos del propietario y copia las filas para no falsear instantáneas. */
    async findEmails(connection, legajo) { return structuredClone(state.emails.filter((address) => address.legajo === legajo)); },
    /** Inserta identidad sintética con valores iniciales fijados por el servidor. */
    async insertEmployee(connection, data, passwordHash, date) {
      if (state.employees.some((employee) => employee.legajo === data.legajo)) {
        throw createAppError('IDENTITY_CONFLICT', 'Conflicto ficticio.', 409);
      }
      const { password, email, ...personal } = data;
      state.employees.push({ ...personal, password_hash: passwordHash, rol: 'ASESOR', estado: 'PENDIENTE', password_changed_at: date });
    },
    /** Inserta correo solo si no está reservado en otra fila vigente. */
    async insertEmail(connection, legajo, email) {
      if (state.emails.some((address) => address.email === email && ['ACTUAL', 'PENDIENTE'].includes(address.estado))) {
        throw createAppError('IDENTITY_CONFLICT', 'Conflicto ficticio.', 409);
      }
      const id = sequence++;
      state.emails.push({ id, legajo, email, estado: 'PENDIENTE', verificado_at: null });
      return id;
    },
    /** Cancela únicamente correos pendientes del propietario. */
    async cancelPendingEmails(connection, legajo) {
      for (const email of state.emails) if (email.legajo === legajo && email.estado === 'PENDIENTE') email.estado = 'CANCELADO';
    },
    /** Emula reemplazo de correo y verificación sin modificar estado del empleado. */
    async confirmEmail(connection, legajo, id, date) {
      for (const email of state.emails) {
        if (email.legajo !== legajo) continue;
        if (email.estado === 'ACTUAL') email.estado = 'ANTERIOR';
        if (String(email.id) === String(id)) { email.estado = 'ACTUAL'; email.verificado_at = date; }
      }
    },
    /** Busca por digest binario y devuelve copia del token interno. */
    async findToken(connection, hash) {
      return structuredClone(state.tokens.find((token) => Buffer.from(token.token_hash).equals(hash)));
    },
    /** Revoca tokens abiertos independientemente de la expiración temporal. */
    async revokeTokens(connection, legajo, type, date) {
      for (const token of state.tokens) {
        if (token.legajo === legajo && token.tipo === type && !token.consumed_at && !token.revoked_at) token.revoked_at = date;
      }
    },
    /** Inserta hash y referencias; comprueba que no quede otro token abierto del mismo tipo. */
    async insertToken(connection, legajo, correoId, type, generated) {
      if (state.tokens.some((token) => token.legajo === legajo && token.tipo === type && !token.consumed_at && !token.revoked_at)) {
        throw new Error('Token abierto duplicado en el doble.');
      }
      state.tokens.push({ id: sequence++, legajo, correo_id: correoId, tipo: type, token_hash: generated.tokenHash,
        expires_at: generated.expiresAt, consumed_at: null, revoked_at: null });
    },
    /** Registra consumo observable de un token ficticio. */
    async consumeToken(connection, id, date) { state.tokens.find((token) => token.id === id).consumed_at = date; },
    /** Guarda jti y tiempos, no guarda JWT. */
    async insertSession(connection, legajo, signed) {
      state.sessions.push({ jti: signed.jti, legajo, issued_at: signed.issuedAt, expires_at: signed.expiresAt, revoked_at: null });
    },
    /** Busca sesión que pertenezca al sujeto presentado. */
    async findSession(connection, jti, legajo) {
      return structuredClone(state.sessions.find((session) => session.jti === jti && session.legajo === legajo));
    },
    /** Revoca una sesión o todas las del empleado, respetando revocaciones anteriores. */
    async revokeSessions(connection, legajo, reason, date, jti) {
      for (const session of state.sessions) {
        if (session.legajo === legajo && !session.revoked_at && (!jti || session.jti === jti)) {
          session.revoked_at = date; session.revocation_reason = reason;
        }
      }
    },
    /** Cambia hash y fecha del empleado sintético. */
    async updatePassword(connection, legajo, passwordHash, date) {
      Object.assign(state.employees.find((employee) => employee.legajo === legajo), { password_hash: passwordHash, password_changed_at: date });
    },
    /** Actualiza datos que ya fueron filtrados por validadores HTTP en las pruebas. */
    async updateProfile(connection, legajo, data) { Object.assign(state.employees.find((employee) => employee.legajo === legajo), data); },
    /** Conserva auditoría sintética para comprobar que no se registren contraseñas o tokens. */
    async audit(connection, legajo, actor, event, field, previous, next, date) {
      state.audits.push({ legajo, actor, event, field, previous, next, date });
    },
  };
  const context = { repository, pool: {}, security: securityConfig(), dummyPasswordHash: fixtureHash,
    /** Devuelve copia del reloj controlado para impedir mutación accidental. */
    now: () => new Date(now),
    /** Captura correo exclusivamente en memoria; jamás usa SMTP. */
    async notify(notice) { notices.push({ ...notice }); },
    /** Captura únicamente códigos de incidentes para comprobar respuestas neutras. */
    reportIncident(incident) { incidents.push(incident); },
  };
  return { context, state, notices, incidents, calls };
}

/** Genera sesión ficticia usando el JWT real de B para pruebas de autorización y HTTP. */
export async function fixtureSession(fixture, legajo = '12345678') {
  const signed = await signAccessToken({ legajo }, fixture.context.security, fixture.context.now());
  await fixture.context.repository.insertSession({}, legajo, signed);
  return signed;
}

/** Devuelve datos de registro sintéticos; permite cambiar campos para casos de validación. */
export function registration(overrides = {}) {
  return { legajo: '22345678', nombre: 'Persona', apellido: 'Prueba',
    email: `fixture-${randomBytes(4).toString('hex')}@example.test`, password: '1234', ...overrides };
}

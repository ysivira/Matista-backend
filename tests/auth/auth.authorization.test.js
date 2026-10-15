import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signAccessToken } from '../../src/infrastructure/security/jwt.js';
import { authenticateToken, logout, login, changePassword } from '../../src/modules/auth/auth.service.js';
import { authorize } from '../../src/shared/middleware/authorize.js';
import { memoryContext, fixtureSession } from './fixtures.js';

/** Un JWT real firmado no basta: todas las condiciones de sesión y cuenta se vuelven a consultar. */
test('rechaza sesión ausente, revocada, vencida, sub ajeno y correo sin verificar', async () => {
  for (const condition of ['missing', 'revoked', 'expired', 'wrong-owner', 'unverified', 'wrong-times']) {
    const f = memoryContext();
    const signed = await fixtureSession(f);
    if (condition === 'missing') f.state.sessions.length = 0;
    if (condition === 'revoked') f.state.sessions[0].revoked_at = f.context.now();
    if (condition === 'expired') f.state.sessions[0].expires_at = new Date('2026-10-15T11:00:00Z');
    if (condition === 'wrong-owner') f.state.sessions[0].legajo = '87654321';
    if (condition === 'unverified') f.state.emails[0].verificado_at = null;
    if (condition === 'wrong-times') f.state.sessions[0].issued_at = new Date('2026-10-15T11:59:59Z');
    await assert.rejects(authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
  }
});

/** La desactivación/baja y desaparición de identidad bloquean solicitudes aun con sesión no revocada. */
test('consulta estado y rol actuales, no claims informativos ni estado cacheado', async () => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  for (const estado of ['INACTIVO', 'BAJA', 'PENDIENTE']) {
    f.state.employees[0].estado = estado;
    await assert.rejects(authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
  }
  f.state.employees[0].estado = 'ACTIVO';
  f.state.employees[0].rol = 'ADMIN';
  assert.equal((await authenticateToken(signed.token, f.context)).user.rol, 'ADMIN');
  f.state.employees[0].rol = 'SUPERVISOR';
  await assert.rejects(authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
  f.state.employees.length = 0;
  await assert.rejects(authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
});

/** Verifica 401/403 sin crear rutas o funcionalidades administrativas. */
test('authorize exige identidad autenticada y el rol consultado', () => {
  const middleware = authorize('ADMIN');
  let result;
  middleware({}, {}, (error) => { result = error; });
  assert.equal(result.status, 401);
  middleware({ auth: { user: { rol: 'ASESOR' } } }, {}, (error) => { result = error; });
  assert.equal(result.status, 403);
  middleware({ auth: { user: { rol: 'ADMIN' } } }, {}, (error) => { result = error; });
  assert.equal(result, undefined);
});

/** Logout es idempotente, afecta solo un jti y no depende de que la cuenta siga activa. */
test('logout revoca solo sesión actual incluso tras desactivación', async () => {
  const f = memoryContext();
  const first = await fixtureSession(f);
  const second = await fixtureSession(f);
  f.state.employees[0].estado = 'INACTIVO';
  await logout(first.token, f.context);
  await logout(first.token, f.context);
  await logout('invalid', f.context);
  assert.ok(f.state.sessions[0].revoked_at);
  assert.equal(f.state.sessions[1].jti, second.jti);
  assert.equal(f.state.sessions[1].revoked_at, null);
});

/** Revalida estado y hash después de bcrypt para impedir emisión posterior a cambios concurrentes. */
test('login no emite sesión si la identidad cambia durante la comprobación', async () => {
  const f = memoryContext();
  const original = f.context.repository.findEmployee;
  f.context.repository.findEmployee = async (connection, legajo, lock) => {
    if (lock) f.state.employees[0].estado = 'INACTIVO';
    return original(connection, legajo, lock);
  };
  await assert.rejects(login({ email: 'fixture@example.test', password: '1234' }, f.context), { code: 'ACCOUNT_NOT_ACTIVE' });
  assert.equal(f.state.sessions.length, 0);
  f.context.repository.findEmployee = async (connection, legajo, lock) => {
    if (lock) f.state.employees[0].password_hash = 'changed-hash-fixture';
    return original(connection, legajo, lock);
  };
  await assert.rejects(login({ email: 'fixture@example.test', password: '1234' }, f.context), { code: 'INVALID_CREDENTIALS' });
});

/** Revalida sesión y contraseña actual dentro de la transacción de cambio de credencial. */
test('no aplica un cambio de contraseña autorizado con una instantánea obsoleta', async () => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  const { claims } = await authenticateToken(signed.token, f.context);
  const original = f.context.repository.findEmployee;
  f.context.repository.findEmployee = async (connection, legajo, lock) => {
    if (lock) f.state.employees[0].password_hash = 'changed-hash-fixture';
    return original(connection, legajo, lock);
  };
  await assert.rejects(changePassword(claims, { currentPassword: '1234', newPassword: '5678' }, f.context), { code: 'CREDENTIALS_CHANGED' });
});

/** Firma un JWT válido no persistido y comprueba también rechazo criptográfico al vencer. */
test('un JWT firmado sin sesión persistida nunca autoriza', async () => {
  const f = memoryContext();
  const signed = await signAccessToken({ legajo: '12345678' }, f.context.security, f.context.now());
  await assert.rejects(authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
  f.context.now = () => signed.expiresAt;
  await assert.rejects(authenticateToken(signed.token, f.context), { code: 'ACCESS_TOKEN_INVALID' });
});

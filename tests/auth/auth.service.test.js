import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyPassword } from '../../src/infrastructure/security/password.js';
import { createTemporaryToken, hashTemporaryToken } from '../../src/infrastructure/security/token.js';
import * as service from '../../src/modules/auth/auth.service.js';
import { memoryContext, fixtureSession, registration } from './fixtures.js';

/** Comprueba registro, hash, confirmación y separación entre verificación y aprobación. */
test('registra ASESOR pendiente, verifica sin activar y no emite sesión antes de aprobación', async () => {
  const f = memoryContext({ seed: false });
  const data = registration({ email: '  REGISTRO@example.test ' });
  assert.equal((await service.register(data, f.context)).code, 'ACCOUNT_REGISTERED');
  assert.equal(f.state.employees[0].rol, 'ASESOR');
  assert.equal(f.state.employees[0].estado, 'PENDIENTE');
  assert.equal(f.state.emails[0].email, 'registro@example.test');
  assert.equal(await verifyPassword('1234', f.state.employees[0].password_hash), true);
  assert.equal(f.state.tokens[0].token_hash.length, 32);
  const token = f.notices[0].token;
  assert.equal(JSON.stringify(f.state).includes(token), false);
  assert.equal((await service.confirmAddress(token, false, f.context)).code, 'EMAIL_VERIFIED');
  assert.equal((await service.confirmAddress(token, false, f.context)).code, 'EMAIL_ALREADY_VERIFIED');
  assert.equal(f.state.audits.filter((audit) => audit.event === 'EMAIL_VERIFICADO').length, 1);
  await assert.rejects(service.login({ email: 'registro@example.test', password: '1234' }, f.context), { code: 'ACCOUNT_PENDING_APPROVAL' });
  assert.equal(f.state.sessions.length, 0);
});

/** Emula rollback ante duplicidad y conserva estado recuperable si el proveedor de correo falla. */
test('revierte registro duplicado y permite reenvío tras fallo SMTP', async () => {
  const f = memoryContext();
  await assert.rejects(service.register(registration({ email: 'fixture@example.test' }), f.context), { code: 'IDENTITY_CONFLICT' });
  assert.equal(f.state.employees.length, 1);
  const capture = f.context.notify;
  f.context.notify = async () => { throw new Error('Detalle SMTP que no debe salir.'); };
  const data = registration();
  assert.equal((await service.register(data, f.context)).verificationDelivery, 'RETRY_REQUIRED');
  assert.equal(f.incidents[0].code, 'AUTH_EMAIL_FAILED');
  const previous = f.state.tokens[0];
  previous.expires_at = new Date('2026-10-14T00:00:00Z');
  f.context.notify = capture;
  await service.resendVerification({ email: data.email }, f.context);
  assert.ok(previous.revoked_at);
  assert.equal(f.state.tokens.filter((token) => !token.revoked_at && !token.consumed_at).length, 1);
});

/** Comprueba que tokens revocados, vencidos, de propósito incorrecto o de otro propietario no cambien datos. */
test('rechaza tokens auxiliares inválidos y vinculaciones de correo ajenas', async () => {
  const f = memoryContext({ seed: false });
  await service.register(registration(), f.context);
  const token = f.notices[0].token;
  const stored = f.state.tokens[0];
  stored.revoked_at = f.context.now();
  await assert.rejects(service.confirmAddress(token, false, f.context), { code: 'TOKEN_INVALID' });
  f.state.tokens[0].revoked_at = null;
  f.state.tokens[0].expires_at = new Date('2026-10-15T11:59:59Z');
  await assert.rejects(service.confirmAddress(token, false, f.context), { code: 'TOKEN_INVALID' });
  f.state.tokens[0].expires_at = new Date('2026-10-16T12:00:00Z');
  f.state.tokens[0].correo_id = 9999;
  await assert.rejects(service.confirmAddress(token, false, f.context), { code: 'TOKEN_INVALID' });
  await assert.rejects(service.confirmAddress('mal-formado', false, f.context), { code: 'TOKEN_INVALID' });
  assert.equal(f.state.emails[0].estado, 'PENDIENTE');
  assert.equal(f.state.audits.length, 1);
});

/** Mantiene neutra recuperación, incluso en fallo SMTP, sin modificar estado de cuenta. */
test('recuperación neutra, consumo único y revocación de sesiones al restablecer contraseña', async () => {
  const f = memoryContext();
  await fixtureSession(f);
  const unknown = await service.forgotPassword({ email: 'desconocido@example.test' }, f.context);
  assert.deepEqual(await service.forgotPassword({ email: 'fixture@example.test' }, f.context), unknown);
  const token = f.notices[0].token;
  assert.equal((await service.resetPassword({ token, newPassword: '5678' }, f.context)).code, 'PASSWORD_RESET');
  assert.equal(await verifyPassword('5678', f.state.employees[0].password_hash), true);
  assert.ok(f.state.sessions[0].revoked_at);
  assert.equal(f.state.employees[0].estado, 'ACTIVO');
  const audit = f.state.audits[0];
  assert.equal(audit.previous, null);
  assert.equal(audit.next, null);
  await assert.rejects(service.resetPassword({ token, newPassword: '9012' }, f.context), { code: 'TOKEN_INVALID' });
  f.context.notify = async () => { throw new Error('Detalle privado.'); };
  assert.deepEqual(await service.forgotPassword({ email: 'fixture@example.test' }, f.context), unknown);
  assert.equal(f.incidents.length, 1);
});

/** Conserva correo actual y sesión hasta confirmar mediante el endpoint de propósito correcto. */
test('cambio de correo es atómico, de un solo uso y revoca sesiones y tokens reset', async () => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  const { claims } = await service.authenticateToken(signed.token, f.context);
  await service.forgotPassword({ email: 'fixture@example.test' }, f.context);
  const response = await service.changeEmail(claims, { email: 'nuevo@example.test', currentPassword: '1234' }, f.context);
  assert.equal(response.code, 'EMAIL_CHANGE_REQUESTED');
  assert.equal(f.state.emails[0].estado, 'ACTUAL');
  assert.equal(f.state.sessions[0].revoked_at, null);
  const token = f.notices.find((notice) => notice.type === 'CHANGE_EMAIL').token;
  await assert.rejects(service.confirmAddress(token, false, f.context), { code: 'TOKEN_INVALID' });
  await assert.rejects(service.login({ email: 'nuevo@example.test', password: '1234' }, f.context), { code: 'INVALID_CREDENTIALS' });
  assert.equal((await service.confirmAddress(token, true, f.context)).code, 'EMAIL_CHANGED');
  assert.equal(f.state.emails[0].estado, 'ANTERIOR');
  assert.equal(f.state.emails[1].estado, 'ACTUAL');
  assert.ok(f.state.sessions[0].revoked_at);
  assert.ok(f.state.tokens.find((stored) => stored.tipo === 'RESET_PASSWORD').revoked_at);
  await assert.rejects(service.confirmAddress(token, true, f.context), { code: 'TOKEN_INVALID' });
  await assert.rejects(service.authenticateToken(signed.token, f.context), { code: 'SESSION_INVALID' });
  assert.equal(f.notices.filter((notice) => notice.type === 'EMAIL_CHANGED').length, 2);
});

/** Verifica contraseña actual, proyección segura, cambios persistentes y cierre de todas las sesiones. */
test('perfil propio y cambio de contraseña no permiten exponer credenciales', async () => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  const { claims } = await service.authenticateToken(signed.token, f.context);
  const changed = await service.editProfile(claims, { telefono: '11111111', segundo_nombre: null }, f.context);
  assert.equal(changed.user.telefono, '11111111');
  assert.equal(Object.hasOwn(changed.user, 'password_hash'), false);
  await assert.rejects(service.changePassword(claims, { currentPassword: '0000', newPassword: '5678' }, f.context), { code: 'CURRENT_PASSWORD_INVALID' });
  await service.changePassword(claims, { currentPassword: '1234', newPassword: '5678' }, f.context);
  assert.equal(await verifyPassword('5678', f.state.employees[0].password_hash), true);
  await assert.rejects(service.getProfile(claims, f.context), { code: 'SESSION_INVALID' });
});

/** El propósito reset no puede confundirse con confirmación y la baja lógica no recupera acceso. */
test('tokens de otro propósito y cuentas de baja no se habilitan', async () => {
  const f = memoryContext({ estado: 'BAJA' });
  assert.deepEqual(await service.forgotPassword({ email: 'fixture@example.test' }, f.context),
    await service.forgotPassword({ email: 'no@example.test' }, f.context));
  assert.equal(f.notices.length, 0);
  const generated = createTemporaryToken('RESET_PASSWORD', f.context.security, f.context.now());
  await f.context.repository.insertToken({}, '12345678', null, 'RESET_PASSWORD', generated);
  assert.deepEqual(hashTemporaryToken(generated.token), generated.tokenHash);
  await assert.rejects(service.confirmAddress(generated.token, false, f.context), { code: 'TOKEN_INVALID' });
  await assert.rejects(service.resetPassword({ token: generated.token, newPassword: '5678' }, f.context), { code: 'TOKEN_INVALID' });
});

/** Impide confirmar un cambio de correo solicitado con credenciales que después fueron recuperadas. */
test('rotar contraseña cancela cambios de correo pendientes y no permite revivirlos mediante reenvío', async () => {
  const f = memoryContext();
  const signed = await fixtureSession(f);
  const { claims } = await service.authenticateToken(signed.token, f.context);
  await service.changeEmail(claims, { email: 'pendiente@example.test', currentPassword: '1234' }, f.context);
  const emailToken = f.notices[0].token;
  await service.forgotPassword({ email: 'fixture@example.test' }, f.context);
  const resetToken = f.notices.find((notice) => notice.type === 'RESET_PASSWORD').token;
  await service.resetPassword({ token: resetToken, newPassword: '5678' }, f.context);
  await assert.rejects(service.confirmAddress(emailToken, true, f.context), { code: 'TOKEN_INVALID' });
  const count = f.notices.length;
  await service.resendVerification({ email: 'pendiente@example.test' }, f.context);
  assert.equal(f.notices.length, count);
  assert.equal(f.state.emails[0].estado, 'ACTUAL');
  assert.equal(f.state.emails[1].estado, 'CANCELADO');
});

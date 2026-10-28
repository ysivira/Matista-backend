/**
 * ============================================================
 * MATISTA | CONTROLADORES DE CUENTA
 * ============================================================
 *
 * Archivo: auth.controller.js
 * Módulo: Autenticación
 *
 * Responsabilidad:
 * Adaptar datos validados a los servicios de cuenta y perfil,
 * emitir o eliminar cookies y devolver respuestas públicas.
 *
 * ============================================================
 */
import { matchedData } from 'express-validator';
import * as service from './auth.service.js';
import { AUTH_COOKIE_NAME } from './auth.constants.js';

/**
 * Extrae solo datos validados, conservando null explícito sin introducir campos opcionales
 * ausentes.
 * @param {object} req Solicitud procesada por express-validator.
 * @returns {object} Entrada pública filtrada; permite borrar datos opcionales mediante PATCH.
 */
function validatedInput(req) {
  const data = matchedData(req, {
    includeOptionals: true
  });
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

/** Elimina cookie con el mismo nombre, path y opciones de seguridad usados al emitirla. */
function clearSessionCookie(req, res) {
  res.clearCookie(AUTH_COOKIE_NAME, req.authHttp.cookie);
}

/** Registra datos validados; retorna HTTP 201 sin credenciales ni tokens. */
export async function register(req, res) {
  res.status(201).json(await service.register(validatedInput(req), req.authContext));
}

/** Emite cookie de sesión de duración no mayor al JWT y devuelve solo perfil público. */
export async function login(req, res) {
  const signed = await service.login(validatedInput(req), req.authContext);
  res.cookie(AUTH_COOKIE_NAME, signed.token, {
    ...req.authHttp.cookie,
    maxAge: Math.max(0, signed.expiresAt.getTime() - req.authContext.now().getTime())
  });
  res.json({
    user: signed.user
  });
}

/** Revoca el jti presentado si sigue siendo verificable, elimina cookie y retorna HTTP 204 idempotente. */
export async function logout(req, res) {
  await service.logout(req.cookies?.[AUTH_COOKIE_NAME], req.authContext);
  clearSessionCookie(req, res);
  res.status(204).end();
}

/** Confirma correo del registro sin activar la cuenta ni emitir cookie. */
export async function verifyEmail(req, res) {
  res.json(await service.confirmAddress(validatedInput(req).token, false, req.authContext));
}

/** Confirma cambio mediante token de un solo uso y elimina la cookie de sesiones revocadas. */
export async function confirmEmailChange(req, res) {
  const result = await service.confirmAddress(validatedInput(req).token, true, req.authContext);
  clearSessionCookie(req, res);
  res.json(result);
}

/** Solicita reenvío con respuesta neutra y sin incluir información SMTP. */
export async function resendVerification(req, res) {
  res.json(await service.resendVerification(validatedInput(req), req.authContext));
}

/** Solicita recuperación manteniendo igual respuesta para correos desconocidos o no elegibles. */
export async function forgotPassword(req, res) {
  res.json(await service.forgotPassword(validatedInput(req), req.authContext));
}

/** Restablece contraseña y elimina cookie porque las sesiones anteriores se revocan. */
export async function resetPassword(req, res) {
  const result = await service.resetPassword(validatedInput(req), req.authContext);
  clearSessionCookie(req, res);
  res.json(result);
}

/** Devuelve perfil propio seguro utilizando el sujeto autenticado, nunca un DNI del cuerpo. */
export async function getProfile(req, res) {
  res.json(await service.getProfile(req.auth.claims, req.authContext));
}

/** Actualiza solo datos personales validados del sujeto autenticado. */
export async function editProfile(req, res) {
  res.json(await service.editProfile(req.auth.claims, validatedInput(req), req.authContext));
}

/** Cambia contraseña con la actual, cierra sesiones y elimina cookie. */
export async function changePassword(req, res) {
  const result = await service.changePassword(
    req.auth.claims,
    validatedInput(req),
    req.authContext
  );
  clearSessionCookie(req, res);
  res.json(result);
}

/** Inicia cambio de correo sin sustituir ni cerrar prematuramente la sesión actual. */
export async function changeEmail(req, res) {
  res.json(await service.changeEmail(req.auth.claims, validatedInput(req), req.authContext));
}

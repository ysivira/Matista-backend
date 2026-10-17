import nodemailer from 'nodemailer';
import { createAppError } from '../../shared/errors/app-error.js';

/**
 * Adapta el transporte Nodemailer de SIGEC a configuración propia de MATISTA.
 * No abre conexión SMTP hasta enviar y no carga archivos .env al importar.
 * @param {object} env Variables SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER y SMTP_PASSWORD.
 * @returns {object} Transporte Nodemailer reutilizable, sin plantillas ni reglas funcionales.
 * @throws {Error} Si falta configuración o los parámetros no son válidos.
 */
export function createEmailTransport(env = process.env) {
  const port = Number(env.SMTP_PORT);
  if (!env.SMTP_HOST?.trim() || !Number.isInteger(port) || port < 1 || port > 65535
      || !['true', 'false'].includes(env.SMTP_SECURE)
      || !env.SMTP_USER?.trim() || !env.SMTP_PASSWORD) {
    throw new Error('Configuración SMTP incompleta o inválida.');
  }
  return nodemailer.createTransport({
    host: env.SMTP_HOST.trim(), port, secure: env.SMTP_SECURE === 'true',
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    // En STARTTLS se exige cifrado antes de autenticar; nunca se desactiva la validación TLS.
    requireTLS: env.SMTP_SECURE === 'false',
  });
}

/**
 * Envía un mensaje usando el patrón sendMail/try-catch adaptado de SIGEC.
 * @param {object} message Destinatario, asunto, cuerpo text/html y adjuntos opcionales del llamador.
 * @param {object} options Transporte sustituible y remitente SMTP_FROM configurado por entorno.
 * @returns {Promise<object>} Identificador y aceptación SMTP, no confirmación de entrega final.
 * @throws {Error} EMAIL_SEND_FAILED si SMTP falla o rechaza la entrega; sin datos del proveedor.
 */
export async function sendEmail({ to, subject, text, html, attachments }, {
  transport, from = process.env.SMTP_FROM,
}) {
  if (!transport || typeof transport.sendMail !== 'function' || !from
      || typeof to !== 'string' || !to || typeof subject !== 'string' || !subject
      || (!text && !html)) {
    throw new Error('Mensaje o transporte de correo incompleto.');
  }
  // El payload conserva la misma forma de siempre; los adjuntos CID de la plantilla
  // AUTH se agregan únicamente cuando el llamador los suministra explícitamente.
  const payload = { from, to, subject, text, html };
  if (Array.isArray(attachments) && attachments.length > 0) {
    payload.attachments = attachments;
  }
  try {
    const info = await transport.sendMail(payload);
    if (info.rejected?.length || !info.accepted?.length) {
      throw new Error('Entrega rechazada.');
    }
    return { messageId: info.messageId, accepted: true };
  } catch {
    // El error SMTP original puede incluir credenciales, destinatarios o contenido del mensaje.
    throw createAppError('EMAIL_SEND_FAILED', 'No se pudo enviar el correo. Intente nuevamente.', 503);
  }
}

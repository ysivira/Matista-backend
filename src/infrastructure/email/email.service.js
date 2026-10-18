import nodemailer from 'nodemailer';
import { createAppError } from '../../shared/errors/app-error.js';

/**
 * Adapta el transporte Nodemailer de SIGEC a configuración propia de MATISTA.
 * No abre conexión SMTP hasta enviar (pool de conexiones bajo demanda) y no carga
 * archivos .env al importar.
 * @param {object} env Variables SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER y SMTP_PASSWORD.
 * @returns {object} Transporte Nodemailer reutilizable con pool y tiempos acotados.
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
    // Pool por proceso: la conexión TCP/TLS existente se reutiliza para varios mensajes
    // y se libera tras el período de inactividad de Nodemailer; no abre conexiones
    // hasta el primer sendMail y no multiplica handshakes por cada aviso AUTH.
    pool: true,
    maxConnections: 2,
    maxMessages: 10,
    // Acota los cuelgues ante un relay degradado sin alterar credenciales ni la
    // seguridad TLS; valores inferiores a los predeterminados (120 s / 30 s / 600 s).
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

/** Transporte compartido de A/B: singleton perezoso por proceso reutilizado entre avisos. */
let sharedTransport;

/**
 * Retorna el transporte compartido, creándolo perezosamente al primer envío y
 * reutilizándolo en los siguientes; la configuración inválida falla como hasta
 * ahora dentro del envío, no durante el arranque del servicio.
 * @param {object} env Variables SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER y SMTP_PASSWORD.
 * @returns {object} Transporte Nodemailer con pool reutilizable.
 */
export function getEmailTransport(env = process.env) {
  sharedTransport ??= createEmailTransport(env);
  return sharedTransport;
}

/**
 * Cierra y olvida el transporte compartido para el apagado ordenado del proceso;
 * es seguro invocarlo sin transporte previo y no toca transportes inyectados.
 * @returns {void}
 */
export function closeSharedEmailTransport() {
  try { sharedTransport?.close(); } finally { sharedTransport = undefined; }
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

import { createEmailTransport, sendEmail } from '../../infrastructure/email/email.service.js';

/**
 * Compone mensajes AUTH de texto con enlaces frontend y usa el transporte existente de B.
 * @param {object} notice Tipo, destinatario y token opcional; no se registran sus valores.
 * @param {object} context Origen frontend, entorno SMTP y transporte opcional inyectado.
 * @returns {Promise<object>} Aceptación SMTP del servicio existente.
 * @throws {Error} Error seguro del transporte de B ante fallo de entrega.
 */
export async function sendAuthNotice({ type, to, token }, { origin, env, transport }) {
  const paths = {
    VERIFY_EMAIL: '/confirm-email', CHANGE_EMAIL: '/confirm-email-change', RESET_PASSWORD: '/reset-password',
  };
  const subjects = {
    VERIFY_EMAIL: 'Verifique su correo en MATISTA',
    CHANGE_EMAIL: 'Confirme su nuevo correo en MATISTA',
    RESET_PASSWORD: 'Recuperación de acceso a MATISTA',
    EMAIL_CHANGED: 'Su correo de MATISTA ha cambiado',
  };
  // El fragmento no se envía en peticiones HTTP al servidor de la futura interfaz.
  const text = type === 'EMAIL_CHANGED'
    ? 'El correo de su cuenta MATISTA ha cambiado. Las sesiones anteriores fueron cerradas.'
    : `Para continuar en MATISTA abra: ${origin}${paths[type]}#token=${encodeURIComponent(token)}`;
  return sendEmail({ to, subject: subjects[type], text }, {
    transport: transport ?? createEmailTransport(env), from: env.SMTP_FROM,
  });
}

/**
 * Prepara los avisos de cuenta y los delega al servicio de correo.
 */
import { getEmailTransport, sendEmail } from '../../infrastructure/email/email.service.js';
import { buildAuthEmail, MATISTA_LOGO_ATTACHMENT } from './auth.email.template.js';

/**
 * Compone mensajes AUTH con la plantilla compartida Amethyst Prism y usa el transporte
 * compartido de A/B. El aviso incluye la versión text (regla vigente conservada) y el
 * HTML con logotipo vía CID. El transporte compartido se reutiliza entre avisos del
 * mismo proceso: un solo pool perezoso evita repetir TCP+TLS en cada notificación.
 * @param {object} notice Tipo, destinatario y token opcional; no se registran sus valores.
 * @param {object} context Origen frontend, entorno SMTP y transporte opcional inyectado.
 * @returns {Promise<object>} Aceptación SMTP del servicio existente.
 * @throws {Error} Error seguro del transporte de B ante fallo de entrega.
 */
export async function sendAuthNotice({ type, to, token }, { origin, env, transport }) {
  const paths = {
    VERIFY_EMAIL: '/confirm-email',
    CHANGE_EMAIL: '/confirm-email-change',
    RESET_PASSWORD: '/reset-password'
  };
  const subjects = {
    VERIFY_EMAIL: 'Verifique su correo en MATISTA',
    CHANGE_EMAIL: 'Confirme su nuevo correo en MATISTA',
    RESET_PASSWORD: 'Recuperación de acceso a MATISTA',
    EMAIL_CHANGED: 'Su correo de MATISTA ha cambiado'
  };
  // El fragmento no se envía en peticiones HTTP al servidor de la futura interfaz;
  // la versión text permanece exactamente igual a la original de X-8.
  const text =
    type === 'EMAIL_CHANGED'
      ? 'El correo de su cuenta MATISTA ha cambiado. Las sesiones anteriores fueron cerradas.'
      : `Para continuar en MATISTA abra: ${origin}${paths[type]}#token=${encodeURIComponent(token)}`;
  // El token del flujo real nunca se registra; aquí solo compone los cuerpos del mensaje.
  const html = buildAuthEmail(type, {
    origin,
    token
  });
  return sendEmail(
    {
      to,
      subject: subjects[type],
      text,
      html,
      attachments: [MATISTA_LOGO_ATTACHMENT]
    },
    {
      // El transporte inyectado tiene prioridad (pruebas); en producción reutiliza el pool
      // compartido.
      transport: transport ?? getEmailTransport(env),
      from: env.SMTP_FROM
    }
  );
}

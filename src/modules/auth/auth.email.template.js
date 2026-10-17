import { fileURLToPath } from 'node:url';

/**
 * Tokens de identidad visual Amethyst Prism, definidos como constantes porque los
 * clientes de correo solo aceptan estilos inline y contenido totalmente estático.
 */
const PRISM = Object.freeze({
  shell: '#1B1D2B',
  surface: '#F5F2FF',
  border: '#DCD6E9',
  primary: '#8B5CF6',
  text: '#202236',
  muted: '#5F6375',
});

/** Identificador CID estable del logotipo oficial embebido en todos los avisos AUTH. */
export const MATISTA_LOGO_CID = 'matista-logo';

/**
 * Adjunto inline del logotipo oficial del login MATISTA (copia íntegra del recurso del
 * frontend, verificada por hash); nodemailer lo referencia mediante src="cid:" del encabezado.
 */
export const MATISTA_LOGO_ATTACHMENT = Object.freeze({
  filename: 'matista-logo.png',
  path: fileURLToPath(new URL('../../assets/brand/logo.png', import.meta.url)),
  contentType: 'image/png',
  cid: MATISTA_LOGO_CID,
  contentDisposition: 'inline',
});

/** Tipografía pila compatible con Gmail y Outlook; Arial es la opción más segura. */
const FONT_STACK = 'Arial, Helvetica, sans-serif';

/** Estilo tipográfico reutilizado entre párrafos del cuerpo y del pie. */
const TEXT_BODY = `color:${PRISM.text};font-family:${FONT_STACK};font-size:15px;line-height:1.6;`;
const TEXT_SMALL = `color:${PRISM.muted};font-family:${FONT_STACK};font-size:13px;line-height:1.5;`;

/**
 * Escapa caracteres especiales de HTML para el contenido dinámico (origen y token).
 * @param {string} value Texto sin confianza insertado en atributos o nodos HTML.
 * @returns {string} Texto seguro para el cuerpo del mensaje.
 */
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Presentación por tipo de aviso: títulos, textos, botón y vigencia ya conformados.
 * Los enlaces se completan con el origen HTTP y el token temporal del flujo real.
 * Excepción: EMAIL_CHANGED no lleva botón, enlace alternativo ni vigencia de token.
 */
const MESSAGE_PRESENTATION = Object.freeze({
  VERIFY_EMAIL: Object.freeze({
    title: 'Verificación de cuenta',
    intro: 'Para verificar su correo y terminar de crear su cuenta en MATISTA, utilice el botón incluido en este mensaje.',
    buttonLabel: 'Verificar mi correo',
    altLink: 'Si el botón no funciona en su cliente de correo, abra este enlace:',
    validity: 'El enlace de verificación es válido durante 24 horas y puede utilizarse una sola vez.',
    note: 'Si usted no creó esta cuenta, ignore y elimine este mensaje: no se realizará ninguna otra acción.',
    path: '/confirm-email',
  }),
  RESET_PASSWORD: Object.freeze({
    title: 'Recuperación de acceso',
    intro: 'Recibimos una solicitud para restablecer la contraseña de su cuenta en MATISTA.',
    buttonLabel: 'Restablecer mi contraseña',
    altLink: 'Si el botón no funciona en su cliente de correo, abra este enlace:',
    validity: 'El enlace de recuperación es válido durante 30 minutos y puede utilizarse una sola vez.',
    note: 'Si usted no solicitó recuperar el acceso, ignore este mensaje: su contraseña actual no fue modificada.',
    path: '/reset-password',
  }),
  CHANGE_EMAIL: Object.freeze({
    title: 'Confirmación de nuevo correo',
    intro: 'Para confirmar su nuevo correo en MATISTA y deshabilitar el anterior, utilice el botón incluido en este mensaje.',
    buttonLabel: 'Confirmar mi nuevo correo',
    altLink: 'Si el botón no funciona en su cliente de correo, abra este enlace:',
    validity: 'El enlace de confirmación es válido durante 24 horas y puede utilizarse una sola vez.',
    note: 'El cambio del correo se hace efectivo solo cuando usted lo confirma mediante este enlace.',
    path: '/confirm-email-change',
  }),
  EMAIL_CHANGED: Object.freeze({
    title: 'Cambio de correo confirmado',
    intro: 'El correo de su cuenta MATISTA ha cambiado y las sesiones anteriores del sistema fueron cerradas.',
    buttonLabel: null,
    altLink: null,
    validity: null,
    note: 'Si usted no reconoce este cambio, comuníquese de inmediato con el administrador de MATISTA.',
    path: null,
  }),
});

/**
 * Encabezado documental de la tarjeta: logotipo oficial embebido mediante CID estable.
 * La banda usa el fondo oscuro del shell (igual que el login) porque el recurso oficial
 * lleva el texto en tono claro y se vuelve ilegible sobre la tarjeta clara.
 * @returns {string} Fila confiable para la tabla de la tarjeta.
 */
function logoHeader() {
  return `<tr><td align="center" style="padding:28px 24px 20px;background:${PRISM.shell};">`
    + `<img src="cid:${MATISTA_LOGO_CID}" alt="MATISTA, Plataforma de Gestión Comercial" `
    + 'width="150" height="75" border="0" style="display:block;width:150px;height:auto;'
    + 'max-width:100%;border:0;" /></td></tr>';
}

/**
 * Cuerpo tipográfico: título, párrafos, botón y avisos de seguridad cuando aplican.
 * @param {object} presentation Contenido textual del tipo de aviso.
 * @param {string|null} flaggedUrl Enlace absoluto del botón y del texto alternativo.
 * @returns {string} Cuerpo HTML con estilos inline totalmente estáticos.
 */
function bodyContent(presentation, flaggedUrl) {
  let body = `<tr><td style="padding:12px 24px 28px;${TEXT_BODY}">`
    + `<h1 style="margin:12px 0 10px;font-size:22px;line-height:1.3;color:${PRISM.text};">`
    + `${escapeHtml(presentation.title)}</h1>`
    + `<p style="margin:0 0 18px;">${escapeHtml(presentation.intro)}</p>`;

  if (presentation.buttonLabel && flaggedUrl) {
    const buttonStyle = `border-radius:10px;background:${PRISM.primary};color:#FFFFFF;`
      + `font-family:${FONT_STACK};font-size:15px;font-weight:bold;`
      + 'padding:13px 26px;text-decoration:none;';
    body += '<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 16px;">'
      + '<tr><td style="border-radius:10px;'
      + `background:${PRISM.primary};">`
      + `<a href="${escapeHtml(flaggedUrl)}" style="display:inline-block;${buttonStyle}">`
      + `${escapeHtml(presentation.buttonLabel)}</a>`
      + '</td></tr></table>'
      + `<p style="margin:0 0 6px;${TEXT_SMALL}">${escapeHtml(presentation.altLink)}</p>`
      + `<p style="margin:0 0 16px;word-break:break-all;${TEXT_SMALL}">`
      + `<a href="${escapeHtml(flaggedUrl)}" style="color:${PRISM.primary};">`
      + `${escapeHtml(flaggedUrl)}</a></p>`;
  }

  if (presentation.validity) {
    body += `<p style="margin:0 0 6px;${TEXT_SMALL}">${escapeHtml(presentation.validity)}</p>`;
  }

  body += `<p style="margin:0;${TEXT_SMALL}">${escapeHtml(presentation.note)}</p>`
    + '</td></tr>';
  return body;
}

/**
 * Pie institucional compartido por los cuatro avisos AUTH.
 * @returns {string} Fila del pie con borde superior prisma.
 */
function footerRow() {
  return `<tr><td style="padding:16px 24px;border-top:1px solid ${PRISM.border};background:${PRISM.surface};`
    + `color:${PRISM.muted};font-family:${FONT_STACK};font-size:12px;line-height:1.5;">`
    + '<strong style="color:inherit;">MATISTA</strong> — Plataforma de Gestión Comercial<br />'
    + 'Mensaje automático de seguridad: no responda a esta dirección de correo.</td></tr>';
}

/**
 * Compone el aviso HTML de un tipo AUTH con la plantilla compartida Amethyst Prism.
 * @param {string} type Tipo del aviso; uno de VERIFY_EMAIL, RESET_PASSWORD, CHANGE_EMAIL o EMAIL_CHANGED.
 * @param {object} parts Datos dinámicos del flujo real.
 * @param {string} parts.origin Origen HTTP canónico del frontend validado por la política.
 * @param {string} [parts.token] Token temporal crudo del flujo; no se registra ni imprime.
 * @returns {string} Documento HTML completo con estilos inline y logotipo vía CID.
 * @throws {Error} Si el tipo de aviso no pertenece a la plantilla AUTH.
 */
export function buildAuthEmail(type, { origin, token }) {
  const presentation = MESSAGE_PRESENTATION[type];
  if (!presentation) throw new Error(`Tipo de aviso AUTH sin plantilla: ${type}`);

  const flaggedUrl = presentation.path && token !== undefined
    ? `${origin}${presentation.path}#token=${encodeURIComponent(token)}`
    : null;
  const title = `${presentation.title} — MATISTA`;

  return '<html lang="es"><head><meta charset="utf-8" />'
    + '<meta name="viewport" content="width=device-width, initial-scale=1" />'
    + '<meta name="x-apple-disable-message-reformatting" />'
    + `<title>${escapeHtml(title)}</title></head>`
    + `<body style="margin:0;padding:0;background:${PRISM.shell};font-family:${FONT_STACK};">`
    + '<table width="100%" cellpadding="0" cellspacing="0" border="0" role="presentation" '
    + `style="background:${PRISM.shell};">`
    + '<tr><td align="center" style="padding:28px 12px;">'
    + '<table width="480" cellpadding="0" cellspacing="0" border="0" role="presentation" '
    + `style="width:480px;max-width:100%;background:${PRISM.surface};`
    + `border:1px solid ${PRISM.border};border-radius:14px;overflow:hidden;">`
    + logoHeader()
    + bodyContent(presentation, flaggedUrl)
    + footerRow()
    + '</table></td></tr></table></body></html>';
}

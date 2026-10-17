import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { sendAuthNotice } from '../../../src/modules/auth/auth.email.js';
import {
  buildAuthEmail,
  MATISTA_LOGO_ATTACHMENT,
  MATISTA_LOGO_CID,
} from '../../../src/modules/auth/auth.email.template.js';
import { sendEmail } from '../../../src/infrastructure/email/email.service.js';

/** Origen de desarrollo de la política HTTP; no representa despliegues reales. */
const DEV_ORIGIN = 'http://localhost:5173';

/** Token ficticio acortado solo para pruebas; jamás corresponde a un token real. */
const FAKE_TOKEN = 'ficticio-abc123prueba';

const ENV = { SMTP_FROM: 'no-reply@example.test' };

/**
 * Captura el mensaje que sendAuthNotice entrega al transporte simulado.
 * @param {string} type Tipo de aviso AUTH.
 * @returns {Promise<object>} Mensaje capturado tal como lo recibiría SMTP.
 */
async function captureNotice(type) {
  let sent;
  const transport = {
    /** Simula aceptación SMTP sin red, credenciales ni buzones reales. */
    async sendMail(message) {
      sent = message;
      return { messageId: 'fixture-id', accepted: [message.to], rejected: [] };
    },
  };
  await sendAuthNotice({ type, to: 'destinatario@example.test', token: type === 'EMAIL_CHANGED' ? undefined : FAKE_TOKEN },
    { origin: DEV_ORIGIN, env: ENV, transport });
  return sent;
}

/** Verifica material visual y adjuntos comunes a los cuatro avisos AUTH. */
test('todos los avisos usan la plantilla con el logotipo oficial embebido por CID', async () => {
  assert.ok(existsSync(MATISTA_LOGO_ATTACHMENT.path), 'El recurso del logotipo debe existir junto al backend.');
  assert.equal(MATISTA_LOGO_ATTACHMENT.cid, MATISTA_LOGO_CID);
  for (const type of ['VERIFY_EMAIL', 'RESET_PASSWORD', 'CHANGE_EMAIL', 'EMAIL_CHANGED']) {
    const message = await captureNotice(type);
    // Documento completo con estilos inline, sin scripts ni recursos remotos.
    assert.match(message.html, /<html lang="es">/);
    assert.match(message.html, new RegExp(`src="cid:${MATISTA_LOGO_CID}"`));
    assert.doesNotMatch(message.html, /<script/i);
    assert.doesNotMatch(message.html, /<img[^>]+src="https?:/);
    // Adjunto único inline con el CID estable.
    assert.equal(message.attachments.length, 1);
    assert.equal(message.attachments[0].cid, MATISTA_LOGO_CID);
    assert.equal(message.attachments[0].contentDisposition, 'inline');
    assert.equal(message.attachments[0].contentType, 'image/png');
  }
});

/** Comprueba asuntos, enlaces, vigencias y botón específico de cada aviso con acción. */
test('asuntos, enlaces, vigencias y botón específico por tipo', async () => {
  const expectations = [
    { type: 'VERIFY_EMAIL', subject: 'Verifique su correo en MATISTA', button: 'Verificar mi correo',
      path: '/confirm-email', validity: 'El enlace de verificación es válido durante 24 horas' },
    { type: 'RESET_PASSWORD', subject: 'Recuperación de acceso a MATISTA', button: 'Restablecer mi contraseña',
      path: '/reset-password', validity: 'El enlace de recuperación es válido durante 30 minutos' },
    { type: 'CHANGE_EMAIL', subject: 'Confirme su nuevo correo en MATISTA', button: 'Confirmar mi nuevo correo',
      path: '/confirm-email-change', validity: 'El enlace de confirmación es válido durante 24 horas' },
  ];
  for (const expectation of expectations) {
    const message = await captureNotice(expectation.type);
    const actionUrl = `${DEV_ORIGIN}${expectation.path}#token=${FAKE_TOKEN}`;
    assert.equal(message.subject, expectation.subject);
    assert.ok(message.html.includes(`>${expectation.button}</a>`), `Falta el botón de ${expectation.type}.`);
    assert.ok(message.html.includes(`href="${actionUrl}"`), `Falta el enlace de acción de ${expectation.type}.`);
    assert.ok(message.html.includes(expectation.validity), `Falta la vigencia de ${expectation.type}.`);
    // La versión text conserva exactamente la frase original con el enlace del contrato.
    assert.ok(message.text.includes(`Para continuar en MATISTA abra: ${actionUrl}`),
      `Texto plano alterado en ${expectation.type}.`);
    // El enlace absoluto también existe como texto alternativo al botón.
    assert.ok(message.html.includes(actionUrl));
  }
});

/** EMAIL_CHANGED informa el cambio pero no ofrece acción ni vigencia. */
test('EMAIL_CHANGED no contiene botón, enlace de acción ni vigencia', async () => {
  const message = await captureNotice('EMAIL_CHANGED');
  assert.equal(message.subject, 'Su correo de MATISTA ha cambiado');
  assert.equal(message.text,
    'El correo de su cuenta MATISTA ha cambiado. Las sesiones anteriores fueron cerradas.');
  assert.doesNotMatch(message.html, /<a href/);
  assert.doesNotMatch(message.html, /24 horas/);
  assert.ok(message.html.includes('Cambio de correo confirmado'));
});

/** El contenido dinámico se escapa: ni el origen ni el token rompen el HTML. */
test('escapa el origen y codifica el token en el atributo href y el texto alternativo', () => {
  const hostileOrigin = 'http://legacy.test/?a=1&b=<i>';
  const html = buildAuthEmail('VERIFY_EMAIL', { origin: hostileOrigin, token: 'tok&en<q>' });
  assert.doesNotMatch(html, /<i>/);
  assert.ok(html.includes('&amp;b=&lt;i&gt;'), 'El origen dinámico debe escaparse en HTML.');
  // El token siempre sale codificado por el mismo mecanismo de la versión text.
  assert.ok(html.includes(encodeURIComponent('tok&en<q>')), 'El token debe ir codificado en el enlace.');
  assert.doesNotMatch(html, /<script/i);
});

/** Las llamadas previas a sendEmail siguen produciendo el mismo payload sin adjuntos. */
test('sendEmail conserva su payload original cuando nadie solicita adjuntos', async () => {
  let sent;
  const transport = {
    /** Simula aceptación SMTP como en las pruebas del servicio. */
    async sendMail(message) {
      sent = message;
      return { messageId: 'fixture-id', accepted: [message.to], rejected: [] };
    },
  };
  const result = await sendEmail({ to: 'destino@example.test', subject: 'Prueba', text: 'Cuerpo' },
    { transport, from: 'matista@example.test' });
  assert.deepEqual(sent, {
    from: 'matista@example.test',
    to: 'destino@example.test',
    subject: 'Prueba',
    text: 'Cuerpo',
    html: undefined,
  });
  assert.equal(Object.hasOwn(sent, 'attachments'), false);
  assert.deepEqual(result, { messageId: 'fixture-id', accepted: true });
});

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { createEmailTransport, sendEmail } from '../../../src/infrastructure/email/email.service.js';

/** Comprueba adaptación SMTP de SIGEC sin conectar ni usar credenciales reales. */
test('configura Nodemailer desde entorno y exige TLS sin enviar mensajes', () => {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true',
    SMTP_USER: 'fixture@example.test', SMTP_PASSWORD: randomBytes(20).toString('hex') };
  const transport = createEmailTransport(env);
  assert.equal(transport.options.host, env.SMTP_HOST);
  assert.equal(transport.options.port, 465);
  assert.equal(transport.options.secure, true);
  assert.equal(transport.options.auth.user, env.SMTP_USER);
  transport.close();
  const starttls = createEmailTransport({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'false' });
  assert.equal(starttls.options.requireTLS, true);
  starttls.close();
  for (const overrides of [{ SMTP_HOST: '' }, { SMTP_PORT: '0' }, { SMTP_PORT: '1.5' },
    { SMTP_SECURE: 'maybe' }, { SMTP_PASSWORD: '' }, { SMTP_USER: '' }]) {
    assert.throws(() => createEmailTransport({ ...env, ...overrides }), /SMTP/);
  }
});

/** Sustituye solo el transporte y verifica que el componente no agregue plantillas funcionales. */
test('envía mediante transporte simulado y devuelve solo aceptación SMTP e identificador', async () => {
  let sent;
  const transport = {
    /** Captura el mensaje de prueba y simula aceptación SMTP sin acceso a red. */
    async sendMail(message) {
      sent = message;
      return { messageId: 'fixture-id', accepted: [message.to], rejected: [], response: 'interno' };
    },
  };
  const message = { to: 'destino@example.test', subject: 'Prueba MATISTA', text: 'Contenido ficticio' };
  const result = await sendEmail(message, { transport, from: 'matista@example.test' });
  assert.deepEqual(sent, { ...message, html: undefined, from: 'matista@example.test' });
  assert.deepEqual(result, { messageId: 'fixture-id', accepted: true });
});

/** Verifica que fallos y rechazos no propaguen respuesta SMTP ni contenido recibido. */
test('controla fallos y rechazos sin revelar datos del proveedor', async () => {
  const sensitive = randomBytes(24).toString('hex');
  const message = { to: 'destino@example.test', subject: 'Prueba', text: sensitive };
  const transports = [
    { /** Simula un error SMTP con información que nunca debe publicarse. */
      async sendMail() { throw new Error(sensitive); } },
    { /** Simula rechazo del destinatario. */
      async sendMail() { return { accepted: [], rejected: [message.to] }; } },
  ];
  for (const transport of transports) {
    await assert.rejects(sendEmail(message, { transport, from: 'matista@example.test' }), (error) => {
      assert.equal(error.code, 'EMAIL_SEND_FAILED');
      assert.equal(error.status, 503);
      assert.equal(JSON.stringify(error).includes(sensitive), false);
      assert.equal(error.message.includes(sensitive), false);
      return true;
    });
  }
  await assert.rejects(sendEmail(message, { transport: {}, from: 'matista@example.test' }), /incompleto/);
});

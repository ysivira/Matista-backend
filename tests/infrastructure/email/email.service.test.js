/**
 * ============================================================
 * MATISTA | PRUEBAS DEL TRANSPORTE SMTP
 * ============================================================
 *
 * Archivo: email.service.test.js
 * Módulo: Pruebas de correo
 *
 * Responsabilidad:
 * Comprobar configuración TLS, reutilización del pool y errores
 * públicos de envío usando transportes simulados, sin SMTP real.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  closeSharedEmailTransport, createEmailTransport, getEmailTransport, sendEmail,
} from '../../../src/infrastructure/email/email.service.js';

/** Comprueba adaptación SMTP de SIGEC sin conectar ni usar credenciales reales. */
test('configura Nodemailer desde entorno y exige TLS sin enviar mensajes', () => {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true',
    SMTP_USER: 'fixture@example.test', SMTP_PASSWORD: randomBytes(20).toString('hex') };
  const transport = createEmailTransport(env);
  assert.equal(transport.options.host, env.SMTP_HOST);
  assert.equal(transport.options.port, 465);
  assert.equal(transport.options.secure, true);
  assert.equal(transport.options.auth.user, env.SMTP_USER);
  // Pool compartido y tiempos acotados aprobados para la optimización SMTP.
  assert.equal(transport.options.pool, true);
  assert.equal(transport.options.maxConnections, 2);
  assert.equal(transport.options.maxMessages, 10);
  assert.equal(transport.options.connectionTimeout, 10000);
  assert.equal(transport.options.greetingTimeout, 10000);
  assert.equal(transport.options.socketTimeout, 30000);
  transport.close();
  const starttls = createEmailTransport({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'false' });
  assert.equal(starttls.options.requireTLS, true);
  starttls.close();
  for (const overrides of [{ SMTP_HOST: '' }, { SMTP_PORT: '0' }, { SMTP_PORT: '1.5' },
    { SMTP_SECURE: 'maybe' }, { SMTP_PASSWORD: '' }, { SMTP_USER: '' }]) {
    assert.throws(() => createEmailTransport({ ...env, ...overrides }), /SMTP/);
  }
});

/** Verifica que las credenciales y la seguridad TLS permanecen Idénticas con pool activo. */
test('mantiene credenciales y TLS obligatorio en 465 y 587 con pool habilitado', () => {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true',
    SMTP_USER: 'fixture@example.test', SMTP_PASSWORD: 'secreto-único' };
  const implicit = createEmailTransport(env);
  assert.deepEqual(implicit.options.auth.pass, 'secreto-único');
  assert.equal(implicit.options.secure, true);
  implicit.close();
  const starttls = createEmailTransport({ ...env, SMTP_PORT: '587', SMTP_SECURE: 'false' });
  assert.equal(starttls.options.requireTLS, true);
  assert.equal(starttls.options.secure, false);
  starttls.close();
});

/** Comprueba que el transporte compartido se reutilice entre llamadas y se reinicie al cerrarlo. */
test('reutiliza un único transporte compartido entre envíos y lo reinicia al cerrarlo', () => {
  const env = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true',
    SMTP_USER: 'fixture@example.test', SMTP_PASSWORD: randomBytes(20).toString('hex') };
  const first = getEmailTransport(env);
  assert.equal(getEmailTransport(env), first);
  closeSharedEmailTransport();
  const second = getEmailTransport(env);
  assert.notEqual(second, first);
  second.close();
  closeSharedEmailTransport();
});

/** Verifica el envío secuencial a varios destinatarios con un solo transporte y sin duplicados. */
test('reutiliza el mismo transporte para múltiples destinatarios sin duplicar envíos', async () => {
  const sent = [];
  const transport = {
    /** Registra cada mensaje y simula aceptación SMTP sin acceso a red. */
    async sendMail(message) {
      sent.push(message);
      return { messageId: `fixture-id-${sent.length}`, accepted: [message.to], rejected: [] };
    },
  };
  const from = 'matista@example.test';
  await sendEmail({ to: 'maria@example.test', subject: 'Prueba', text: 'contenido' }, { transport, from });
  await sendEmail({ to: 'pedro@example.test', subject: 'Prueba', text: 'contenido' }, { transport, from });
  await sendEmail({ to: 'lucia@example.test', subject: 'Prueba', text: 'contenido' }, { transport, from });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((message) => message.to),
    ['maria@example.test', 'pedro@example.test', 'lucia@example.test']);
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

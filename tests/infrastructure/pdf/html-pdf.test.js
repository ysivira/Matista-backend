/** Pruebas aisladas de selección del navegador, CDP, limpieza y diagnóstico sin datos privados. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beforeEach, mock, test } from 'node:test';
import { createAppError, isAppError } from '../../../src/shared/errors/app-error.js';

const pdf = Buffer.from('%PDF-1.4\nDocumento sintético');
let estado;

mock.module('@sparticuz/chromium', {
  defaultExport: {
    args: ['--no-sandbox', '--no-zygote', '--headless=shell', '--disable-web-security', '--allow-running-insecure-content'],
    async executablePath() {
      estado.extracciones++;
      if (estado.errorExtraccion) throw estado.errorExtraccion;
      return '/tmp/opencode/chromium-prueba';
    }
  }
});
mock.module('node:fs/promises', {
  namedExports: {
    async mkdtemp() {
      if (estado.errorTemporal) throw estado.errorTemporal;
      return '/tmp/opencode/matista-documento-prueba';
    },
    async writeFile(...argumentos) { estado.escrituras.push(argumentos); },
    async rm(...argumentos) {
      estado.limpiezas.push(argumentos);
      if (estado.errorLimpieza) throw estado.errorLimpieza;
    }
  }
});
mock.module('node:child_process', {
  namedExports: {
    spawn(...argumentos) {
      estado.ejecuciones.push(argumentos);
      const chrome = new EventEmitter();
      chrome.stderr = new EventEmitter();
      chrome.pid = estado.errorSpawn ? undefined : 123;
      chrome.exitCode = null;
      chrome.signalCode = null;
      chrome.kill = signal => {
        estado.senales.push(signal);
        chrome.signalCode = signal;
        queueMicrotask(() => chrome.emit('exit'));
      };
      queueMicrotask(() => {
        if (estado.errorSpawn) return chrome.emit('error', estado.errorSpawn);
        if (estado.salidaChrome) {
          chrome.exitCode = 127;
          return chrome.emit('exit');
        }
        chrome.stderr.emit('data', 'DevTools listening on ws://127.0.0.1:123/prueba\n');
      });
      return chrome;
    }
  }
});

class SocketPrueba extends EventTarget {
  constructor() {
    super();
    estado.socketCreado?.();
    if (!estado.sinConexion) queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }
  send(texto) {
    const comando = JSON.parse(texto);
    estado.comandos.push(comando);
    let result = {};
    if (comando.method === 'Target.createTarget') result = { targetId: 'pagina' };
    if (comando.method === 'Target.attachToTarget') result = { sessionId: 'sesion' };
    if (comando.method === 'Runtime.evaluate') result = {
      result: { value: comando.params.expression.endsWith('documentoListo') ? 'true' : estado.desbordamiento }
    };
    if (comando.method === 'Page.printToPDF') result = { data: pdf.toString('base64') };
    const respuesta = comando.method === estado.comandoFallido
      ? { id: comando.id, error: { message: 'DATO_PRIVADO_NO_REGISTRAR' } }
      : { id: comando.id, result };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(respuesta) })));
  }
  close() { estado.socketCerrado = true; }
}

const { imprimirHtmlPdf } = await import('../../../src/infrastructure/pdf/html-pdf.js');

beforeEach(t => {
  const original = { VERCEL: process.env.VERCEL, CHROME_BIN: process.env.CHROME_BIN };
  const websocket = globalThis.WebSocket;
  t.after(() => {
    for (const [clave, valor] of Object.entries(original)) {
      if (valor === undefined) delete process.env[clave];
      else process.env[clave] = valor;
    }
    globalThis.WebSocket = websocket;
  });
  delete process.env.VERCEL;
  delete process.env.CHROME_BIN;
  globalThis.WebSocket = SocketPrueba;
  estado = { extracciones: 0, ejecuciones: [], escrituras: [], limpiezas: [], senales: [], comandos: [], registros: [] };
  t.mock.method(console, 'error', (...argumentos) => estado.registros.push(argumentos));
});

test('PDF local conserva google-chrome, CDP y el HTML literal sin extraer Chromium', async () => {
  const html = '<html>DATO_PRIVADO_NO_REGISTRAR</html>';
  assert.deepEqual(await imprimirHtmlPdf(html), pdf);
  assert.equal(estado.extracciones, 0);
  assert.equal(estado.ejecuciones[0][0], 'google-chrome');
  assert.ok(!estado.ejecuciones[0][1].includes('--no-sandbox'));
  assert.equal(estado.escrituras[0][1], html);
  assert.deepEqual(estado.escrituras[0][2], { mode: 0o600 });
  assert.deepEqual(estado.comandos.find(c => c.method === 'Page.printToPDF').params, {
    printBackground: true, preferCSSPageSize: true, displayHeaderFooter: false
  });
  assert.equal(estado.socketCerrado, true);
  assert.deepEqual(estado.senales, ['SIGTERM']);
  assert.equal(estado.limpiezas[0][0], '/tmp/opencode/matista-documento-prueba');
  assert.deepEqual(estado.registros, []);
});

test('PDF local respeta CHROME_BIN sin argumentos de sandbox serverless', async () => {
  process.env.CHROME_BIN = '/opt/chrome personalizado';
  await imprimirHtmlPdf('HTML');
  assert.equal(estado.ejecuciones[0][0], process.env.CHROME_BIN);
  assert.equal(estado.extracciones, 0);
  assert.ok(!estado.ejecuciones[0][1].includes('--no-sandbox'));
});

test('PDF Vercel resuelve Chromium y conserva un único modo headless sin relajar seguridad web', async () => {
  process.env.VERCEL = '1';
  assert.deepEqual(await imprimirHtmlPdf('HTML'), pdf);
  assert.equal(estado.extracciones, 1);
  assert.equal(estado.ejecuciones[0][0], '/tmp/opencode/chromium-prueba');
  const args = estado.ejecuciones[0][1];
  assert.ok(args.includes('--no-sandbox'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.deepEqual(args.filter(a => a.startsWith('--headless')), ['--headless']);
  assert.ok(!args.includes('--disable-web-security'));
  assert.ok(!args.includes('--allow-running-insecure-content'));
  assert.equal(estado.limpiezas.length, 1);
  assert.notEqual(estado.limpiezas[0][0], '/tmp/opencode/chromium-prueba');
});

test('CHROME_BIN tiene prioridad también en Vercel, sin extraer otro ejecutable', async () => {
  process.env.VERCEL = '1';
  process.env.CHROME_BIN = '/opt/chrome';
  await imprimirHtmlPdf('HTML');
  assert.equal(estado.ejecuciones[0][0], '/opt/chrome');
  assert.equal(estado.extracciones, 0);
  assert.ok(estado.ejecuciones[0][1].includes('--no-sandbox'));
});

test('ENOENT devuelve 503 operacional y diagnóstico seguro sin HTML, rutas, mensajes ni stack', async () => {
  process.env.CHROME_BIN = '/DATO_PRIVADO_NO_REGISTRAR/chrome';
  estado.errorSpawn = Object.assign(new Error('DATO_PRIVADO_NO_REGISTRAR'), { code: 'ENOENT' });
  await assert.rejects(imprimirHtmlPdf('DATO_PRIVADO_NO_REGISTRAR'), error => {
    assert.equal(isAppError(error), true);
    assert.equal(error.code, 'PDF_NO_DISPONIBLE');
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(estado.registros[0][1], {
    etapa: 'iniciar_navegador', navegador: 'CHROME_BIN', codigo: 'ENOENT',
    node: process.versions.node, plataforma: process.platform, arquitectura: process.arch,
    salida: null, senal: null
  });
  assert.ok(!JSON.stringify(estado.registros).includes('DATO_PRIVADO'));
  assert.equal(estado.limpiezas.length, 1);
  assert.deepEqual(estado.senales, []);
});

test('errores de extracción se identifican antes del spawn y no eliminan el binario compartido', async () => {
  process.env.VERCEL = '1';
  estado.errorExtraccion = Object.assign(new Error('DATO_PRIVADO_NO_REGISTRAR'), { code: 'ENOSPC' });
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros[0][1].etapa, 'resolver_navegador');
  assert.equal(estado.registros[0][1].codigo, 'ENOSPC');
  assert.deepEqual(estado.ejecuciones, []);
  assert.deepEqual(estado.limpiezas, []);
});

test('runtime sin WebSocket produce diagnóstico explícito y 503', async () => {
  globalThis.WebSocket = undefined;
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros[0][1].etapa, 'runtime');
  assert.equal(estado.registros[0][1].codigo, 'PDF_RUNTIME');
  assert.deepEqual(estado.ejecuciones, []);
});

test('salida prematura de Chrome registra código de proceso y no stderr', async () => {
  estado.salidaChrome = true;
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros[0][1].codigo, 'CHROME_EXIT');
  assert.equal(estado.registros[0][1].salida, 127);
});

test('conexión DevTools tiene timeout y libera navegador y temporal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  estado.sinConexion = true;
  const creado = new Promise(resolve => { estado.socketCreado = resolve; });
  const rechazo = assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  await creado;
  t.mock.timers.tick(15001);
  await rechazo;
  assert.equal(estado.registros[0][1].codigo, 'DEVTOOLS_TIMEOUT');
  assert.equal(estado.socketCerrado, true);
  assert.equal(estado.limpiezas.length, 1);
});

test('fallo de impresión registra etapa y descarta mensajes internos del protocolo', async () => {
  estado.comandoFallido = 'Page.printToPDF';
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros[0][1].etapa, 'imprimir');
  assert.equal(estado.registros[0][1].codigo, 'ERROR_NAVEGADOR');
  assert.ok(!JSON.stringify(estado.registros).includes('DATO_PRIVADO'));
  assert.equal(estado.socketCerrado, true);
});

test('desbordamiento conserva exactamente el error documental 422', async () => {
  estado.desbordamiento = 'fila_no_paginable';
  const error = createAppError('PDF_CONTENIDO_EXTENSO', 'Contenido extenso.', 422);
  await assert.rejects(imprimirHtmlPdf('HTML', { errorDesbordamiento: error }), recibido => recibido === error);
  assert.deepEqual(estado.registros, []);
  assert.equal(estado.limpiezas.length, 1);
});

test('fallos de temporales se traducen al mismo contrato PDF', async () => {
  estado.errorTemporal = Object.assign(new Error('DATO_PRIVADO_NO_REGISTRAR'), { code: 'ENOSPC' });
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros[0][1].etapa, 'preparar_temporal');
  assert.deepEqual(estado.limpiezas, []);
});

test('limpieza fallida no oculta el error original ni registra códigos arbitrarios', async () => {
  estado.errorSpawn = Object.assign(new Error('DATO_PRIVADO_NO_REGISTRAR'), { code: 'ENOENT' });
  estado.errorLimpieza = Object.assign(new Error('DATO_PRIVADO_NO_REGISTRAR'), { code: 'DATO_PRIVADO_NO_REGISTRAR' });
  await assert.rejects(imprimirHtmlPdf('HTML'), { code: 'PDF_NO_DISPONIBLE', status: 503 });
  assert.equal(estado.registros.length, 2);
  assert.equal(estado.registros[1][1].etapa, 'limpiar_temporal');
  assert.equal(estado.registros[1][1].codigo, 'ERROR_NAVEGADOR');
  assert.ok(!JSON.stringify(estado.registros).includes('DATO_PRIVADO'));
});

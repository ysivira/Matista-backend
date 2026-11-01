/**
 * ============================================================
 * MATISTA | IMPRESIÓN HTML A PDF
 * ============================================================
 *
 * Archivo: html-pdf.js
 * Módulo: Infraestructura documental
 *
 * Responsabilidad:
 * Imprimir documentos autónomos mediante Chrome headless y su
 * protocolo de depuración, con control de tiempo y desbordamiento.
 *
 * Consideraciones técnicas:
 * - El HTML recibido se escribe sin reinterpretar su contenido.
 * - El proceso, el socket y los temporales se limpian al finalizar.
 *
 * ============================================================
 */
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { constants, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppError } from '../../shared/errors/app-error.js';

const CODIGOS_TECNICOS = new Set([
  'ENOENT', 'EACCES', 'ENOEXEC', 'ENOSPC', 'EMFILE', 'ENOMEM', 'ECONNREFUSED',
  'ERR_MODULE_NOT_FOUND', 'PDF_RUNTIME', 'PDF_PLATAFORMA', 'CHROME_TIMEOUT',
  'CHROME_EXIT', 'DEVTOOLS_TIMEOUT', 'IMPRESION_TIMEOUT'
]);

const LIMITE_STDERR_ARRANQUE = 8192;
const PATRONES_ARRANQUE = [
  ['BIBLIOTECA_AUSENTE', /error while loading shared libraries|cannot open shared object file/i],
  ['SIMBOLO_INCOMPATIBLE', /symbol lookup error|version [`'][^\n]{0,120}not found/i],
  ['CHECK_FALLIDO', /check failed|fatal:/i],
  ['MEMORIA_COMPARTIDA', /\/dev\/shm|shared_memory|shared memory/i],
  ['GRAFICOS', /ANGLE|SwiftShader|Vulkan|EGL|GPU process|gpu_init/i],
  ['SANDBOX', /sandbox|seccomp|prctl/i],
  ['CRASHPAD', /crashpad|crash reporter/i],
  ['FUENTES', /fontconfig|fonts\.conf/i],
  ['PERMISO_DENEGADO', /permission denied|operation not permitted/i],
  ['SISTEMA_SOLO_LECTURA', /read-only file system/i],
  ['SIN_ESPACIO', /no space left on device/i],
  ['MEMORIA_AGOTADA', /out of memory|cannot allocate memory/i]
];
const BIBLIOTECAS_ARRANQUE = [
  'libnspr4.so', 'libnss3.so', 'libnssutil3.so', 'libexpat.so.1', 'libc.so.6',
  'libgcc_s.so.1', 'libEGL.so', 'libGLESv2.so', 'libvulkan.so.1', 'libvk_swiftshader.so'
];

/** Conserva códigos y señales conocidos del sistema, nunca cadenas arbitrarias del error. */
function resultadoProceso(code, signal) {
  return {
    salida: Number.isInteger(code) ? code : null,
    senal: typeof signal === 'string' && Object.hasOwn(constants.signals, signal) ? signal : null
  };
}

/** Clasifica solo la cola acotada de arranque; no publica fragmentos de texto libre del navegador. */
function diagnosticarArranque(diagnostico) {
  const texto = diagnostico.stderr.toString('utf8');
  return {
    categorias: PATRONES_ARRANQUE.filter(([, patron]) => patron.test(texto)).map(([codigo]) => codigo),
    bibliotecas: BIBLIOTECAS_ARRANQUE.filter(nombre => texto.includes(nombre)),
    bytesConservados: diagnostico.stderr.length,
    truncado: diagnostico.truncado
  };
}

/** Registra solo valores técnicos controlados: nunca HTML, rutas, mensajes, stderr crudo ni secretos. */
function registrarFallo(error, etapa, navegador, chrome, diagnostico) {
  const resultado = diagnostico.close ?? diagnostico.exit ?? resultadoProceso(chrome?.exitCode, chrome?.signalCode);
  console.error('[matista] fallo de generación PDF', {
    etapa,
    navegador,
    codigo: CODIGOS_TECNICOS.has(error?.code) ? error.code : 'ERROR_NAVEGADOR',
    node: process.versions.node,
    plataforma: process.platform,
    arquitectura: process.arch,
    ...resultado,
    ...(diagnostico.exit || diagnostico.close ? {
      proceso: { exit: diagnostico.exit, close: diagnostico.close }
    } : {}),
    ...(diagnostico.stderr.length ? { stderrArranque: diagnosticarArranque(diagnostico) } : {})
  });
}

/**
 * Imprime el HTML mediante Chrome local o Chromium empaquetado para Vercel, usando el mismo CDP.
 * @param {string} html Documento autónomo generado por servidor, con datos escapados y recursos embebidos.
 * @param {object} [opciones] Opciones del control de desbordamiento.
 * @param {Error} [opciones.errorDesbordamiento] Error que se conserva si el contenido no cabe.
 * @returns {Promise<Buffer>} PDF A4 paginado, sin URL ni encabezados automáticos del navegador.
 * @throws {Error} PDF_NO_DISPONIBLE si falla el navegador o vence una espera del protocolo.
 */
export async function imprimirHtmlPdf(html, { errorDesbordamiento } = {}) {
  const vercel = process.env.VERCEL === '1';
  const navegador = process.env.CHROME_BIN ? 'CHROME_BIN' : vercel ? 'chromium' : 'google-chrome';
  let temporal, chrome, socket;
  const diagnostico = { exit: null, close: null, stderr: Buffer.alloc(0), truncado: false };
  let etapa = 'runtime';
  try {
    if (typeof WebSocket !== 'function')
      throw Object.assign(new Error('Runtime PDF incompatible'), { code: 'PDF_RUNTIME' });
    etapa = 'resolver_navegador';
    let ejecutable = process.env.CHROME_BIN || 'google-chrome';
    let argumentos = [];
    if (vercel) {
      if (process.platform !== 'linux' || process.arch !== 'x64')
        throw Object.assign(new Error('Plataforma Chromium incompatible'), { code: 'PDF_PLATAFORMA' });
      // Importación diferida: el desarrollo local no extrae ni configura Chromium serverless.
      const { default: chromium } = await import('@sparticuz/chromium');
      if (!process.env.CHROME_BIN) ejecutable = await chromium.executablePath();
      // Headless se fija abajo; el documento autónomo no requiere relajar la seguridad web.
      argumentos = chromium.args.filter(argumento =>
        !argumento.startsWith('--headless') &&
        argumento !== '--disable-web-security' &&
        argumento !== '--allow-running-insecure-content'
      );
      // Vercel dispone de /tmp, pero no garantiza memoria compartida utilizable en /dev/shm.
      argumentos.push('--disable-dev-shm-usage');
    }
    etapa = 'preparar_temporal';
    temporal = await mkdtemp(path.join(tmpdir(), 'matista-documento-'));
    const archivo = path.join(temporal, 'documento.html');
    await writeFile(archivo, html, { mode: 0o600 });
    etapa = 'iniciar_navegador';
    chrome = spawn(
      ejecutable,
      [
        ...argumentos,
        '--headless',
        '--disable-gpu',
        '--disable-background-networking',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + path.join(temporal, 'perfil'),
        'about:blank'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    const endpoint = await new Promise((resolve, reject) => {
      let arranqueCompleto = false;
      // close permite drenar stderr tras exit; la espera sigue acotada aunque close no llegue.
      const timer = setTimeout(() => reject(Object.assign(new Error('Chrome timeout'), {
        code: diagnostico.exit ? 'CHROME_EXIT' : 'CHROME_TIMEOUT'
      })), 15000);
      chrome.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      chrome.once('exit', (code, signal) => {
        diagnostico.exit = resultadoProceso(code, signal);
      });
      chrome.once('close', (code, signal) => {
        diagnostico.close = resultadoProceso(code, signal);
        if (!arranqueCompleto) {
          clearTimeout(timer);
          reject(Object.assign(new Error('Chrome terminó'), { code: 'CHROME_EXIT' }));
        }
      });
      chrome.stderr.on('data', chunk => {
        // Nunca capturar mensajes posteriores a DevTools, cuando podría cargarse contenido privado.
        if (arranqueCompleto) return;
        const datos = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const longitud = diagnostico.stderr.length + datos.length;
        diagnostico.truncado ||= longitud > LIMITE_STDERR_ARRANQUE;
        diagnostico.stderr = datos.length >= LIMITE_STDERR_ARRANQUE
          ? Buffer.from(datos.subarray(-LIMITE_STDERR_ARRANQUE))
          : Buffer.concat([diagnostico.stderr.subarray(Math.max(0, longitud - LIMITE_STDERR_ARRANQUE)), datos]);
        const match = diagnostico.stderr.toString('utf8').match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match && !diagnostico.exit && !diagnostico.close) {
          arranqueCompleto = true;
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    etapa = 'conectar_devtools';
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('DevTools timeout'), { code: 'DEVTOOLS_TIMEOUT' })), 15000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', error => { clearTimeout(timer); reject(error); }, { once: true });
    });

    let id = 0;
    const pendientes = new Map();
    socket.addEventListener('message', evento => {
      const m = JSON.parse(evento.data);
      const espera = pendientes.get(m.id);
      if (!espera) return;
      clearTimeout(espera.timer);
      pendientes.delete(m.id);
      if (m.error) espera.reject(new Error('Chrome no completó la impresión'));
      else espera.resolve(m.result);
    });

    /**
     * Envía un comando al navegador y espera la respuesta identificada por su número.
     * @param {string} method Comando del protocolo de Chrome.
     * @param {object} [params] Parámetros del comando.
     * @param {string} [sessionId] Sesión del documento cuando el comando la requiere.
     * @returns {Promise<object>} Resultado del comando.
     * @throws {Error} Si Chrome rechaza el comando o vence el tiempo de espera.
     */
    function comando(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const numero = ++id;
        const timer = setTimeout(() => {
          pendientes.delete(numero);
          reject(Object.assign(new Error('Impresión timeout'), { code: 'IMPRESION_TIMEOUT' }));
        }, 20000);
        pendientes.set(numero, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: numero, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }

    etapa = 'cargar_documento';
    const { targetId } = await comando('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await comando('Target.attachToTarget', { targetId, flatten: true });
    await comando('Page.enable', {}, sessionId);
    await comando('Page.navigate', { url: pathToFileURL(archivo).href }, sessionId);
    etapa = 'paginar';
    let listo = false;
    for (let intento = 0; intento < 100; intento++) {
      const resultado = await comando(
        'Runtime.evaluate',
        {
          expression: 'document.documentElement.dataset.documentoListo',
          returnByValue: true
        },
        sessionId
      );
      if (resultado.result.value === 'true') {
        listo = true;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!listo) throw new Error('Documento no preparado');
    const comprobacion = await comando(
      'Runtime.evaluate',
      {
        expression: 'document.documentElement.dataset.documentoError',
        returnByValue: true
      },
      sessionId
    );
    if (comprobacion.result.value) throw errorDesbordamiento ?? new Error('El documento excede el área imprimible');
    etapa = 'imprimir';
    const { data } = await comando(
      'Page.printToPDF',
      {
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false
      },
      sessionId
    );
    return Buffer.from(data, 'base64');
  } catch (error) {
    if (errorDesbordamiento && error === errorDesbordamiento) throw error;
    registrarFallo(error, etapa, navegador, chrome, diagnostico);
    throw createAppError(
      'PDF_NO_DISPONIBLE',
      'No se pudo preparar el PDF. Intenta nuevamente o utiliza Imprimir.',
      503
    );
  } finally {
    try {
      socket?.close();
      if (chrome?.pid && !diagnostico.exit && !diagnostico.close && chrome.exitCode == null && chrome.signalCode == null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => { chrome.kill('SIGKILL'); resolve(); }, 2000);
          chrome.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          chrome.kill('SIGTERM');
        });
      }
    } catch (error) {
      registrarFallo(error, 'cerrar_navegador', navegador, chrome, diagnostico);
    }
    try {
      // Solo se elimina el directorio privado de esta operación, no el binario compartido de Chromium.
      if (temporal) await rm(temporal, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      registrarFallo(error, 'limpiar_temporal', navegador, chrome, diagnostico);
    }
  }
}

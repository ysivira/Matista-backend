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
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAppError } from '../../shared/errors/app-error.js';

/**
 * Imprime el mismo HTML usado por el navegador mediante Chrome instalado, sin librerías adicionales.
 * @param {string} html Documento autónomo generado por servidor, con datos escapados y recursos embebidos.
 * @param {object} [opciones] Opciones del control de desbordamiento.
 * @param {Error} [opciones.errorDesbordamiento] Error que se conserva si el contenido no cabe.
 * @returns {Promise<Buffer>} PDF A4 paginado, sin URL ni encabezados automáticos del navegador.
 * @throws {Error} PDF_NO_DISPONIBLE si Chrome no puede generar el documento dentro de 20 segundos.
 */
export async function imprimirHtmlPdf(html, { errorDesbordamiento } = {}) {
  const temporal = await mkdtemp(path.join(tmpdir(), 'matista-documento-'));
  let chrome, socket;
  try {
    const archivo = path.join(temporal, 'documento.html');
    await writeFile(archivo, html, { mode: 0o600 });
    chrome = spawn(
      process.env.CHROME_BIN || 'google-chrome',
      [
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
      let salida = '';
      const timer = setTimeout(() => reject(new Error('Chrome timeout')), 15000);
      chrome.once('error', error => {
        clearTimeout(timer);
        reject(error);
      });
      chrome.once('exit', () => {
        clearTimeout(timer);
        reject(new Error('Chrome terminó'));
      });
      chrome.stderr.on('data', chunk => {
        salida += chunk;
        const match = salida.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });

    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
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
          reject(new Error('Impresión timeout'));
        }, 20000);
        pendientes.set(numero, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: numero, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }

    const { targetId } = await comando('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await comando('Target.attachToTarget', { targetId, flatten: true });
    await comando('Page.enable', {}, sessionId);
    await comando('Page.navigate', { url: pathToFileURL(archivo).href }, sessionId);
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
    throw createAppError(
      'PDF_NO_DISPONIBLE',
      'No se pudo preparar el PDF. Intenta nuevamente o utiliza Imprimir.',
      503
    );
  } finally {
    socket?.close();
    if (chrome && chrome.exitCode == null) {
      chrome.kill('SIGTERM');
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        chrome.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Solo se elimina el directorio privado creado por esta operación, nunca archivos del proyecto.
    await rm(temporal, { recursive: true, force: true, maxRetries: 3 });
  }
}

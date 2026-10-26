import { createServer, request } from 'node:http';
import { once } from 'node:events';

/**
 * Monta una aplicación de prueba en loopback y registra su cierre al finalizar.
 * @param {object} t Contexto node:test para liberar el recurso.
 * @param {Function} app Aplicación Express, sin listener propio.
 * @returns {Promise<Function>} Función de solicitud JSON al puerto efímero.
 */
export async function startTestServer(t, app) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  /** Cierra el servidor local de pruebas y sus conexiones al terminar el caso. */
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => {
      /** Resuelve el cierre o propaga el fallo de liberación del servidor. */
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  /**
   * Envía una solicitud local con método/cuerpo/cabeceras opcionales.
   * @param {string} path Ruta interna de la aplicación de prueba.
   * @param {object} options Método, cuerpo, cabeceras y responseType=buffer para documentos binarios.
   * @returns {Promise<object>} Estado, cabeceras y cuerpo JSON.
   */
  return async function requestJson(path, { method = 'GET', body, headers = {}, responseType = 'json' } = {}) {
    return new Promise((resolve, reject) => {
      /** Acumula la respuesta HTTP local sin invocar servicios externos. */
      const req = request({ host: '127.0.0.1', port: server.address().port, path, method,
        headers: { 'content-type': 'application/json', ...headers }, agent: false }, (res) => {
        let content = '';
        const chunks = [];
        if (responseType !== 'buffer') res.setEncoding('utf8');
        /** Acumula un fragmento de respuesta de prueba. */
        res.on('data', (chunk) => { if (responseType === 'buffer') chunks.push(chunk); else content += chunk; });
        /** Devuelve el cuerpo completo; propaga respuestas JSON inválidas. */
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, headers: res.headers, body: responseType === 'buffer' ? Buffer.concat(chunks) : content ? JSON.parse(content) : null });
          } catch (error) { reject(error); }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

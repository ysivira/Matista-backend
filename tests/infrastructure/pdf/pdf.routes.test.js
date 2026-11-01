/** Contrato HTTP de los tres handlers PDF reales, con servicios/documentos sintéticos y sin MySQL. */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import express from 'express';
import { createAppError } from '../../../src/shared/errors/app-error.js';
import { errorHandler } from '../../../src/shared/errors/error-handler.js';
import { startTestServer } from '../../helpers/http.js';

const pdf = Buffer.from('%PDF-1.4\nDocumento sintético');
let errorPdf, llamadas, errorLectura;
const cotizacion = { id: 36 };
const contexto = { asesor: { nombre: 'Sintético' } };

async function generarPdf(...argumentos) {
  llamadas.push(argumentos);
  if (errorPdf) throw errorPdf;
  return pdf;
}

mock.module('../../../src/modules/asesor/cotizaciones.service.js', {
  namedExports: {
    async obtenerDatosPdf(pool, actor, id) {
      assert.equal(actor, 'asesor-prueba');
      assert.equal(id, '36');
      if (errorLectura) throw errorLectura;
      return { cotizacion, contexto };
    }
  }
});
mock.module('../../../src/modules/asesor/documentos.js', { namedExports: { cotizacionPdf: generarPdf } });
mock.module('../../../src/infrastructure/pdf/html-pdf.js', { namedExports: { imprimirHtmlPdf: generarPdf } });
mock.module('../../../src/modules/admin/tarifario.routes.js', {
  namedExports: { listarPlanes() {}, consultarTarifario() {} }
});
mock.module('../../../src/modules/admin/tarifario.service.js', {
  namedExports: {
    async gestionarPlanes() { return [{ id: 1, nombre: 'Plan sintético' }]; },
    async gestionarTarifario() { return { tarifas: [], plan: { id: 1 } }; }
  }
});
mock.module('../../../src/modules/admin/catalogo.impresion.js', {
  namedExports: { async documentoCatalogoHtml() { return '<html>Documento sintético</html>'; } }
});

const { createAsesorRouter } = await import('../../../src/modules/asesor/asesor.routes.js');
const { createCatalogoRouter } = await import('../../../src/modules/admin/catalogo.routes.js');

const casos = [
  { tipo: 'cotizacion', ruta: '/api/asesor/cotizaciones/36/pdf', patron: '/cotizaciones/:id/pdf', archivo: 'matista-cotizacion.pdf' },
  { tipo: 'plan', ruta: '/api/catalogo/planes/1/pdf', patron: '/planes/:id/:formato', archivo: 'matista-detalle-plan.pdf' },
  { tipo: 'lista', ruta: '/api/catalogo/listas/1/Voluntario/pdf', patron: '/listas/:planId/:tipoIngreso/:formato', archivo: 'matista-lista-precios.pdf' }
];

beforeEach(() => { errorPdf = undefined; errorLectura = undefined; llamadas = []; });

/** Monta solo los handlers documentales reales; no prueba ni sustituye AUTH en producción. */
async function servidor(t) {
  const env = { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173' };
  const asesor = createAsesorRouter({ env });
  const catalogo = createCatalogoRouter({ env });
  const app = express();
  app.use((req, res, next) => {
    req.auth = { user: { legajo: 'asesor-prueba' } };
    req.authContext = { pool: {}, now: () => new Date('2026-11-01T12:00:00Z') };
    res.set('Cache-Control', 'no-store');
    next();
  });
  for (const caso of casos) {
    const router = caso.tipo === 'cotizacion' ? asesor : catalogo;
    const handler = router.stack.find(layer => layer.route?.path === caso.patron).route.stack[0].handle;
    const prefijo = caso.tipo === 'cotizacion' ? '/api/asesor' : '/api/catalogo';
    app.get(prefijo + caso.patron, handler);
  }
  app.use(errorHandler);
  return startTestServer(t, app);
}

for (const caso of casos) {
  test(`${caso.tipo}: entrega Buffer PDF y encabezados correctos en éxito`, async t => {
    const request = await servidor(t);
    const respuesta = await request(caso.ruta, { responseType: 'buffer' });
    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers['content-type'], /^application\/pdf/);
    assert.equal(respuesta.headers['content-disposition'], `attachment; filename=${caso.archivo}`);
    assert.equal(respuesta.headers['cache-control'], 'no-store');
    assert.deepEqual(respuesta.body, pdf);
    assert.equal(llamadas.length, 1);
    if (caso.tipo === 'cotizacion') assert.deepEqual(llamadas[0], [cotizacion, contexto]);
  });

  test(`${caso.tipo}: fallo del navegador devuelve 503 JSON sin encabezados PDF`, async t => {
    errorPdf = createAppError('PDF_NO_DISPONIBLE', 'No se pudo preparar el PDF.', 503);
    const request = await servidor(t);
    const respuesta = await request(caso.ruta);
    assert.equal(respuesta.status, 503);
    assert.match(respuesta.headers['content-type'], /^application\/json/);
    assert.equal(respuesta.headers['content-disposition'], undefined);
    assert.equal(respuesta.headers['cache-control'], 'no-store');
    assert.deepEqual(respuesta.body, { error: { code: 'PDF_NO_DISPONIBLE', message: 'No se pudo preparar el PDF.' } });
  });
}

test('cotizacion: desbordamiento conserva 422 JSON sin descarga PDF', async t => {
  errorPdf = createAppError('PDF_CONTENIDO_EXTENSO', 'Contenido extenso.', 422);
  const request = await servidor(t);
  const respuesta = await request(casos[0].ruta);
  assert.equal(respuesta.status, 422);
  assert.match(respuesta.headers['content-type'], /^application\/json/);
  assert.equal(respuesta.headers['content-disposition'], undefined);
  assert.equal(respuesta.body.error.code, 'PDF_CONTENIDO_EXTENSO');
});

test('cotizacion: error de lectura autorizado no invoca el generador', async t => {
  errorLectura = createAppError('ASESOR_NO_ENCONTRADO', 'No disponible.', 404);
  const request = await servidor(t);
  const respuesta = await request(casos[0].ruta);
  assert.equal(respuesta.status, 404);
  assert.equal(respuesta.headers['content-disposition'], undefined);
  assert.deepEqual(llamadas, []);
});

test('impresión HTML de catálogo no invoca el navegador del servidor', async t => {
  const request = await servidor(t);
  for (const caso of casos.slice(1)) {
    const respuesta = await request(caso.ruta.replace(/pdf$/, 'impresion'), { responseType: 'buffer' });
    assert.equal(respuesta.status, 200);
    assert.match(respuesta.headers['content-type'], /^text\/html/);
    assert.equal(respuesta.headers['content-disposition'], undefined);
  }
  assert.deepEqual(llamadas, []);
});

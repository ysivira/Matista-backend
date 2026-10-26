import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { casosDocumentosPdf } from '../../helpers/pdf.fixtures.js';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { documentoCatalogoHtml } from '../../../src/modules/admin/catalogo.impresion.js';
import { imprimirHtmlPdf } from '../../../src/infrastructure/pdf/html-pdf.js';
import { html, pesos, fecha } from '../../../src/infrastructure/pdf/formato-documental.js';

const referencia = JSON.parse(await readFile(new URL('../../fixtures/pdf/referencia-html.json', import.meta.url), 'utf8'));

/**
 * Invoca únicamente los contratos documentales públicos según el caso de referencia.
 * @param {object} caso Snapshot o catálogo sintético con tipo y opción de impresión.
 * @returns {Promise<string>} HTML autónomo sin conectar a servicios ni recalcular importes.
 */
function renderizarCaso(caso) {
  return caso.documento === 'cotizacion' ? cotizacionHtml(caso.datos, caso.contexto)
    : documentoCatalogoHtml(caso.datos, caso.tipo, caso.imprimir);
}

for (const caso of casosDocumentosPdf()) {
  /** Conserva todos los bytes de presentación, script y CSS y comprueba que no se altere la entrada. */
  test(`REFACTOR11 HTML exacto, autónomo y sin mutaciones: ${caso.id}`, async () => {
    const antes = structuredClone(caso);
    const documento = await renderizarCaso(caso);
    assert.equal(createHash('sha256').update(documento).digest('hex'), referencia.casos[caso.id].sha256);
    assert.deepEqual(caso, antes);
    assert.match(documento, /<style>/);
    assert.match(documento, /src="data:image\/png;base64,/);
    assert.doesNotMatch(documento, /<link\b|<script[^>]+src=|src="(?:file:|https?:|\/)/i);
    assert.doesNotMatch(documento, /\/\* MATISTA_/);
    const scripts = [...documento.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Script(scripts[0][1]));
  });
}

/** Protege los formatos compartidos al extraerlos, sin sustituir DECIMAL por números de punto flotante. */
test('REFACTOR11 formatos documentales conservan escape, precisión y fecha argentina', () => {
  assert.equal(html('<script> & "texto" \'fin\''), '&lt;script&gt; &amp; &quot;texto&quot; &#39;fin&#39;');
  assert.equal(html(null), '');
  assert.equal(pesos('999999999999999999.01'), '$ 999.999.999.999.999.999,01');
  assert.equal(pesos('0.05'), '$ 0,05');
  assert.equal(pesos('1234.5'), '$ 1.234,50');
  assert.equal(fecha('2026-10-24T01:00:00Z'), '23/10/2026');
});

/** Valida referencias, estados rechazados y la única diferencia autorizada al solicitar impresión. */
test('REFACTOR11 contratos de emisión e impresión permanecen iguales', async () => {
  assert.equal(casosDocumentosPdf().length, Object.keys(referencia.casos).length);
  const cotizacion = casosDocumentosPdf().find(c => c.id === 'cotizacion-rubi').datos;
  for (const estado of ['BORRADOR', 'ANULADA']) {
    await assert.rejects(cotizacionHtml({ ...cotizacion, estado }), { code: 'ASESOR_ESTADO', status: 409 });
    await assert.rejects(cotizacionPdf({ ...cotizacion, estado }), { code: 'ASESOR_ESTADO', status: 409 });
  }
  const lista = casosDocumentosPdf().find(c => c.id === 'lista-obligatorio');
  const normal = await documentoCatalogoHtml(lista.datos, lista.tipo);
  const impresion = await documentoCatalogoHtml(lista.datos, lista.tipo, true);
  assert.equal(impresion.replace('window.print();', ''), normal);
});

/** Comprueba Chrome real, A4, páginas, textos e importes en todos los casos sin depender del fixture temporal antiguo. */
test('REFACTOR11 PDF real: páginas y contenido de cotizaciones y catálogo', { skip: process.env.RUN_PDF_TESTS !== '1' }, async () => {
  const temporal = await mkdtemp(path.join(tmpdir(), 'matista-pdf-compatibilidad-'));
  try {
    for (const caso of casosDocumentosPdf()) {
      const documento = await renderizarCaso(caso);
      const pdf = caso.documento === 'cotizacion' ? await cotizacionPdf(caso.datos, caso.contexto) : await imprimirHtmlPdf(documento);
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      const archivo = path.join(temporal, caso.id + '.pdf');
      await writeFile(archivo, pdf, { mode: 0o600 });
      const info = execFileSync('pdfinfo', [archivo], { encoding: 'utf8' });
      assert.equal(Number(info.match(/Pages:\s+(\d+)/)[1]), referencia.casos[caso.id].paginas, caso.id);
      assert.match(info, /Page size:.*A4/);
      const texto = execFileSync('pdftotext', ['-layout', archivo, '-'], { encoding: 'utf8' });
      if (caso.documento === 'cotizacion') {
        assert.ok(texto.includes(caso.id === 'cotizacion-beneficios-iva-tramos' ? '151.164,00' : '199.926,44'), caso.id);
      }
      if (caso.id.includes('tablas-extensas')) assert.ok(texto.includes('Prestación 90'), caso.id);
      if (caso.id === 'cotizacion-parrafo-extenso') assert.equal((texto.match(/Párrafo extenso que no puede omitirse\./g) ?? []).length, 150);
      if (caso.id === 'cotizacion-beneficios-iva-tramos') assert.ok(!texto.includes('160.000,00'));
    }
  } finally {
    // Solo se elimina el directorio privado creado para esta prueba, nunca recursos del proyecto.
    await rm(temporal, { recursive: true, force: true });
  }
});

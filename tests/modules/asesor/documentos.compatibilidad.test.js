/**
 * ============================================================
 * MATISTA | COMPATIBILIDAD DOCUMENTAL
 * ============================================================
 *
 * Archivo: documentos.compatibilidad.test.js
 * Módulo: Pruebas documentales
 *
 * Responsabilidad:
 * Contrastar documentos con referencias históricas y detectar
 * cambios de contenido; el PDF real requiere RUN_PDF_TESTS.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { casosDocumentosPdf } from '../../helpers/pdf.fixtures.js';
import {
  contratoCss, contratoDocumento, contratoPaginacion,
  reconstruirDocumento, separarEstilos, sha256
} from '../../helpers/documentos.contratos.js';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { documentoCatalogoHtml } from '../../../src/modules/admin/catalogo.impresion.js';
import { imprimirHtmlPdf } from '../../../src/infrastructure/pdf/html-pdf.js';
import { html, pesos, fecha } from '../../../src/infrastructure/pdf/formato-documental.js';

const referencia = JSON.parse(await readFile(new URL('../../fixtures/pdf/referencia-html.json', import.meta.url), 'utf8'));
const contratos = JSON.parse(await readFile(new URL('../../fixtures/pdf/referencia-contratos.json', import.meta.url), 'utf8'));
const historia = JSON.parse(await readFile(new URL('../../fixtures/pdf/referencia-html-historica.json', import.meta.url), 'utf8'));
const logoHistorico = await readFile(new URL('../../../src/infrastructure/pdf/assets/logo-matista.png', import.meta.url));

/**
 * Invoca únicamente los contratos documentales públicos según el caso de referencia.
 * @param {object} caso Snapshot o catálogo sintético con tipo y opción de impresión.
 * @returns {Promise<string>} HTML autónomo sin conectar a servicios ni recalcular importes.
 */
function renderizarCaso(caso) {
  return caso.documento === 'cotizacion' ? cotizacionHtml(caso.datos, caso.contexto)
    : documentoCatalogoHtml(caso.datos, caso.tipo, caso.imprimir);
}

/**
 * Reconstruye una referencia y autentica todos sus bytes con los hashes originales.
 * @param {string} id Escenario histórico de los fixtures documentales.
 * @returns {string} HTML histórico completo, con su CSS original y recurso fijado por hash.
 * @throws {AssertionError} Si la referencia, el recurso o cualquiera de los hashes fue alterado.
 */
function documentoHistorico(id) {
  const esperado = contratos.casos[id];
  assert.equal(historia.origen, referencia.commit, 'Origen de los fragmentos históricos');
  assert.deepEqual(Object.keys(historia.casos), Object.keys(referencia.casos));
  assert.equal(sha256(logoHistorico), historia.logoSha256, 'Integridad del recurso histórico');
  const fragmentos = historia.casos[id].map(fragmento =>
    fragmento.replaceAll('__MATISTA_LOGO_HISTORICO__', 'data:image/png;base64,' + logoHistorico.toString('base64')));
  assert.equal(sha256(JSON.stringify(fragmentos)), esperado.sha256SinCss, 'Integridad del HTML histórico');
  const estilosHistoricos = esperado.estilos.map(id => {
    assert.equal(sha256(contratos.estilos[id]), id, 'Integridad del CSS histórico');
    return contratos.estilos[id];
  });
  const anterior = reconstruirDocumento({ fragmentos, estilos: estilosHistoricos });
  // Los hashes originales autentican la referencia, no el HTML reformateado.
  assert.equal(sha256(anterior), referencia.casos[id].sha256, 'Integridad del documento histórico completo');
  return anterior;
}

for (const caso of casosDocumentosPdf()) {
  /** Compara estructura y contenido con una referencia cuyos bytes históricos siguen verificados. */
  test(`SPEC22 compatibilidad estructural contra historia: ${caso.id}`, async () => {
    const anterior = documentoHistorico(caso.id);
    assert.deepEqual(contratoDocumento(await renderizarCaso(caso)), contratoDocumento(anterior));
  });

  /** Compara CSS por separado, sin ordenar ni descartar reglas, declaraciones o valores desconocidos. */
  test(`FIX19 contrato CSS ordenado: ${caso.id}`, async () => {
    const partes = separarEstilos(await renderizarCaso(caso));
    const esperado = contratos.casos[caso.id];
    assert.equal(partes.estilos.length, esperado.estilos.length);
    partes.estilos.forEach((css, indice) => {
      assert.deepEqual(contratoCss(css), contratoCss(contratos.estilos[esperado.estilos[indice]]));
    });
  });

  /** La verificación de inmutabilidad se ejecuta aunque fallen los contratos HTML o CSS. */
  test(`FIX19 documento sin mutaciones: ${caso.id}`, async () => {
    const antes = structuredClone(caso);
    await renderizarCaso(caso);
    assert.deepEqual(caso, antes);
  });

  /** Comprueba recursos autónomos y ausencia de marcadores pendientes independientemente del hash. */
  test(`FIX19 seguridad y recursos autónomos: ${caso.id}`, async () => {
    const documento = await renderizarCaso(caso);
    assert.match(documento, /<style>/);
    assert.match(documento, /src="data:image\/png;base64,/);
    assert.doesNotMatch(documento, /<link\b|<script[^>]+src=|src="(?:file:|https?:|\/)/i);
    assert.doesNotMatch(documento, /\/\* MATISTA_/);
  });

  /** Compila el script sin ejecutarlo y exige uno solo, aunque falle otra prueba del documento. */
  test(`FIX19 sintaxis de paginación: ${caso.id}`, async () => {
    const documento = await renderizarCaso(caso);
    const scripts = [...documento.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Script(scripts[0][1]));
  });
}

const mutacionesDocumentales = [
  ['importe', '$ 199.926,44', '$ 199.926,45'],
  ['condición contractual eliminada', '<p class="texto-oficial">Condiciones oficiales sintéticas &amp; referencias.</p>', ''],
  ['atributo HTML', '<main id="documento">', '<main id="otro">'],
  ['regla CSS', 'height:297mm', 'height:298mm'],
  ['lógica de paginación', 'contenido.scrollHeight>contenido.clientHeight+1', 'contenido.scrollHeight>contenido.clientHeight+2'],
  ['texto significativo', '<h1>Cotización comercial</h1>', '<h1>Cotización alterada</h1>'],
  ['entidad HTML', '&amp; referencias.', '&#38; referencias.'],
  ['contenido de template', '<template id="catalogo">', '<template id="catalogo-alterado">'],
  ['texto del script', "'Página '", "'Página  '"],
  ['agrupación aritmética', "(hoja.querySelector('footer').offsetTop-contenido.offsetTop-12)", "(hoja.querySelector('footer').offsetTop-(contenido.offsetTop-12))"],
  ['recurso autónomo', 'src="data:image/png;base64,', 'src="https://example.test/'],
];
for (const [nombre, antes, despues] of mutacionesDocumentales) {
  /** Muta una referencia autenticada en memoria; nunca escribe fixtures ni producción. */
  test(`SPEC22 contrato estructural detecta ${nombre}`, () => {
    const original = documentoHistorico('cotizacion-rubi');
    assert.ok(original.includes(antes), `La mutación ${nombre} debe alcanzar su objetivo`);
    const modificado = original.replace(antes, despues);
    assert.notEqual(modificado, original);
    assert.notDeepEqual(contratoDocumento(modificado), contratoDocumento(original));
  });
}

const espaciosSignificativos = [
  ['inline dentro de body', '<body><span>A</span> <span>B</span></body>', '<body><span>A</span><span>B</span></body>'],
  ['inline dentro de div', '<div><span>A</span> <span>B</span></div>', '<div><span>A</span><span>B</span></div>'],
  ['texto directo junto a un contenedor', '<body>A <div>B</div></body>', '<body>A<div>B</div></body>'],
  ['pre', '<pre>A\n B</pre>', '<pre>A B</pre>'],
  ['textarea', '<textarea>A\n B</textarea>', '<textarea>A B</textarea>'],
  ['celda vacía frente a un espacio', '<table><tbody><tr><td> </td></tr></tbody></table>', '<table><tbody><tr><td></td></tr></tbody></table>'],
  ['nota pre-wrap', '<p class="nota">A\n B</p>', '<p class="nota">A B</p>'],
  ['texto oficial pre-wrap', '<p class="texto-oficial">A\n B</p>', '<p class="texto-oficial">A B</p>'],
  ['atributo con espacio', '<div title="A B"></div>', '<div title="AB"></div>'],
  ['clase aparente dentro de title', `<div title=' class="plan"'><span>A</span> <span>B</span></div>`, `<div title=' class="plan"'><span>A</span><span>B</span></div>`],
];
for (const [nombre, antes, despues] of espaciosSignificativos) {
  /** Conserva blancos que pueden afectar texto, atributos o contenido preformateado. */
  test(`SPEC22 conserva espacio significativo: ${nombre}`, () => {
    assert.notDeepEqual(contratoDocumento(antes), contratoDocumento(despues));
  });
}

/** Admite indentación solo entre filas/celdas, sin tocar el interior de una celda. */
test('SPEC22 admite formato seguro en estructura de tabla', () => {
  assert.deepEqual(
    contratoDocumento('<table><tbody><tr><td>A &amp; B</td></tr></tbody></table>'),
    contratoDocumento('<table>\n  <tbody>\n    <tr>\n      <td>A &amp; B</td>\n    </tr>\n  </tbody>\n</table>')
  );
});

/** La tokenización permite formato de instrucciones sin quitar contenido de literales. */
test('SPEC22 admite formato JavaScript conservando sus tokens', () => {
  assert.deepEqual(
    contratoPaginacion("function excede(){return contenido.scrollHeight>contenido.clientHeight+1;}"),
    contratoPaginacion("function excede() {\n  return contenido.scrollHeight > contenido.clientHeight + 1;\n}")
  );
});

/** Los saltos tras return, async y antes de ++ pueden modificar la semántica mediante ASI. */
test('SPEC22 detecta saltos JavaScript significativos para ASI', () => {
  for (const [antes, despues] of [
    ['function f(){return valor;}', 'function f(){return\nvalor;}'],
    ['function f(){return valor;}', 'function f(){return/*\n*/valor;}'],
    ['valor++;', 'valor\n++;'],
    ['async function f(){}', 'async\nfunction f(){}'],
    ['function f(){let a=1,b=1;a++\nb;}', 'function f(){let a=1,b=1;a\n++b;}'],
  ]) {
    const esperado = contratoPaginacion(antes);
    // También es un rechazo válido que el cambio deje de ser sintácticamente correcto.
    assert.throws(() => assert.deepEqual(contratoPaginacion(despues), esperado));
  }
});

/** Una sintaxis no cubierta se rechaza: nunca se ignoran templates ni HTML ambiguo. */
test('SPEC22 contrato estructural falla cerrado fuera de su gramática', () => {
  assert.throws(() => contratoPaginacion('const texto = `A`;'));
  assert.throws(() => contratoPaginacion('const patron = /A/;'));
  assert.throws(() => contratoDocumento('<div><span></div>'));
  assert.throws(() => contratoDocumento('<style>.a{color:red}'));
  assert.throws(() => contratoDocumento('<script>const a = ;</script>'));
});

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
  assert.deepEqual(Object.keys(contratos.casos), Object.keys(referencia.casos));
  assert.equal(contratos.origen, referencia.commit);
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

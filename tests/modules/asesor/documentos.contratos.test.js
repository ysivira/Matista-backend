/**
 * ============================================================
 * MATISTA | SENSIBILIDAD DE CONTRATOS DOCUMENTALES
 * ============================================================
 *
 * Archivo: documentos.contratos.test.js
 * Módulo: Pruebas documentales
 *
 * Responsabilidad:
 * Probar que el comparador admite formato CSS neutro y rechaza
 * mutaciones de selectores, valores, orden y fragmentos HTML.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { contratoCss, reconstruirDocumento, separarEstilos, sha256 } from '../../helpers/documentos.contratos.js';

/** Demuestra que el CSS protegido actual y el histórico verificado solo difieren en formato. */
test('FIX19 sensibilidad: CSS real reindentado conserva el contrato histórico', async () => {
  const referencias = JSON.parse(await readFile(new URL('../../fixtures/pdf/referencia-contratos.json', import.meta.url), 'utf8'));
  const css = await readFile(new URL('../../../src/modules/asesor/documentos/cotizacion.css', import.meta.url), 'utf8');
  const id = referencias.casos['cotizacion-rubi'].estilos[0];
  assert.deepEqual(contratoCss(css), contratoCss(referencias.estilos[id]));
});

const compacta = '@page{size:A4;margin:0}@media print{.a,.b{color:red;color:blue!important;margin:1px 2px}}';
const formateada = `
  @page { size: A4; margin: 0; }
  @media  print {
    .a, .b {
      color: red;
      color: blue!important;
      margin: 1px  2px;
    }
  }
`;

/** Cubre saltos CRLF/tabulaciones, blancos de indentación y punto y coma final opcional. */
test('FIX19 sensibilidad: formato inocuo de reglas, declaraciones, comas y medios no falla', () => {
  assert.deepEqual(contratoCss(compacta), contratoCss(formateada));
  assert.deepEqual(contratoCss(compacta), contratoCss(formateada.replaceAll('\n', '\r\n\t')));
  assert.deepEqual(contratoCss('.a{color:red}'), contratoCss('/* comentario */ .a { color: red; }'));
  assert.deepEqual(contratoCss('.a{color:red!important}'), contratoCss('.a {color: red ! important;}'));
  assert.deepEqual(contratoCss('.a>.b+.c~.d{color:red}'), contratoCss('.a > .b + .c ~ .d {color:red}'));
  assert.deepEqual(contratoCss('@media screen and (max-width:800px){.a{color:red}}'),
    contratoCss('@media screen and ( max-width : 800px ) { .a { color: red; } }'));
  assert.deepEqual(contratoCss('@supports(display:grid){.a{color:red}}'),
    contratoCss('@supports( display : grid ) { .a { color: red; } }'));
});

const mutacionesCss = [
  ['selector', '.a,.b', '.a,.c'],
  ['color/valor', 'color:red', 'color:green'],
  ['margen', 'margin:1px 2px', 'margin:2px 2px'],
  ['tamaño de página', 'size:A4', 'size:A3'],
  ['prioridad', 'blue!important', 'blue'],
  ['orden de declaraciones duplicadas', 'color:red;color:blue!important', 'color:blue!important;color:red'],
  ['declaración duplicada eliminada', 'color:red;', ''],
  ['condición de medios', '@media print', '@media screen'],
];
for (const [nombre, anterior, nuevo] of mutacionesCss) {
  /** Cada mutación semántica se compara con el contrato sin modificar referencias ni archivos CSS. */
  test(`FIX19 sensibilidad CSS detecta ${nombre}`, () => {
    const modificado = compacta.replace(anterior, nuevo);
    assert.notEqual(modificado, compacta);
    assert.notDeepEqual(contratoCss(modificado), contratoCss(compacta));
  });
}

const paresDistintos = [
  ['tamaño de fuente', '.a{font-size:10pt}', '.a{font-size:11pt}'],
  ['orden de reglas que afecta cascada', '.a{color:red}.a{color:blue}', '.a{color:blue}.a{color:red}'],
  ['selector descendiente frente a pseudoclase', '.a :hover{color:red}', '.a:hover{color:red}'],
  ['selector funcional en condición', '@supports selector(a :hover){.a{color:red}}', '@supports selector(a:hover){.a{color:red}}'],
  ['límite de tokens por comentario', '.a{width:1/**/px}', '.a{width:1px}'],
  ['hash separado por comentario', '.a{color:#/**/abc}', '.a{color:#abc}'],
  ['número separado por comentario', '.a{opacity:1/**/.2}', '.a{opacity:1.2}'],
  ['función separada por comentario', '.a{width:calc/**/(1px)}', '.a{width:calc(1px)}'],
  ['espacios en cadena', '.a{content:"a b ; , : { }"}', '.a{content:"ab ; , : { }"}'],
  ['cadena con comilla escapada', String.raw`.a{content:"a\" b"}`, String.raw`.a{content:"a\"b"}`],
  ['escape hexadecimal y terminador', String.raw`.\31 a{color:red}`, String.raw`.\31a{color:red}`],
  ['propiedad desconocida por navegador', '.a{matista-desconocida:uno}', '.a{matista-desconocida:dos}'],
  ['at-rule desconocida por navegador', '@matista nueva{dato:uno}', '@matista nueva{dato:dos}'],
  ['valores desconocidos duplicados', '.a{color:matista; color:red}', '.a{color:red}'],
  ['variable CSS y blancos significativos', '.a{--texto: a b}', '.a{--texto: ab}'],
  ['variable CSS vacía frente a espacio', '.a{--texto:}', '.a{--texto: }'],
  ['URL con signos de comentario', '.a{background:url(data:image/svg+xml,a/*b)}', '.a{background:url(data:image/svg+xml,ab)}'],
  ['media anidado', '@media print{@supports(display:grid){.a{margin:1px}}}', '@media print{@supports(display:flex){.a{margin:1px}}}'],
];
for (const [nombre, antes, despues] of paresDistintos) {
  /** Protege diferencias que se perderían al borrar blancos o al usar solo CSSOM del navegador. */
  test(`FIX19 sensibilidad CSS preserva ${nombre}`, () => {
    assert.notDeepEqual(contratoCss(antes), contratoCss(despues));
  });
}

for (const css of ['.a{color:red', '.a{content:"sin cierre}', '.a{width:calc(2px}', '/* sin cierre', '.a{color:red}}', '.a{.b{color:red}}', String.raw`.a{background:u\72l(data:a)}`]) {
  /** La sintaxis fuera del contrato soportado falla explícitamente en lugar de ignorarse. */
  test(`FIX19 CSS falla cerrado: ${css}`, () => {
    assert.throws(() => contratoCss(css), assert.AssertionError);
  });
}

const documento = '<!doctype html><html><head><!-- <style>falso</style> --><style media="print">.a{color:red}</style></head>'
  + '<body data-ejemplo="<style>atributo</style>"><p style="color:red">A &amp; B</p>'
  + '<style>.b{margin:1px}</style><script>const ejemplo = "<style>script</style>";</script></body></html>';

/** Comprueba separación inequívoca y reconstrucción exacta con dos estilos y falsos positivos raw-text. */
test('FIX19 HTML solo excluye contenidos de style reales, sin tocar comentarios, atributos o scripts', () => {
  const partes = separarEstilos(documento);
  assert.deepEqual(partes.estilos, ['.a{color:red}', '.b{margin:1px}']);
  assert.equal(reconstruirDocumento(partes), documento);
  const reindentado = reconstruirDocumento(partes, ['\n .a { color: red; }\n', '.b { margin: 1px; }']);
  assert.deepEqual(separarEstilos(reindentado).fragmentos, partes.fragmentos);
  assert.throws(() => reconstruirDocumento(partes, ['.a{}']), assert.AssertionError);
});

const mutacionesHtml = [
  ['texto', 'A &amp; B', 'A &amp; C'],
  ['escape', '&amp;', '&'],
  ['atributo', 'data-ejemplo=', 'data-otro='],
  ['estilo inline', 'style="color:red"', 'style="color:blue"'],
  ['atributo de style', 'media="print"', 'media="screen"'],
  ['script', 'const ejemplo', 'let ejemplo'],
  ['espaciado no CSS', '<p style=', '<p  style='],
  ['cantidad de style', '<style>.b{margin:1px}</style>', ''],
  ['posición de style', '<style>.b{margin:1px}</style><script>', '<script>'],
  ['referencia embebida', 'data-ejemplo=', 'src='],
];
for (const [nombre, anterior, nuevo] of mutacionesHtml) {
  /** Toda diferencia fuera del texto de style debe cambiar el contrato estricto de fragmentos. */
  test(`FIX19 sensibilidad HTML detecta ${nombre}`, () => {
    let modificado = documento.replace(anterior, nuevo);
    if (nombre === 'posición de style') modificado = modificado.replace('</body>', '<style>.b{margin:1px}</style></body>');
    assert.notEqual(sha256(JSON.stringify(separarEstilos(modificado).fragmentos)),
      sha256(JSON.stringify(separarEstilos(documento).fragmentos)));
  });
}

/** Rechaza un cierre ambiguo en vez de normalizar silenciosamente un documento inválido. */
test('FIX19 HTML falla cerrado ante style/comentario sin cierre', () => {
  for (const html of ['<style>.a{}', '<!-- sin cierre', '<style media="print>']) {
    assert.throws(() => separarEstilos(html), assert.AssertionError);
  }
});

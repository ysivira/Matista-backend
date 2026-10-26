import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { calcularCotizacion } from '../../../src/domain/comercial/cotizacion.engine.js';
import { REGLAS_COMERCIALES } from '../../../src/domain/comercial/reglas.confirmadas.js';

/** Crea una emisión sintética con economía del motor y texto oficial recibido, sin escribir en MySQL. */
function emision(plan = { nombre: 'RUBÍ', condiciones_generales: 'Texto oficial\n\nSegundo párrafo & <literal>.' }) {
  const solicitud = { version_contrato: 1, referencias: { tarifa_version_id: '1', politica_id: '2' },
    cliente: { nombres: 'Titular', apellidos: 'Prueba', dni: '12345678' }, plan,
    asesor: { nombre: 'Asesor', apellido: 'Comercial', legajo: '999' },
    entrada: { modalidad: 'Obligatorio', familia: { titular: { edad: 35, estado_civil: 'SOLTERO' }, miembros: [] }, aportes: { sueldo_bruto: '1050.79' },
      condiciones: { esquema: 'TRAMOS', tramos: [], tdc: false, beneficios: { solicita_afinidad: false } } },
    catalogo: { tarifas: [{ rango_clave: '26-35', precio: '200000.00' }], porcentajes: [], politica: {
      comercial_fijo_max_pct: '40.00', comercial_fijo_meses_max: 12, comercial_escalonado_max_pct: '50.00', comercial_escalonado_tramos_max: 4,
      comercial_escalonado_total_meses_max: 12, primer_tramo_50_meses_max: 3, tope_comercial_tdc_pct: '55.00',
      porcentaje_aporte_reconocido: '7.00', tope_sueldo_bruto: '4800000.00', joven_porcentaje: '0.00' } } };
  return { estado: 'EMITIDA', numero: 'MAT-PRUEBA-004', emitida_at: '2026-10-24T15:00:00Z', modalidad: 'Obligatorio', solicitud,
    resultado: calcularCotizacion(solicitud, REGLAS_COMERCIALES), contacto: {} };
}

test('PDF HTML: identidad oficial, importes persistidos y condiciones literales sin beneficios cero', async () => {
  const q = emision(); const antes = JSON.stringify(q);
  const html = await cotizacionHtml(q);
  assert.ok(html.includes('template id="comercial"')); assert.ok(html.includes('template id="catalogo"'));
  for (const texto of ['MAT-PRUEBA-004', 'Asesor Comercial', '$ 199.926,44', '$ 73,56', 'Segundo párrafo &amp; &lt;literal&gt;.']) assert.ok(html.includes(texto), texto);
  assert.ok(!html.includes('Beneficio TDC')); assert.ok(!html.includes('Beneficio Afinidad'));
  assert.ok(!html.includes('Condiciones comerciales pactadas'));
  assert.equal(JSON.stringify(q), antes);
  await assert.rejects(cotizacionHtml({ ...q, estado: 'BORRADOR' }), { code: 'ASESOR_ESTADO' });
});

test('PDF HTML: ausencia oficial explícita y respaldo para snapshot antiguo sin alterarlo', async () => {
  const q = emision({ nombre: 'Histórico' });
  assert.match(await cotizacionHtml(q), /no contiene condiciones generales/);
  assert.match(await cotizacionHtml(q, { plan: { condiciones_generales: 'Condiciones recuperadas del catálogo' } }), /Condiciones recuperadas del catálogo/);
  assert.equal(Object.hasOwn(q.solicitud.plan, 'condiciones_generales'), false);
});

test('PDF usa el resultado histórico, muestra porcentajes futuros pero nunca sus importes', async () => {
  const q = emision();
  q.solicitud.entrada.aportes.sueldo_bruto = '999999.00'; // El dato cambió, el PDF no debe recalcular el resultado capturado.
  q.resultado.tramos.push({ desde_mes: 4, hasta_mes: 6, porcentaje_comercial: '45.00', total: '87654.32' });
  const html = await cotizacionHtml(q);
  assert.ok(html.includes('$ 199.926,44')); assert.ok(html.includes('$ 73,56'));
  assert.ok(html.includes('Meses 4 a 6')); assert.ok(html.includes('45,00 %'));
  assert.ok(!html.includes('87.654,32')); assert.ok(!html.includes('87654.32'));
});

test('Chrome real: cuatro catálogos completos y continuación legible de condiciones extensas', { skip: process.env.RUN_PDF_TESTS !== '1' }, async () => {
  const audit = JSON.parse(await readFile('/tmp/opencode/ui05/catalogo.json', 'utf8'));
  await mkdir('/tmp/opencode/ui05/pdf', { recursive: true });
  for (const plan of audit.planes) {
    const q = emision(plan), archivo = `/tmp/opencode/ui05/pdf/plan-${plan.id}.pdf`;
    await writeFile(archivo, await cotizacionPdf(q));
    const paginas = Number(execFileSync('pdfinfo', [archivo], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]);
    assert.ok(paginas >= 2);
    const primera = execFileSync('pdftotext', ['-f', '1', '-l', '1', archivo, '-'], { encoding: 'utf8' });
    const siguientes = execFileSync('pdftotext', ['-f', '2', archivo, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
    assert.ok(primera.includes('199.926,44')); assert.ok(primera.includes('73,56'));
    assert.ok(!primera.includes('Beneficio TDC'));
    assert.ok(siguientes.includes('Condiciones generales'));
    for (const celda of plan.detalles.split(/[\n|]/).filter(c => c.trim())) assert.ok(siguientes.includes(celda.replace(/\s+/g, ' ').trim()), celda);
    assert.ok(siguientes.includes(plan.condiciones_generales.replace(/\s+/g, ' ')));
  }
  const archivo = '/tmp/opencode/ui05/pdf/condiciones-extensas.pdf';
  await writeFile(archivo, await cotizacionPdf(emision({ nombre: 'Extenso sintético', condiciones_generales: 'Párrafo extenso que no puede omitirse.\n'.repeat(150) })));
  assert.ok(Number(execFileSync('pdfinfo', [archivo], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1]) > 2);
  const texto = execFileSync('pdftotext', [archivo, '-'], { encoding: 'utf8' });
  assert.equal((texto.match(/Párrafo extenso que no puede omitirse\./g) ?? []).length, 150);
});

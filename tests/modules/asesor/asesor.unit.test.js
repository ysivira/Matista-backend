import assert from 'node:assert/strict';
import test from 'node:test';
import { validarPreparacion, validarCliente } from '../../../src/modules/asesor/asesor.validation.js';
import { solicitarCalculo, esResultadoEconomico } from '../../../src/modules/asesor/motor.contract.js';
import { cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { listaCsv } from '../../../src/modules/admin/catalogo.documentos.js';
import { loadMigrations } from '../../../src/infrastructure/database/migration-runner.js';
import { documentoCatalogoHtml } from '../../../src/modules/admin/catalogo.impresion.js';

/** Devuelve entrada sintética sin fórmulas ni importes oficiales. */
function entrada() {
  return { cliente_id: '1', plan_id: '1', modalidad: 'Voluntario', familia: { titular: { edad: 25, estado_civil: 'SOLTERO' }, miembros: [] },
    aportes: {}, condiciones: { tramos: [], tdc: false, beneficios: { solicita_afinidad: false } } };
}

test('acepta estructura declarativa y rechaza resultados económicos o propiedad inyectados', () => {
  assert.deepEqual(validarPreparacion(entrada()), entrada());
  for (const dato of [{ total: '1.00' }, { asesor_legajo: '1' }, { resultado: {} }, { estado: 'EMITIDA' }]) {
    assert.throws(() => validarPreparacion({ ...entrada(), ...dato }), { code: 'ASESOR_VALIDACION' });
  }
  const datos = entrada(); datos.condiciones.tramos.push({ porcentaje_id: '1', meses: 1, total: '0.00' });
  assert.throws(() => validarPreparacion(datos), { code: 'ASESOR_VALIDACION' });
});

test('modalidades exigen sus datos declarados y familia no permite otro titular', () => {
  assert.throws(() => validarPreparacion({ ...entrada(), modalidad: 'Obligatorio' }), { code: 'ASESOR_VALIDACION' });
  assert.equal(validarPreparacion({ ...entrada(), modalidad: 'Obligatorio', aportes: { sueldo_bruto: '100000.00' } }).modalidad, 'Obligatorio');
  assert.equal(validarPreparacion({ ...entrada(), modalidad: 'Monotributo', aportes: { categoria: 'A', adherentes: 0 } }).modalidad, 'Monotributo');
  const datos = entrada(); datos.familia.miembros.push({ parentesco: 'TITULAR', edad: 20 });
  assert.throws(() => validarPreparacion(datos), { code: 'ASESOR_VALIDACION' });
});

test('cliente se registra con identidad y contacto, sin familia ni propiedad', () => {
  const base = { dni: '12345678', nombres: 'Test', apellidos: 'Test' };
  const registrado = validarCliente({ ...base, email: 't@example.test', fecha_nacimiento: '1999-02-15', provincia: 'Córdoba', localidad: 'Villa María' });
  assert.equal(registrado.fecha_nacimiento, '1999-02-15');
  assert.deepEqual(registrado.provincia, 'Córdoba'); assert.equal(registrado.localidad, 'Villa María');
  assert.equal('familia' in registrado, false);
  // Los registros históricos permanecen editables sin fecha de nacimiento ni ubicación.
  const historico = validarCliente({ ...base });
  assert.equal(historico.fecha_nacimiento, null); assert.equal(historico.provincia, null); assert.equal(historico.localidad, null);
  // La composición familiar ya no pertenece al contrato de escritura del cliente.
  assert.throws(() => validarCliente({ ...base, familia: entrada().familia }), { code: 'ASESOR_VALIDACION' });
  assert.throws(() => validarCliente({ ...base, asesor_legajo: '1' }), { code: 'ASESOR_VALIDACION' });
});

test('fecha de nacimiento rechaza formato, futuras, imposibles y superiores al tope de edad', () => {
  const base = { dni: '12345678', nombres: 'Test', apellidos: 'Test' };
  for (const fecha of ['15/12/1999', '1999-13-01', '1999-02-29', '2999-01-01', '1899-01-01']) {
    assert.throws(() => validarCliente({ ...base, fecha_nacimiento: fecha }), { code: 'ASESOR_VALIDACION' }, fecha);
  }
  assert.equal(validarCliente({ ...base, fecha_nacimiento: '2004-02-29' }).fecha_nacimiento, '2004-02-29');
});

test('contrato incompleto no fabrica resultado y PDF rechaza borrador', async () => {
  await assert.rejects(solicitarCalculo({ version_contrato: 1, entrada: entrada() }), { code: 'ASESOR_VALIDACION', status: 400 });
  assert.equal(esResultadoEconomico({ total: '1.00' }), false);
  await assert.rejects(cotizacionPdf({ estado: 'BORRADOR' }), { code: 'ASESOR_ESTADO', status: 409 });
});

test('CSV conserva precio real y neutraliza fórmulas de hojas de cálculo', () => {
  const csv = listaCsv({ plan: { nombre: '=test' }, tipo_ingreso: 'Voluntario', version: { id: 1 }, tarifas: [{ rango_etario: '0-25', precio: '123.45', rango_nota: null }] });
  assert.ok(csv.includes("'=test")); assert.ok(csv.includes('123.45'));
});

test('documentos comparten logo y tablas, escapan texto y presentan precios/fechas argentinos', async () => {
  const plan = { nombre: 'RUBÍ', detalles: 'Consulta | 100% | Sin cargo\nTexto ambiguo <script> | original', condiciones_generales: 'Información íntegra & vigente' };
  const ficha = await documentoCatalogoHtml(plan, 'plan');
  assert.match(ficha, /data:image\/png;base64/);
  assert.match(ficha, /<th>Prestación<\/th><th>Cobertura<\/th><th>Observaciones<\/th>/);
  assert.match(ficha, /<td>Consulta<\/td><td>100%<\/td><td>Sin cargo<\/td>/);
  assert.match(ficha, /Texto ambiguo &lt;script&gt; \| original/);
  assert.match(ficha, /Información íntegra &amp; vigente/);
  const lista = { plan, tipo_ingreso: 'Voluntario', version: { id: '2', fecha_activacion: '2026-10-23T12:00:00Z' }, tarifas: [{ rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '221788.31' }] };
  const pdf = await documentoCatalogoHtml(lista, 'precios');
  const impresion = await documentoCatalogoHtml(lista, 'precios', true);
  assert.match(pdf, /\$ 221\.788,31/); assert.match(pdf, /23\/10\/2026/); assert.ok(!pdf.includes('2026-10-23T'));
  assert.equal(impresion.replace('window.print();', ''), pdf);
  assert.ok(!pdf.includes('<small>(*)</small>')); assert.match(pdf, /HIJO 0-1\(\*\)/);
});

test('migraciones ASESOR preservan FK de propiedad y guardia de emisión sin alterar 001–023', async () => {
  const m = (await loadMigrations(new URL('../../../migrations', import.meta.url).pathname)).slice(23);
  assert.deepEqual(m.map(x => x.targetTable), ['clientes', 'cotizaciones', 'miembros_cotizacion', 'asesor_auditoria', 'cotizaciones', 'politica_comercial', 'clientes']);
  assert.equal(m[6].kind, 'alter');
  assert.match(m[6].sql, /fecha_nacimiento DATE NULL/);
  assert.match(m[6].sql, /MODIFY familia JSON NULL/);
  assert.doesNotMatch(m[6].sql, /\b(UPDATE|DELETE|DROP)\b/i);
  assert.match(m[1].sql, /FOREIGN KEY \(cliente_id, asesor_legajo\)/);
  assert.match(m[1].sql, /INTERVAL 15 DAY/);
  assert.match(m[1].sql, /resultado IS NOT NULL/);
  assert.match(m[4].sql, /vence_at IS NOT NULL/);
  assert.match(m[4].sql, /JSON_TYPE\(resultado\) = 'OBJECT'/);
});

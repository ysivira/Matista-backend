import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularCotizacion, segmentoIntegrante } from '../../../src/domain/comercial/cotizacion.engine.js';
import { REGLAS_COMERCIALES } from '../../../src/domain/comercial/reglas.confirmadas.js';
import { erroresDescuentos } from '../../../src/domain/comercial/descuentos.validation.js';
import { calcularEdad } from '../../../src/domain/comercial/edad.js';
import { validarPreparacion } from '../../../src/modules/asesor/asesor.validation.js';
import { solicitarCalculo, esResultadoEconomico } from '../../../src/modules/asesor/motor.contract.js';

// RUBÍ, versión 27 de matista_test, consultada en solo lectura el 26/10/2026.
// Cada fila conserva clave y precios [Obligatorio, Voluntario]; no depende de MySQL al probar.
const TARIFAS_VERIFICADAS = [
  ['0-25', '172025.40', '184134.32'],
  ['26-35', '172025.75', '184134.32'],
  ['36-40', '191506.81', '204986.58'],
  ['41-50', '199093.52', '213107.68'],
  ['51-60', '297590.39', '318538.12'],
  ['61-65', '516075.30', '552401.23'],
  ['66+', '516075.30', '552401.23'],
  ['FAMILIAR A CARGO', '541879.30', '580021.99'],
  ['HIJO 0-1', '91460.76', '97898.48'],
  ['HIJO 2-20', '73168.61', '78317.30'],
  ['HIJO 21-29', '180626.69', '193339.99'],
  ['HIJO 30-39', '201083.56', '215236.31'],
  ['HIJO 40-49', '209046.27', '223760.50'],
  ['MAT 0-25', '241867.98', '258892.98'],
  ['MAT 26-35', '326858.10', '349842.20'],
  ['MAT 36-40', '363875.92', '389460.17'],
  ['MAT 41-50', '378278.43', '404903.95'],
  ['MAT 51-60', '565443.97', '605201.73'],
  ['MAT 61-65', '980578.85', '1049525.89'],
  ['MAT 66-00', '980543.74', '1049563.81'],
];

/** Crea datos sintéticos con parámetros explícitos, independientes de la base y de valores del frontend. */
function solicitud() {
  return { version_contrato: 1, referencias: { tarifa_version_id: '1', politica_id: '2' },
    entrada: { modalidad: 'Voluntario', familia: { titular: { edad: 30, estado_civil: 'SOLTERO' }, miembros: [] }, aportes: {},
      condiciones: { tramos: [], tdc: false, beneficios: { solicita_afinidad: false } } },
    catalogo: { tarifas: [{ rango_clave: '26-35', precio: '200000.00' }, { rango_clave: 'MAT 26-35', precio: '300000.00' }, { rango_clave: 'HIJO 2-20', precio: '50000.00' }],
      porcentajes: [{ id: 1, porcentaje: '20.00', vigente_hasta: null }, { id: 2, porcentaje: '50.00', vigente_hasta: null }],
      politica: { porcentaje_aporte_reconocido: '7.00', tope_sueldo_bruto: '4800000.00', joven_porcentaje: '26.00',
        comercial_fijo_max_pct: '50.00', comercial_fijo_meses_max: 12, comercial_escalonado_max_pct: '50.00', comercial_escalonado_tramos_max: 4, comercial_escalonado_total_meses_max: 12,
        primer_tramo_50_meses_max: 3, tdc_habilitado: 1, tdc_pct: '5.00', afinidad_pct: '10.00', tope_comercial_tdc_pct: '55.00',
        aporte_monotributo: '23892.00', aporte_adherente: '23892.00', iva_voluntario_pct: '10.50' } } };
}

/**
 * Combina las tarifas verificadas con la política sintética existente, sin leer ni escribir bases.
 * @param {number} edad Años declarados del titular.
 * @param {string} estadoCivil Estado civil contractual del titular.
 * @param {string} modalidad Régimen; Monotributo reutiliza la lista Obligatorio.
 * @returns {object} Solicitud nueva e independiente con contrato v1 y precios DECIMAL literales.
 */
function solicitudTarifarioVerificado(edad, estadoCivil = 'CASADO', modalidad = 'Obligatorio') {
  const s = solicitud();
  s.referencias.tarifa_version_id = '27';
  s.entrada = { ...s.entrada, cliente_id: '1', plan_id: '1', modalidad,
    familia: { titular: { edad, estado_civil: estadoCivil }, miembros: [] },
    aportes: modalidad === 'Voluntario' ? {} : modalidad === 'Obligatorio'
      ? { opcion_aporte: 'SUELDO', sueldo_bruto: '1000000.00' } : { categoria: 'A', adherentes: 1 } };
  s.catalogo.tarifas = TARIFAS_VERIFICADAS.map(([rango_clave, obligatorio, voluntario]) => ({
    rango_clave, precio: modalidad === 'Voluntario' ? voluntario : obligatorio,
  }));
  return s;
}

test('IVA configurable se aplica exclusivamente a Voluntario; centavos exactos HALF-UP', () => {
  const s = solicitud();
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '221000.00');
  s.catalogo.politica.iva_voluntario_pct = '21.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '242000.00');
  s.catalogo.tarifas[0].precio = '0.05'; s.catalogo.politica.iva_voluntario_pct = '10.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '0.06');
});

test('Obligatorio: bruto y aporte personal del recibo son equivalentes y respetan el mismo tope', () => {
  const s = solicitud(); s.entrada.modalidad = 'Obligatorio'; s.entrada.aportes = { sueldo_bruto: '1000000.00' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '130000.00');
  s.entrada.aportes = { opcion_aporte: 'PERSONAL_RECIBO', aporte_personal: '30000.00' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '130000.00');
  s.catalogo.tarifas[0].precio = '500000.00';
  s.entrada.aportes = { sueldo_bruto: '6000000.00' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '164000.00');
  s.entrada.aportes = { opcion_aporte: 'PERSONAL_RECIBO', aporte_personal: '180000.00' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '164000.00');
  s.entrada.aportes = { opcion_aporte: 'DECLARADO', aporte_obra_social: '30000.00' };
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /Identifica el dato anterior/);
});

test('Monotributo: categoría informativa y aporte unitario del titular compartido con adherentes', () => {
  const s = solicitud(); s.entrada.modalidad = 'Monotributo';
  s.entrada.familia.miembros = [{ parentesco: 'HIJO', edad: 10 }];
  s.entrada.aportes = { categoria: 'A', adherentes: 1 };
  const a = calcularCotizacion(s, REGLAS_COMERCIALES);
  assert.equal(a.precio_base, '250000.00'); assert.equal(a.total, '202216.00');
  s.entrada.aportes.categoria = 'K';
  assert.deepEqual(calcularCotizacion(s, REGLAS_COMERCIALES), a);
  s.catalogo.politica.aporte_adherente = '10000.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '202216.00');
  s.catalogo.politica.aporte_adherente = null;
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '202216.00');
  s.catalogo.politica.aporte_monotributo = '10000.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '230000.00');
  s.catalogo.politica.aporte_monotributo = null;
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /configurar el aporte monotributo/);
});

test('orden confirmado joven, comercial, TDC y afinidad con tope configurable compartido', () => {
  const s = solicitud(); s.entrada.familia.titular.edad = 29;
  s.catalogo.politica.tope_comercial_tdc_pct = '61.00';
  s.entrada.condiciones = { tramos: [{ porcentaje_id: '1', meses: 3 }], tdc: true, beneficios: { solicita_afinidad: true } };
  const r = calcularCotizacion(s, REGLAS_COMERCIALES);
  assert.deepEqual(r.tramos[0].desglose, { precio_base: '200000.00', descuento_joven: '52000.00', descuento_comercial: '29600.00', descuento_tdc: '5920.00', descuento_afinidad: '11248.00', aporte_base: '0.00', aporte_adherentes: '0.00', iva: '10629.36' });
  assert.equal(r.total, '111861.36');
  s.catalogo.politica.tope_comercial_tdc_pct = '60.00';
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /superan el tope/);
  s.catalogo.politica.tope_comercial_tdc_pct = '61.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, r.total);
});

test('matrimonio incluye cónyuge, no hay totales negativos y faltantes comerciales se rechazan', () => {
  const s = solicitud(); s.entrada.modalidad = 'Obligatorio'; s.entrada.aportes = { sueldo_bruto: '4800000.00' };
  s.entrada.familia = { titular: { edad: 30, estado_civil: 'CASADO' }, miembros: [{ parentesco: 'CONYUGE', edad: 31 }] };
  const r = calcularCotizacion(s, REGLAS_COMERCIALES); assert.equal(r.precio_base, '300000.00'); assert.equal(r.total, '0.00');
  s.entrada.familia.miembros.push({ parentesco: 'HIJO', edad: 5 });
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, '14000.00');
  s.entrada.condiciones.tramos = [{ porcentaje_id: '99', meses: 3 }];
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /porcentaje publicado/);
});

for (const pct of [40, 45, 50]) {
  for (const adicionales of [0, 5, 15]) {
    test(`campaña ${pct} %, adicionales ${adicionales} %: límite contractual y aplicación secuencial`, () => {
      const s = solicitud();
      s.catalogo.porcentajes = [{ id: 1, porcentaje: `${pct}.00`, vigente_hasta: null }];
      s.catalogo.politica.comercial_fijo_max_pct = '40.00';
      s.entrada.condiciones = { esquema: 'TRAMOS', tramos: [{ porcentaje_id: '1', meses: 3 }], tdc: adicionales > 0, beneficios: { solicita_afinidad: adicionales === 15 } };
      if (pct + adicionales > 55) assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /tope vigente de 55.00/);
      else assert.ok(calcularCotizacion(s, REGLAS_COMERCIALES).total);
      s.catalogo.politica.tope_comercial_tdc_pct = '65.00';
      const r = calcularCotizacion(s, REGLAS_COMERCIALES);
      const saldoComercial = 200000 * (100 - pct) / 100;
      assert.equal(r.tramos[0].desglose.descuento_comercial, (200000 - saldoComercial).toFixed(2));
      assert.equal(r.tramos[0].desglose.descuento_tdc, (adicionales ? saldoComercial * 0.05 : 0).toFixed(2));
      assert.equal(r.tramos[0].desglose.descuento_afinidad, (adicionales === 15 ? saldoComercial * 0.95 * 0.1 : 0).toFixed(2));
    });
  }
}

test('validación contextual: fijo excluyente, duración individual/acumulada, primer 50 y publicación', () => {
  const s = solicitud(), p = s.catalogo.politica;
  p.comercial_fijo_max_pct = '40.00';
  const c = { esquema: 'TRAMOS', tramos: [{ porcentaje_id: '2', meses: 3 }], tdc: false, beneficios: { solicita_afinidad: false } };
  assert.deepEqual(erroresDescuentos(c, p, s.catalogo.porcentajes), []);
  c.esquema = 'FIJO';
  assert.match(erroresDescuentos(c, p, s.catalogo.porcentajes)[0].message, /40.00/);
  delete c.esquema; // Los snapshots anteriores conservan la inferencia de fijo con un solo período.
  assert.match(erroresDescuentos(c, p, s.catalogo.porcentajes)[0].message, /40.00/);
  c.esquema = 'TRAMOS'; c.tramos[0].meses = 4;
  assert.ok(erroresDescuentos(c, p, s.catalogo.porcentajes).some(e => e.field.endsWith('.meses') && /primer tramo/.test(e.message)));
  c.tramos = [{ porcentaje_id: '1', meses: 7 }, { porcentaje_id: '1', meses: 6 }];
  assert.equal(erroresDescuentos(c, p, s.catalogo.porcentajes).filter(e => /acumulada/.test(e.message)).length, 2);
  c.tramos[1].meses = 5;
  assert.deepEqual(erroresDescuentos(c, p, s.catalogo.porcentajes), []);
  c.esquema = 'FIJO';
  assert.ok(erroresDescuentos(c, p, s.catalogo.porcentajes).some(e => /único tramo/.test(e.message)));
  c.tramos = [{ porcentaje_id: '99', meses: '' }];
  assert.equal(erroresDescuentos(c, p, s.catalogo.porcentajes).length, 2);
});

test('precisión: pares exactos coinciden, un recibo redondeado no equivale al bruto original', () => {
  const s = solicitud(); s.entrada.modalidad = 'Obligatorio';
  for (const [bruto, personal] of [['1000.00', '30.00'], ['1051.00', '31.53'], ['4800000.00', '144000.00']]) {
    s.entrada.aportes = { sueldo_bruto: bruto };
    const directo = calcularCotizacion(s, REGLAS_COMERCIALES);
    s.entrada.aportes = { opcion_aporte: 'PERSONAL_RECIBO', aporte_personal: personal };
    assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).total, directo.total);
  }
  s.entrada.aportes = { sueldo_bruto: '1050.79' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).aportes[0].importe, '73.56');
  s.entrada.aportes = { opcion_aporte: 'PERSONAL_RECIBO', aporte_personal: '31.52' };
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).aportes[0].importe, '73.55');
});

/** Comprueba todas las edades admitidas contra las veinte claves reales, incluidos vínculos históricos. */
test('FIX10 segmentos de 0 a 120 años coinciden con el catálogo verificado sin cambiar bandas existentes', () => {
  const generados = new Set();
  const bandas = [
    [0, 25, '0-25', 'MAT 0-25'], [26, 35, '26-35', 'MAT 26-35'],
    [36, 40, '36-40', 'MAT 36-40'], [41, 50, '41-50', 'MAT 41-50'],
    [51, 60, '51-60', 'MAT 51-60'], [61, 65, '61-65', 'MAT 61-65'],
    [66, 120, '66+', 'MAT 66-00'],
  ];
  for (const [desde, hasta, individual, matrimonial] of bandas) {
    for (let edad = desde; edad <= hasta; edad++) {
      for (const [casado, esperado] of [[false, individual], [true, matrimonial]]) {
        const segmento = segmentoIntegrante({ parentesco: 'TITULAR', edad }, casado);
        assert.equal(segmento, esperado, `Titular de ${edad}, casado=${casado}`);
        generados.add(segmento);
      }
      assert.equal(segmentoIntegrante({ parentesco: 'CONYUGE', edad }, true), null);
      assert.equal(segmentoIntegrante({ parentesco: 'ADHERENTE', edad }, false), 'FAMILIAR A CARGO');
    }
  }
  generados.add('FAMILIAR A CARGO');
  const bandasHijos = [
    [0, 1, 'HIJO 0-1'], [2, 20, 'HIJO 2-20'], [21, 29, 'HIJO 21-29'],
    [30, 39, 'HIJO 30-39'], [40, 49, 'HIJO 40-49'], [50, 50, '41-50'],
    [51, 60, '51-60'], [61, 65, '61-65'], [66, 120, '66+'],
  ];
  for (const [desde, hasta, esperado] of bandasHijos) {
    for (let edad = desde; edad <= hasta; edad++) {
      for (const casado of [false, true]) {
        const segmento = segmentoIntegrante({ parentesco: 'HIJO', edad }, casado);
        assert.equal(segmento, esperado, `Hijo de ${edad}, casado=${casado}`);
        generados.add(segmento);
      }
    }
  }
  assert.deepEqual([...generados].sort(), TARIFAS_VERIFICADAS.map(([clave]) => clave).sort());
});

for (const [estadoCivil, edad, segmento, precioObligatorio, precioVoluntario, totalVoluntario, totalObligatorio, totalMonotributo] of [
  ['CASADO', 65, 'MAT 61-65', '980578.85', '1049525.89', '1159726.11', '910578.85', '932794.85'],
  ['CASADO', 66, 'MAT 66-00', '980543.74', '1049563.81', '1159768.01', '910543.74', '932759.74'],
  ['CASADO', 80, 'MAT 66-00', '980543.74', '1049563.81', '1159768.01', '910543.74', '932759.74'],
  ['CASADO', 120, 'MAT 66-00', '980543.74', '1049563.81', '1159768.01', '910543.74', '932759.74'],
  ['SOLTERO', 65, '61-65', '516075.30', '552401.23', '610403.36', '446075.30', '468291.30'],
  ['SOLTERO', 66, '66+', '516075.30', '552401.23', '610403.36', '446075.30', '468291.30'],
  ['SOLTERO', 80, '66+', '516075.30', '552401.23', '610403.36', '446075.30', '468291.30'],
  ['SOLTERO', 120, '66+', '516075.30', '552401.23', '610403.36', '446075.30', '468291.30'],
]) {
  for (const [modalidad, total] of [['Voluntario', totalVoluntario], ['Obligatorio', totalObligatorio], ['Monotributo', totalMonotributo]]) {
    /** Verifica el contrato público y los importes esperados sin modificar la solicitud ni recalcular los esperados. */
    test(`FIX10 ${estadoCivil} de ${edad}, ${modalidad}: resuelve ${segmento} y conserva economía`, async () => {
      const s = solicitudTarifarioVerificado(edad, estadoCivil, modalidad);
      const antes = structuredClone(s);
      validarPreparacion(s.entrada);
      const r = await solicitarCalculo(s);
      assert.equal(r.integrantes[0].segmento, segmento);
      assert.equal(r.integrantes[0].edad, edad);
      assert.equal(r.precio_base, modalidad === 'Voluntario' ? precioVoluntario : precioObligatorio);
      assert.equal(r.total, total);
      assert.equal(esResultadoEconomico(r), true);
      assert.equal(r.motor_version, modalidad === 'Monotributo' ? 'matista-3-monotributo' : 'matista-2');
      assert.deepEqual(r.referencias, s.referencias);
      assert.deepEqual(s, antes);
    });
  }
}

for (const modalidad of ['Voluntario', 'Obligatorio', 'Monotributo']) {
  for (const [titular, conyuge, segmento] of [
    [65, 65, 'MAT 61-65'], [65, 66, 'MAT 66-00'], [66, 65, 'MAT 66-00'],
    [65, 80, 'MAT 66-00'], [80, 65, 'MAT 66-00'], [120, 65, 'MAT 66-00'],
  ]) {
    /** Conserva la edad del mayor, cónyuge incluido una sola vez, edades declaradas e hijos independientes. */
    test(`FIX10 matrimonio ${titular}/${conyuge}, ${modalidad}: catálogo real, inversión e hijos`, () => {
      const s = solicitudTarifarioVerificado(titular, 'CASADO', modalidad);
      s.entrada.familia.miembros = [{ parentesco: 'CONYUGE', edad: conyuge },
        { parentesco: 'HIJO', edad: 1 }, { parentesco: 'HIJO', edad: 20 }];
      validarPreparacion(s.entrada);
      const r = calcularCotizacion(s, REGLAS_COMERCIALES);
      assert.deepEqual(r.integrantes.map(m => m.segmento), [segmento, null, 'HIJO 0-1', 'HIJO 2-20']);
      assert.deepEqual(r.integrantes.map(m => m.edad), [titular, conyuge, 1, 20]);
      assert.equal(r.integrantes[1].precio, '0.00');
      assert.equal(r.precio_base, modalidad === 'Voluntario'
        ? (segmento === 'MAT 61-65' ? '1225741.67' : '1225779.59')
        : (segmento === 'MAT 61-65' ? '1145208.22' : '1145173.11'));
      s.entrada.familia.titular.edad = conyuge;
      s.entrada.familia.miembros[0].edad = titular;
      const invertida = calcularCotizacion(s, REGLAS_COMERCIALES);
      assert.equal(invertida.precio_base, r.precio_base);
      assert.deepEqual(invertida.tramos, r.tramos);
      assert.deepEqual(invertida.aportes, r.aportes);
    });
  }
}

/** Mantiene los límites de edad y composición en el validador existente, sin aceptaciones nuevas. */
test('FIX10 edades inválidas, cónyuges incoherentes y máximo de familiares conservan sus rechazos', () => {
  for (const edad of [-1, 121, 65.5, '66', null]) {
    const s = solicitudTarifarioVerificado(edad);
    assert.throws(() => validarPreparacion(s.entrada), { code: 'ASESOR_VALIDACION' });
    s.entrada.familia.titular.edad = 66;
    s.entrada.familia.miembros = [{ parentesco: 'HIJO', edad }];
    assert.throws(() => validarPreparacion(s.entrada), { code: 'ASESOR_VALIDACION' });
  }
  const s = solicitudTarifarioVerificado(66);
  s.entrada.familia.miembros = [{ parentesco: 'CONYUGE', edad: 65 }, { parentesco: 'CONYUGE', edad: 66 }];
  assert.throws(() => validarPreparacion(s.entrada), { code: 'ASESOR_VALIDACION' });
  s.entrada.familia.miembros.pop();
  s.entrada.familia.titular.estado_civil = 'SOLTERO';
  assert.throws(() => validarPreparacion(s.entrada), { code: 'ASESOR_VALIDACION' });
  s.entrada.familia.titular.estado_civil = 'CASADO';
  s.entrada.familia.miembros = Array.from({ length: 30 }, () => ({ parentesco: 'HIJO', edad: 0 }));
  assert.doesNotThrow(() => validarPreparacion(s.entrada));
  s.entrada.familia.miembros.push({ parentesco: 'HIJO', edad: 0 });
  assert.throws(() => validarPreparacion(s.entrada), { code: 'ASESOR_VALIDACION' });
});

/** Comprueba el cumpleaños 66 en UTC usando el cálculo de edad existente y sin cambiar edades declaradas. */
test('FIX10 cumpleaños 66 cambia solo la clave matrimonial y OTRO conserva el segmento individual', () => {
  const hoy = new Date('2026-10-26T12:00:00Z');
  const anterior = calcularEdad('1960-10-27', hoy);
  const cumplidos = calcularEdad('1960-10-26', hoy);
  assert.equal(anterior, 65); assert.equal(cumplidos, 66);
  assert.equal(segmentoIntegrante({ parentesco: 'TITULAR', edad: anterior }, true), 'MAT 61-65');
  assert.equal(segmentoIntegrante({ parentesco: 'TITULAR', edad: cumplidos }, true), 'MAT 66-00');
  const s = solicitudTarifarioVerificado(cumplidos, 'OTRO');
  validarPreparacion(s.entrada);
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).integrantes[0].segmento, '66+');
});

/** Impide que la corrección oculte una tarifa ausente sustituyéndola por la individual de la misma edad. */
test('FIX10 una lista sin MAT 66-00 sigue rechazándose sin equivalencias ni precios inventados', () => {
  const s = solicitudTarifarioVerificado(66);
  s.catalogo.tarifas = s.catalogo.tarifas.filter(t => t.rango_clave !== 'MAT 66-00');
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), { code: 'COTIZACION_REGLA', status: 422 });
});

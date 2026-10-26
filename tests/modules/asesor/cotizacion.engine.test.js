import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularCotizacion } from '../../../src/domain/comercial/cotizacion.engine.js';
import { REGLAS_COMERCIALES } from '../../../src/domain/comercial/reglas.confirmadas.js';
import { erroresDescuentos } from '../../../src/domain/comercial/descuentos.validation.js';

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

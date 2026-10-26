import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularCotizacion } from '../../../src/domain/comercial/cotizacion.engine.js';
import { erroresDescuentos } from '../../../src/domain/comercial/descuentos.validation.js';
import { REGLAS_COMERCIALES } from '../../../src/domain/comercial/reglas.confirmadas.js';
import { validarFamilia } from '../../../src/modules/asesor/asesor.validation.js';
import { solicitudMonotributo } from '../../helpers/monotributo.js';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Crea un joven sintético con porcentajes publicados independientes de MySQL para comprobar el límite acumulado. */
function joven(comercial = '20.00', esquema = 'TRAMOS') {
  const s = solicitudMonotributo();
  s.entrada.modalidad = 'Voluntario'; s.entrada.aportes = {};
  s.entrada.familia = { titular: { edad: 25, estado_civil: 'SOLTERO' }, miembros: [] };
  s.catalogo.tarifas = [{ rango_clave: '0-25', precio: '200000.00' }];
  Object.assign(s.catalogo.politica, { tdc_habilitado: 1, tdc_pct: '5.00', afinidad_pct: '10.00' });
  s.catalogo.porcentajes = [{ id: '1', porcentaje: comercial, vigente_hasta: null }];
  s.entrada.condiciones = { esquema, tramos: [{ porcentaje_id: '1', meses: 3 }], tdc: true, beneficios: { solicita_afinidad: true } };
  return s;
}

for (const esquema of ['FIJO', 'TRAMOS']) {
  for (const [comercial, total] of [['13.00', 54], ['14.00', 55], ['20.00', 61], ['40.00', 81]]) {
    test(`FIX07 ${esquema}: joven + comercial ${comercial} + TDC + afinidad = ${total}`, () => {
      const s = joven(comercial, esquema), antes = JSON.stringify(s);
      const errores = erroresDescuentos(s.entrada.condiciones, s.catalogo.politica, s.catalogo.porcentajes, s.entrada.familia);
      if (total <= 55) { assert.deepEqual(errores, []); assert.ok(calcularCotizacion(s, REGLAS_COMERCIALES).total); }
      else {
        assert.equal(errores[0].field, 'condiciones.tramos.0.porcentaje_id');
        assert.match(errores[0].message, new RegExp(`${total}.00 %`));
        assert.match(errores[0].message, new RegExp(`Exceso: ${total - 55}.00 puntos`));
        assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), { code: 'COTIZACION_REGLA', status: 422 });
      }
      assert.equal(JSON.stringify(s), antes);
    });
  }
}

test('FIX07 cada período, política variable, sin campaña y pérdida de elegibilidad joven', () => {
  const s = joven('14.00');
  s.catalogo.porcentajes.push({ id: '2', porcentaje: '20.00', vigente_hasta: null });
  s.entrada.condiciones.tramos.push({ porcentaje_id: '2', meses: 3 });
  let errores = erroresDescuentos(s.entrada.condiciones, s.catalogo.politica, s.catalogo.porcentajes, s.entrada.familia);
  assert.deepEqual(errores.map(e => e.field), ['condiciones.tramos.1.porcentaje_id']);
  s.catalogo.politica.tope_comercial_tdc_pct = '61.00';
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).tramos.length, 2);
  s.entrada.condiciones.tramos = []; s.catalogo.politica.tope_comercial_tdc_pct = '40.00';
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /41.00 %.*40.00 %.*1.00 puntos/);
  s.entrada.familia.titular.estado_civil = 'OTRO';
  assert.deepEqual(erroresDescuentos(s.entrada.condiciones, s.catalogo.politica, s.catalogo.porcentajes, s.entrada.familia), []);
  assert.equal(calcularCotizacion(s, REGLAS_COMERCIALES).beneficios[0].porcentaje, '0.00');
  s.entrada.familia.titular.estado_civil = 'SOLTERO'; s.catalogo.politica.joven_porcentaje = null;
  assert.throws(() => calcularCotizacion(s, REGLAS_COMERCIALES), /configurar el descuento joven/);
});

for (const modalidad of ['Voluntario', 'Obligatorio', 'Monotributo']) {
  for (const [titular, conyuge, banda] of [[25, 27, '26-35'], [27, 25, '26-35'], [27, 27, '26-35'], [41, 35, '41-50'], [29, 42, '41-50']]) {
    test(`FIX07 matrimonio ${titular}/${conyuge} ${modalidad}: edad mayor e inversión invariantes con hijos`, () => {
      const s = solicitudMonotributo();
      s.entrada.modalidad = modalidad;
      s.entrada.aportes = modalidad === 'Voluntario' ? {} : modalidad === 'Obligatorio' ? { sueldo_bruto: '10000.00' } : { categoria: 'F', adherentes: 2 };
      s.entrada.familia.titular.edad = titular;
      s.entrada.familia.miembros = [{ parentesco: 'CONYUGE', edad: conyuge }, { parentesco: 'HIJO', edad: 12 }, { parentesco: 'HIJO', edad: 1 }];
      s.catalogo.tarifas.push({ rango_clave: 'MAT 0-25', precio: '800000.00' }, { rango_clave: 'MAT 26-35', precio: '900000.00' });
      const r = calcularCotizacion(s, REGLAS_COMERCIALES);
      assert.equal(r.integrantes[0].segmento, `MAT ${banda}`);
      assert.equal(r.integrantes[0].edad, titular);
      assert.equal(r.integrantes[1].precio, '0.00');
      assert.equal(r.integrantes[1].segmento, null);
      assert.equal(r.precio_base, banda === '26-35' ? '1052815.32' : '1208928.47');
      s.entrada.familia.titular.edad = conyuge; s.entrada.familia.miembros[0].edad = titular;
      const invertida = calcularCotizacion(s, REGLAS_COMERCIALES);
      assert.equal(invertida.precio_base, r.precio_base); assert.equal(invertida.total, r.total);
      assert.deepEqual(invertida.tramos, r.tramos); assert.deepEqual(invertida.aportes, r.aportes);
    });
  }
}

test('FIX07 civil y vínculo: OTRO válido sin cónyuge; duplicados e incoherencias se rechazan sin mutar', () => {
  const familia = { titular: { edad: 25, estado_civil: 'OTRO' }, miembros: [] };
  assert.deepEqual(validarFamilia(familia), familia);
  familia.miembros.push({ parentesco: 'CONYUGE', edad: 27 });
  assert.throws(() => validarFamilia(familia), /requiere titular casado/);
  familia.titular.estado_civil = 'SOLTERO';
  assert.throws(() => validarFamilia(familia), /requiere titular casado/);
  familia.titular.estado_civil = 'CASADO'; assert.deepEqual(validarFamilia(familia), familia);
  familia.miembros.push({ parentesco: 'CONYUGE', edad: 28 });
  assert.throws(() => validarFamilia(familia), /Solo se admite un cónyuge/);
});

/**
 * Comprueba los importes corregidos en Chrome sin alterar el snapshot; propaga errores de generación y aserciones.
 * @param {import('node:test').TestContext} t Registra la limpieza de sus archivos privados al finalizar.
 */
test('FIX07 PDF real usa el mismo resultado corregido sin recalcular el snapshot', { skip: process.env.RUN_PDF_TESTS !== '1' }, async (t) => {
  const s = solicitudMonotributo();
  s.entrada.familia.titular.edad = 25; s.entrada.familia.miembros[0].edad = 27;
  s.catalogo.tarifas.push({ rango_clave: 'MAT 0-25', precio: '800000.00' }, { rango_clave: 'MAT 26-35', precio: '900000.00' });
  const resultado = calcularCotizacion(s, REGLAS_COMERCIALES);
  const q = { estado: 'EMITIDA', numero: 'MAT-FIX07-SINTETICA', emitida_at: '2026-10-25T12:00:00Z', modalidad: 'Monotributo', solicitud: s, resultado, contacto: {} };
  const antes = JSON.stringify(q);
  assert.equal(resultado.precio_base, '1042815.32'); assert.equal(resultado.total, '606153.96');
  assert.ok((await cotizacionHtml(q)).includes('606.153,96'));
  const temporal = await mkdtemp(join(tmpdir(), 'matista-pdf-fix07-'));
  /** Elimina exclusivamente el directorio privado creado por esta prueba. */
  t.after(async () => { await rm(temporal, { recursive: true, force: true }); });
  const path = join(temporal, 'matrimonio-corregido.pdf');
  await writeFile(path, await cotizacionPdf(q));
  const texto = execFileSync('pdftotext', [path, '-'], { encoding: 'utf8' });
  for (const importe of ['1.042.815,32', '606.153,96', '23.892,00', '47.784,00']) assert.ok(texto.includes(importe));
  assert.equal(JSON.stringify(q), antes);
});

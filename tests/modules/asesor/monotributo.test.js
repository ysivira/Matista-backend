import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularCotizacion } from '../../../src/domain/comercial/cotizacion.engine.js';
import { REGLAS_COMERCIALES } from '../../../src/domain/comercial/reglas.confirmadas.js';
import { validarPreparacion } from '../../../src/modules/asesor/asesor.validation.js';
import { previsualizarPreparacion, guardarPreparacion, calcularPreparacion, emitirPreparacion, obtenerDetalle, consultarHistorial } from '../../../src/modules/asesor/cotizaciones.service.js';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { solicitudMonotributo } from '../../helpers/monotributo.js';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('SPEC: matrimonio 41 + hijo 12, dos adherentes y 35 % produce 707627.51', () => {
  const s = solicitudMonotributo(); const r = calcularCotizacion(s, REGLAS_COMERCIALES);
  assert.deepEqual(r.integrantes.map(m => [m.segmento, m.precio]), [['MAT 41-50', '1056113.15'], [null, '0.00'], ['HIJO 2-20', '142815.32']]);
  assert.equal(r.precio_base, '1198928.47');
  assert.equal(r.tramos[0].desglose.descuento_comercial, '419624.96');
  assert.deepEqual(r.aportes, [{ concepto: 'Monotributo (titular)', importe: '23892.00' }, { concepto: 'Adherentes Monotributo', importe: '47784.00' }]);
  assert.equal(r.total, '707627.51');
  assert.equal(r.motor_version, 'matista-3-monotributo');
});

test('adherentes independientes: cero, varios sin familiares, más de 30 y saldo no negativo', () => {
  const s = solicitudMonotributo();
  s.entrada.familia = { titular: { edad: 41, estado_civil: 'SOLTERO' }, miembros: [] };
  s.entrada.condiciones.tramos = [];
  for (const [cantidad, adicional, total] of [[0, '0.00', '531957.74'], [2, '47784.00', '484173.74'], [31, '531957.74', '0.00']]) {
    s.entrada.aportes.adherentes = cantidad;
    validarPreparacion(s.entrada);
    const r = calcularCotizacion(s, REGLAS_COMERCIALES);
    assert.equal(r.aportes[1].importe, adicional); assert.equal(r.total, total);
    assert.equal(r.precio_base, '555849.74');
  }
});

test('cada hijo usa su banda, el cónyuge permanece incluido y los aportes no eligen tarifas', () => {
  const s = solicitudMonotributo();
  s.entrada.familia.miembros = [{ parentesco: 'CONYUGE', edad: 58 }, ...[1, 12, 23, 35, 45, 52].map(edad => ({ parentesco: 'HIJO', edad }))];
  s.catalogo.tarifas.push({ rango_clave: 'MAT 51-60', precio: '1200000.00' });
  const r = calcularCotizacion(s, REGLAS_COMERCIALES);
  assert.deepEqual(r.integrantes.map(m => m.segmento), ['MAT 51-60', null, 'HIJO 0-1', 'HIJO 2-20', 'HIJO 21-29', 'HIJO 30-39', 'HIJO 40-49', '51-60']);
  s.entrada.aportes.adherentes = 0;
  assert.deepEqual(calcularCotizacion(s, REGLAS_COMERCIALES).integrantes, r.integrantes);
});

test('nuevas preparaciones rechazan vínculo adherente e importes inválidos sin reinterpretar historia', () => {
  for (const modalidad of ['Monotributo', 'Obligatorio', 'Voluntario']) {
    const s = solicitudMonotributo(); s.entrada.modalidad = modalidad;
    s.entrada.familia.miembros[0].parentesco = 'ADHERENTE';
    assert.throws(() => validarPreparacion(s.entrada), /vínculo familiar real/);
  }
  for (const adherentes of [-1, 1.5, '', '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    const s = solicitudMonotributo(); s.entrada.aportes.adherentes = adherentes;
    assert.throws(() => validarPreparacion(s.entrada), /entero no negativo/);
  }
});

/** Crea un doble SQL estricto y expone catálogo/filas para probar cambios de política sin escribir MySQL. */
function poolRecotizacion() {
  const s = solicitudMonotributo();
  const original = { id: '10', cliente_id: '1', asesor_legajo: '999', plan_id: '4', modalidad: 'Monotributo', estado: 'EMITIDA', revision: 2,
    solicitud: structuredClone(s), resultado: { ...calcularCotizacion(s, REGLAS_COMERCIALES), motor_version: 'matista-2', total: '999999.00' }, contacto: {} };
  const filas = new Map([['10', original]]); const tiposConsultados = [];
  /** Responde únicamente las consultas conocidas del flujo y conserva las escrituras en memoria. */
  async function consulta(sql, params = []) {
    if (sql.startsWith('SET ')) return [[]];
    if (sql.includes('FROM politica_comercial')) return [sql.includes("'PROGRAMADA'") ? [] : [s.catalogo.politica]];
    if (sql.includes('FROM porcentajes_comerciales')) return [s.catalogo.porcentajes];
    if (sql.includes('FROM clientes')) return [[{ ...s.cliente, fecha_nacimiento: null, familia: null }]];
    if (sql.includes('FROM tarifario_versiones')) return [[{ id: '8' }]];
    if (sql.includes('FROM tarifas')) { tiposConsultados.push(params[2]); return [s.catalogo.tarifas]; }
    if (sql.includes('FROM planes')) return [[{ ...s.plan, activa: 1 }]];
    if (sql.includes('FROM empleados')) return [[s.asesor]];
    if (sql.includes('SELECT q.id')) return [[...filas.values()].map(q => ({ ...q, total: q.resultado?.total ?? null, aportes: JSON.stringify(q.resultado?.aportes ?? []) }))];
    if (sql.includes('SELECT * FROM cotizaciones')) return [[filas.get(String(params[0]))].filter(Boolean).map(q => structuredClone(q))];
    if (sql.startsWith('INSERT INTO cotizaciones')) {
      filas.set('11', { id: '11', plan_id: params[0], modalidad: params[1], solicitud: JSON.parse(params[4]), cliente_id: params[5], asesor_legajo: params[6], contacto: JSON.parse(params[7]), origen_id: params[8], estado: 'BORRADOR', revision: 0 });
      return [{ insertId: 11 }];
    }
    if (sql.startsWith('INSERT INTO miembros_cotizacion') || sql.startsWith('INSERT INTO asesor_auditoria')) return [{ affectedRows: 1 }];
    if (sql.includes('FROM asesor_auditoria') || sql.includes('SELECT id,estado,created_at FROM cotizaciones')) return [[]];
    throw new Error('Consulta no prevista en el doble de recotización');
  }
  return { s, filas, tiposConsultados, pool: {
    /** Entrega conexión sin recursos externos y conserva límites transaccionales observables por servicios. */
    async getConnection() { return { query: consulta, execute: consulta,
      /** El doble solo opera sobre memoria local de esta prueba. */
      async beginTransaction() {},
      /** No hay transacción externa que confirmar. */
      async commit() {},
      /** Las pruebas no provocan fallos transaccionales en este doble. */
      async rollback() {},
      /** No hay socket MySQL asociado. */
      release() {},
    }; },
  } };
}

test('servicios: preview y recotización de existente usan Obligatorio y conservan original/historial', async () => {
  const f = poolRecotizacion(), s = solicitudMonotributo();
  const antes = JSON.stringify(f.filas.get('10'));
  const preview = await previsualizarPreparacion(f.pool, '999', s.entrada);
  assert.equal(preview.resultado.total, '707627.51'); assert.equal(f.filas.size, 1);
  const nueva = await guardarPreparacion(f.pool, '999', s.entrada, { origenId: '10' });
  assert.equal(nueva.origen_id, '10'); assert.equal(nueva.id, '11');
  const calculo = await calcularPreparacion(f.pool, '999', nueva.id);
  assert.deepEqual(calculo.resultado, preview.resultado);
  const detalle = await obtenerDetalle(f.pool, '999', '10');
  assert.equal(detalle.resultado.total, '999999.00');
  const historial = await consultarHistorial(f.pool, '999', {});
  assert.equal(historial.cotizaciones[0].total, '999999.00');
  assert.deepEqual(historial.cotizaciones[0].aportes, f.filas.get('10').resultado.aportes);
  assert.equal(JSON.stringify(f.filas.get('10')), antes);
  assert.ok(f.tiposConsultados.every(t => t === 'Obligatorio'));
  const q = { ...nueva, estado: 'EMITIDA', numero: 'MAT-11', emitida_at: '2026-10-24T15:00:00Z', resultado: calculo.resultado };
  const html = await cotizacionHtml(q);
  for (const importe of ['707.627,51', '419.624,96', '23.892,00', '47.784,00']) assert.ok(html.includes(importe));
});

test('FIX07 servicios rechazan joven excedido en preview, guardado, recotización, cálculo y emisión sin tocar origen', async () => {
  const f = poolRecotizacion(); const antes = JSON.stringify(f.filas.get('10'));
  Object.assign(f.s.catalogo.politica, { tdc_habilitado: 1, tdc_pct: '5.00', afinidad_pct: '10.00' });
  f.s.catalogo.porcentajes.push({ id: '20', porcentaje: '20.00', vigente_hasta: null });
  const entrada = structuredClone(f.s.entrada);
  entrada.familia = { titular: { edad: 25, estado_civil: 'SOLTERO' }, miembros: [] };
  entrada.condiciones = { esquema: 'FIJO', tramos: [{ porcentaje_id: '20', meses: 3 }], tdc: true, beneficios: { solicita_afinidad: true } };
  await assert.rejects(previsualizarPreparacion(f.pool, '999', entrada), /61.00 %.*55.00 %.*6.00 puntos/);
  await assert.rejects(guardarPreparacion(f.pool, '999', entrada), { code: 'COTIZACION_REGLA' });
  await assert.rejects(guardarPreparacion(f.pool, '999', entrada, { origenId: '10' }), { code: 'COTIZACION_REGLA' });
  assert.equal(f.filas.size, 1);
  f.filas.set('12', { ...structuredClone(f.filas.get('10')), id: '12', estado: 'BORRADOR', revision: 0,
    solicitud: { ...structuredClone(f.s), entrada } });
  await assert.rejects(calcularPreparacion(f.pool, '999', '12'), { code: 'COTIZACION_REGLA' });
  await assert.rejects(emitirPreparacion(f.pool, '999', '12', { revision: 0, huella: 'a'.repeat(64) }), { code: 'COTIZACION_REGLA' });
  assert.equal(f.filas.get('12').estado, 'BORRADOR'); assert.equal(JSON.stringify(f.filas.get('10')), antes);
});

/**
 * Comprueba páginas e importes de aceptación en Chrome; propaga errores de generación y aserciones.
 * @param {import('node:test').TestContext} t Registra la limpieza de sus archivos privados al finalizar.
 */
test('PDF Monotributo real: dos páginas e importes separados del caso de aceptación', { skip: process.env.RUN_PDF_TESTS !== '1' }, async (t) => {
  const solicitud = solicitudMonotributo();
  const q = { estado: 'EMITIDA', numero: 'MAT-MONO-TEST', emitida_at: '2026-10-24T15:00:00Z', modalidad: 'Monotributo', solicitud, resultado: calcularCotizacion(solicitud, REGLAS_COMERCIALES), contacto: {} };
  const temporal = await mkdtemp(join(tmpdir(), 'matista-pdf-monotributo-'));
  /** Elimina exclusivamente el directorio privado creado por esta prueba. */
  t.after(async () => { await rm(temporal, { recursive: true, force: true }); });
  const archivo = join(temporal, 'caso-referencia.pdf');
  await writeFile(archivo, await cotizacionPdf(q));
  assert.match(execFileSync('pdfinfo', [archivo], { encoding: 'utf8' }), /Pages:\s+2\b/);
  const texto = execFileSync('pdftotext', ['-f', '1', '-l', '1', archivo, '-'], { encoding: 'utf8' });
  for (const importe of ['1.198.928,47', '419.624,96', '23.892,00', '47.784,00', '707.627,51']) assert.ok(texto.includes(importe));
  assert.ok(texto.includes('Monotributo (titular)')); assert.ok(texto.includes('Adherentes Monotributo'));
});

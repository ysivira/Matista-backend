import assert from 'node:assert/strict';
import test from 'node:test';
import { calcularEdad, hoyUTC } from '../../../src/domain/comercial/edad.js';
import { actualizarCliente, insertarCliente, emitirCotizacion } from '../../../src/modules/asesor/asesor.repository.js';
import { guardarCliente } from '../../../src/modules/asesor/clientes.service.js';

test('edad por años cumplidos con referencia UTC, cumpleaños y calendario real', () => {
  for (const [fecha, referencia, esperado] of [
    ['2000-10-24', '2026-10-24T00:00:00Z', 26],
    ['2000-10-25', '2026-10-24T23:59:59Z', 25],
    ['2000-10-23', '2026-10-24T12:00:00Z', 26],
    ['2000-02-29', '2025-02-28T12:00:00Z', 24],
    ['2000-02-29', '2025-03-01T00:00:00Z', 25],
    ['2000-02-29', '2024-02-29T00:00:00Z', 24],
    ['2026-10-25', '2026-10-24T12:00:00Z', null],
    ['2001-02-29', '2026-10-24T12:00:00Z', null],
    ['2000-04-31', '2026-10-24T12:00:00Z', null],
    ['2000-13-01', '2026-10-24T12:00:00Z', null],
    [null, '2026-10-24T12:00:00Z', null],
    ['2026-10-24', '2026-10-23T23:30:00-03:00', 0],
  ]) assert.equal(calcularEdad(fecha, new Date(referencia)), esperado, `${fecha} / ${referencia}`);
  assert.equal(hoyUTC(new Date('2026-10-23T23:30:00-03:00')).toISOString(), '2026-10-24T00:00:00.000Z');
  assert.equal(calcularEdad('2000-01-01', new Date('invalida')), null);
});

test('escrituras de cliente no reemplazan familia histórica y emisión fija la edad efectiva', async () => {
  const consultas = [];
  const c = {
    /** Captura SQL parametrizado sin acceder a bases ni registrar identidades reales. */
    async execute(sql, valores) { consultas.push({ sql, valores }); return [{ insertId: 1 }]; },
  };
  const datos = { dni: '12345678', nombres: 'Prueba', apellidos: 'Prueba', email: null, telefono: null,
    direccion: null, fecha_nacimiento: '2000-01-01', provincia: null, localidad: null };
  await insertarCliente(c, datos, '1');
  await actualizarCliente(c, '1', '1', datos);
  for (const consulta of consultas) assert.doesNotMatch(consulta.sql, /familia/);
  assert.ok(consultas[1].sql.includes('revision=revision+1'));
  await emitirCotizacion(c, { id: '1', asesor_legajo: '1' }, {
    referencias: { tarifa_version_id: '1', politica_id: '1' }, entrada: { familia: { titular: { edad: 26 } } },
  }, {});
  assert.deepEqual(consultas.at(-1).valores, [26, '1']);
});

test('alta exige nacimiento y correo antes de abrir conexión, sin exigir familia', async () => {
  const base = { dni: '12345678', nombres: 'Prueba', apellidos: 'Prueba' };
  const pool = {
    /** Si la validación intenta persistir una entrada inválida, la prueba falla. */
    getConnection() { throw new Error('No debe abrir conexión'); },
  };
  await assert.rejects(guardarCliente(pool, '1', base), { code: 'ASESOR_VALIDACION' });
  await assert.rejects(guardarCliente(pool, '1', { ...base, fecha_nacimiento: '2000-01-01' }), { code: 'ASESOR_VALIDACION' });
});

test('edición anterior preserva columnas nuevas omitidas y controla revisión y DNI', async () => {
  const fila = { id: '1', dni: '12345678', revision: 2, fecha_nacimiento: '2000-01-01',
    provincia: 'Córdoba', localidad: 'Villa María', familia: { titular: { edad: 20, estado_civil: 'SOLTERO' }, miembros: [] } };
  const consultas = [];
  const conexion = {
    /** Simula configuración UTC sin abrir ninguna base. */
    async query() {},
    /** Registra límites transaccionales del servicio bajo prueba. */
    async beginTransaction() {},
    /** Confirma el doble de transacción. */
    async commit() {},
    /** Revierte el doble de transacción. */
    async rollback() {},
    /** Libera la conexión simulada. */
    release() {},
    /** Reproduce las lecturas del registro anterior y captura escrituras parametrizadas. */
    async execute(sql, valores) {
      consultas.push({ sql, valores });
      return sql.startsWith('SELECT') ? [[fila]] : [{}];
    },
  };
  const pool = {
    /** Reutiliza la conexión simulada del caso. */
    async getConnection() { return conexion; },
  };
  const entrada = { dni: fila.dni, nombres: 'Prueba', apellidos: 'Prueba', revision: 2 };
  await guardarCliente(pool, '1', entrada, '1');
  const update = consultas.find(c => c.sql.startsWith('UPDATE'));
  assert.deepEqual(update.valores.slice(5, 8), [fila.fecha_nacimiento, fila.provincia, fila.localidad]);
  assert.doesNotMatch(update.sql, /familia/);
  await assert.rejects(guardarCliente(pool, '1', { ...entrada, revision: 1 }, '1'), { code: 'ASESOR_CONCURRENCIA' });
  await assert.rejects(guardarCliente(pool, '1', { ...entrada, dni: '87654321' }, '1'), { code: 'ASESOR_VALIDACION' });
});

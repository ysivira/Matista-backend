import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  obtenerPorcentajeComercialPorId,
  bloquearPorcentajeComercialVigente,
  insertarEmpleadoAuditoria,
} from '../../../src/modules/admin/porcentajes-comerciales.repository.js';
import { obtenerEmpleado } from '../../../src/modules/admin/employees.repository.js';

/**
 * Captura consultas sobre una conexión existente, sin permitir adquisiciones ni transacciones nuevas.
 * @param {object[]} filas Filas a devolver, sin normalizar sus tipos ni proyección.
 * @returns {object} Conexión limitada y llamadas observables.
 */
function conexionCapturadora(filas = []) {
  const llamadas = [];
  const connection = {
    /** Conserva referencia y valores del resultado entregado por mysql2. */
    async execute(sql, parametros) {
      llamadas.push({ sql: sql.replace(/\s+/g, ' ').trim(), parametros });
      return [filas, []];
    },
  };
  connection.query = connection.execute;
  return { connection, llamadas };
}

test('lectura por id conserva proyección, parámetro BIGINT, fila DECIMAL y ausencia', async () => {
  const id = '9007199254740993';
  const fila = { id, porcentaje: '25.00', descripcion: null, fecha_vigencia: '2026-10-22',
    vigente_hasta: null, actor_legajo: '1234567', created_at: '2026-10-22' };
  const { connection, llamadas } = conexionCapturadora([fila]);
  assert.equal(await obtenerPorcentajeComercialPorId(connection, id), fila);
  assert.deepEqual(llamadas, [{ sql: 'SELECT id, porcentaje, descripcion, fecha_vigencia, vigente_hasta, actor_legajo, created_at FROM porcentajes_comerciales WHERE id = ?', parametros: [id] }]);
  assert.equal(await obtenerPorcentajeComercialPorId(conexionCapturadora().connection, id), undefined);
});

test('bloqueos conservan exactamente proyecciones y FOR UPDATE de edición y baja', async () => {
  for (const conDescripcion of [true, false]) {
    const fila = { id: 1, porcentaje: '10.00', ...(conDescripcion ? { descripcion: 'Inicial' } : {}) };
    const { connection, llamadas } = conexionCapturadora([fila]);
    assert.equal(await bloquearPorcentajeComercialVigente(connection, '10.00', { conDescripcion }), fila);
    assert.deepEqual(llamadas, [{ sql: `SELECT id, porcentaje${conDescripcion ? ', descripcion' : ''} FROM porcentajes_comerciales WHERE porcentaje = ? AND vigente_hasta IS NULL FOR UPDATE`, parametros: ['10.00'] }]);
  }
  assert.equal(await bloquearPorcentajeComercialVigente(conexionCapturadora().connection, '10.00'), undefined);
});

test('auditoría conserva tabla, columnas, valores y reloj SQL NOW(6) sobre la conexión recibida', async () => {
  const { connection, llamadas } = conexionCapturadora();
  const datos = { legajo: '1234567', actor_legajo: '1234567', evento: 'PORCENTAJE_COMERCIAL_ACTUALIZADO',
    campo: 'DESCRIPCION', valor_anterior: 'N/A', valor_nuevo: 'Nueva' };
  assert.equal(await insertarEmpleadoAuditoria(connection, datos), undefined);
  assert.deepEqual(llamadas, [{ sql: 'INSERT INTO empleados_auditoria (legajo, actor_legajo, evento, campo, valor_anterior, valor_nuevo, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW(6))',
    parametros: [datos.legajo, datos.actor_legajo, datos.evento, datos.campo, datos.valor_anterior, datos.valor_nuevo] }]);
});

test('repositorios propagan el mismo error sin capturarlo ni abrir otra transacción', async () => {
  const error = new Error('Fallo sintético del driver');
  const connection = {
    /** Simula error de driver sin acceso externo. */
    async execute() { throw error; },
  };
  await assert.rejects(obtenerPorcentajeComercialPorId(connection, 1), e => e === error);
  await assert.rejects(bloquearPorcentajeComercialVigente(connection, '10.00'), e => e === error);
  await assert.rejects(insertarEmpleadoAuditoria(connection, {}), e => e === error);
});

test('persistencia de empleados reutilizada conserva identidad y undefined sin nuevas implementaciones', async () => {
  const fila = { legajo: '1234567', nombre: 'David', apellido: 'Diaz', email: null };
  const { connection, llamadas } = conexionCapturadora([fila]);
  assert.equal(await obtenerEmpleado(connection, fila.legajo), fila);
  assert.deepEqual(llamadas[0].parametros, [fila.legajo]);
  assert.match(llamadas[0].sql, /FROM empleados e/);
  assert.equal(await obtenerEmpleado(conexionCapturadora().connection, fila.legajo), undefined);
});

test('servicio sin SQL ejecutable ni snapshotActor duplicado y con tres límites transaccionales intactos', () => {
  const codigo = readFileSync(new URL('../../../src/modules/admin/porcentajes-comerciales.service.js', import.meta.url), 'utf8');
  assert.doesNotMatch(codigo, /\.(execute|query)\s*\(/);
  assert.doesNotMatch(codigo, /\b(SELECT|INSERT|UPDATE|DELETE)\b|snapshotActor/);
  assert.equal((codigo.match(/transaction: true/g) ?? []).length, 3);
  assert.equal((codigo.match(/await obtenerEmpleado\(connection, actor\.legajo\)/g) ?? []).length, 3);
});

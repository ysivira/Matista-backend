// Pruebas unitarias del repositorio ADMIN de empleados (SL-1) contra una
// conexion mysql2 simulada (sin base de datos). Comprueban el contrato
// publico del listado/detalle y la consulta del correo ACTUAL con su
// marca de verificacion (regresion del 500 por columna derivada ausente).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  listarEmpleados,
  obtenerEmpleado,
} from '../../../src/modules/admin/employees.repository.js';

/**
 * Captura SQL y parametros devolviendo las filas sinteticas indicadas.
 * @param {object[]} filas Resultado de la siguiente consulta.
 * @returns {object} Conexion mysql2 simulada con llamadas observables.
 */
function conexionConQuery(filas) {
  const llamadas = [];
  return {
    llamadas,
    async query(sql, parametros = []) {
      llamadas.push({ sql, parametros });
      return [filas, []];
    },
  };
}

describe('repositorio ADMIN de empleados (SPEC-25)', () => {
  test('la subconsulta del correo ACTUAL selecciona verificado_at (regresion del 500)', async () => {
    const connection = conexionConQuery([]);
    await listarEmpleados(connection);

    const sql = connection.llamadas[0].sql;
    // La tabla derivada debe exponer la columna antes de compararla en el
    // SELECT externo; si falta, MySQL responde ER_BAD_FIELD_ERROR (500).
    assert.match(sql, /SELECT legajo, email, verificado_at/);
    assert.match(sql, /WHERE estado = 'ACTUAL'/);
    assert.match(sql, /AS email_verificado/);
  });

  test('lista filas publicas con email_verificado booleano y sin credenciales', async () => {
    const connection = conexionConQuery([
      { legajo: '0000000001', nombre: 'A', apellido: 'B', rol: 'ASESOR', estado: 'ACTIVO', email: 'a@matista.test', email_verificado: 1 },
      { legajo: '0000000099', nombre: 'C', apellido: 'D', rol: 'ASESOR', estado: 'PENDIENTE', email: 'b@matista.test', email_verificado: 0 },
    ]);
    const filas = await listarEmpleados(connection);

    assert.equal(filas[0].email_verificado, true);
    assert.equal(filas[1].email_verificado, false);
    assert.ok(!('password_hash' in filas[0]), 'sin credenciales en el listado');
  });

  test('obtenerEmpleado coerza email_verificado y devuelve undefined si no existe', async () => {
    const conFila = conexionConQuery([
      { legajo: '0000000001', email: 'a@matista.test', email_verificado: 1 },
    ]);
    const fila = await obtenerEmpleado(conFila, '0000000001');
    assert.equal(fila.email_verificado, true);
    assert.deepEqual(conFila.llamadas[0].parametros, ['0000000001']);

    const vacio = conexionConQuery([]);
    assert.equal(await obtenerEmpleado(vacio, '9999999999'), undefined);
  });

  test('el detalle incluye direccion y filtros del listado llegan parametrizados', async () => {
    const connection = conexionConQuery([]);
    await listarEmpleados(connection, { estado: 'PENDIENTE', rol: 'ASESOR', busqueda: 'an' });
    const { sql, parametros } = connection.llamadas[0];

    assert.match(sql, /WHERE e\.estado = \? AND e\.rol = \? AND /);
    assert.deepEqual(parametros.slice(0, 2), ['PENDIENTE', 'ASESOR']);
  });
});

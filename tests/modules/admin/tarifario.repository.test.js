import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  listarPlanesActivos,
  listarTarifasActivas,
  obtenerPlanPorId,
} from '../../../src/modules/admin/tarifario.repository.js';

/**
 * Captura SQL y parametros devolviendo las filas sinteticas indicadas.
 * @param {object[]} filas Resultado de la siguiente consulta.
 * @returns {object} Conexion mysql2 simulada con llamadas observables.
 */
function conexionCapturadora(filas) {
  const llamadas = [];
  return {
    llamadas,
    async execute(sql, parametros = []) {
      llamadas.push({ sql, parametros });
      return [filas, []];
    },
  };
}

describe('repositorio de consulta tarifaria SL-2', () => {
  test('lista exclusivamente planes activos y ordenados por id', async () => {
    const connection = conexionCapturadora([{ id: 1, nombre: 'PLAN' }]);
    const filas = await listarPlanesActivos(connection);

    assert.equal(filas.length, 1);
    assert.match(connection.llamadas[0].sql, /WHERE activa = 1/);
    assert.match(connection.llamadas[0].sql, /ORDER BY id/);
  });

  test('busca el plan parametrizado incluyendo su estado', async () => {
    const connection = conexionCapturadora([{ id: 2, nombre: 'PLAN', activa: 0 }]);
    const plan = await obtenerPlanPorId(connection, 2);

    assert.equal(plan.activa, 0);
    assert.deepEqual(connection.llamadas[0].parametros, [2]);
  });

  test('filtra version, plan, modalidad y baja logica sin convertir DECIMAL', async () => {
    const connection = conexionCapturadora([{ precio: '123.45' }]);
    const filas = await listarTarifasActivas(connection, {
      versionId: 8,
      planId: 3,
      tipoIngreso: 'Voluntario',
    });

    assert.equal(filas[0].precio, '123.45');
    assert.match(connection.llamadas[0].sql, /activa = 1/);
    assert.deepEqual(connection.llamadas[0].parametros, [8, 3, 'Voluntario']);
  });
});

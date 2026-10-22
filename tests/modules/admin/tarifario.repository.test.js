import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  listarPlanesActivos,
  listarTarifasActivas,
  listarTarifasDeVersion,
  listarVersiones,
  obtenerPlanPorId,
  obtenerVersionPorId,
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

describe('repositorio de consultas de versiones SL-3', () => {
  const conexionConQuery = (filas) => ({
    llamadas: [],
    async execute(sql, parametros = []) {
      this.llamadas.push({ sql, parametros });
      return [filas, []];
    },
    async query(sql, parametros = []) {
      this.llamadas.push({ sql, parametros });
      return [filas, []];
    },
  });

  test('lista versiones cronologicamente por creacion con responsable', async () => {
    const connection = conexionConQuery([]);
    await listarVersiones(connection);

    assert.match(connection.llamadas[0].sql, /LEFT JOIN empleados/);
    assert.match(connection.llamadas[0].sql, /ORDER BY v.created_at ASC, v.id ASC/);
  });

  test('busca la version parametrizada identificando estados y trazabilidad', async () => {
    const connection = conexionConQuery([{ id: 5 }]);
    const version = await obtenerVersionPorId(connection, 5);

    assert.equal(version.id, 5);
    assert.match(connection.llamadas[0].sql, /WHERE v.id = \?/);
    assert.deepEqual(connection.llamadas[0].parametros, [5]);
  });

  test('lee el snapshot completo y opcionalmente carga solo filas activas', async () => {
    const completas = conexionConQuery([{ plan_id: 1, precio: '10.00', activa: 0 }]);
    await listarTarifasDeVersion(completas, 9);
    assert.match(completas.llamadas[0].sql, /JOIN planes/);
    assert.doesNotMatch(completas.llamadas[0].sql, /activa = 1/);
    assert.deepEqual(completas.llamadas[0].parametros, [9]);

    const efectivas = conexionConQuery([{ plan_id: 1, precio: '10.00', activa: 1 }]);
    await listarTarifasDeVersion(efectivas, 9, { soloActivas: true });
    assert.match(efectivas.llamadas[0].sql, /AND t.activa = 1/);
  });
});

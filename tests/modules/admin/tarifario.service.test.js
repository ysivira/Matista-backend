import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  gestionarPlanes,
  gestionarTarifario,
} from '../../../src/modules/admin/tarifario.service.js';
import { validarParametrosTarifario } from '../../../src/modules/admin/tarifario.validators.js';

/**
 * Crea dependencias en memoria para observar el caso de uso sin abrir MySQL.
 * @param {object} overrides Resultados o funciones que cada prueba necesita variar.
 * @returns {object} Bolsa compatible con el servicio y llamadas observables.
 */
function dependenciasFalsas(overrides = {}) {
  const llamadas = [];
  const dependencias = {
    async withConnection(pool, operation) {
      llamadas.push({ metodo: 'withConnection', pool });
      return operation({ prueba: true });
    },
    async listarPlanesActivos() {
      return [{ id: 1, nombre: 'PLAN', detalles: null, condiciones_generales: null }];
    },
    async obtenerPlanPorId(connection, planId) {
      llamadas.push({ metodo: 'obtenerPlanPorId', planId });
      return { id: planId, nombre: 'PLAN', activa: 1 };
    },
    async resolverVersionVigente(connection, fechaReferencia) {
      llamadas.push({ metodo: 'resolverVersionVigente', fechaReferencia });
      return {
        id: 9007199254740991n,
        tipo: 'CARGA_INICIAL',
        estado: 'ACTIVA',
        fecha_activacion: new Date('2026-10-19T12:00:00.000Z'),
      };
    },
    async listarTarifasActivas(connection, filtro) {
      llamadas.push({ metodo: 'listarTarifasActivas', filtro });
      return [
        { rango_clave: 'HIJO 0-1', rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '30.00' },
        { rango_clave: '66+', rango_etario: '66-00', rango_nota: null, precio: '20.10' },
        { rango_clave: '0-25', rango_etario: '0-25', rango_nota: null, precio: '10.00' },
      ];
    },
    ...overrides,
  };
  return { dependencias, llamadas };
}

describe('servicio de consulta tarifaria SL-2', () => {
  test('lista planes activos sin transformar el contrato persistido', async () => {
    const { dependencias } = dependenciasFalsas();
    const planes = await gestionarPlanes({ pool: true }, dependencias);

    assert.deepEqual(planes, [
      { id: 1, nombre: 'PLAN', detalles: null, condiciones_generales: null },
    ]);
  });

  test('compone version, precio decimal, notas y orden comercial', async () => {
    const { dependencias, llamadas } = dependenciasFalsas();
    const resultado = await gestionarTarifario(
      { pool: true },
      { planId: '1', tipoIngreso: 'Obligatorio' },
      new Date('2026-10-20T13:14:49.123Z'),
      dependencias,
    );

    assert.deepEqual(resultado.plan, { id: 1, nombre: 'PLAN' });
    assert.equal(resultado.tipo_ingreso, 'Obligatorio');
    assert.deepEqual(resultado.version, {
      id: '9007199254740991',
      tipo: 'CARGA_INICIAL',
      estado: 'ACTIVA',
      fecha_activacion: '2026-10-19T12:00:00.000Z',
    });
    assert.deepEqual(
      resultado.tarifas.map((tarifa) => tarifa.rango_clave),
      ['0-25', '66+', 'HIJO 0-1'],
    );
    assert.equal(resultado.tarifas[1].precio, '20.10');
    assert.equal(resultado.tarifas[2].rango_nota, '(*)');
    assert.equal(
      llamadas.find((llamada) => llamada.metodo === 'resolverVersionVigente').fechaReferencia,
      '2026-10-20 13:14:49.123000',
    );
    assert.deepEqual(
      llamadas.find((llamada) => llamada.metodo === 'listarTarifasActivas').filtro,
      { versionId: 9007199254740991n, planId: 1, tipoIngreso: 'Obligatorio' },
    );
  });

  test('acepta una coleccion activa vacia como resultado valido', async () => {
    const { dependencias } = dependenciasFalsas({
      listarTarifasActivas: async () => [],
    });
    const resultado = await gestionarTarifario(
      {},
      { planId: '2', tipoIngreso: 'Voluntario' },
      new Date('2026-10-20T12:00:00Z'),
      dependencias,
    );

    assert.deepEqual(resultado.tarifas, []);
  });

  test('distingue plan inexistente, inactivo y ausencia de version vigente', async () => {
    for (const escenario of ['inexistente', 'inactivo', 'sin-version']) {
      const { dependencias } = dependenciasFalsas({
        obtenerPlanPorId: async () => escenario === 'inexistente'
          ? undefined
          : { id: 1, nombre: 'PLAN', activa: escenario === 'inactivo' ? 0 : 1 },
        resolverVersionVigente: async () => escenario === 'sin-version' ? null : {
          id: 1,
          tipo: 'CARGA_INICIAL',
          estado: 'ACTIVA',
          fecha_activacion: new Date(),
        },
      });

      await assert.rejects(
        gestionarTarifario(
          {},
          { planId: '1', tipoIngreso: 'Obligatorio' },
          new Date('2026-10-20T12:00:00Z'),
          dependencias,
        ),
        escenario === 'inexistente'
          ? { code: 'ADMIN_NO_ENCONTRADO', status: 404 }
          : { code: 'ADMIN_ESTADO', status: 409 },
      );
    }
  });

  test('rechaza identificadores y modalidades fuera del contrato antes de consultar', async () => {
    for (const parametros of [
      { planId: '0', tipoIngreso: 'Obligatorio' },
      { planId: '01', tipoIngreso: 'Obligatorio' },
      { planId: '65536', tipoIngreso: 'Obligatorio' },
      { planId: '1', tipoIngreso: 'obligatorio' },
      { planId: '1', tipoIngreso: 'Ambas' },
    ]) {
      assert.throws(
        () => validarParametrosTarifario(parametros),
        (error) => error.code === 'ADMIN_VALIDACION'
          && error.status === 400
          && error.details.length >= 1,
      );
    }
  });
});

/**
 * ============================================================
 * MATISTA | PRUEBAS DE PREVISUALIZACIÓN DE AUMENTOS
 * ============================================================
 *
 * Archivo: tarifario.aumento-previa.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Comparar vista previa y aplicación definitiva, preservando
 * redondeo, modalidad, orden y ausencia de escrituras en la previa.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  aumentarVersionTarifario,
  calcularImportesAumento,
  previsualizarAumentoVersion,
} from '../../../src/modules/admin/tarifario.service.js';

const ACTOR_PRUEBA = { legajo: '1234567' };

/** Precios con centavos y casos sensibles al redondeo HALF-UP. */
const TARIFAS_EQUIVALENCIA = Object.freeze([
  { id: 201, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' },
  { id: 202, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '50.25' },
  { id: 203, plan_id: 3, tipo_ingreso: 'Obligatorio', rango_clave: '36-40', precio: '99.99' },
  { id: 204, plan_id: 3, tipo_ingreso: 'Voluntario', rango_clave: '41-50', precio: '0.01' },
]);

/** Porcentajes representativos: enteros, centavos y casos de redondeo. */
const PORCENTAJES = Object.freeze(['5', '0.01', '33.33', '7.77']);

/**
 * Crea un entorno en memoria compartido por previsualización y aplicación:
 * la misma lista de tarifas alimenta ambas operaciones, de modo que la
 * comparación de importes sea una equivalencia real y no un espejo.
 * @param {object[]} tarifas Filas iniciales de la versión 7.
 * @returns {object} Dependencias falsas y estado observable.
 */
function entornoAumento(tarifas = TARIFAS_EQUIVALENCIA.map((fila) => ({ ...fila, version_id: 7 }))) {
  const estado = {
    version: {
      id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 0,
      version_base_id: 1, actor_legajo: '1234567',
    },
    tarifas,
    eventos: [],
    siguienteEvento: 1,
    escriturasAumento: 0,
  };
  const dependencias = {
    async withConnection(pool, operation) {
      const connection = {
        async execute(sql, parametros = []) {
          if (sql.startsWith('SELECT nombre, apellido FROM empleados')) {
            return [[{ nombre: 'Marcelo', apellido: 'Suarez' }], []];
          }
          throw new Error(`SQL no contemplado: ${sql}`);
        },
        // El aumento definitivo lee sus filas con SQL propio dentro de la
        // transacción; el doble devuelve exactamente las filas del estado.
        async query(sql, parametros = []) {
          if (sql.includes('FROM tarifas')) {
            const versionId = Number(parametros[0]);
            const modalidad = parametros[1];
            return [estado.tarifas.filter(
              (fila) => Number(fila.version_id) === versionId
                && (!modalidad || fila.tipo_ingreso === modalidad),
            ), []];
          }
          throw new Error(`SQL no contemplado: ${sql}`);
        },
      };
      return operation(connection);
    },
    async obtenerVersionPorId(connection, versionId) {
      return Number(estado.version.id) === Number(versionId) ? estado.version : null;
    },
    async obtenerEmpleado(connection, legajo) {
      return { legajo, nombre: 'Marcelo', apellido: 'Suarez' };
    },
    async listarTarifasDeVersion(connection, versionId) {
      return estado.tarifas
        .filter((fila) => Number(fila.version_id) === Number(versionId))
        .map((fila) => ({
          ...fila,
          plan_nombre: `PLAN ${fila.plan_id}`,
          rango_nota: null,
        }));
    },
    async listarTarifasDeVersion(connection, versionId) {
      return estado.tarifas
        .filter((fila) => Number(fila.version_id) === Number(versionId))
        .map((fila) => ({
          ...fila,
          plan_nombre: `PLAN ${fila.plan_id}`,
          rango_nota: null,
        }));
    },
    async bloquearVersion(connection, versionId) {
      return Number(estado.version.id) === Number(versionId) ? estado.version : null;
    },
    async incrementarRevision(connection, { id, revision }) {
      estado.version.revision = Number(revision) + 1;
      return 1;
    },
    async insertarEvento(connection, evento) {
      const id = estado.siguienteEvento;
      estado.siguienteEvento += 1;
      estado.eventos.push({ id, ...evento });
      return id;
    },
    async aumentarPrecios(connection, { importes }) {
      estado.escriturasAumento += 1;
      for (const [id, precio] of importes) {
        const fila = estado.tarifas.find((tarifa) => Number(tarifa.id) === Number(id));
        fila.precio = precio;
      }
      return importes.length;
    },
  };
  return { dependencias, estado };
}

/**
 * Busca una fila de la previsualización por su identificador.
 * @param {object} previa Respuesta del servicio de previsualización.
 * @param {number} id Identificador de tarifa.
 * @returns {object} Fila prevista.
 */
function filaPrevia(previa, id) {
  return previa.filas.find((fila) => Number(fila.id) === id);
}

describe('previsualización del aumento masivo (lectura pura)', () => {
  test('la previsualización coincide exactamente con la aplicación definitiva', async () => {
    for (const porcentaje of PORCENTAJES) {
      const { dependencias, estado } = entornoAumento();
      const previa = await previsualizarAumentoVersion(
        { pool: true }, { id: '7' }, { porcentaje }, dependencias,
      );
      await aumentarVersionTarifario(
        { pool: true }, { id: '7' },
        { porcentaje, tipoIngreso: null, revision: '0' },
        ACTOR_PRUEBA, dependencias,
      );
      // Cada precio escrito por el aumento definitivo es exactamente el
      // precio_nuevo previsto; los precios no escritos (sin cambio de un
      // centavo) se previsualizan con precio_nuevo igual al anterior.
      for (const fila of estado.tarifas) {
        const prevista = filaPrevia(previa, fila.id);
        assert.ok(prevista, `fila ${fila.id} ausente en la previa (${porcentaje}%)`);
        if (prevista.precio_nuevo !== prevista.precio_anterior) {
          assert.equal(fila.precio, prevista.precio_nuevo, `precio escrito vs previsto (${porcentaje}%)`);
        } else {
          assert.equal(fila.precio, prevista.precio_anterior, `fila sin cambio (${porcentaje}%)`);
        }
        assert.equal(prevista.precio_anterior, String(prevista.precio_anterior));
      }
      // El incremento previsto es exactamente la diferencia de centavos.
      for (const fila of previa.filas) {
        const diferencia = (BigInt(fila.precio_nuevo.replace('.', ''))
          - BigInt(fila.precio_anterior.replace('.', ''))).toString();
        assert.equal(BigInt(fila.incremento.replace('.', '')), BigInt(diferencia));
      }
    }
  });

  test('la previsualización no escribe precios ni registra eventos', async () => {
    const { dependencias, estado } = entornoAumento();
    const antes = estado.tarifas.map((fila) => ({ ...fila }));
    const previa = await previsualizarAumentoVersion(
      { pool: true }, { id: '7' }, { porcentaje: '5' }, dependencias,
    );
    assert.equal(previa.filas.length, 4);
    assert.equal(estado.escriturasAumento, 0);
    assert.equal(estado.eventos.length, 0);
    assert.equal(estado.version.revision, 0);
    assert.deepEqual(estado.tarifas, antes);
  });

  test('la previsualización respeta la modalidad pedida y conserva su orden comercial', async () => {
    const { dependencias } = entornoAumento();
    const previa = await previsualizarAumentoVersion(
      { pool: true }, { id: '7' },
      { porcentaje: '10', tipoIngreso: 'Voluntario' }, dependencias,
    );
    assert.deepEqual(previa.filas.map((fila) => fila.tipo_ingreso), ['Voluntario', 'Voluntario']);
    assert.deepEqual(previa.filas.map((fila) => Number(fila.id)), [202, 204]);
    assert.equal(previa.tipo_ingreso, 'Voluntario');
    // Orden comercial por plan y rango, igual que el snapshot de pantalla.
    const completa = await previsualizarAumentoVersion(
      { pool: true }, { id: '7' }, { porcentaje: '10' }, dependencias,
    );
    assert.deepEqual(completa.filas.map((fila) => Number(fila.id)), [201, 202, 203, 204]);
    assert.equal(completa.tipo_ingreso, null);
  });

  test('la previsualización reporta los mismos errores económicos que la aplicación', async () => {
    // Porcentaje inválido: 400 ADMIN_VALIDACION.
    const { dependencias } = entornoAumento();
    await assert.rejects(
      previsualizarAumentoVersion({ pool: true }, { id: '7' }, { porcentaje: '150' }, dependencias),
      (error) => error.code === 'ADMIN_VALIDACION' && error.status === 400,
    );
    await assert.rejects(
      previsualizarAumentoVersion({ pool: true }, { id: '7' }, { porcentaje: '0' }, dependencias),
      { code: 'ADMIN_VALIDACION', status: 400 },
    );
    // Versión inexistente: 404.
    await assert.rejects(
      previsualizarAumentoVersion({ pool: true }, { id: '99' }, { porcentaje: '5' }, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
    // Sin filas de la modalidad: 409, mismo mensaje que la aplicación.
    const sinFilas = entornoAumento([{
      id: 201, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio',
      rango_clave: '0-25', precio: '100.00',
    }]);
    await assert.rejects(
      previsualizarAumentoVersion(
        { pool: true }, { id: '7' }, { porcentaje: '5', tipoIngreso: 'Voluntario' },
        sinFilas.dependencias,
      ),
      (error) => error.status === 409
        && /no tiene filas de la modalidad Voluntario/.test(error.message),
    );
    // Tope de columna excedido: 409 y sin escrituras.
    const alTope = entornoAumento([{
      id: 301, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio',
      rango_clave: '0-25', precio: '99999999.00',
    }]);
    await assert.rejects(
      previsualizarAumentoVersion(
        { pool: true }, { id: '7' }, { porcentaje: '1' }, alTope.dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(alTope.estado.escriturasAumento, 0);
  });

  test('el cálculo puro compartido reproduce los casos de redondeo aprobados', () => {
    const importes = calcularImportesAumento(
      TARIFAS_EQUIVALENCIA.map((fila) => ({ ...fila, version_id: 7 })),
      '5',
    );
    const porId = new Map(importes.map((calculo) => [calculo.id, calculo]));
    assert.equal(porId.get(201).nuevo, '105.00');
    // 50.25 * 1.05 = 52.7625 -> 52.76 (HALF-UP sobre centavos exactos).
    assert.equal(porId.get(202).nuevo, '52.76');
    // Medio centavo clásico: 99.99 más 5% es 104.99.
    assert.equal(porId.get(203).nuevo, '104.99');
    // 0.01 más 0.01% no alcanza un centavo: la fila queda sin cambio.
    assert.equal(porId.get(204).nuevo, '0.01');
    assert.equal(porId.get(204).aumento, '0.00');
  });
});

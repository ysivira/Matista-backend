/**
 * ============================================================
 * MATISTA | PRUEBAS DE MECANISMOS ADMIN
 * ============================================================
 *
 * Archivo: admin.mecanismos.unit.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Probar precisión monetaria, errores públicos y lista permitida
 * de auditoría sin utilizar bases de datos.
 *
 * ============================================================
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ERRORES_ADMIN,
  errorConcurrencia,
  errorFechaOcupada,
  errorNoEncontrado,
  errorValidacion,
  mapearErrorIntegridad,
} from '../../../src/modules/admin/admin.errors.js';
import {
  aplicarPorcentaje,
  compararImportes,
  centavosAImporte,
  esImporteValido,
  esPorcentajeValido,
  importeACentavos,
  redondearImporte,
} from '../../../src/modules/admin/admin.money.js';
import {
  EVENTOS_VERSION,
  etiquetaVersion,
  registrarAuditoriaVersion,
} from '../../../src/modules/admin/admin.audit.js';
import { withAdminVersionLock } from '../../../src/modules/admin/admin.transaction.js';

const integrando = '1000000000000000001';

// SPEC-06: traslado desde integración; usa solo un pool doble, sin hooks MySQL ni DDL.
test('un fallo de RELEASE_LOCK no impide liberar la conexion', async () => {
  let liberada = false;
  const connection = {
    // Falso pool con una conexion espia: todo funciona salvo RELEASE_LOCK
    // El contrato de mysql2 es [filas, campos] con filas = [objetoFila].
    query: async () => [[], []],
    execute: async (sql) => {
      if (/RELEASE_LOCK/u.test(sql)) {
        throw new Error('RELEASE_LOCK simulado roto.');
      }
      return [[{ resultado: 1 }], undefined];
    },
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => { liberada = true; },
  };
  const poolFalso = { getConnection: async () => connection };
  const salida = await withAdminVersionLock(poolFalso, async () => 'ok');
  assert.equal(salida.resultado, 'ok');
  assert.equal(salida.bloqueoAdquirido, true);
  assert.equal(salida.liberacionOk, false);
  assert.equal(liberada, true);
});

test('redondea importes a dos decimales con HALF-UP', () => {
  assert.equal(redondearImporte('0.005'), '0.01');
  assert.equal(redondearImporte('0.004'), '0.00');
  assert.equal(redondearImporte('2.675'), '2.68');
  assert.equal(redondearImporte('1.995'), '2.00');
  assert.equal(redondearImporte('12'), '12.00');
  assert.equal(redondearImporte('12.3'), '12.30');
  assert.equal(redondearImporte('100145118.435'), '100145118.44');
});

test('no usa punto flotante en bordes clasicos', () => {
  // 2.675 y 0.285 se corrompen con binario IEEE; el calculo es por BigInt.
  assert.equal(redondearImporte('0.285'), '0.29');
  assert.equal(aplicarPorcentaje('404808.93', '7.00'), '28336.63');
  assert.equal(aplicarPorcentaje('100.00', '2.5'), '2.50');
});

test('maneja limites, negativos y conversiones consistentes', () => {
  assert.equal(redondearImporte('99999999.995'), '100000000.00');
  assert.equal(aplicarPorcentaje('-404808.93', '7.00'), '-28336.63');
  assert.equal(centavosAImporte(100n), '1.00');
  assert.equal(centavosAImporte(-5n), '-0.05');
  assert.equal(centavosAImporte(0n), '0.00');
  assert.equal(importeACentavos('66.00'), 6600n);
  assert.equal(importeACentavos('66.005'), 6601n);
  assert.equal(compararImportes('3.00', '2.99'), 1);
  assert.equal(compararImportes('3.00', '3.00'), 0);
  assert.equal(compararImportes('3.00', '3.01'), -1);
  assert.equal(compararImportes('3', '3.00'), 0);
});

test('valida importes y porcentajes del esquema', () => {
  assert.equal(esImporteValido('4048.08'), true);
  assert.equal(esImporteValido('4048.083'), false);
  assert.equal(esImporteValido('-1.00'), false);
  assert.equal(esImporteValido('99999999.99'), true);
  assert.equal(esImporteValido('100000000.00'), false);
  assert.equal(esImporteValido('abc'), false);
  assert.equal(esPorcentajeValido('7.00'), true);
  assert.equal(esPorcentajeValido('40.00'), true);
  assert.equal(esPorcentajeValido('99.99'), true);
  assert.equal(esPorcentajeValido('100.00'), false);
  assert.equal(esPorcentajeValido('-1'), false);
  assert.equal(esPorcentajeValido('7'), true);
});

test('expone errores de dominio ADMIN con contratos estables', () => {
  const validacion = errorValidacion('Entrada invalida.');
  assert.equal(validacion.code, 'ADMIN_VALIDACION');
  assert.equal(validacion.status, 400);

  const estado = errorFechaOcupada();
  assert.equal(estado.code, 'VERSION_DATE_TAKEN');
  assert.equal(estado.status, 409);

  const concurrencia = errorConcurrencia();
  assert.equal(concurrencia.code, 'ADMIN_CONCURRENCIA');
  assert.equal(concurrencia.status, 409);

  const inexistentes = errorNoEncontrado();
  assert.equal(inexistentes.code, 'ADMIN_NO_ENCONTRADO');
  assert.equal(inexistentes.status, 404);

  assert.equal(ERRORES_ADMIN.COLA_OCUPADA, 'VERSION_QUEUE_REJECTED');
  assert.equal(ERRORES_ADMIN.CONFLICTO_PRECIO, 'PRICE_VERSION_CONFLICT');
  assert.equal(ERRORES_ADMIN.INTEGRIDAD, 'ADMIN_INTEGRIDAD');
});

test('clasifica errores de integridad de MySQL y conserva los demas', () => {
  const duplicado = Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
  const mapped = mapearErrorIntegridad(duplicado);
  assert.equal(mapped.code, 'ADMIN_INTEGRIDAD');
  assert.equal(mapped.status, 409);

  const network = Object.assign(new Error('<timeout>'), { code: 'ETIMEDOUT' });
  assert.equal(mapearErrorIntegridad(network), network);
});

test('registra solo los eventos VERSION_* aprobados por la migracion 012', async () => {
  assert.deepEqual(EVENTOS_VERSION, [
    'VERSION_CREADA',
    'VERSION_PROGRAMADA',
    'VERSION_CANCELADA',
    'VERSION_REACTIVADA',
    'VERSION_REVERTIDA',
  ]);

  const consultas = [];
  const connection = {
    // Connection falsa que captura el INSERT sin tocar la base.
    execute: async (sql, params) => { consultas.push([sql, params]); return [[], []]; },
  };

  await registrarAuditoriaVersion(
    connection,
    'VERSION_CREADA',
    integrando,
    null,
    etiquetaVersion(7, 'ACTIVA'),
    '2026-10-19 12:00:00.000000',
  );

  assert.equal(consultas.length, 1);
  const [sql, params] = consultas[0];
  assert.match(sql, /empleados_auditoria/);
  // Convencion TARIFARIO: legajo = actor (referencia propia) y campo fijo.
  assert.match(sql, /'TARIFARIO'/);
  assert.deepEqual(params, [
    integrando, integrando, 'VERSION_CREADA', null, 'version#7:ACTIVA',
    '2026-10-19 12:00:00.000000',
  ]);
});

test('rechaza antes de la base un evento fuera de la whitelist', async () => {
  const connection = {
    execute: async () => { throw new Error('NO debe tocar la base.'); },
  };

  await assert.rejects(
    registrarAuditoriaVersion(connection, 'EMAIL_CAMBIADO', integrando, null, null, 'ahora'),
    /no permitido/,
  );
});

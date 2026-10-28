/**
 * ============================================================
 * MATISTA | COMPATIBILIDAD MONETARIA ADMIN
 * ============================================================
 *
 * Archivo: admin.money.compatibilidad.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Preservar exports, identidad de funciones, errores y redondeo
 * entre la interfaz ADMIN y la implementación monetaria compartida.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as neutral from '../../../src/shared/lib/money.js';
import * as admin from '../../../src/modules/admin/admin.money.js';
import { isAppError } from '../../../src/shared/errors/app-error.js';

/** Comprueba que la ruta pública anterior reexporta las mismas nueve funciones, sin otra implementación. */
test('ARCH14 ADMIN conserva exportaciones e identidad de las utilidades monetarias neutrales', () => {
  assert.deepEqual(Object.keys(admin), Object.keys(neutral));
  assert.equal(Object.keys(neutral).length, 9);
  for (const nombre of Object.keys(neutral)) assert.equal(admin[nombre], neutral[nombre], nombre);
});

/** Protege códigos, mensajes y estado HTTP de errores monetarios reconocidos por el manejador existente. */
test('ARCH14 errores monetarios conservan ADMIN_VALIDACION, HTTP 400 y origen operativo', () => {
  const casos = [
    [() => neutral.parseDecimal(Infinity), 'El valor monetario no es un numero finito.'],
    [() => neutral.parseDecimal('invalido'), 'El valor monetario no tiene formato decimal.'],
    [() => neutral.dividirHalfUp(1n, 0n), 'Division monetaria por cero.'],
    [() => neutral.aplicarPorcentaje('1.00', '-1'), 'El porcentaje no puede ser negativo.'],
  ];
  for (const [operacion, mensaje] of casos) {
    /** Verifica la forma y procedencia del error, no solo propiedades imitables por una excepción ajena. */
    assert.throws(operacion, error => {
      assert.ok(isAppError(error));
      assert.equal(error.code, 'ADMIN_VALIDACION');
      assert.equal(error.status, 400);
      assert.equal(error.message, mensaje);
      assert.equal(error.details, undefined);
      return true;
    });
  }
});

/** Comprueba BigInt, HALF-UP, negativos, límites y porcentajes sobre la implementación compartida. */
test('ARCH14 precisión y redondeo monetario se conservan en la ubicación neutral', () => {
  assert.equal(neutral.importeACentavos('999999999999999999.995'), 100000000000000000000n);
  assert.equal(neutral.importeACentavos('-0.005'), -1n);
  assert.equal(neutral.centavosAImporte(-1n), '-0.01');
  assert.equal(neutral.redondearImporte('1.005'), '1.01');
  assert.equal(neutral.aplicarPorcentaje('0.05', '10'), '0.01');
  assert.equal(neutral.compararImportes('1', '1.00'), 0);
  assert.equal(neutral.esImporteValido('99999999.99'), true);
  assert.equal(neutral.esImporteValido('100000000.00'), false);
  assert.equal(neutral.esPorcentajeValido('-1'), false);
  assert.equal(neutral.esPorcentajeValido('99.99'), true);
});

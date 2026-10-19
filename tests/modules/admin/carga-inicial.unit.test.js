import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normalizarRangoClave,
  seleccionarReferenciasValidas,
  validarOrigen,
} from '../../../src/modules/admin/carga-inicial.service.js';

const fuenteCompleta = Object.freeze({
  planes: Object.freeze([
    { id: 1, nombre: 'RUBÍ', activo: 1 },
    { id: 2, nombre: 'ESMERALDA', activo: 1 },
    { id: 3, nombre: 'ZAFIRO', activo: 1 },
    { id: 4, nombre: 'DIAMANTE', activo: 1 },
    { id: 5, nombre: 'Básico', activo: 0 },
  ]),
  referencias: Object.freeze([]),
  aportes: Object.freeze([
    { categoria: 'A', aporte: '16353.97' },
    { categoria: 'Adherente', aporte: '14208.87' },
    ...['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']
      .map((categoria, indice) => ({
        categoria,
        aporte: String(10000 + indice),
      })),
  ]),
});

// Construye la matriz exacta aprobada: 8 grupos de 20 claves por plan.
function referencia(id, planId, tipo, rango) {
  return {
    id,
    plan_id: planId,
    tipo_ingreso: tipo,
    rango_etario: rango,
    precio: '100.00',
    activo: 1,
    plan_activo: 1,
  };
}

const CLAVES_20 = Object.freeze([
  '0-25', '26-35', '36-40', '41-50', '51-60', '61-65', '66-00',
  'FAMILIAR A CARGO',
  'HIJO 0-1(*)', 'HIJO 2-20', 'HIJO 21-29', 'HIJO 30-39', 'HIJO 40-49',
  'MAT 0-25', 'MAT 26-35', 'MAT 36-40', 'MAT 41-50', 'MAT 51-60',
  'MAT 61-65', 'MAT 66-00',
]);

function matrixFuente() {
  const referencias = [];
  let id = 1;

  for (const planId of [1, 2, 3, 4]) {
    for (const tipo of ['Obligatorio', 'Voluntario']) {
      for (const rango of CLAVES_20) {
        // En SIGEC vivo el plan 1 carece de '26-35' Obligatorio (es el id 165)
        // y el plan 4 de '0-25' Obligatorio (es el id 164): sin esto la matriz
        // sintetica duplicaria claves respecto del origen real.
        if (tipo === 'Obligatorio' && rango === '26-35' && planId === 1) {
          continue;
        }
        if (tipo === 'Obligatorio' && rango === '0-25' && planId === 4) {
          continue;
        }

        referencias.push(referencia(id, planId, tipo, rango));
        id += 1;
      }
    }
  }

  // Ruido a excluir: 6 inactivas, 2 de plan inactivo y 2 monotributo, mas
  // los registros completadores 164 y 165 (activos, planes activos).
  referencias.push(
    { id: 4, plan_id: 4, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '394935.54', activo: 0, plan_activo: 1 },
    { id: 5, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_etario: '0-17', precio: '15000.00', activo: 0, plan_activo: 1 },
    { id: 161, plan_id: 1, tipo_ingreso: 'monotributo', rango_etario: '0-17', precio: '15000.00', activo: 1, plan_activo: 1 },
    { id: 162, plan_id: 1, tipo_ingreso: 'monotributo', rango_etario: '18-25', precio: '20000.00', activo: 1, plan_activo: 1 },
    { id: 163, plan_id: 4, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '394.94', activo: 0, plan_activo: 1 },
    { id: 164, plan_id: 4, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '404808.93', activo: 1, plan_activo: 1 },
    { id: 165, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_etario: '26-35', precio: '172025.75', activo: 1, plan_activo: 1 },
    { id: 166, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '34.00', activo: 0, plan_activo: 1 },
    { id: 167, plan_id: 1, tipo_ingreso: 'Voluntario', rango_etario: '0-25', precio: '50.00', activo: 0, plan_activo: 1 },
    { id: 168, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '50.00', activo: 0, plan_activo: 1 },
    { id: 169, plan_id: 5, tipo_ingreso: 'Obligatorio', rango_etario: '0-25', precio: '34.00', activo: 1, plan_activo: 0 },
    { id: 170, plan_id: 5, tipo_ingreso: 'Voluntario', rango_etario: '0-25', precio: '34.00', activo: 1, plan_activo: 0 },
  );

  return referencias;
}

test('normaliza 66-00 como 66+ e HIJO 0-1(*) con anotacion preservada', () => {
  assert.deepEqual(normalizarRangoClave('66-00'), { clave: '66+', nota: null });
  assert.deepEqual(
    normalizarRangoClave('HIJO 0-1(*)'),
    { clave: 'HIJO 0-1', nota: '(*)' },
  );
  assert.deepEqual(
    normalizarRangoClave('MAT 61-65'),
    { clave: 'MAT 61-65', nota: null },
  );
});

test('seleccciona 160 validas y documenta las 10 exclusiones con motivo', () => {
  const { validas, excluidos } = seleccionarReferenciasValidas(matrixFuente());

  assert.equal(validas.length, 160);
  assert.equal(excluidos.length, 10);

  const excluidosPorId = new Map(excluidos.map((fila) => [fila.id, fila]));

  for (const id of [4, 5, 163, 166, 167, 168]) {
    assert.equal(excluidosPorId.get(id).motivo, 'Referencia inactiva');
  }
  for (const id of [169, 170]) {
    assert.match(excluidosPorId.get(id).motivo, /plan inactivo/);
  }
  for (const id of [161, 162]) {
    assert.match(excluidosPorId.get(id).motivo, /monotributo/);
  }

  // Los registros 164 y 165 completan la matriz activa de planes 4 y 1.
  const porId = new Map(validas.map((fila) => [fila.id, fila]));
  assert.equal(porId.get(164).rango_clave, '0-25');
  assert.equal(porId.get(165).rango_clave, '26-35');
  assert.equal(porId.get(164).plan_id, 4);
  assert.equal(porId.get(165).plan_id, 1);

  // Normalizacion aplicada dentro de la matriz: 66-00 pasa a clave 66+ y
  // la anotacion (*) queda preservada en rango_nota.
  const hijoPuntito = validas.find((fila) => fila.rango_etario === 'HIJO 0-1(*)');
  assert.equal(hijoPuntito.rango_clave, 'HIJO 0-1');
  assert.equal(hijoPuntito.rango_nota, '(*)');
  assert.ok(validas.some((fila) => fila.rango_clave === '66+'));
});

test('validarOrigen devuelve el material listo para la carga', () => {
  const fuente = {
    ...fuenteCompleta,
    referencias: matrixFuente(),
  };

  const resultado = validarOrigen(fuente);

  assert.equal(resultado.planesActivos.length, 4);
  assert.equal(resultado.validas.length, 160);
  assert.equal(resultado.excluidos.length, 10);
  assert.equal(resultado.aportes.length, 12);
});

test('validarOrigen rechaza matriz incompleta, duplicados y aportes raros', () => {
  // Faltan tarifas: exactamente 160 permitidas.
  const incompletas = matrixFuente().filter((fila) => fila.id !== 165);

  assert.throws(
    () => validarOrigen({ ...fuenteCompleta, referencias: incompletas }),
    /160 tarifas validas/,
  );

  // Duplicado canonico dentro de la misma version: se traslada una fila
  // activa del plan 2 a la clave ya ocupada por el plan 1 (id 165).
  const duplicadas = matrixFuente();
  duplicadas.find(
    (fila) => fila.plan_id === 2
      && fila.tipo_ingreso === 'Obligatorio'
      && fila.rango_etario === '26-35',
  ).plan_id = 1;

  assert.throws(
    () => validarOrigen({ ...fuenteCompleta, referencias: duplicadas }),
    /duplicada/,
  );

  // Menos de 12 aportes.
  assert.throws(
    () => validarOrigen({
      ...fuenteCompleta,
      referencias: matrixFuente(),
      aportes: fuenteCompleta.aportes.slice(0, 11),
    }),
    /12 aportes/,
  );

  // Aporte no positivo.
  assert.throws(
    () => validarOrigen({
      ...fuenteCompleta,
      referencias: matrixFuente(),
      aportes: [
        ...fuenteCompleta.aportes.slice(0, 11),
        { categoria: 'K2', aporte: '-1' },
      ],
    }),
    /positivo/,
  );

  // Plan activo con nombre fuera de la matriz aprobada.
  assert.throws(
    () => validarOrigen({
      planes: [
        { id: 1, nombre: 'RUBÍ', activo: 1 },
        { id: 2, nombre: 'ESMERALDA', activo: 1 },
        { id: 3, nombre: 'ZAFIRO', activo: 1 },
        { id: 4, nombre: 'EXTRA', activo: 1 },
      ],
      referencias: matrixFuente(),
      aportes: fuenteCompleta.aportes,
    }),
    /matriz aprobada/,
  );
});

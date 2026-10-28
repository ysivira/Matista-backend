/**
 * ============================================================
 * MATISTA | PRUEBAS AISLADAS DE CARGA
 * ============================================================
 *
 * Archivo: carga-inicial.unit.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Verificar normalización de rangos, exclusiones, catálogo inicial
 * e idempotencia con fuentes y conexiones sintéticas.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  evaluarEstado,
  ejecutarCargaInicial,
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

/**
 * Conexion destino sintetica: interpreta el SQL del servicio con el estado
 * de catalogo que cada prueba necesita y registra todas las escrituras.
 * @param {object} opciones Estado inicial del catalogo y id de la politica nueva.
 * @returns {{destino: object, escrituras: object}} Doble y observabilidad.
 */
function crearDestino({ estadoCatalogo, politicaInsertId = 77 }) {
  const escrituras = { sqls: [], begins: 0, commits: 0, rollbacks: 0 };
  const destino = {
    async query(sql, valores = []) {
      escrituras.sqls.push({ sql, valores });
      if (/SELECT legajo FROM empleados/i.test(sql)) {
        return [[{ legajo: valores[0] }], []];
      }
      if (sql.includes('AS planes')) {
        return [[estadoCatalogo], []];
      }
      if (sql.includes("tipo = 'CARGA_INICIAL'")) {
        return [estadoCatalogo.versionCargaInicialId
          ? [{ id: estadoCatalogo.versionCargaInicialId, estado: estadoCatalogo.versionCargaInicialEstado }]
          : [], []];
      }
      if (sql.includes('AS total FROM tarifas WHERE version_id')) {
        return [[{ total: estadoCatalogo.tarifasCargaInicial ?? 0 }], []];
      }
      if (/INSERT INTO planes/i.test(sql)) return [{ insertId: 1 }, []];
      if (/INSERT INTO tarifario_versiones/i.test(sql)) return [{ insertId: 41 }, []];
      if (/INSERT INTO tarifas/i.test(sql)) return [{ insertId: 1 }, []];
      if (/INSERT INTO monotributo_aportes/i.test(sql)) return [{ insertId: 1 }, []];
      if (/INSERT INTO politica_comercial/i.test(sql)) return [{ insertId: politicaInsertId }, []];
      if (/INSERT INTO porcentajes_comerciales/i.test(sql)) return [{ insertId: 1 }, []];
      throw new Error(`SQL no contemplada por el doble: ${sql}`);
    },
    async beginTransaction() { escrituras.begins += 1; },
    async commit() { escrituras.commits += 1; },
    async rollback() { escrituras.rollbacks += 1; },
    release() {},
  };
  return { destino, escrituras };
}

/** Conexion SIGEC sintetica con la matriz aprobada completa. */
function crearFuenteSigec() {
  return {
    async query(sql) {
      if (sql.includes('FROM planes')) {
        return [[
          { id: 1, nombre: 'RUBÍ', detalles: 'D1', condiciones_generales: 'C1', activo: 1 },
          { id: 2, nombre: 'ESMERALDA', detalles: 'D2', condiciones_generales: 'C2', activo: 1 },
          { id: 3, nombre: 'ZAFIRO', detalles: 'D3', condiciones_generales: 'C3', activo: 1 },
          { id: 4, nombre: 'DIAMANTE', detalles: 'D4', condiciones_generales: 'C4', activo: 1 },
          { id: 5, nombre: 'Básico', detalles: 'D5', condiciones_generales: 'C5', activo: 0 },
        ], []];
      }
      if (sql.includes('FROM listas_de_precios')) return [matrixFuente(), []];
      if (sql.includes('FROM monotributo_aportes')) return [fuenteCompleta.aportes, []];
      throw new Error(`SQL SIGEC no contemplada: ${sql}`);
    },
  };
}

/** Pool destino que entrega siempre la misma conexion sintetica. */
function crearPoolPara(destino) {
  return { async getConnection() { return destino; } };
}

test('la carga nueva siembra el catalogo de porcentajes vinculado a la politica vigente', async () => {
  const { destino, escrituras } = crearDestino({
    estadoCatalogo: {
      planes: 0, versiones: 0, tarifas: 0, aportesAbiertos: 0,
      politicasAbiertas: 0, politicaVigenteId: null, porcentajesVigenteAbiertos: 0,
      versionCargaInicialId: null, versionCargaInicialEstado: null, tarifasCargaInicial: 0,
    },
  });

  const resumen = await ejecutarCargaInicial({
    matistaPool: crearPoolPara(destino),
    sigecConnection: crearFuenteSigec(),
    actorLegajo: '12345678',
  });

  assert.equal(resumen.aplicada, true);
  assert.equal(resumen.porcentajesComerciales, 9, 'la política nueva nace con catálogo completo');

  const insercion = escrituras.sqls.find((escritura) => /INSERT INTO porcentajes_comerciales/.test(escritura.sql));
  assert.ok(insercion, 'la carga debe insertar el catálogo comercial');
  // Cada fila tiene tres parametros: politica, porcentaje y actor. La
  // descripcion NULL y UTC_TIMESTAMP(6) son literales SQL, no parametros.
  assert.equal(insercion.valores.length, 27);
  assert.deepEqual(
    insercion.valores.filter((_, indice) => indice % 3 === 1),
    ['50.00', '45.00', '40.00', '35.00', '30.00', '25.00', '20.00', '15.00', '10.00'],
  );
  assert.ok(insercion.valores.filter((_, indice) => indice % 3 === 0).every((id) => id === 77),
    'todas las filas quedan vinculadas a la política creada');
  assert.equal(escrituras.commits, 1);
  assert.equal(escrituras.rollbacks, 0);
});

test('una carga existente con catalogo vacio completa solo los porcentajes', async () => {
  const { destino, escrituras } = crearDestino({
    estadoCatalogo: {
      planes: 4, versiones: 1, tarifas: 160, aportesAbiertos: 12,
      politicasAbiertas: 1, politicaVigenteId: 10, porcentajesVigenteAbiertos: 0,
      versionCargaInicialId: 41, versionCargaInicialEstado: 'ACTIVA', tarifasCargaInicial: 160,
    },
  });

  const resumen = await ejecutarCargaInicial({
    matistaPool: crearPoolPara(destino),
    sigecConnection: crearFuenteSigec(),
    actorLegajo: '12345678',
  });

  assert.equal(resumen.aplicada, false, 'el resto de la carga ya existe y no se repite');
  assert.equal(resumen.porcentajesComerciales, 9, 'el catálogo vacío se completó');

  const inserciones = escrituras.sqls.filter((escritura) => /INSERT INTO/i.test(escritura.sql));
  assert.equal(inserciones.length, 1, 'solo se inserta el catálogo comercial');
  assert.match(inserciones[0].sql, /INSERT INTO porcentajes_comerciales/);
  assert.ok(inserciones[0].valores.filter((_, indice) => indice % 3 === 0).every((id) => id === 10),
    'el backfill queda vinculado a la política vigente existente');
  assert.equal(escrituras.commits, 1);
  assert.equal(escrituras.rollbacks, 0);
});

test('una carga existente con catalogo propio del negocio no escribe nada', async () => {
  const { destino, escrituras } = crearDestino({
    estadoCatalogo: {
      planes: 4, versiones: 1, tarifas: 160, aportesAbiertos: 12,
      politicasAbiertas: 1, politicaVigenteId: 10, porcentajesVigenteAbiertos: 4,
      versionCargaInicialId: 41, versionCargaInicialEstado: 'ACTIVA', tarifasCargaInicial: 160,
    },
  });

  const resumen = await ejecutarCargaInicial({
    matistaPool: crearPoolPara(destino),
    sigecConnection: crearFuenteSigec(),
    actorLegajo: '12345678',
  });

  assert.equal(resumen.aplicada, false);
  assert.equal(resumen.porcentajesComerciales, 4, 'el catálogo del negocio se conserva tal cual');
  assert.equal(escrituras.sqls.filter((escritura) => /INSERT INTO/i.test(escritura.sql)).length, 0,
    'ninguna escritura sobre una carga consistente con catálogo');
  assert.equal(escrituras.begins, 0);
});

test('evaluarEstado razona por estado VIGENTE y no por la fecha de cierre', () => {
  // Base con carga completa y una política VIGENTE: idempotente.
  assert.equal(
    evaluarEstado({
      planes: 4, versiones: 1, tarifas: 160, aportesAbiertos: 12,
      politicasAbiertas: 1, versionCargaInicialId: 41,
      versionCargaInicialEstado: 'ACTIVA', tarifasCargaInicial: 160,
    }),
    'CARGA_EXISTENTE',
  );

  // Una política CANCELADA conserva vigente_hasta NULL (migración 021):
  // sin política VIGENTE la base no puede considerarse consistente.
  assert.throws(
    () => evaluarEstado({
      planes: 4, versiones: 1, tarifas: 160, aportesAbiertos: 12,
      politicasAbiertas: 0, versionCargaInicialId: 41,
      versionCargaInicialEstado: 'ACTIVA', tarifasCargaInicial: 160,
    }),
    /intermedio o inconsistente/,
  );

  // Base realmente vacía.
  assert.equal(
    evaluarEstado({
      planes: 0, versiones: 0, tarifas: 0, aportesAbiertos: 0,
      politicasAbiertas: 0, versionCargaInicialId: null,
      versionCargaInicialEstado: null, tarifasCargaInicial: 0,
    }),
    'VACIA',
  );
});

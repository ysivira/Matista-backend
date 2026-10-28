/**
 * ============================================================
 * MATISTA | INTEGRACIÓN DE TRAZABILIDAD TARIFARIA
 * ============================================================
 *
 * Archivo: tarifario.trazabilidad.integration.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Comprobar resumen y deshacer desde eventos reales de fixtures
 * propios; la integración MySQL requiere RUN_DB_TESTS.
 *
 * ============================================================
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import {
  aumentarVersionTarifario,
  crearBorradorTarifario,
  deshacerUltimoCambioEconomico,
  editarTarifaVersion,
  finalizarVersionTarifario,
  resumirEventosDeVersion,
} from '../../../src/modules/admin/tarifario.service.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';

// Pruebas gated del resumen de auditoria y del deshacer del ultimo cambio
// economico contra matista_test con el esquema REAL (014). El flujo crea
// un borrador, aplica un aumento masivo y una edicion individual, y luego
// deshace capa por capa verificando precios y eventos DESHACE reales.
// after() elimina exclusivamente el borrador identificado por la corrida.
const enabled = process.env.RUN_DB_TESTS === '1';

let config;
let pool;
let actorLegajo;
let versionActivaInicial;
let versionIdCorrida;

/** Prepara la conexion y obtiene las referencias preexistentes de solo lectura. */
before(async () => {
  if (!enabled) {
    return;
  }

  config = loadDatabaseConfig(process.env, { purpose: 'migration' });
  assertTestDatabase(config);
  pool = createDatabasePool(config);
  await verifyDatabaseConnection(pool, 'matista_test');
  await runMigrations({
    pool,
    config,
    migrationsDirectory: new URL('../../../migrations', import.meta.url)
      .pathname,
  });

  const [empleados] = await pool.query(
    `SELECT legajo FROM empleados WHERE rol = 'ADMIN' ORDER BY legajo LIMIT 1`,
  );
  assert.ok(empleados[0], 'matista_test necesita un administrador registrado');
  actorLegajo = empleados[0].legajo;

  const [activas] = await pool.query(
    `SELECT id, estado, fecha_activacion FROM tarifario_versiones
      WHERE estado = 'ACTIVA' AND tipo = 'CARGA_INICIAL'
      LIMIT 1`,
  );
  assert.ok(
    activas[0],
    'matista_test necesita la CARGA_INICIAL del catalogo en estado ACTIVA',
  );
  versionActivaInicial = Number(activas[0].id);
});

/** Elimina exclusivamente la version creada y capturada por esta corrida. */
after(async () => {
  if (!pool) {
    return;
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (versionIdCorrida) {
      await connection.execute(
        `DELETE FROM tarifario_versiones_eventos
          WHERE version_id = ? AND agrupador_id IS NOT NULL`,
        [versionIdCorrida],
      );
      await connection.execute(
        'DELETE FROM tarifario_versiones_eventos WHERE version_id = ?',
        [versionIdCorrida],
      );
      await connection.execute('DELETE FROM tarifas WHERE version_id = ?', [versionIdCorrida]);
      await connection.execute('DELETE FROM tarifario_versiones WHERE id = ?', [versionIdCorrida]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
});

/**
 * Devuelve el ID capturado del borrador de esta corrida.
 * @returns {number} ID de la version creada por la primera prueba.
 * @throws {AssertionError} Si la prueba creadora no registro la version.
 */
function borradorDeLaCorrida() {
  assert.ok(versionIdCorrida, 'necesita un borrador creado por la prueba previa');
  return versionIdCorrida;
}

test('resumen: presenta los eventos reales con conteo del grupo', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const creado = await crearBorradorTarifario(pool, { legajo: actorLegajo });
  const versionId = Number(creado.version.id);
  versionIdCorrida = versionId;

  // Cambios economicos: aumento masivo + edicion individual.
  await aumentarVersionTarifario(
    pool,
    { id: String(versionId) },
    { porcentaje: '10', revision: '0' },
    { legajo: actorLegajo },
  );
  const [filas] = await pool.query(
    'SELECT id, precio FROM tarifas WHERE version_id = ? ORDER BY id LIMIT 1',
    [versionId],
  );
  await editarTarifaVersion(
    pool,
    { id: String(versionId), tarifaId: String(filas[0].id) },
    { precio: '123.45', revision: '1' },
    { legajo: actorLegajo },
  );

  const [conteo] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [versionId],
  );
  const totalFilas = Number(conteo[0].filas);

  const resumen = await resumirEventosDeVersion(pool, { id: String(versionId) });
  assert.equal(resumen.version.id, String(versionId));
  assert.equal(resumen.version.estado, 'PREPARACION');

  // Orden mas reciente primero: la edicion individual encabeza.
  assert.equal(resumen.eventos[0].tipo_operacion, 'PRECIO');
  assert.equal(resumen.eventos[0].valor_nuevo, '123.45');
  assert.equal(resumen.eventos[0].agrupador, null);

  const agrupador = resumen.eventos.find(
    (evento) => evento.tipo_operacion === 'AUMENTO_MASIVO',
  );
  assert.ok(agrupador, 'el resumen debe mostrar el cabezal del aumento');
  // El grupo del aumento tiene un hijo PRECIO por cada fila del snapshot.
  assert.equal(agrupador.filas_agrupadas, totalFilas);
  assert.ok(agrupador.detalle.includes('10%'));

  const hijos = resumen.eventos.filter((evento) => evento.agrupador !== null);
  assert.equal(hijos.length, totalFilas);
});

test('deshacer: revierte la edicion individual y deja auditoria DESHACE', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const versionId = await borradorDeLaCorrida();
  // La fila editada en la prueba del resumen es la primera del borrador.
  const [filas] = await pool.query(
    `SELECT id, precio FROM tarifas
      WHERE version_id = ? ORDER BY id ASC LIMIT 1`,
    [versionId],
  );
  const fila = filas[0];
  const [clave] = await pool.query(
    `SELECT plan_id, tipo_ingreso, rango_clave FROM tarifas
      WHERE version_id = ? AND id = ?`,
    [versionId, fila.id],
  );
  const [base] = await pool.query(
    `SELECT precio FROM tarifas
      WHERE version_id = ? AND plan_id = ? AND tipo_ingreso = ?
        AND rango_clave = ?`,
    [versionActivaInicial, clave[0].plan_id, clave[0].tipo_ingreso, clave[0].rango_clave],
  );
  // Deshacer la EDICION restaura el precio post-aumento (el valor
  // anterior del evento de edicion), no el precio base.
  const centavosBase = Math.round(Number(String(base[0].precio)) * 100);
  const precioPostAumento = ((centavosBase + Math.round(centavosBase / 10)) / 100).toFixed(2);

  const deshecho = await deshacerUltimoCambioEconomico(
    pool,
    { id: String(versionId) },
    { revision: '2' },
    { legajo: actorLegajo },
  );
  assert.equal(deshecho.filas, 1);
  assert.equal(deshecho.revision, 3);
  assert.equal(deshecho.evento.tipo, 'DESHACER_EDICION');

  const [verificada] = await pool.query(
    'SELECT precio FROM tarifas WHERE id = ?',
    [fila.id],
  );
  assert.equal(String(verificada[0].precio), precioPostAumento);

  const [evento] = await pool.query(
    `SELECT tipo_evento, tipo_operacion, agrupador_id, valor_anterior,
            valor_nuevo, detalle
       FROM tarifario_versiones_eventos
      WHERE id = ?`,
    [Number(deshecho.evento.id)],
  );
  assert.ok(evento[0]);
  assert.equal(evento[0].tipo_operacion, 'PRECIO');
  assert.equal(evento[0].agrupador_id, null);
  assert.equal(String(evento[0].valor_anterior), '123.45');
  assert.equal(String(evento[0].valor_nuevo), precioPostAumento);
  assert.ok(String(evento[0].detalle).startsWith('DESHACE:'));
});

test('deshacer: revierte el aumento masivo completo con auditoria agrupada', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const versionId = await borradorDeLaCorrida();

  const deshecho = await deshacerUltimoCambioEconomico(
    pool,
    { id: String(versionId) },
    { revision: '3' },
    { legajo: actorLegajo },
  );

  const [conteo] = await pool.query(
    'SELECT COUNT(*) AS filas FROM tarifas WHERE version_id = ?',
    [versionId],
  );
  const totalFilas = Number(conteo[0].filas);
  assert.equal(deshecho.filas, totalFilas);
  assert.equal(deshecho.revision, 4);
  assert.equal(deshecho.evento.tipo, 'DESHACER_GRUPO');

  // Todas las filas vuelven al precio base: verificamos una fila
  // cualquiera por su clave comercial contra la version inicial.
  const [comparacion] = await pool.query(
    `SELECT copia.precio AS precio_copia, base.precio AS precio_base
       FROM tarifas copia, tarifas base
      WHERE copia.version_id = ? AND base.version_id = ?
        AND copia.plan_id = base.plan_id
        AND copia.tipo_ingreso = base.tipo_ingreso
        AND copia.rango_clave = base.rango_clave
      LIMIT 1`,
    [versionId, versionActivaInicial],
  );
  assert.ok(comparacion[0], 'las filas base y del borrador deben coincidir');
  assert.equal(
    String(comparacion[0].precio_copia),
    String(comparacion[0].precio_base),
  );

  const [grupo] = await pool.query(
    `SELECT tipo_operacion, detalle FROM tarifario_versiones_eventos
      WHERE id = ?`,
    [Number(deshecho.evento.id)],
  );
  assert.equal(grupo[0].tipo_operacion, 'AUMENTO_MASIVO');
  assert.ok(String(grupo[0].detalle).startsWith('DESHACE:'));

  const [hijos] = await pool.query(
    `SELECT COUNT(*) AS cant FROM tarifario_versiones_eventos
      WHERE agrupador_id = ? AND tipo_operacion = 'PRECIO'`,
    [Number(deshecho.evento.id)],
  );
  assert.equal(Number(hijos[0].cant), totalFilas);

  const [hijo] = await pool.query(
    `SELECT tipo_evento, detalle FROM tarifario_versiones_eventos
      WHERE agrupador_id = ? AND tipo_operacion = 'PRECIO'
      LIMIT 1`,
    [Number(deshecho.evento.id)],
  );
  assert.equal(hijo[0].tipo_evento, 'MODIFICACION');
  assert.ok(String(hijo[0].detalle).startsWith('DESHACE:'));
});

test('deshacer: rechaza versiones cerradas y sin cambios pendientes', async (t) => {
  if (!enabled) {
    t.skip();
    return;
  }
  const versionId = await borradorDeLaCorrida();

  // Nada vigente que deshacer: ya se revirtio todo lo economico.
  await assert.rejects(
    deshacerUltimoCambioEconomico(
      pool,
      { id: String(versionId) },
      { revision: '4' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_ESTADO', status: 409 },
  );

  // Cerramos la version: LISTA_PARA_ACTIVAR ya no admite deshacer.
  await finalizarVersionTarifario(
    pool,
    { id: String(versionId) },
    { revision: '4' },
    { legajo: actorLegajo },
  );
  await assert.rejects(
    deshacerUltimoCambioEconomico(
      pool,
      { id: String(versionId) },
      { revision: '5' },
      { legajo: actorLegajo },
    ),
    { code: 'ADMIN_TRANSICION', status: 409 },
  );
});

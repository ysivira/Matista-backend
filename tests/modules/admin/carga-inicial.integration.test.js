/**
 * ============================================================
 * MATISTA | INTEGRACIÓN DE CARGA INICIAL
 * ============================================================
 *
 * Archivo: carga-inicial.integration.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Comprobar consistencia, idempotencia y rollback de la carga
 * en MySQL; la ejecución real requiere RUN_DB_TESTS.
 *
 * ============================================================
 */
import 'dotenv/config';

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createDatabasePool,
  verifyDatabaseConnection,
} from '../../../src/infrastructure/database/connection.js';
import {
  assertTestDatabase,
  loadDatabaseConfig,
} from '../../../src/infrastructure/database/config.js';
import { runMigrations } from '../../../src/infrastructure/database/migration-runner.js';
import {
  abrirConexionSigec,
  leerEstadoCatalogo,
} from '../../../src/modules/admin/carga-inicial.repository.js';
import {
  ejecutarCargaInicial,
} from '../../../src/modules/admin/carga-inicial.service.js';

// Pruebas de integracion de la carga inicial (E2) contra matista_test y
// sigec_db (solo lectura). El catalogo inicial es PERMANENTE en la base:
// estas pruebas no lo eliminan ni lo sobreescriben; verifican consistencia,
// idempotencia y rollback usando transacciones con rollback propio.
// Requieren RUN_DB_TESTS=1, las variables SIGEC_DB_* y la carga aplicada.
const enabled = process.env.RUN_DB_TESTS === '1';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');

let config;
let pool;
let sigecConnection;

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
    migrationsDirectory,
  });

  sigecConnection = await abrirConexionSigec();
});

after(async () => {
  if (sigecConnection) {
    await sigecConnection.end();
  }

  if (pool) {
    await pool.end();
  }
});

/** Ejecuta `callback` con una conexion propia en transaccion y siempre
 *  revertira el rollback: garantiza que ninguna prueba escriba sobre el
 *  catalogo permanente de matista_test.
 *
 *  - Parametros: `callback` recibe la conexion abierta y en transaccion.
 *  - Uso: cada prueba que simule escrituras se aisl aqui desde `pool`.
 */
async function conTransaccionAislada(callback) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await callback(connection);
  } finally {
    await connection.rollback();
    connection.release();
  }
}

test('el catalogo permanente esta consistente con la carga aprobada', {
  skip: !enabled,
}, async () => {
  const estado = await leerEstadoCatalogo(pool);

  assert.equal(estado.planes, 4);
  assert.equal(estado.aportesAbiertos, 12);
  assert.ok(estado.politicasAbiertas >= 1);
  assert.equal(estado.versionCargaInicialEstado, 'ACTIVA');
  assert.equal(estado.tarifasCargaInicial, 160);

  const connection = await pool.getConnection();

  try {
    // Version CARGA_INICIAL unica y actor NULL conforme al diseño.
    const [versiones] = await connection.query(
      `SELECT COUNT(*) AS cargaIniciales, SUM(actor_legajo IS NULL) AS sinActor
         FROM tarifario_versiones
        WHERE tipo = 'CARGA_INICIAL'`,
    );

    assert.equal(versiones[0].cargaIniciales, 1);
    assert.equal(Number(versiones[0].sinActor), 1);

    // Matriz 8 grupos de 20 claves canonicas unicas.
    const [grupos] = await connection.query(
      `SELECT plan_id, tipo_ingreso, COUNT(*) AS total,
              COUNT(DISTINCT rango_clave) AS clavesUnicas
         FROM tarifas
        WHERE version_id = ?
        GROUP BY plan_id, tipo_ingreso`,
      [estado.versionCargaInicialId],
    );

    assert.equal(grupos.length, 8);
    assert.ok(grupos.every(
      (grupo) => grupo.total === 20 && grupo.clavesUnicas === 20,
    ));

    // Registros 164/165 presentes con sus precios originales.
    const [completadores] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM tarifas
        WHERE version_id = ?
          AND (
            (plan_id = 4 AND rango_etario = '0-25' AND precio = 404808.93)
            OR
            (plan_id = 1 AND rango_etario = '26-35' AND precio = 172025.75)
          )`,
      [estado.versionCargaInicialId],
    );

    assert.equal(completadores[0].total, 2);

    // Normalizaciones canonicas aplicadas en la matriz vigente: 8 claves
    // '66+' (una por grupo) y 8 'HIJO 0-1' con anotacion preservada.
    const [canonicas] = await connection.query(
      `SELECT
         COUNT(CASE WHEN rango_clave = '66+' THEN 1 END) AS total66,
         SUM(CASE WHEN rango_clave = 'HIJO 0-1' AND rango_nota = '(*)'
                  THEN 1 ELSE 0 END) AS hijosPunteros
       FROM tarifas
      WHERE version_id = ?`,
      [estado.versionCargaInicialId],
    );

    assert.equal(Number(canonicas[0].total66), 8);
    assert.equal(Number(canonicas[0].hijosPunteros), 8);

    // Politica comercial: una fila abierta con valores aprobados.
    const [politica] = await connection.query(
      `SELECT porcentaje_aporte_reconocido AS aporteReconocido,
              tope_sueldo_bruto AS topeSueldoBruto,
              joven_porcentaje AS jovenPorcentaje,
              comercial_fijo_max_pct AS fijoMax,
              comercial_fijo_meses_max AS fijoMeses,
              comercial_escalonado_max_pct AS escalonadoMax,
              comercial_escalonado_tramos_max AS escalonadoTramos,
              comercial_escalonado_total_meses_max AS escalonadoMeses,
              primer_tramo_50_meses_max AS primerTramo,
              tdc_pct AS tdcPct,
              tdc_habilitado AS tdcHabilitado,
              tope_comercial_tdc_pct AS topeComercialTdc,
              afinidad_pct AS afinidad
         FROM politica_comercial
        WHERE vigente_hasta IS NULL`,
    );

    assert.equal(politica.length, 1);
    const valores = politica[0];

    assert.equal(String(valores.aporteReconocido), '7.00');
    assert.equal(String(valores.topeSueldoBruto), '4800000.00');
    assert.equal(String(valores.jovenPorcentaje), '26.00');
    assert.equal(String(valores.fijoMax), '40.00');
    assert.equal(valores.fijoMeses, 12);
    assert.equal(String(valores.escalonadoMax), '50.00');
    assert.equal(valores.escalonadoTramos, 4);
    assert.equal(valores.escalonadoMeses, 12);
    assert.equal(valores.primerTramo, 3);
    assert.equal(String(valores.tdcPct), '5.00');
    assert.equal(valores.tdcHabilitado, 1);
    assert.equal(String(valores.topeComercialTdc), '55.00');
    assert.equal(valores.afinidad, null);

    // Correspondencia de precios de origen y destino (muestra canonica).
    const [integrales] = await connection.query(
      `SELECT t.plan_id, t.tipo_ingreso, t.rango_clave, t.rango_etario,
              t.precio
         FROM tarifas AS t
        WHERE t.version_id = ?
          AND t.rango_clave IN ('66+', 'HIJO 0-1')
        ORDER BY t.id`,
      [estado.versionCargaInicialId],
    );

    for (const fila of integrales) {
      const [origen] = await sigecConnection.query(
        `SELECT COUNT(*) AS coincidentes
           FROM listas_de_precios AS lp
           JOIN planes AS p ON p.id = lp.plan_id
          WHERE p.activo = 1
            AND lp.activo = 1
            AND lp.plan_id = ?
            AND lp.tipo_ingreso = ?
            AND lp.rango_etario = ?
            AND lp.precio = ?`,
        [fila.plan_id, fila.tipo_ingreso, fila.rango_etario, fila.precio],
      );

      assert.ok(
        origen[0].coincidentes >= 1,
        `No hay coincidencia en origen para ${fila.plan_id} `
        + `${fila.tipo_ingreso} ${fila.rango_clave}`,
      );
    }
  } finally {
    connection.release();
  }
});

test('la re-ejecucion de la carga es idempotente sobre el catalogo permanente', {
  skip: !enabled,
}, async () => {
  // Necesita un legajo ADMIN activo existente (fixture permanente de la base).
  const connection = await pool.getConnection();
  const [admins] = await connection.query(
    `SELECT legajo
       FROM empleados
      WHERE rol = 'ADMIN' AND estado = 'ACTIVO'
      LIMIT 1`,
  );

  connection.release();

  assert.ok(
    admins.length === 1,
    'matista_test requiere un legajo ADMIN activo para ejecutar la carga '
    + '(fixture permanente).',
  );

  const estadoAntes = await leerEstadoCatalogo(pool);
  const resumen = await ejecutarCargaInicial({
    matistaPool: pool,
    sigecConnection,
    actorLegajo: String(admins[0].legajo),
  });
  const estadoDespues = await leerEstadoCatalogo(pool);

  assert.equal(resumen.aplicada, false);
  assert.deepEqual(estadoDespues, estadoAntes);
});

test('los guardas de DB impiden una segunda carga dentro de una transaccion', {
  skip: !enabled,
}, async () => {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [carga] = await connection.query(
      `SELECT id, fecha_activacion
         FROM tarifario_versiones
        WHERE tipo = 'CARGA_INICIAL'
        LIMIT 1`,
    );
    const versionOriginal = carga[0];

    // (a) fecha_activacion es unica: INSERT ... SELECT conservando la fecha
    // exacta (microsegundos) garantiza el rechazo determinista.
    await assert.rejects(
      connection.query(
        `INSERT INTO tarifario_versiones
           (tipo, fecha_activacion, estado, observacion)
         SELECT tipo, fecha_activacion, 'ACTIVA', 'intento duplicado de carga'
           FROM tarifario_versiones
          WHERE id = ?`,
        [versionOriginal.id],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );

    // (b) la misma clave canonica no puede repetirse dentro de la version
    // inicial: el snapshot es completo y unico por version.
    await assert.rejects(
      connection.query(
        `INSERT INTO tarifas
           (version_id, plan_id, tipo_ingreso, rango_etario, rango_clave, precio)
         VALUES (?, 1, 'Obligatorio', '66-00', '66+', 111.11)`,
        [versionOriginal.id],
      ),
      (error) => error.code === 'ER_DUP_ENTRY',
    );
  } finally {
    await connection.rollback();
    connection.release();
  }

  // El catalogo permanente permanece intacto tras el rollback.
  const estado = await leerEstadoCatalogo(pool);
  assert.equal(estado.planes, 4);
  assert.equal(estado.aportesAbiertos, 12);
});

test('una falla simulada dentro de transaccion no altera el catalogo permanente', {
  skip: !enabled,
}, async () => {
  await conTransaccionAislada(async (connection) => {
    // Dentro de la transaccion del test se retira por orden de dependencia
    // el catalogo (solo en la vista transaccional) para poder ejecutar la
    // ruta completa de la carga desde catalogo vacio; el rollback del test
    // devuelve TODO el catalogo permanente sin perdidas.
    await connection.query('DELETE FROM politica_comercial');
    await connection.query('DELETE FROM monotributo_aportes');
    await connection.query('DELETE FROM tarifas');
    await connection.query('DELETE FROM tarifario_versiones');
    await connection.query('DELETE FROM planes');

    const [admin] = await connection.query(
      `SELECT legajo FROM empleados
        WHERE rol = 'ADMIN' AND estado = 'ACTIVO' LIMIT 1`,
    );
    const actorLegajo = String(admin[0].legajo);

    // La ruta completa escribe planes/version/tarifas y falla en el punto
    // inyectado: el servicio no hace commit (conexion externa) y el
    // rollback del test restaura el catalogo permanente original.
    await assert.rejects(
      ejecutarCargaInicial({
        matistaConnection: connection,
        sigecConnection,
        actorLegajo,
        fallarTrasTarifas: true,
      }),
      /rollback de la carga/,
    );
  });

  const estado = await leerEstadoCatalogo(pool);

  assert.equal(estado.planes, 4);
  assert.equal(estado.aportesAbiertos, 12);
  assert.equal(estado.politicasAbiertas, 1);
  assert.equal(estado.tarifasCargaInicial, 160);
});

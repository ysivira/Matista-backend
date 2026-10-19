import 'dotenv/config';

import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
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

// Pruebas de integracion de la carga inicial (E2): reales contra
// matista_test y sigec_db (solo lectura). Requieren RUN_DB_TESTS=1 mas
// las variables SIGEC_DB_* y ran ejecutar tras las migraciones.
const enabled = process.env.RUN_DB_TESTS === '1';
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');

let config;
let pool;
let sigecConnection;
let actorLegajo;

// Vacia las tablas ADMIN para dejar la base reproducible entre pruebas.
// DELETE en cascada logica por orden de dependencia: politica/aportes/
// cancelaciones/tarifas primero; versiones requiere retirar la self-FK
// momentaneamente y reponerla tal como la creo la migracion 007.
async function vaciarCatalogoAdmin() {
  const connection = await pool.getConnection();

  try {
    await connection.query('DELETE FROM politica_comercial');
    await connection.query('DELETE FROM monotributo_aportes');
    await connection.query('DELETE FROM tarifario_cancelaciones');
    await connection.query('DELETE FROM tarifas');
    await connection.query(
      'ALTER TABLE tarifario_versiones '
      + 'DROP FOREIGN KEY fk_tarifario_versiones_base',
    );
    await connection.query('DELETE FROM tarifario_versiones');
    await connection.query(
      'ALTER TABLE tarifario_versiones '
      + 'ADD CONSTRAINT fk_tarifario_versiones_base '
      + 'FOREIGN KEY (version_base_id) REFERENCES tarifario_versiones (id)',
    );
    await connection.query('DELETE FROM planes');
  } finally {
    connection.release();
  }
}

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

  // Legajo temporal responsable de la carga: se conserva durante la
  // misma suite y se elimina al final (los inserts lo referencian).
  actorLegajo = String(randomInt(10_000_000, 99_999_999));
  const connection = await pool.getConnection();

  try {
    await connection.query(
      `INSERT INTO empleados (
         legajo, nombre, apellido, password_hash
       ) VALUES (?, 'Carga', 'E2', 'hash-no-real')`,
      [actorLegajo],
    );
  } finally {
    connection.release();
  }
});

after(async () => {
  if (pool && enabled) {
    await vaciarCatalogoAdmin();

    const connection = await pool.getConnection();

    try {
      await connection.query(
        'DELETE FROM empleados WHERE legajo = ?',
        [actorLegajo],
      );
    } finally {
      connection.release();
    }
  }

  if (sigecConnection) {
    await sigecConnection.end();
  }

  if (pool) {
    await pool.end();
  }
});

test('la carga inicial completa la matriz aprobada exacta', {
  skip: !enabled,
}, async () => {
  const resumen = await ejecutarCargaInicial({
    matistaPool: pool,
    sigecConnection,
    actorLegajo,
  });

  assert.equal(resumen.aplicada, true);
  assert.equal(resumen.planes, 4);
  assert.equal(resumen.tarifas, 160);
  assert.equal(resumen.aportesMonotributo, 12);
  assert.equal(resumen.politicaComercial, 1);

  const excluidosPorId = new Map(
    resumen.excluidos.map((fila) => [fila.id, fila.motivo]),
  );

  assert.equal(resumen.excluidos.length, 10);
  for (const id of [4, 5, 163, 166, 167, 168]) {
    assert.equal(excluidosPorId.get(id), 'Referencia inactiva');
  }
  for (const id of [161, 162]) {
    assert.match(excluidosPorId.get(id), /monotributo/);
  }
  for (const id of [169, 170]) {
    assert.match(excluidosPorId.get(id), /plan inactivo/);
  }

  const connection = await pool.getConnection();

  try {
    // Cronicidad real en DB: version unica ACTIVA con actor NULL.
    const [versiones] = await connection.query(
      `SELECT id, tipo, estado, actor_legajo
         FROM tarifario_versiones`,
    );

    assert.equal(versiones.length, 1);
    assert.equal(versiones[0].tipo, 'CARGA_INICIAL');
    assert.equal(versiones[0].estado, 'ACTIVA');
    assert.equal(versiones[0].actor_legajo, null);

    const versionId = versiones[0].id;

    // Matriz exacta en destino: 8 grupos plan/modalidad con 20 claves.
    const [grupos] = await connection.query(
      `SELECT plan_id, tipo_ingreso, COUNT(*) AS total,
              COUNT(DISTINCT rango_clave) AS clavesUnicas
         FROM tarifas
        WHERE version_id = ?
        GROUP BY plan_id, tipo_ingreso`,
      [versionId],
    );

    assert.equal(grupos.length, 8);
    assert.ok(grupos.every(
      (grupo) => grupo.total === 20 && grupo.clavesUnicas === 20,
    ));

    // Correspondencia de precios y normalizaciones contra SIGEC.
    const [integrales] = await connection.query(
      `SELECT t.plan_id, t.tipo_ingreso, t.rango_clave, t.rango_etario,
              t.rango_nota, t.precio
         FROM tarifas AS t
        WHERE t.version_id = ?
          AND t.rango_clave IN ('66+', 'HIJO 0-1')
        ORDER BY t.id`,
      [versionId],
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
        [
          fila.plan_id,
          fila.tipo_ingreso,
          fila.rango_etario,
          fila.precio,
        ],
      );

      assert.ok(
        origen[0].coincidentes >= 1,
        `No hay coincidencia en origen para ${fila.plan_id} `
        + `${fila.tipo_ingreso} ${fila.rango_clave}`,
      );

      // Normalizacion: 66-00 => 66+ sin anotacion; HIJO 0-1(*) keeping nota.
      if (fila.rango_etario === '66-00') {
        assert.equal(fila.rango_clave, '66+');
        assert.equal(fila.rango_nota, null);
      } else {
        assert.equal(fila.rango_etario, 'HIJO 0-1(*)');
        assert.equal(fila.rango_clave, 'HIJO 0-1');
        assert.equal(fila.rango_nota, '(*)');
      }
    }

    const [registrosIncluidos] = await connection.query(
      `SELECT COUNT(*) AS total
         FROM tarifas
        WHERE version_id = ?
          AND (
            (plan_id = 4 AND rango_etario = '0-25' AND precio = 404808.93)
            OR
            (plan_id = 1 AND rango_etario = '26-35'
              AND precio = 172025.75)
          )`,
      [versionId],
    );

    assert.equal(registrosIncluidos[0].total, 2);

    // Monotributo: 12 filas abiertas con actor registrado.
    const [aportes] = await connection.query(
      `SELECT categoria, aporte, vigente_hasta, actor_legajo
         FROM monotributo_aportes
        WHERE vigente_hasta IS NULL
        ORDER BY categoria`,
    );

    assert.equal(aportes.length, 12);
    assert.ok(
      aportes.every((fila) => String(fila.actor_legajo) === actorLegajo),
    );

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
  } finally {
    connection.release();
  }
});

test('la segunda ejecucion es idempotente sin duplicar registros', {
  skip: !enabled,
}, async () => {
  const estadoAntes = await leerEstadoCatalogo(pool);
  const resumen = await ejecutarCargaInicial({
    matistaPool: pool,
    sigecConnection,
    actorLegajo,
  });
  const estadoDespues = await leerEstadoCatalogo(pool);

  assert.equal(resumen.aplicada, false);
  assert.deepEqual(estadoDespues, estadoAntes);
});

test('una falla simulada deja todas las tablas ADMIN como estaban', {
  skip: !enabled,
}, async () => {
  await vaciarCatalogoAdmin();

  await assert.rejects(
    ejecutarCargaInicial({
      matistaPool: pool,
      sigecConnection,
      actorLegajo,
      fallarTrasTarifas: true,
    }),
    /rollback de la carga/,
  );

  const estado = await leerEstadoCatalogo(pool);

  assert.equal(estado.planes, 0);
  assert.equal(estado.versiones, 0);
  assert.equal(estado.tarifas, 0);
  assert.equal(estado.aportesAbiertos, 0);
  assert.equal(estado.politicasAbiertas, 0);
});

test('la carga es reproducible tras el rollback (tercera ejecucion)', {
  skip: !enabled,
}, async () => {
  const resumen = await ejecutarCargaInicial({
    matistaPool: pool,
    sigecConnection,
    actorLegajo,
  });

  assert.equal(resumen.aplicada, true);
  assert.equal(resumen.tarifas, 160);
  assert.equal(resumen.aportesMonotributo, 12);
});

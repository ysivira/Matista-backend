import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadMigrations,
} from '../../../src/infrastructure/database/migration-runner.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.resolve(currentDirectory, '../../../migrations');
const bootstrapFile = path.resolve(
  currentDirectory,
  '../../../database/bootstrap/000_create_local_databases.sql',
);

test('el bootstrap solo declara matista_dev y matista_test', async () => {
  const bootstrap = await readFile(bootstrapFile, 'utf8');

  assert.match(bootstrap, /CREATE DATABASE IF NOT EXISTS matista_dev/);
  assert.match(bootstrap, /CREATE DATABASE IF NOT EXISTS matista_test/);
  assert.doesNotMatch(bootstrap, /matista_db/);
  assert.doesNotMatch(bootstrap, /sigec_db|sigec_test/);
});

test('las cinco migraciones AUTH son validas, ordenadas y no destructivas', async () => {
  const migrations = await loadMigrations(migrationsDirectory);

  assert.deepEqual(
    migrations.slice(0, 5).map((migration) => migration.targetTable),
    [
      'empleados',
      'empleados_correos',
      'auth_tokens',
      'auth_sesiones',
      'empleados_auditoria',
    ],
  );
});

test('las migraciones ADMIN declaran el orden FK aprobado sin tablas extra', async () => {
  const migrations = await loadMigrations(migrationsDirectory);

  assert.deepEqual(
    migrations.slice(5).map((migration) => [
      migration.version,
      migration.targetTable,
      migration.kind,
    ]),
    [
      ['006_create_planes', 'planes', 'create'],
      ['007_create_tarifario_versiones', 'tarifario_versiones', 'create'],
      ['008_create_tarifario_cancelaciones', 'tarifario_cancelaciones', 'create'],
      ['009_create_tarifas', 'tarifas', 'create'],
      ['010_create_politica_comercial', 'politica_comercial', 'create'],
      ['011_create_monotributo_aportes', 'monotributo_aportes', 'create'],
      ['012_alter_empleados_auditoria_eventos', 'empleados_auditoria', 'alter'],
      ['013_ciclo_vida_versiones', 'tarifario_versiones', 'alter'],
      ['014_auditoria_eventos_versiones', 'tarifario_versiones_eventos', 'create'],
      ['015_garantias_exclusividad_versiones', 'tarifario_versiones', 'alter'],
      ['016_reanudacion_evento', 'tarifario_versiones_eventos', 'alter'],
      ['017_descarte_versiones', 'tarifario_versiones_eventos', 'alter'],
    ],
  );
});

test('el ciclo de vida nuevo declara estados, borrador y garantias unicas', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const ciclo = migrations.find((m) => m.version === '013_ciclo_vida_versiones');
  const auditoria = migrations.find((m) => m.version === '014_auditoria_eventos_versiones');
  const garantias = migrations.find(
    (m) => m.version === '015_garantias_exclusividad_versiones',
  );

  // 013: modelo "copia completa" sin cancelaciones productoras de flujo.
  assert.match(ciclo.sql, /estado IN \('PREPARACION', 'LISTA_PARA_ACTIVAR', 'ACTIVA', 'HISTORICA', 'CANCELADA'\)/);
  assert.match(ciclo.sql, /tipo IN \('CARGA_INICIAL', 'EDICION_LISTA'\)/);
  assert.match(ciclo.sql, /fecha_activacion DATETIME\(6\) NULL/);
  assert.match(ciclo.sql, /revision INT UNSIGNED NOT NULL DEFAULT 0/);

  // 014: auditoria con snapshot de identidad y agrupador de masivo.
  assert.match(auditoria.sql, /actor_nombre VARCHAR\(100\) NOT NULL/);
  assert.match(auditoria.sql, /REFERENCES empleados \(legajo\)/);
  assert.match(auditoria.sql, /chk_eventos_agrupador_fila/);
  assert.match(auditoria.sql, /chk_eventos_valores/);

  // 015: exclusividad a nivel de persistencia (concurrencia sin banderas).
  assert.match(garantias.sql, /guard_activa INT\s+GENERATED ALWAYS AS \(IF\(estado = 'ACTIVA', 1, NULL\)\) STORED/);
  assert.match(garantias.sql, /uq_guard_activa_version/);
  assert.match(garantias.sql, /uq_guard_borrador_version/);
});

test('el tarifario aprobado declara snapshot, baja logica y vigencia lazy', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const tarifas = migrations.find(
    (migration) => migration.targetTable === 'tarifas',
  );
  const versiones = migrations.find(
    (migration) => migration.targetTable === 'tarifario_versiones',
  );

  // Columna activa requisito RF-D09: baja lógica sin destruir historial.
  assert.match(tarifas.sql, /activa TINYINT NOT NULL DEFAULT 1/);
  assert.match(tarifas.sql, /uq_tarifas_version_clave/);
  assert.match(tarifas.sql, /tipo_ingreso IN \('Obligatorio', 'Voluntario'\)/);
  assert.match(tarifas.sql, /rango_nota VARCHAR\(20\) NULL/);
  // Vigencia lazy: orden por fecha, nunca por id.
  assert.match(versiones.sql, /uq_tarifario_versiones_fecha \(fecha_activacion\)/);
  assert.match(
    versiones.sql,
    /tipo IN \('CARGA_INICIAL', 'AUMENTO_MASIVO', 'EDICION_PLAN', 'REVERSION'\)/,
  );
  assert.match(versiones.sql, /fk_tarifario_versiones_base/);
  assert.match(versiones.sql, /version_revertida_id IS NOT NULL/);
});

test('la fila abierta viva en politica_comercial y monotributo_aportes', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const politica = migrations.find(
    (migration) => migration.targetTable === 'politica_comercial',
  );
  const aportes = migrations.find(
    (migration) => migration.targetTable === 'monotributo_aportes',
  );

  // Valores iniciales aprobados: llevan resolución en E2 (carga), la estructura solo los permite.
  assert.match(politica.sql, /uq_politica_comercial_abierta/);
  assert.match(politica.sql, /afinidad_pct DECIMAL\(5,2\) NULL/);
  assert.match(politica.sql, /tope_comercial_tdc_pct/);
  assert.match(aportes.sql, /categoria_abierta/);
  assert.match(aportes.sql, /uq_monotributo_abierta/);
});

test('la alter extension del CHECK de auditoria mantiene los eventos AUTH', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const alter = migrations.find((migration) => migration.kind === 'alter');

  assert.match(alter.sql, /DROP CHECK chk_empleados_auditoria_evento_campo/);
  assert.match(alter.sql, /'ESTADO_CAMBIADO' AND campo = 'ESTADO'/);
  assert.match(alter.sql, /'ROL_CAMBIADO' AND campo = 'ROL'/);
  assert.match(
    alter.sql,
    /'VERSION_REVERTIDA'\s*\)\s*AND campo = 'TARIFARIO'/,
  );
});

test('la auditoria declara campo y prohibe valores para password', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const auditMigration = migrations.find(
    (migration) => migration.targetTable === 'empleados_auditoria',
  );

  assert.match(auditMigration.sql, /campo VARCHAR\(16\)/);
  assert.match(auditMigration.sql, /campo = 'PASSWORD'/);
  assert.match(
    auditMigration.sql,
    /valor_anterior IS NULL AND valor_nuevo IS NULL/,
  );
});

test('tokens y correos contienen las claves generadas aprobadas', async () => {
  const migrations = await loadMigrations(migrationsDirectory);
  const tokens = migrations.find(
    (migration) => migration.targetTable === 'auth_tokens',
  );
  const emails = migrations.find(
    (migration) => migration.targetTable === 'empleados_correos',
  );

  assert.match(tokens.sql, /token_abierto_clave/);
  assert.match(tokens.sql, /uq_auth_tokens_abierto/);
  assert.match(emails.sql, /uq_empleados_correos_actual/);
  assert.match(emails.sql, /uq_empleados_correos_pendiente/);
  assert.match(emails.sql, /uq_empleados_correos_reservado/);
  assert.match(emails.sql, /idx_empleados_correos_login/);
});

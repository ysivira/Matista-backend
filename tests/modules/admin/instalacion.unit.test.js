import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { leerFuenteVersionada } from '../../../src/modules/admin/instalacion.repository.js';
import {
  ejecutarCargaAutonoma, validarCatalogoVersionado
} from '../../../src/modules/admin/instalacion.service.js';
import {
  assertLocalInstallationTarget, withLocalInstallation
} from '../../../src/infrastructure/database/local-installation.js';

const archivo = fileURLToPath(new URL('../../../database/seed/carga_inicial_autonoma.json', import.meta.url));
const fuente = await leerFuenteVersionada(archivo);
const config = { nodeEnv: 'development', database: 'matista_local', host: '127.0.0.1' };

test('fuente E2 verificada: integridad, matriz 4/160/12 y normalización reversible', async () => {
  assert.equal(createHash('sha256').update(await readFile(archivo)).digest('hex'),
    'c4091816077059241b7f735aa066b2d1c649735ccdf785ebc4f66aab0653c1cd');
  const { planes, tarifas, aportes } = validarCatalogoVersionado(fuente);
  assert.equal(planes.length, 4);
  assert.equal(tarifas.length, 160);
  assert.equal(aportes.length, 12);
  assert.deepEqual(planes.map(p => p.nombre), ['RUBÍ', 'ESMERALDA', 'ZAFIRO', 'DIAMANTE']);
  assert.ok(tarifas.every(t => typeof t.rango_etario === 'string'));
  assert.ok(tarifas.some(t => t.rango_etario === '66-00' && t.rango_clave === '66+'));
  assert.ok(tarifas.some(t => t.rango_etario === 'HIJO 0-1(*)' && t.rango_nota === '(*)'));
});

test('fuente incompleta, duplicada o con importes/rangos inválidos aborta', () => {
  assert.throws(() => validarCatalogoVersionado({ ...fuente, tarifas: fuente.tarifas.slice(1) }), /160 tarifas/);
  const copy = () => structuredClone(fuente);
  const inactiva = copy(); inactiva.planes[0].activa = 0;
  assert.throws(() => validarCatalogoVersionado(inactiva), /no activos/);
  const duplicada = copy(); duplicada.tarifas[1] = duplicada.tarifas[0];
  assert.throws(() => validarCatalogoVersionado(duplicada), /duplicada/);
  for (const precio of ['-1.00', 'Infinity', 'NaN', '0.00']) {
    const invalida = copy(); invalida.tarifas[0].precio = precio;
    assert.throws(() => validarCatalogoVersionado(invalida), /precio/);
  }
  const nota = copy(); nota.tarifas[0].rango_nota = '(?)';
  assert.throws(() => validarCatalogoVersionado(nota), /rango_nota/);
  assert.throws(() => validarCatalogoVersionado({ ...fuente, aportes_monotributo: [] }), /12 aportes/);
});

test('lectura falla explícitamente ante fuente ausente', async () => {
  await assert.rejects(() => leerFuenteVersionada(`${archivo}.inexistente`), /No se puede leer/);
});

test('lector rechaza contenido alterado aunque respete la matriz', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'matista-seed-'));
  const file = `${directory}/alterado.json`;
  t.after(async () => { await unlink(file); await rmdir(directory); });
  const altered = structuredClone(fuente);
  altered.tarifas[0].precio = '1.00';
  await writeFile(file, JSON.stringify(altered));
  await assert.rejects(() => leerFuenteVersionada(file), /no coincide con el catálogo verificado/);
});

test('guardas locales rechazan producción, bases existentes y hosts remotos antes de conectar', async () => {
  for (const override of [
    { nodeEnv: 'production' }, { nodeEnv: 'test' }, { database: 'matista_dev' },
    { database: 'matista_test' }, { database: 'matista_db' }, { host: 'remoto.invalid' }
  ]) {
    const destino = { ...config, ...override };
    const pool = { getConnection() { assert.fail('No debe conectar'); } };
    assert.throws(() => assertLocalInstallationTarget(destino), /solo development/);
    await assert.rejects(() => ejecutarCargaAutonoma({
      matistaPool: pool, config: destino, archivo, actorLegajo: '900000001'
    }), /solo development/);
  }
});

test('transacción compartida hace rollback y libera lock/conexión ante un error', async () => {
  const eventos = [];
  const connection = {
    async query(sql) {
      if (sql.includes('DATABASE()')) return [[{ databaseName: 'matista_local' }]];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) { eventos.push('unlock'); return [[]]; }
      assert.fail(sql);
    },
    async beginTransaction() { eventos.push('begin'); },
    async commit() { eventos.push('commit'); },
    async rollback() { eventos.push('rollback'); },
    release() { eventos.push('release'); }
  };
  await assert.rejects(() => withLocalInstallation(
    { getConnection: async () => connection }, config,
    async () => { throw new Error('falla simulada'); }
  ), /falla simulada/);
  assert.deepEqual(eventos, ['begin', 'rollback', 'unlock', 'release']);
});

test('rechaza base efectiva distinta y lock ocupado sin ejecutar la operación', async () => {
  for (const caso of ['database', 'lock']) {
    let released = false;
    const connection = {
      async query(sql) {
        if (sql.includes('DATABASE()')) return [[{ databaseName: caso === 'database' ? 'otra' : 'matista_local' }]];
        if (sql.includes('GET_LOCK')) return [[{ acquired: 0 }]];
        assert.fail(sql);
      },
      release() { released = true; }
    };
    await assert.rejects(() => withLocalInstallation(
      { getConnection: async () => connection }, config, () => assert.fail('No operar')
    ), caso === 'database' ? /no seleccionó/ : /otra instalación/);
    assert.ok(released);
  }
});

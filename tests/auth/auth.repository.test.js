import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as repository from '../../src/modules/auth/auth.repository.js';

/** Verifica conexión UTC única, orden transaccional y liberación sin acceder a MySQL. */
test('unidad de trabajo usa UTC, commit y release sobre la misma conexión', async () => {
  const calls = [];
  const connection = {
    /** Captura la configuración de sesión solicitada al checkout. */
    async query(sql) { calls.push(sql); },
    /** Captura inicio transaccional. */
    async beginTransaction() { calls.push('begin'); },
    /** Captura confirmación. */
    async commit() { calls.push('commit'); },
    /** Captura reversión inesperada en el caso exitoso. */
    async rollback() { calls.push('rollback'); },
    /** Captura liberación. */
    release() { calls.push('release'); },
  };
  const pool = { /** Proporciona únicamente la conexión doble. */ async getConnection() { return connection; } };
  const result = await repository.withConnection(pool, async (received) => {
    assert.equal(received, connection); calls.push('operation'); return 'ok';
  }, { transaction: true });
  assert.equal(result, 'ok');
  assert.deepEqual(calls, ["SET time_zone = '+00:00'", 'begin', 'operation', 'commit', 'release']);
});

/** Comprueba rollback, traducción de duplicidad y release también si falla la configuración UTC. */
test('revierte errores transaccionales y no oculta fallos de infraestructura', async () => {
  const calls = [];
  const connection = {
    /** Permite la configuración de sesión del caso transaccional. */ async query() {},
    /** Registra inicio. */ async beginTransaction() { calls.push('begin'); },
    /** No debe alcanzarse ante fallo de la operación. */ async commit() { calls.push('commit'); },
    /** Registra reversión. */ async rollback() { calls.push('rollback'); },
    /** Registra devolución al pool. */ release() { calls.push('release'); },
  };
  const pool = { /** Devuelve conexión simulada. */ async getConnection() { return connection; } };
  await assert.rejects(repository.withConnection(pool, async () => {
    throw Object.assign(new Error('SQL no publicable.'), { code: 'ER_DUP_ENTRY' });
  }, { transaction: true }), { code: 'IDENTITY_CONFLICT', status: 409 });
  assert.deepEqual(calls, ['begin', 'rollback', 'release']);
  connection.query = async () => { throw new Error('UTC fixture failure'); };
  calls.length = 0;
  await assert.rejects(repository.withConnection(pool, async () => {}, { transaction: true }), /UTC fixture/);
  assert.deepEqual(calls, ['release']);
});

/** Verifica parámetros separados del SQL, bloqueos y lista de columnas cerrada en actualización de perfil. */
test('consultas parametrizadas no permiten columnas ni propietarios controlados por entrada', async () => {
  const calls = [];
  const connection = {
    /** Captura SQL y parámetros sin ejecutar ninguna consulta. */
    async execute(sql, params) { calls.push({ sql, params }); return [[]]; },
  };
  const hostile = "' OR 1=1 --";
  await repository.findEmployee(connection, hostile, true);
  assert.match(calls[0].sql, /WHERE legajo = \? FOR UPDATE$/);
  assert.deepEqual(calls[0].params, [hostile]);
  assert.equal(calls[0].sql.includes(hostile), false);
  await repository.updateProfile(connection, '12345678', { telefono: hostile, rol: 'ADMIN', password_hash: 'no' });
  assert.match(calls[1].sql, /SET telefono = \? WHERE legajo = \?/);
  assert.equal(calls[1].sql.includes('rol'), false);
  assert.deepEqual(calls[1].params, [hostile, '12345678']);
  await repository.revokeTokens(connection, '12345678', 'VERIFICAR_EMAIL', new Date());
  assert.match(calls[2].sql, /consumed_at IS NULL AND revoked_at IS NULL/);
  assert.equal(calls[2].sql.includes('expires_at >'), false);
});

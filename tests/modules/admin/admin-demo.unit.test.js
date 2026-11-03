import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADMIN_DEMO, crearAdminDemo, exigirEntornoNoProduccion
} from '../../../src/modules/admin/admin-demo.service.js';
import { loadSecurityConfig } from '../../../src/infrastructure/security/config.js';

const config = { nodeEnv: 'development', database: 'matista_local', host: '127.0.0.1' };
const security = loadSecurityConfig({ NODE_ENV: 'development', JWT_SECRET: 'A'.repeat(43) });

test('cuenta demo: guardas antes de conexión, inclusive desde el servicio', async () => {
  const env = { NODE_ENV: 'development', DB_NAME: 'matista_local', DB_HOST: '127.0.0.1', DB_USER: 'test', DB_PASSWORD: '' };
  assert.doesNotThrow(() => exigirEntornoNoProduccion(env));
  for (const override of [
    { NODE_ENV: 'production' }, { DB_NAME: 'matista_dev' }, { DB_NAME: 'matista_test' },
    { DB_NAME: 'matista_db' }, { DB_HOST: 'remote.invalid' }
  ]) assert.throws(() => exigirEntornoNoProduccion({ ...env, ...override }));
  for (const override of [{ nodeEnv: 'production' }, { database: 'matista_test' }, { host: 'remote.invalid' }]) {
    await assert.rejects(() => crearAdminDemo({
      config: { ...config, ...override }, security,
      matistaPool: { getConnection() { assert.fail('No conectar'); } }
    }), /solo development/);
  }
});

function destino({ cuenta, correos = [], reservado } = {}) {
  const writes = [];
  const connection = {
    async query(sql) {
      if (sql.includes('DATABASE()')) return [[{ databaseName: config.database }]];
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[]];
      assert.fail(sql);
    },
    async execute(sql, values) {
      if (/FROM empleados WHERE/.test(sql)) return [cuenta ? [cuenta] : []];
      if (/WHERE email_reservado/.test(sql)) return [reservado ? [reservado] : []];
      if (/FROM empleados_correos/.test(sql)) return [correos];
      if (/INSERT/.test(sql)) { writes.push({ sql, values }); return [{}]; }
      assert.fail(sql);
    },
    async beginTransaction() {}, async commit() {}, async rollback() {}, release() {}
  };
  return { matistaPool: { getConnection: async () => connection }, writes };
}

test('crea ADMIN/ACTIVO verificado con bcrypt real y registro auditado', async () => {
  const { matistaPool, writes } = destino();
  const result = await crearAdminDemo({ matistaPool, config, security });
  assert.equal(result.creado, true);
  assert.equal(writes.length, 3);
  const empleado = writes[0];
  assert.match(empleado.sql, /'ADMIN', 'ACTIVO'/);
  assert.match(empleado.values[3], /^\$2[aby]\$12\$/);
  const { verifyPassword } = await import('../../../src/infrastructure/security/password.js');
  assert.equal(await verifyPassword(ADMIN_DEMO.password, empleado.values[3]), true);
  assert.match(writes[1].sql, /'ACTUAL'/);
  assert.ok(writes[1].values[2] instanceof Date);
  assert.match(writes[2].sql, /empleados_auditoria/);
});

test('repetir no escribe ni restablece una contraseña cambiada', async () => {
  const { matistaPool, writes } = destino({
    cuenta: { rol: 'ADMIN', estado: 'ACTIVO', password_hash: 'hash ya cambiado' },
    correos: [{ email: ADMIN_DEMO.email, estado: 'ACTUAL', verificado_at: new Date() }]
  });
  const result = await crearAdminDemo({ matistaPool, config, security });
  assert.equal(result.creado, false);
  assert.equal(writes.length, 0);
});

test('conflictos de legajo/correo abortan sin reparación ni inserciones', async () => {
  for (const datos of [
    { cuenta: { rol: 'ASESOR', estado: 'PENDIENTE' } },
    { reservado: { legajo: '12345678' } }
  ]) {
    const { matistaPool, writes } = destino(datos);
    await assert.rejects(() => crearAdminDemo({ matistaPool, config, security }), /inconsistente|reservado/);
    assert.equal(writes.length, 0);
  }
});

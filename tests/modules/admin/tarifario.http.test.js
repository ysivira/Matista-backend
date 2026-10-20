import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../../../src/app.js';
import { fixtureSession, localEnv, memoryContext } from '../../auth/fixtures.js';
import { startTestServer } from '../../helpers/http.js';

/**
 * Simula el subconjunto mysql2 usado por las consultas SL-2, sin persistencia.
 * @returns {object} Pool con catalogo, version y dos tarifas sinteticas.
 */
function poolTarifarioFalso() {
  const connection = {
    async query() {
      return [[], []];
    },
    async execute(sql, parametros = []) {
      if (sql.includes('FROM planes') && sql.includes('WHERE activa = 1')) {
        return [[{
          id: 1,
          nombre: 'PLAN SINTETICO',
          detalles: null,
          condiciones_generales: null,
        }], []];
      }
      if (sql.includes('FROM planes') && sql.includes('WHERE id = ?')) {
        return [[{ id: parametros[0], nombre: 'PLAN SINTETICO', activa: 1 }], []];
      }
      if (sql.includes('FROM tarifario_versiones')) {
        return [[{
          id: 4,
          tipo: 'CARGA_INICIAL',
          estado: 'ACTIVA',
          fecha_activacion: new Date('2026-10-14T12:00:00Z'),
          actor_legajo: null,
        }], []];
      }
      if (sql.includes('FROM tarifas')) {
        return [[
          { rango_clave: '0-25', rango_etario: '0-25', rango_nota: null, precio: '100.00' },
          { rango_clave: 'HIJO 0-1', rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '50.25' },
        ], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    release() {},
  };
  return { async getConnection() { return connection; } };
}

test('rutas SL-2 aplican contrato, rol ADMIN, no-store y fallback unico', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  fixture.context.pool = poolTarifarioFalso();
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;

  const sinSesion = await request('/api/admin/planes');
  assert.equal(sinSesion.status, 401);

  const planes = await request('/api/admin/planes', { headers: { cookie } });
  assert.equal(planes.status, 200);
  assert.equal(planes.headers['cache-control'], 'no-store');
  assert.deepEqual(planes.body.planes.map((plan) => plan.nombre), ['PLAN SINTETICO']);

  const tarifario = await request(
    '/api/admin/tarifario/planes/1/Obligatorio',
    { headers: { cookie } },
  );
  assert.equal(tarifario.status, 200);
  assert.equal(tarifario.body.version.id, '4');
  assert.equal(tarifario.body.tarifas[1].rango_nota, '(*)');
  assert.equal(tarifario.body.tarifas[1].precio, '50.25');

  const invalido = await request(
    '/api/admin/tarifario/planes/0/Ambas',
    { headers: { cookie } },
  );
  assert.equal(invalido.status, 400);
  assert.equal(invalido.body.error.code, 'ADMIN_VALIDACION');
  assert.equal(invalido.body.error.details.length, 2);

  fixture.state.employees[0].rol = 'ASESOR';
  const prohibido = await request('/api/admin/planes', { headers: { cookie } });
  assert.equal(prohibido.status, 403);
  assert.equal(prohibido.body.error.code, 'ROLE_FORBIDDEN');

  fixture.state.employees[0].rol = 'ADMIN';
  const desconocida = await request('/api/admin/no-existe', { headers: { cookie } });
  assert.equal(desconocida.status, 404);
  assert.equal(desconocida.body.error.code, 'ADMIN_ROUTE_NOT_FOUND');
});

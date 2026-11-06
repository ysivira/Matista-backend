/** SPEC-07 CP-54: HTTP real y lectura de configuración simulada; nunca conecta a MySQL. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../../src/app.js';
import { memoryContext, fixtureSession, localEnv } from '../../auth/fixtures.js';
import { solicitudMonotributo } from '../../helpers/monotributo.js';
import { startTestServer } from '../../helpers/http.js';
import { evidence } from '../../helpers/evidence.js';

/** Adaptador solo lectura: omite un único campo en una copia, no en el fixture base. */
function lecturaSimulada(s, actor, observation) {
  const control = { phase: 'valida', writes: 0, policies: [], transactions: [] };
  const consulta = async (sql, parameters = []) => {
    if (sql === "SET time_zone = '+00:00'") return [[]];
    if (!/^\s*SELECT\b/i.test(sql)) {
      control.writes++;
      throw new Error('El adaptador CP-54 no permite escrituras ni DDL.');
    }
    let rows;
    if (sql.includes('FROM clientes WHERE id = ? AND asesor_legajo = ?')) {
      assert.deepEqual(parameters, [s.cliente.id, actor]);
      rows = [{ ...s.cliente, asesor_legajo: actor, fecha_nacimiento: null, familia: null }];
    } else if (sql === 'SELECT id, nombre, activa FROM planes WHERE id = ?' ||
               sql === 'SELECT id,nombre,detalles,condiciones_generales FROM planes WHERE id=?') {
      assert.deepEqual(parameters, [s.plan.id]);
      rows = [{ ...s.plan, activa: 1 }];
    } else if (sql.includes("FROM tarifario_versiones v") && sql.includes("v.estado IN ('ACTIVA', 'HISTORICA')")) {
      assert.equal(parameters.length, 1);
      assert.match(parameters[0], /^\d{4}-\d{2}-\d{2} /);
      rows = [{ id: s.referencias.tarifa_version_id }];
    } else if (sql.includes('FROM politica_comercial p') && sql.includes("WHERE p.estado = 'VIGENTE'")) {
      assert.deepEqual(parameters, []);
      const policy = structuredClone(s.catalogo.politica);
      if (control.phase === 'unitario-ausente') delete policy.aporte_monotributo;
      control.policies.push({ phase: control.phase, policy: structuredClone(policy) });
      rows = [policy];
    } else if (sql.includes('FROM tarifas') && sql.includes('AND activa = 1')) {
      assert.deepEqual(parameters, [s.referencias.tarifa_version_id, s.plan.id, 'Obligatorio']);
      rows = s.catalogo.tarifas;
    } else if (sql.includes('FROM porcentajes_comerciales') && sql.includes('WHERE politica_comercial_id IN (?)')) {
      assert.deepEqual(parameters, [s.catalogo.politica.id]);
      rows = s.catalogo.porcentajes;
    } else if (sql === 'SELECT legajo,nombre,apellido FROM empleados WHERE legajo=?') {
      assert.deepEqual(parameters, [actor]);
      rows = [{ ...s.asesor, legajo: actor }];
    } else {
      throw new Error('Lectura no prevista en el adaptador CP-54.');
    }
    observation.record('simulated-adapter-read', { dependency: 'memoria, no MySQL', phase: control.phase, sql, parameters, rows });
    return [structuredClone(rows)];
  };
  const transaction = event => { control.transactions.push({ phase: control.phase, event }); };
  return { control, pool: {
    async getConnection() { return {
      query: consulta, execute: consulta,
      async beginTransaction() { transaction('begin'); },
      async commit() { transaction('commit'); },
      async rollback() { transaction('rollback'); },
      release() { transaction('release'); },
    }; },
  } };
}

test('SPEC07 CP-54: unitario ausente en lectura simulada rechaza HTTP sin resultado ni escrituras', async t => {
  const observation = evidence('CP-54/unitario-ausente-simulado');
  observation.record('scope', { dependency: 'Adaptador de lectura en memoria; no MySQL',
    injection: 'Eliminar únicamente aporte_monotributo de una copia de la respuesta de política',
    production: 'HTTP, validadores, servicios, repositorios y motor sin modificaciones' });
  const fixture = memoryContext();
  const session = await fixtureSession(fixture);
  const s = solicitudMonotributo();
  const sourceBefore = structuredClone(s);
  const authBefore = structuredClone(fixture.state);
  const f = lecturaSimulada(s, fixture.state.employees[0].legajo, observation);
  fixture.context.pool = f.pool;
  const request = await startTestServer(t, createApp({ env: localEnv, authContext: fixture.context }));
  const path = '/api/asesor/cotizaciones/previsualizacion';
  const body = JSON.stringify(s.entrada);
  const headers = { origin: localEnv.FRONTEND_ORIGIN, cookie: `matista_session=${session.token}` };
  let baseline;
  for (const phase of ['valida', 'unitario-ausente', 'recuperada']) {
    f.control.phase = phase;
    const response = await request(path, { method: 'POST', body, headers });
    observation.record('phase', { phase });
    observation.http('POST', path, s.entrada, response);
    if (phase === 'unitario-ausente') {
      assert.equal(response.status, 422);
      const message = 'ADMIN debe configurar el aporte monotributo antes de cotizar.';
      assert.deepEqual(response.body, { error: { code: 'COTIZACION_REGLA', message, details: [{ field: 'entrada', message }] } });
      assert.ok(!Object.hasOwn(response.body, 'resultado'));
      assert.ok(!/NaN|Infinity|undefined/.test(JSON.stringify(response.body)));
    } else {
      assert.equal(response.status, 200);
      const result = response.body.resultado;
      assert.equal(result.total, '707627.51');
      assert.equal(result.precio_base, '1198928.47');
      assert.deepEqual(result.aportes, [
        { concepto: 'Monotributo (titular)', importe: '23892.00' },
        { concepto: 'Adherentes Monotributo', importe: '47784.00' },
      ]);
      for (const amount of [result.precio_base, result.total, ...result.aportes.map(a => a.importe), ...result.tramos.map(tramo => tramo.total)]) {
        assert.match(amount, /^\d+\.\d{2}$/);
        assert.ok(BigInt(amount.replace('.', '')) >= 0n);
      }
      if (phase === 'valida') baseline = response.body;
      else assert.deepEqual(response.body, baseline);
    }
    assert.equal(f.control.writes, 0);
    assert.deepEqual(s, sourceBefore);
    assert.deepEqual(fixture.state, authBefore);
    assert.deepEqual(f.control.transactions.filter(event => event.phase === phase).map(event => event.event),
      ['begin', phase === 'unitario-ausente' ? 'rollback' : 'commit', 'release']);
  }
  assert.equal(f.control.policies.length, 3);
  const [valid, missing, restored] = f.control.policies.map(read => read.policy);
  const { aporte_monotributo, ...withoutUnit } = valid;
  assert.equal(aporte_monotributo, '23892.00');
  assert.ok(!Object.hasOwn(missing, 'aporte_monotributo'));
  assert.deepEqual(missing, withoutUnit);
  assert.deepEqual(restored, valid);
  observation.record('safety', { writesAttempted: f.control.writes, fixtureUnchanged: true, authUnchanged: true,
    omittedFields: ['aporte_monotributo'], transactions: f.control.transactions });
  observation.accepted('Dependencia simulada: HTTP 422 sin resultado/importes; rollback y liberación; cero escrituras; fixtures intactos y recuperación idéntica. No acredita configuración inválida persistida en MySQL.');
});

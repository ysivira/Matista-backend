import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../../../src/app.js';
import { memoryContext, fixtureSession, localEnv } from '../../auth/fixtures.js';
import { startTestServer } from '../../helpers/http.js';

test('HTTP campaña: autenticación, origen, autorización y errores de campo sin escrituras', async t => {
  const fixture = memoryContext(); const sesion = await fixtureSession(fixture);
  const politica = { id: '7', comercial_fijo_max_pct: '40.00', comercial_fijo_meses_max: 12,
    comercial_escalonado_max_pct: '50.00', comercial_escalonado_tramos_max: 4, comercial_escalonado_total_meses_max: 12,
    primer_tramo_50_meses_max: 3, tdc_habilitado: 1, tdc_pct: '5.00', afinidad_pct: '10.00', tope_comercial_tdc_pct: '55.00', joven_porcentaje: '26.00' };
  fixture.context.pool = {
    /** Solo permite lecturas del catálogo y configuración de zona horaria en el doble SQL. */
    async getConnection() { return {
      /** Rechaza cualquier intento de persistencia desde la validación inmediata. */
      async query(sql) {
        if (sql.startsWith('SET time_zone')) return [[]];
        assert.match(sql.trim(), /^SELECT/);
        return [sql.includes('FROM politica_comercial') ? [politica] : [{ id: '1', porcentaje: '50.00', vigente_hasta: null }]];
      },
      /** Libera el doble sin mantener conexiones reales. */
      release() {},
    }; },
  };
  const request = await startTestServer(t, createApp({ env: localEnv, authContext: fixture.context }));
  const body = JSON.stringify({ condiciones: { esquema: 'TRAMOS', tramos: [{ porcentaje_id: '1', meses: 3 }], tdc: true, beneficios: { solicita_afinidad: false } } });
  const headers = { origin: localEnv.FRONTEND_ORIGIN, cookie: `matista_session=${sesion.token}` };
  assert.equal((await request('/api/asesor/condiciones/validacion', { method: 'POST', body, headers: { origin: headers.origin } })).status, 401);
  assert.equal((await request('/api/asesor/condiciones/validacion', { method: 'POST', body, headers: { ...headers, origin: 'https://ajeno.example' } })).status, 403);
  const valido = await request('/api/asesor/condiciones/validacion', { method: 'POST', body, headers });
  assert.equal(valido.status, 200); assert.deepEqual(valido.body.errores, []);
  const invalido = await request('/api/asesor/condiciones/validacion', { method: 'POST', body: body.replace('"solicita_afinidad":false', '"solicita_afinidad":true'), headers });
  assert.equal(invalido.status, 200); assert.equal(invalido.body.errores[0].field, 'condiciones.tramos.0.porcentaje_id');
  const conFamilia = { ...JSON.parse(body), familia: { titular: { edad: 25, estado_civil: 'SOLTERO' }, miembros: [] } };
  const joven = await request('/api/asesor/condiciones/validacion', { method: 'POST', body: JSON.stringify(conFamilia), headers });
  assert.equal(joven.status, 200);
  assert.match(joven.body.errores[0].message, /81.00 %.*55.00 %.*26.00 puntos/);
  conFamilia.familia.titular.estado_civil = 'OTRO';
  const otro = await request('/api/asesor/condiciones/validacion', { method: 'POST', body: JSON.stringify(conFamilia), headers });
  assert.deepEqual(otro.body.errores, []);
  fixture.state.employees[0].rol = 'ADMIN';
  assert.equal((await request('/api/asesor/condiciones/validacion', { method: 'POST', body, headers })).status, 403);
});

test('HTTP con doble SQL: esquema pendiente responde 503 seguro y deja diagnóstico sin SQL', async t => {
  const fixture = memoryContext();
  const sesion = await fixtureSession(fixture);
  const avisos = [];
  const anterior = console.warn;
  console.warn = (...args) => avisos.push(args);
  t.after(() => { console.warn = anterior; });
  fixture.context.pool = {
    /** Simula conexión cuya tabla falta; AUTH conserva su repositorio en memoria. */
    async getConnection() {
      return {
        /** Reproduce únicamente el código mysql2, con mensaje que nunca debe divulgarse. */
        async query() { const error = new Error('SQL privado de diagnóstico'); error.code = 'ER_NO_SUCH_TABLE'; throw error; },
        /** El doble no posee sockets para liberar. */
        release() {},
      };
    },
  };
  const request = await startTestServer(t, createApp({ env: localEnv, authContext: fixture.context }));
  for (const ruta of ['/api/asesor/clientes', '/api/asesor/cotizaciones']) {
    const r = await request(ruta, { headers: { cookie: `matista_session=${sesion.token}` } });
    assert.equal(r.status, 503); assert.equal(r.body.error.code, 'ASESOR_ESQUEMA_PENDIENTE');
    assert.ok(!JSON.stringify(r.body).includes('SQL privado'));
  }
  assert.equal(avisos.length, 2);
  assert.equal(avisos[0][1].mysqlCode, 'ER_NO_SUCH_TABLE');
  assert.ok(!JSON.stringify(avisos).includes('SQL privado'));
});

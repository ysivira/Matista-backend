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
      if (sql.includes('FROM politica_comercial')) {
        return [[{
          id: 1,
          porcentaje_aporte_reconocido: '50.00',
          tope_sueldo_bruto: '500000.00',
          joven_porcentaje: '10.00',
          comercial_fijo_max_pct: '15.00',
          comercial_fijo_meses_max: 6,
          comercial_escalonado_max_pct: '25.00',
          comercial_escalonado_tramos_max: 3,
          comercial_escalonado_total_meses_max: 12,
          primer_tramo_50_meses_max: 6,
          tdc_pct: '5.00',
          tdc_habilitado: 1,
          tope_comercial_tdc_pct: '10.00',
          afinidad_pct: '3.00',
          fecha_vigencia: new Date('2026-10-14T12:00:00Z'),
          vigente_hasta: null,
          actor_legajo: '1234567',
          created_at: new Date('2026-10-14T12:00:00Z'),
        }], []];
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

/**
 * Simula mysql2 para las consultas SL-3: historial, detalle, snapshot
 * completo y resolver vigente-en-fecha.
 * @returns {object} Pool con catalogo reducido y versiones sinteticas.
 */
function poolVersionesFalso() {
  const versiones = [
    {
      id: 7,
      tipo: 'EDICION_LISTA',
      estado: 'PREPARACION',
      revision: 0,
      fecha_activacion: null,
      version_base_id: 1,
      actor_legajo: '1234567',
      created_at: new Date('2026-10-21T14:00:00Z'),
      nombre: 'Marcelo',
      apellido: 'Suarez',
    },
    {
      id: 1,
      tipo: 'CARGA_INICIAL',
      estado: 'ACTIVA',
      revision: 0,
      fecha_activacion: new Date('2026-10-19T16:37:36Z'),
      version_base_id: null,
      actor_legajo: null,
      created_at: new Date('2026-10-19T16:20:00Z'),
      nombre: null,
      apellido: null,
    },
  ];
  const tarifasCrudas = [
    { plan_id: 1, plan_nombre: 'RUBI', tipo_ingreso: 'Obligatorio', rango_clave: '0-25', rango_etario: '0-25', rango_nota: null, precio: '10.00', activa: 1 },
    { plan_id: 1, plan_nombre: 'RUBI', tipo_ingreso: 'Obligatorio', rango_clave: 'HIJO 0-1', rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '50.25', activa: 0 },
  ];
  const connection = {
    async query(sql, parametros = []) {
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes('ORDER BY v.created_at')) {
        return [versiones, []];
      }
      if (sql.includes('WHERE v.id = ?')) {
        return [[versiones.find((fila) => Number(fila.id) === Number(parametros[0]))].filter(Boolean), []];
      }
      if (sql.includes('JOIN planes ON planes.id = t.plan_id')) {
        if (sql.includes('AND t.activa = 1')) {
          return [tarifasCrudas.filter((fila) => Number(fila.activa) === 1), []];
        }
        return [tarifasCrudas, []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async execute(sql) {
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes("estado IN ('ACTIVA', 'HISTORICA')")) {
        return [[{
          id: 1,
          tipo: 'CARGA_INICIAL',
          estado: 'ACTIVA',
          fecha_activacion: new Date('2026-10-19T16:37:36Z'),
          actor_legajo: null,
        }], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    release() {},
  };
  return { async getConnection() { return connection; } };
}

test('rutas SL-3 responden historial, detalle, snapshot y reconstruccion', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  fixture.context.pool = poolVersionesFalso();
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;

  const sinSesion = await request('/api/admin/tarifario/versiones');
  assert.equal(sinSesion.status, 401);

  const historial = await request('/api/admin/tarifario/versiones', { headers: { cookie } });
  assert.equal(historial.status, 200);
  assert.equal(historial.headers['cache-control'], 'no-store');
  assert.deepEqual(historial.body.versiones.map((version) => version.id), ['7', '1']);
  assert.equal(historial.body.versiones[0].actor_nombre, 'Marcelo');
  assert.equal(historial.body.versiones[0].fecha_activacion, null);
  assert.equal(historial.body.versiones[1].actor_legajo, null);

  const detalle = await request('/api/admin/tarifario/versiones/7', { headers: { cookie } });
  assert.equal(detalle.status, 200);
  assert.equal(detalle.body.version.estado, 'PREPARACION');

  const detalleNulo = await request('/api/admin/tarifario/versiones/404', { headers: { cookie } });
  assert.equal(detalleNulo.status, 404);
  assert.equal(detalleNulo.body.error.code, 'ADMIN_NO_ENCONTRADO');

  const tarifas = await request('/api/admin/tarifario/versiones/7/tarifas', { headers: { cookie } });
  assert.equal(tarifas.status, 200);
  assert.deepEqual(
    tarifas.body.tarifas.map((tarifa) => tarifa.rango_clave),
    ['0-25', 'HIJO 0-1'],
  );
  assert.equal(tarifas.body.tarifas[1].activa, false);

  const reconstruccion = await request(
    '/api/admin/tarifario?fecha=2026-10-20T09:30:00-03:00',
    { headers: { cookie } },
  );
  assert.equal(reconstruccion.status, 200);
  assert.equal(reconstruccion.body.fecha, '2026-10-20T12:30:00.000Z');
  assert.equal(reconstruccion.body.version.id, '1');

  const fechaInvalida = await request(
    '/api/admin/tarifario?fecha=2026-10-19T16:37:36',
    { headers: { cookie } },
  );
  assert.equal(fechaInvalida.status, 400);
  assert.equal(fechaInvalida.body.error.code, 'ADMIN_VALIDACION');

  const idInvalido = await request('/api/admin/tarifario/versiones/0x4', { headers: { cookie } });
  assert.equal(idInvalido.status, 400);
  assert.equal(idInvalido.body.error.code, 'ADMIN_VALIDACION');

  fixture.state.employees[0].rol = 'ASESOR';
  const prohibido = await request('/api/admin/tarifario/versiones', { headers: { cookie } });
  assert.equal(prohibido.status, 403);
});

// ─────────────────────────────────────────────────────────────────────
// Rutas SL-4/SL-5. El doble scriptea el flujo transaccional completo que
// el servicio dispara contra MySQL (bloqueos, copia, guardas y eventos)
// con el mismo encadenamiento de instrucciones que la base real espera;
// el wire de HTTP/validation está ASSURED con las invariantes del
// contrato SL-4.
// ─────────────────────────────────────────────────────────────────────

import {
  errorEstado,
} from '../../../src/modules/admin/admin.errors.js';

/**
 * Pool falso con estado transaccional para el ciclo SL-4/SL-5: guarda la
 * version activa (1), un borrador cread a partir del POST y los cambios
 * inducidos por aumento/edicion/finalizacion/activacion. Cada consulta
 * sigue el mismo patron que sus contrapartes reales del repositorio.
 */
function poolCicloFalso() {
  const estado = {
    activa: {
      id: 1, tipo: 'CARGA_INICIAL', estado: 'ACTIVA', revision: 0,
      fecha_activacion: new Date('2026-10-19T16:37:36Z'),
      version_base_id: null, actor_legajo: null,
      created_at: new Date('2026-10-19T16:20:00Z'),
      nombre: null, apellido: null,
    },
    borrador: null,
    borradorId: 7,
    filas: [
      { id: 101, version_id: 1, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' },
      { id: 102, version_id: 1, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '50.25' },
    ],
    eventos: [], siguienteEvento: 1, sqlHorde: [],
  };

  const connection = {
    async query(sql, parametros = []) {
      estado.sqlHorde.push(sql);
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes("WHERE v.estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR')")) {
        return [estado.borrador ? [estado.borrador] : [], []];
      }
      if (sql.includes('SELECT id, plan_id, tipo_ingreso, rango_clave, precio')) {
        const versionId = Number(parametros[0]);
        return [
          estado.filas.filter((fila) => fila.version_id === versionId),
          [],
        ];
      }
      if (sql.includes('WHERE v.id = ?')) {
        const id = Number(parametros[0]);
        return [[Number(id) === 1 ? estado.activa : estado.borrador], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async execute(sql, parametros = []) {
      estado.sqlHorde.push(sql);
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes("WHERE estado = 'ACTIVA'") && sql.includes('FOR UPDATE')) {
        return [estado.activa ? [estado.activa] : [], []];
      }
      if (sql.startsWith('INSERT INTO tarifario_versiones_eventos')) {
        const id = estado.siguienteEvento;
        estado.siguienteEvento += 1;
        estado.eventos.push({ id, versionId: parametros[0], sql: sql });
        return [{ insertId: id }];
      }
      if (sql.startsWith('INSERT INTO tarifario_versiones')) {
        const id = estado.borradorId;
        estado.borradorId += 1;
        estado.borrador = {
          id, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 0,
          fecha_activacion: null, version_base_id: 1,
          actor_legajo: parametros[1],
          created_at: new Date('2026-10-21T15:00:00Z'),
          nombre: 'Marcelo', apellido: 'Suarez',
        };
        return [{ insertId: id }];
      }
      if (sql.startsWith('INSERT INTO tarifas')) {
        // Snapshot de la lista ANTES de anexar las copias (evita el
        // bucle infinito de un for..of sobre el array mutado).
        const copia = [...estado.filas];
        for (const fila of copia) {
          estado.filas.push({ ...fila, id: fila.id + 10, version_id: Number(parametros[0]) });
        }
        return [{ affectedRows: copia.length }];
      }
      if (sql.startsWith('SELECT id, tipo, estado')) {
        const id = Number(parametros[0]);
        return [[Number(id) === 1 ? estado.activa : estado.borrador], []];
      }
      if (sql.startsWith('SELECT id, version_id, plan_id')) {
        const tarifaId = Number(parametros[0]);
        const versionId = Number(parametros[1]);
        return [
          estado.filas.filter((fila) => fila.id === tarifaId
            && fila.version_id === versionId),
          [],
        ];
      }
      if (sql.startsWith('UPDATE tarifario_versiones SET revision')) {
        // Comparacion optimista con estado en memoria del doble.
        const id = Number(parametros[0]);
        const esperada = Number(parametros[1]);
        const fila = id === 1 ? estado.activa : estado.borrador;
        if (!fila || Number(fila.revision) !== esperada) {
          return [{ affectedRows: 0 }];
        }
        fila.revision = esperada + 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE tarifario_versiones')) {
        // parametros = [nuevoEstado, id]; honra la transicion pedida
        // (LISTA_PARA_ACTIVAR en la finalizacion, ACTIVA al activar).
        const nuevoEstado = parametros[0];
        const id = Number(parametros[1]);
        if (id === 1) {
          estado.activa = null;
          return [{ affectedRows: 1 }];
        }
        if (estado.borrador) {
          estado.borrador = {
            ...estado.borrador,
            estado: nuevoEstado,
            fecha_activacion: nuevoEstado === 'ACTIVA'
              ? new Date('2026-10-21T18:05:00Z')
              : null,
          };
        }
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE tarifas SET precio = ? WHERE id = ?')) {
        // UPDATE del caso B (individual) y del caso masivo por fila.
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT COUNT(*) AS filas')) {
        const versionId = Number(parametros[0]);
        return [[{ filas: estado.filas.filter((f) => f.version_id === versionId).length }], []];
      }
      if (sql.startsWith('SELECT nombre, apellido FROM empleados')) {
        return [[{ nombre: 'Marcelo', apellido: 'Suarez' }], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async beginTransaction() { estado.abierta = true; },
    async commit() { estado.abierta = false; },
    async rollback() { estado.abierta = false; },
    release() {},
  };
  return {
    async getConnection() {
      return connection;
    },
    estado,
  };
}

test('rutas SL-4/SL-5 aplican el ciclo completo con contrato y roles', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolCicloFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;

  // El guardia CSRF (requireTrustedOrigin) exige el origin confiada en
  // operaciones mutables; las aprueban las amenazas mutate.
  const originMutante = { origin: 'http://localhost:5173' };

  const sinSesion = await request('/api/admin/tarifario/versiones', {
    method: 'post',
    headers: { origin: 'http://localhost:5173' },
  });
  assert.equal(sinSesion.status, 401);

  // A: crear borrador (201).
  const creacion = await request('/api/admin/tarifario/versiones', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
  });
  assert.equal(creacion.status, 201);
  assert.equal(creacion.body.version.estado, 'PREPARACION');
  assert.equal(creacion.body.version.version_base_id, '1');
  assert.equal(creacion.body.version.evento.tipo, 'CREACION');

  // Validaciones del cuerpo antes de tocar la base.
  const aumentoInvalido = await request('/api/admin/tarifario/versiones/7/aumentos', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: JSON.stringify({ porcentaje: '0', revision: '0' }),
  });
  assert.equal(aumentoInvalido.status, 400);
  assert.equal(aumentoInvalido.body.error.code, 'ADMIN_VALIDACION');

  // Aumento masivo (modulo conservado del cierre).
  const aumento = await request('/api/admin/tarifario/versiones/7/aumentos', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: JSON.stringify({ porcentaje: '5', revision: '0' }),
  });
  assert.equal(aumento.status, 200);
  assert.equal(aumento.body.filas, 2);
  assert.equal(aumento.body.revision, 1);
  assert.equal(aumento.body.porcentaje, '5');

  // B: edicion individual de precio con revision optimista.
  const edicion = await request('/api/admin/tarifario/versiones/7/tarifas/111', {
    method: 'patch',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: JSON.stringify({ precio: '120.50', revision: '1' }),
  });
  assert.equal(edicion.status, 200);
  assert.equal(edicion.body.tarifa.precio, '120.50');
  assert.equal(edicion.body.revision, 2);

  // Aumento: sin revision correcta es 409 (doble simula desfase).
  pool.estado.borrador.revision = 9;
  const desfase = await request('/api/admin/tarifario/versiones/7/tarifas/111', {
    method: 'patch',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: JSON.stringify({ precio: '120.50', revision: '1' }),
  });
  assert.equal(desfase.status, 409);
  assert.equal(desfase.body.error.code, 'ADMIN_CONCURRENCIA');
  // La revision real de la base sigue siendo 2 tras el conflicto.
  pool.estado.borrador.revision = 2;

  // C: finalizacion.
  const finalizacion = await request('/api/admin/tarifario/versiones/7/finalizacion', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
    body: JSON.stringify({ revision: '2' }),
  });
  assert.equal(finalizacion.status, 200);
  assert.equal(finalizacion.body.version.estado, 'LISTA_PARA_ACTIVAR');

  // D: activacion manual.
  const activacion = await request('/api/admin/tarifario/versiones/7/activacion', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
  });
  assert.equal(activacion.status, 200);
  assert.equal(activacion.body.version.estado, 'ACTIVA');
  assert.equal(activacion.body.versionReemplazada, '1');
  assert.equal(activacion.body.evento.tipo, 'ACTIVACION');

  // ASESOR guardia: sin vista ADMIN no hay caso de C/D.
  fixture.state.employees[0].rol = 'ASESOR';
  const prohibida = await request('/api/admin/tarifario/versiones/7/activacion', {
    method: 'post',
    headers: { cookie, origin: 'http://localhost:5173' },
  });
  assert.equal(prohibida.status, 403);
});

// ─────────────────────────────────────────────────────────────────────
// Rutas del resumen de eventos y del deshacer. El doble mantiene
// listamente el estado transaccional minimo que el deshacer toca:
// borrador en PREPARACION (revision), tarifas por clave de negocio y
// eventos auditados reales (con un AUMENTO_MASIVO agrupado y una
// edicion individual posterior).
// ─────────────────────────────────────────────────────────────────────

function poolDeshacerFalso() {
  const estado = {
    borrador: {
      id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 2,
      fecha_activacion: null, version_base_id: 1, actor_legajo: '1234567',
      created_at: new Date('2026-10-21T15:00:00Z'),
      nombre: 'Marcelo', apellido: 'Suarez',
    },
    filas: [
      { id: 101, version_id: 7, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '110.00' },
      { id: 102, version_id: 7, plan_id: 1, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '55.28' },
      { id: 103, version_id: 7, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', precio: '45.50' },
    ],
    eventos: [
      { id: 1, version_id: 7, agrupador_id: null, tipo_evento: 'CREACION', tipo_operacion: null, plan_id: null, tipo_ingreso: null, rango_clave: null, valor_anterior: null, valor_nuevo: null, detalle: 'Creacion de la version 7.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T15:01:00Z') },
      { id: 2, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'AUMENTO_MASIVO', plan_id: null, tipo_ingreso: null, rango_clave: null, valor_anterior: null, valor_nuevo: null, detalle: 'Se aumento un 10% el valor. Obligatorio, Voluntario.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T15:02:00Z') },
      { id: 3, version_id: 7, agrupador_id: 2, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 1, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', valor_anterior: '100.00', valor_nuevo: '110.00', detalle: 'mod. PRECIO del rango 0-25.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T15:02:01Z') },
      { id: 4, version_id: 7, agrupador_id: 2, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 1, tipo_ingreso: 'Voluntario', rango_clave: '66+', valor_anterior: '50.25', valor_nuevo: '55.28', detalle: 'mod. PRECIO del rango 66+.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T15:02:02Z') },
      { id: 5, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', valor_anterior: '30.00', valor_nuevo: '45.50', detalle: 'mod. PRECIO del rango HIJO 0-1.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T15:03:00Z') },
    ],
    siguienteEvento: 10,
    // Fuente historica para la ruta de recuperacion (id 5).
    fuente: {
      id: 5, tipo: 'EDICION_LISTA', estado: 'HISTORICA', revision: 7,
      fecha_activacion: new Date('2026-09-01T12:00:00Z'), version_base_id: 1,
      actor_legajo: null, created_at: new Date('2026-08-30T10:00:00Z'),
      nombre: null, apellido: null,
    },
    filasFuente: [
      { id: 201, version_id: 5, plan_id: 9, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '99.00' },
      { id: 202, version_id: 5, plan_id: 9, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '49.99' },
    ],
    borradorAbierto: null,
    versiones: [],
    proximoBorradorId: 8,
  };

  const connection = {
    async query(sql, parametros = []) {
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes('FROM tarifario_versiones_eventos')) {
        const versionId = Number(parametros[0]);
        return [
          estado.eventos.filter((evento) => evento.version_id === versionId),
          [],
        ];
      }
      if (sql.includes('WHERE v.id = ?')) {
        const id = Number(parametros[0]);
        const fila = id === estado.borrador?.id ? estado.borrador
          : id === estado.fuente.id ? estado.fuente : null;
        return [[fila], []];
      }
      if (sql.includes("WHERE v.estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR')")) {
        return [[estado.borradorAbierto], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async execute(sql, parametros = []) {
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.startsWith('SELECT id, tipo, estado')) {
        const id = Number(parametros[0]);
        const fila = id === estado.borrador?.id ? estado.borrador
          : id === estado.fuente.id ? estado.fuente : null;
        return [[fila], []];
      }
      if (sql.startsWith('UPDATE tarifario_versiones SET revision')) {
        const esperada = Number(parametros[1]);
        if (Number(estado.borrador.revision) !== esperada) {
          return [{ affectedRows: 0 }];
        }
        estado.borrador.revision = esperada + 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("WHERE v.estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR')")) {
        return [[estado.borradorAbierto], []];
      }
      if (sql.startsWith('INSERT INTO tarifario_versiones_eventos')) {
        // Simula el INSERT real: persiste el evento en memoria con la
        // forma de fila que el deshacer vuelve a leer (parametros del
        // repositorio: version, agrupador, tipo evento/operacion, actor,
        // entidad, valores y detalle).
        const id = estado.siguienteEvento;
        estado.siguienteEvento += 1;
        const [versionId, agrupadorId, tipoEvento, tipoOperacion,
          actorLegajo, actorNombre, actorApellido, planId, tipoIngreso,
          rangoClave, valorAnterior, valorNuevo, detalle] = parametros;
        estado.eventos.push({
          id, version_id: Number(versionId), agrupador_id: agrupadorId,
          tipo_evento: tipoEvento, tipo_operacion: tipoOperacion,
          actor_legajo: actorLegajo, actor_nombre: actorNombre,
          actor_apellido: actorApellido,
          plan_id: planId === null ? null : Number(planId),
          tipo_ingreso: tipoIngreso, rango_clave: rangoClave,
          valor_anterior: valorAnterior, valor_nuevo: valorNuevo,
          detalle,
          evento_en: new Date('2026-10-21T16:00:00Z'),
        });
        return [{ insertId: id }];
      }
      if (sql.startsWith('INSERT INTO tarifario_versiones')
        && !sql.startsWith('INSERT INTO tarifario_versiones_eventos')) {
        // Persiste el borrador nuevo y lo deja como unico borrador
        // abierto (como haria guard_borrador en el esquema real).
        const [versionBaseId, actorLegajo, observacion] = parametros;
        const id = estado.proximoBorradorId;
        estado.proximoBorradorId += 1;
        estado.borradorAbierto = {
          id, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 0,
          fecha_activacion: null, version_base_id: Number(versionBaseId),
          actor_legajo: actorLegajo, created_at: new Date('2026-10-21T16:30:00Z'),
          nombre: null, apellido: null,
          observacion,
        };
        estado.versiones.push(estado.borradorAbierto);
        return [{ insertId: id }];
      }
      if (sql.startsWith('INSERT INTO tarifas')) {
        const [destinoId, origenId] = parametros;
        let copiadas = 0;
        for (const fila of estado.filasFuente.filter((f) => f.version_id === Number(origenId))) {
          estado.filas.push({ ...fila, id: fila.id + 50, version_id: Number(destinoId) });
          copiadas += 1;
        }
        return [{ affectedRows: copiadas }];
      }
      if (sql.startsWith('UPDATE tarifario_versiones')
        && !sql.startsWith('UPDATE tarifario_versiones SET revision')) {
        // parametros = [nuevoEstado, id]: transicion de cabecera.
        estado.borrador = { ...estado.borrador, estado: parametros[0] };
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('UPDATE tarifas SET precio = ? WHERE id = ?')) {
        const fila = estado.filas.find((f) => f.id === Number(parametros[1]));
        if (fila) fila.precio = parametros[0];
        return [{ affectedRows: fila ? 1 : 0 }];
      }
      if (sql.includes('WHERE version_id = ? AND plan_id = ?')) {
        const [versionId, planId, tipoIngreso, rangoClave] = parametros;
        return [
          estado.filas.filter((fila) => fila.version_id === Number(versionId)
            && fila.plan_id === Number(planId)
            && fila.tipo_ingreso === tipoIngreso
            && fila.rango_clave === rangoClave),
          [],
        ];
      }
      if (sql.startsWith('SELECT nombre, apellido FROM empleados')) {
        return [[{ nombre: 'Marcelo', apellido: 'Suarez' }], []];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  return {
    async getConnection() { return connection; },
    estado,
  };
}

test('ruta de recuperacion: historica -> borrador, exclusividad y rechazos', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolDeshacerFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;
  const origin = { origin: 'http://localhost:5173' };

  // Recuperacion feliz desde la fuente historica (id 5).
  const feliz = await request('/api/admin/tarifario/versiones/5/recuperacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(feliz.status, 201);
  assert.equal(feliz.body.version.tipo, 'EDICION_LISTA');
  assert.equal(feliz.body.version.estado, 'PREPARACION');
  assert.equal(feliz.body.version.version_base_id, '5');
  assert.equal(feliz.body.version.evento.tipo, 'CREACION');
  // Copia completa de la fuente (2 filas) y evento CREACION persistido.
  const idRecuperado = Number(feliz.body.version.id);
  assert.equal(
    pool.estado.filas.filter((f) => f.version_id === idRecuperado).length,
    pool.estado.filasFuente.length,
  );
  assert.ok(pool.estado.eventos.some((evento) => evento.version_id === idRecuperado
    && evento.tipo_evento === 'CREACION'));

  // Exclusividad: ya existe el borrador abierto recien creado.
  const repetida = await request('/api/admin/tarifario/versiones/5/recuperacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(repetida.status, 409);
  assert.equal(repetida.body.error.code, 'ADMIN_ESTADO');

  // Rechaza origen no historico (borrador PREPARACION, id 7).
  const transicion = await request('/api/admin/tarifario/versiones/7/recuperacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(transicion.status, 409);
  assert.equal(transicion.body.error.code, 'ADMIN_TRANSICION');

  // Rechaza version inexistente.
  const inexistente = await request('/api/admin/tarifario/versiones/9/recuperacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(inexistente.status, 404);
  assert.equal(inexistente.body.error.code, 'ADMIN_NO_ENCONTRADO');
});

test('ruta de reanudacion: LISTA_PARA_ACTIVAR vuelve a PREPARACION con evento', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolDeshacerFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;
  const origin = { origin: 'http://localhost:5173' };

  // El borrador estaba cerrado para activacion: PUT reanudacion pasa a
  // PREPARACION y registra el evento REANUDACION.
  pool.estado.borrador = { ...pool.estado.borrador, estado: 'LISTA_PARA_ACTIVAR' };
  const feliz = await request('/api/admin/tarifario/versiones/7/reanudacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(feliz.status, 200);
  assert.equal(feliz.body.version.estado, 'PREPARACION');
  assert.equal(feliz.body.version.revision, 2);
  assert.equal(feliz.body.evento.tipo, 'REANUDACION');
  assert.equal(pool.estado.borrador.estado, 'PREPARACION');
  assert.ok(pool.estado.eventos.some((evento) => evento.tipo_evento === 'REANUDACION'));

  // ACTIVA y HISTORICA siguen protegidas: 409 transicion.
  pool.estado.borrador = { ...pool.estado.borrador, estado: 'ACTIVA' };
  const activa = await request('/api/admin/tarifario/versiones/7/reanudacion', {
    method: 'POST', headers: { cookie, ...origin },
  });
  assert.equal(activa.status, 409);
  assert.equal(activa.body.error.code, 'ADMIN_TRANSICION');
});

test('ruta de descarte: version no activada pasa a CANCELADA con evento DESCARTE', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolDeshacerFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;
  const origin = { origin: 'http://localhost:5173' };

  // LISTA_PARA_ACTIVAR puede descartarse con motivo y revision vigente.
  pool.estado.borrador = { ...pool.estado.borrador, estado: 'LISTA_PARA_ACTIVAR' };
  const feliz = await request('/api/admin/tarifario/versiones/7/descarte', {
    method: 'POST',
    headers: { cookie, ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 2, motivo: 'El cliente no aprobo la lista.' }),
  });
  assert.equal(feliz.status, 200);
  // El estado interno reutiliza el valor heredado CANCELADA (pantalla:
  // Descartada) y el evento queda auditado con su motivo.
  assert.equal(feliz.body.version.estado, 'CANCELADA');
  assert.equal(feliz.body.version.tipo, 'EDICION_LISTA');
  assert.equal(feliz.body.evento.tipo, 'DESCARTE');
  assert.equal(pool.estado.borrador.estado, 'CANCELADA');
  const evento = pool.estado.eventos.find((fila) => fila.tipo_evento === 'DESCARTE');
  assert.ok(evento, 'el evento DESCARTE quedo persistido');
  assert.ok(evento.detalle.includes('Motivo: El cliente no aprobo la lista.'));

  // Reutiliza reserva: ACTIVA no puede descartarse (409 transicion) y la
  // vigencia quedaria intacta.
  pool.estado.borrador = { ...pool.estado.borrador, estado: 'ACTIVA' };
  const activa = await request('/api/admin/tarifario/versiones/7/descarte', {
    method: 'POST',
    headers: { cookie, ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 2, motivo: 'Intento sobre la activa.' }),
  });
  assert.equal(activa.status, 409);
  assert.equal(activa.body.error.code, 'ADMIN_TRANSICION');

  // Motivo vacio: rechaza 400 ADMIN_VALIDACION sin llegar al estado.
  pool.estado.borrador = { ...pool.estado.borrador, estado: 'PREPARACION' };
  const sinMotivo = await request('/api/admin/tarifario/versiones/7/descarte', {
    method: 'POST',
    headers: { cookie, ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 2 }),
  });
  assert.equal(sinMotivo.status, 400);
  assert.equal(sinMotivo.body.error.code, 'ADMIN_VALIDACION');

  // Sin sesion: 401.
  const sinSesion = await request('/api/admin/tarifario/versiones/7/descarte', {
    method: 'POST',
    headers: { ...origin, 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 2, motivo: 'Sin cookie.' }),
  });
  assert.equal(sinSesion.status, 401);
});

test('rutas de eventos y deshacer responden contrato, roles y transaccion', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolDeshacerFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;
  const origin = { origin: 'http://localhost:5173' };

  const sinSesion = await request('/api/admin/tarifario/versiones/7/eventos');
  assert.equal(sinSesion.status, 401);

  const idInvalido = await request('/api/admin/tarifario/versiones/0x4/eventos', {
    headers: { cookie },
  });
  assert.equal(idInvalido.status, 400);
  assert.equal(idInvalido.body.error.code, 'ADMIN_VALIDACION');

  const eventos = await request('/api/admin/tarifario/versiones/7/eventos', {
    headers: { cookie },
  });
  assert.equal(eventos.status, 200);
  assert.equal(eventos.headers['cache-control'], 'no-store');
  assert.equal(eventos.body.version.id, '7');
  // Mas recientes primero: la edicion individual del HIJO 0-1 encabeza.
  assert.deepEqual(
    eventos.body.eventos.map((evento) => evento.id),
    ['5', '4', '3', '2', '1'],
  );
  // El cabezal del aumento masivo lleva la cantidad real de hijos.
  const agrupador = eventos.body.eventos.find((evento) => evento.id === '2');
  assert.equal(agrupador.tipo_operacion, 'AUMENTO_MASIVO');
  assert.equal(agrupador.filas_agrupadas, 2);
  const hijo = eventos.body.eventos.find((evento) => evento.id === '4');
  assert.equal(hijo.valor_anterior, '50.25');
  assert.equal(hijo.valor_nuevo, '55.28');

  // Deshacer exige origin confiable (CSRF).
  const sinOrigin = await request('/api/admin/tarifario/versiones/7/deshacer', {
    method: 'post',
    headers: { cookie },
    body: JSON.stringify({ revision: '2' }),
  });
  assert.equal(sinOrigin.status, 403);

  // Deshace la ULTIMA edicion individual: HIJO 0-1 vuelve a 30.00.
  const deshacer = await request('/api/admin/tarifario/versiones/7/deshacer', {
    method: 'post',
    headers: { cookie, ...origin },
    body: JSON.stringify({ revision: '2' }),
  });
  assert.equal(deshacer.status, 200);
  assert.equal(deshacer.body.filas, 1);
  assert.equal(deshacer.body.revision, 3);
  assert.equal(deshacer.body.evento.tipo, 'DESHACER_EDICION');
  assert.equal(
    pool.estado.filas.find((f) => f.id === 103).precio,
    '30.00',
  );

  // Segundo golpe: deshace el AUMENTO_MASIVO agrupado completo.
  const deshacerGrupo = await request('/api/admin/tarifario/versiones/7/deshacer', {
    method: 'post',
    headers: { cookie, ...origin },
    body: JSON.stringify({ revision: '3' }),
  });
  assert.equal(deshacerGrupo.status, 200);
  assert.equal(deshacerGrupo.body.filas, 2);
  assert.equal(deshacerGrupo.body.revision, 4);
  assert.equal(deshacerGrupo.body.evento.tipo, 'DESHACER_GRUPO');
  assert.equal(
    pool.estado.filas.find((f) => f.id === 101).precio,
    '100.00',
  );
  assert.equal(
    pool.estado.filas.find((f) => f.id === 102).precio,
    '50.25',
  );

  // Ya no queda ningun cambio economico vigente: 409.
  const sinCambios = await request('/api/admin/tarifario/versiones/7/deshacer', {
    method: 'post',
    headers: { cookie, ...origin },
    body: JSON.stringify({ revision: '4' }),
  });
  assert.equal(sinCambios.status, 409);
  assert.equal(sinCambios.body.error.code, 'ADMIN_ESTADO');

  // La revision desfasada tambien rechaza el deshacer.
  const desfase = await request('/api/admin/tarifario/versiones/7/deshacer', {
    method: 'post',
    headers: { cookie, ...origin },
    body: JSON.stringify({ revision: '1' }),
  });
  assert.equal(desfase.status, 409);
  assert.equal(desfase.body.error.code, 'ADMIN_CONCURRENCIA');

  // Rol ASESOR: sin permisos sobre trazabilidad ni deshacer.
  fixture.state.employees[0].rol = 'ASESOR';
  const prohibida = await request('/api/admin/tarifario/versiones/7/eventos', {
    headers: { cookie },
  });
  assert.equal(prohibida.status, 403);
});

// ─────────────────────────────────────────────────────────────────────
// Rutas de política comercial (SPEC-03 ADMIN): ciclo de vida con estados
// VIGENTE/PROGRAMADA/HISTORICA/CANCELADA, eventos y recuperación.
// ─────────────────────────────────────────────────────────────────────

/**
 * Pool falso para la política comercial con estado transaccional en memoria.
 * Simula el ciclo de vida real: activaciones, cierres, programaciones y
 * eventos, para verificar los contratos HTTP sin base de datos.
 * @returns {object} Pool con política comercial sintética.
 */
function poolPoliticaComercialFalso() {
  const estado = {
    politicas: [{
      id: 1,
      estado: 'VIGENTE',
      revision: 0,
      version_base_id: null,
      porcentaje_aporte_reconocido: '50.00',
      tope_sueldo_bruto: '500000.00',
      joven_porcentaje: '10.00',
      comercial_fijo_max_pct: '15.00',
      comercial_fijo_meses_max: 6,
      comercial_escalonado_max_pct: '25.00',
      comercial_escalonado_tramos_max: 3,
      comercial_escalonado_total_meses_max: 12,
      primer_tramo_50_meses_max: 6,
      tdc_pct: '5.00',
      tdc_habilitado: 1,
      tope_comercial_tdc_pct: '10.00',
      afinidad_pct: '3.00',
      aporte_monotributo: '23892.00',
      fecha_vigencia: new Date('2026-10-14T12:00:00Z'),
      vigente_hasta: null,
      cancelada_en: null,
      cancelada_por: null,
      motivo_cancelacion: null,
      actor_legajo: '1234567',
      actor_nombre: 'Laura',
      actor_apellido: 'Gimenez',
      created_at: new Date('2026-10-14T12:00:00Z'),
    }],
    porcentajes: [{
      id: 1,
      politica_comercial_id: 1,
      porcentaje: '10.00',
      descripcion: null,
      fecha_vigencia: new Date('2026-10-14T12:00:00Z'),
      vigente_hasta: null,
      actor_legajo: '1234567',
      created_at: new Date('2026-10-14T12:00:00Z'),
    }],
    eventos: [],
    siguienteId: 2,
    sqlHorde: [],
  };

  const buscarPolitica = (id) => estado.politicas.find(
    (fila) => Number(fila.id) === Number(id),
  ) ?? null;
  const buscarVigente = () => estado.politicas.find(
    (fila) => fila.estado === 'VIGENTE',
  ) ?? null;
  const buscarProgramada = () => estado.politicas.find(
    (fila) => fila.estado === 'PROGRAMADA',
  ) ?? null;

  const connection = {
    async query(sql, parametros = []) {
      estado.sqlHorde.push(sql);
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes('FROM porcentajes_comerciales') && sql.includes('politica_comercial_id IN')) {
        const ids = parametros.map(Number);
        return [estado.porcentajes.filter((fila) => ids.includes(Number(fila.politica_comercial_id))), []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'VIGENTE'")) {
        return [buscarVigente() ? [buscarVigente()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'PROGRAMADA'")) {
        return [buscarProgramada() ? [buscarProgramada()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes('ORDER BY p.created_at')) {
        return [[...estado.politicas].reverse(), []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes('WHERE p.id = ?')) {
        const politica = buscarPolitica(parametros[0]);
        return [politica ? [politica] : [], []];
      }
      if (sql.includes('FROM politica_comercial_eventos')) {
        const politicaId = Number(parametros[0]);
        return [
          estado.eventos
            .filter((evento) => Number(evento.politica_comercial_id) === politicaId)
            .sort((a, b) => b.id - a.id),
          [],
        ];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async execute(sql, parametros = []) {
      estado.sqlHorde.push(sql);
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes('FROM porcentajes_comerciales') && sql.includes('politica_comercial_id IN')) {
        const ids = parametros.map(Number);
        return [estado.porcentajes.filter((fila) => ids.includes(Number(fila.politica_comercial_id))), []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'VIGENTE'")) {
        return [buscarVigente() ? [buscarVigente()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'PROGRAMADA'")) {
        return [buscarProgramada() ? [buscarProgramada()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes('WHERE p.id = ?')) {
        const politica = buscarPolitica(parametros[0]);
        return [politica ? [politica] : [], []];
      }
      if (sql.includes('FROM politica_comercial_eventos')) {
        const politicaId = Number(parametros[0]);
        return [
          estado.eventos
            .filter((evento) => Number(evento.politica_comercial_id) === politicaId)
            .sort((a, b) => b.id - a.id),
          [],
        ];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async execute(sql, parametros = []) {
      estado.sqlHorde.push(sql);
      if (sql.includes('SET time_zone')) {
        return [[], []];
      }
      if (sql.includes('FROM porcentajes_comerciales') && sql.includes('politica_comercial_id IN')) {
        const ids = parametros.map(Number);
        return [estado.porcentajes.filter((fila) => ids.includes(Number(fila.politica_comercial_id))), []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'VIGENTE'")) {
        return [buscarVigente() ? [buscarVigente()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes("estado = 'PROGRAMADA'")) {
        return [buscarProgramada() ? [buscarProgramada()] : [], []];
      }
      if (sql.includes('FROM politica_comercial') && sql.includes('WHERE p.id = ?')) {
        const politica = buscarPolitica(parametros[0]);
        return [politica ? [politica] : [], []];
      }
      if (sql.includes('FROM empleados WHERE legajo = ?')) {
        return [[{ nombre: 'Laura', apellido: 'Gimenez' }], []];
      }
      if (sql.includes('INSERT INTO politica_comercial_eventos')) {
        const [politicaId, tipoEvento, actorLegajo, actorNombre, actorApellido, detalle] = parametros;
        estado.eventos.push({
          id: estado.eventos.length + 1,
          politica_comercial_id: politicaId,
          tipo_evento: tipoEvento,
          actor_legajo: actorLegajo,
          actor_nombre: actorNombre,
          actor_apellido: actorApellido,
          detalle,
          evento_en: new Date('2026-10-21T18:00:00Z'),
        });
        return [{ insertId: estado.eventos.length }];
      }
      if (sql.includes('UPDATE porcentajes_comerciales') && sql.includes('SET vigente_hasta')) {
        const fechaCierre = parametros[0];
        const politicaId = Number(parametros[1]);
        estado.porcentajes = estado.porcentajes.map((fila) => (
          fila.vigente_hasta === null && Number(fila.politica_comercial_id) === politicaId
            ? { ...fila, vigente_hasta: fechaCierre }
            : fila
        ));
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE politica_comercial') && sql.includes("SET estado = 'HISTORICA'")) {
        const politica = buscarPolitica(parametros[1]);
        politica.estado = 'HISTORICA';
        politica.vigente_hasta = parametros[0];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE politica_comercial') && sql.includes("SET estado = 'VIGENTE'")) {
        const politica = buscarPolitica(parametros[0]);
        politica.estado = 'VIGENTE';
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE politica_comercial') && sql.includes("SET estado = 'CANCELADA'")) {
        const politica = buscarPolitica(parametros[2]);
        politica.estado = 'CANCELADA';
        politica.cancelada_en = new Date('2026-10-21T18:00:00Z');
        politica.cancelada_por = parametros[0];
        politica.motivo_cancelacion = parametros[1];
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('UPDATE politica_comercial') && sql.includes('revision = revision + 1')) {
        const politica = buscarPolitica(parametros[16]);
        if (!politica || politica.estado !== 'PROGRAMADA') return [{ affectedRows: 0 }];
        politica.porcentaje_aporte_reconocido = parametros[0];
        politica.tope_sueldo_bruto = parametros[1];
        politica.joven_porcentaje = parametros[2];
        politica.comercial_fijo_max_pct = parametros[3];
        politica.comercial_fijo_meses_max = parametros[4];
        politica.comercial_escalonado_max_pct = parametros[5];
        politica.comercial_escalonado_tramos_max = parametros[6];
        politica.comercial_escalonado_total_meses_max = parametros[7];
        politica.primer_tramo_50_meses_max = parametros[8];
        politica.tdc_pct = parametros[9];
        politica.tdc_habilitado = parametros[10];
        politica.tope_comercial_tdc_pct = parametros[11];
        politica.afinidad_pct = parametros[12];
        politica.aporte_monotributo = parametros[13];
        politica.fecha_vigencia = parametros[14];
        politica.actor_legajo = parametros[15];
        politica.revision += 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO politica_comercial')) {
        const [
          estadoNuevo, versionBaseId,
          porcentaje_aporte_reconocido, tope_sueldo_bruto, joven_porcentaje,
          comercial_fijo_max_pct, comercial_fijo_meses_max,
          comercial_escalonado_max_pct, comercial_escalonado_tramos_max,
          comercial_escalonado_total_meses_max, primer_tramo_50_meses_max,
          tdc_pct, tdc_habilitado, tope_comercial_tdc_pct, afinidad_pct,
          aporte_monotributo, fechaVigencia, actorLegajo,
        ] = parametros;
        if (estadoNuevo === 'VIGENTE') {
          const anterior = buscarVigente();
          if (anterior) {
            anterior.estado = 'HISTORICA';
            anterior.vigente_hasta = fechaVigencia;
          }
        }
        const nuevaId = estado.siguienteId;
        estado.siguienteId += 1;
        estado.politicas.push({
          id: nuevaId,
          estado: estadoNuevo,
          revision: 0,
          version_base_id: versionBaseId,
          porcentaje_aporte_reconocido,
          tope_sueldo_bruto,
          joven_porcentaje,
          comercial_fijo_max_pct,
          comercial_fijo_meses_max,
          comercial_escalonado_max_pct,
          comercial_escalonado_tramos_max,
          comercial_escalonado_total_meses_max,
          primer_tramo_50_meses_max,
          tdc_pct,
          tdc_habilitado,
          tope_comercial_tdc_pct,
          afinidad_pct,
          aporte_monotributo,
          fecha_vigencia: fechaVigencia,
          vigente_hasta: null,
          cancelada_en: null,
          cancelada_por: null,
          motivo_cancelacion: null,
          actor_legajo: actorLegajo,
          actor_nombre: 'Laura',
          actor_apellido: 'Gimenez',
          created_at: new Date('2026-10-21T18:00:00Z'),
        });
        return [{ insertId: nuevaId }];
      }
      if (sql.includes('INSERT INTO porcentajes_comerciales')) {
        const [politicaId, porcentaje, fecha, actorLegajo] = parametros;
        estado.porcentajes.push({
          id: estado.porcentajes.length + 1,
          politica_comercial_id: politicaId,
          porcentaje,
          descripcion: null,
          fecha_vigencia: fecha,
          vigente_hasta: null,
          actor_legajo: actorLegajo,
          created_at: new Date('2026-10-21T18:00:00Z'),
        });
        return [{ insertId: estado.porcentajes.length }];
      }
      throw new Error(`Consulta no contemplada por el doble: ${sql}`);
    },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  return {
    async getConnection() { return connection; },
    estado,
  };
}

test('rutas de política comercial aplican contrato, rol ADMIN y transaccion', async (t) => {
  const fixture = memoryContext({ rol: 'ADMIN' });
  const pool = poolPoliticaComercialFalso();
  fixture.context.pool = pool;
  const signed = await fixtureSession(fixture);
  const app = createApp({ env: localEnv, authContext: fixture.context });
  const request = await startTestServer(t, app);
  const cookie = `matista_session=${signed.token}`;
  const originMutante = { origin: 'http://localhost:5173' };

  // Sin sesion: 401
  const sinSesion = await request('/api/admin/politica-comercial');
  assert.equal(sinSesion.status, 401);

  // GET /politica-comercial: 200 con la política vigente sin pendiente
  const politica = await request('/api/admin/politica-comercial', { headers: { cookie } });
  assert.equal(politica.status, 200);
  assert.equal(politica.headers['cache-control'], 'no-store');
  assert.equal(String(politica.body.id), '1');
  assert.equal(politica.body.estado, 'VIGENTE');
  assert.equal(politica.body.joven_porcentaje, '10.00');
  assert.equal(politica.body.tdc_pct, '5.00');
  assert.equal(politica.body.tdc_habilitado, 1);
  assert.deepEqual(politica.body.porcentajes_comerciales, ['10.00']);
  assert.equal(politica.body.programacion_pendiente, null);

  // Las rutas estáticas se resuelven antes de /:id y ambas incluyen el catálogo.
  const historial = await request('/api/admin/politica-comercial/historial', { headers: { cookie } });
  assert.equal(historial.status, 200);
  assert.equal(historial.body.historial.length, 1);
  const detalle = await request('/api/admin/politica-comercial/1', { headers: { cookie } });
  assert.equal(detalle.status, 200);
  assert.deepEqual(detalle.body.porcentajes_comerciales, ['10.00']);
  assert.deepEqual(detalle.body.eventos, []);

  // PUT /politica-comercial/:id con datos validos: 200 con nueva política vigente
  const actualizacion = await request('/api/admin/politica-comercial/1', {
    method: 'put',
    headers: { cookie, ...originMutante, 'content-type': 'application/json' },
    body: JSON.stringify({
      joven_porcentaje: '12.00',
      tdc_pct: '6.00',
      tdc_habilitado: 1,
    }),
  });
  assert.equal(actualizacion.status, 200);
  assert.equal(String(actualizacion.body.id), '2');
  assert.equal(actualizacion.body.estado, 'VIGENTE');
  assert.equal(actualizacion.body.joven_porcentaje, '12.00');
  assert.equal(actualizacion.body.tdc_pct, '6.00');
  assert.equal(actualizacion.body.tdc_habilitado, 1);
  // La política anterior quedó histórica y se registró el evento de creación
  const versionAnterior = pool.estado.politicas.find((fila) => fila.id === 1);
  assert.equal(versionAnterior.estado, 'HISTORICA');
  assert.ok(versionAnterior.vigente_hasta);
  assert.equal(pool.estado.eventos.length, 1);
  assert.equal(pool.estado.eventos[0].tipo_evento, 'CREACION');
  assert.equal(pool.estado.eventos[0].actor_legajo, '12345678');
  assert.equal(pool.estado.eventos[0].actor_nombre, 'Laura');

  // Validación: joven_porcentaje fuera de rango -> 400
  const invalido = await request('/api/admin/politica-comercial/2', {
    method: 'put',
    headers: { cookie, ...originMutante, 'content-type': 'application/json' },
    body: JSON.stringify({ joven_porcentaje: '150' }),
  });
  assert.equal(invalido.status, 400);
  assert.equal(invalido.body.error.code, 'ADMIN_VALIDACION');

  // Validación: tdc_habilitado invalido -> 400
  const invalido2 = await request('/api/admin/politica-comercial/2', {
    method: 'put',
    headers: { cookie, ...originMutante, 'content-type': 'application/json' },
    body: JSON.stringify({ tdc_habilitado: 2 }),
  });
  assert.equal(invalido2.status, 400);
  assert.equal(invalido2.body.error.code, 'ADMIN_VALIDACION');

  // ID desactualizado: 409 por concurrencia
  const inexistente = await request('/api/admin/politica-comercial/999', {
    method: 'put',
    headers: { cookie, ...originMutante, 'content-type': 'application/json' },
    body: JSON.stringify({ joven_porcentaje: '12.00' }),
  });
  assert.equal(inexistente.status, 409);
  assert.equal(inexistente.body.error.code, 'ADMIN_CONCURRENCIA');

  // Recuperar la versión histórica preserva su fila y crea otra activa.
  const recuperacion = await request('/api/admin/politica-comercial/1/recuperacion', {
    method: 'post',
    headers: { cookie, ...originMutante },
  });
  assert.equal(recuperacion.status, 201);
  assert.equal(String(recuperacion.body.id), '3');
  assert.equal(recuperacion.body.joven_porcentaje, '10.00');
  assert.deepEqual(recuperacion.body.porcentajes_comerciales, ['10.00']);
  assert.equal(pool.estado.eventos.length, 2);
  assert.equal(pool.estado.eventos[1].tipo_evento, 'RECUPERACION');

  // El detalle de la histórica expone su auditoría de ciclo.
  const detalleHistorica = await request('/api/admin/politica-comercial/1', { headers: { cookie } });
  assert.equal(detalleHistorica.status, 200);
  assert.equal(detalleHistorica.body.estado, 'HISTORICA');
  assert.ok(detalleHistorica.body.vigente_hasta);

  // ASESOR: 403
  fixture.state.employees[0].rol = 'ASESOR';
  const prohibido = await request('/api/admin/politica-comercial', { headers: { cookie } });
  assert.equal(prohibido.status, 403);
  assert.equal(prohibido.body.error.code, 'ROLE_FORBIDDEN');
});

test('CORS responde el preflight de PUT y anuncia los métodos mutables', async (t) => {
  const app = createApp({ env: localEnv, authContext: memoryContext().context });
  const request = await startTestServer(t, app);
  const preflight = await request('/api/admin/politica-comercial/1', {
    method: 'OPTIONS',
    headers: {
      origin: localEnv.FRONTEND_ORIGIN,
      'access-control-request-method': 'PUT',
    },
  });

  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], localEnv.FRONTEND_ORIGIN);
  assert.match(preflight.headers['access-control-allow-methods'], /PUT/);
  assert.match(preflight.headers['access-control-allow-methods'], /DELETE/);
});

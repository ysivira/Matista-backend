/**
 * ============================================================
 * MATISTA | INTEGRACIÓN COMERCIAL
 * ============================================================
 *
 * Archivo: asesor.integration.test.js
 * Módulo: Pruebas comerciales
 *
 * Responsabilidad:
 * Probar propiedad, preparación, emisión e historia mediante
 * HTTP y MySQL reales; requiere habilitar RUN_DB_TESTS.
 *
 * ============================================================
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes, randomInt } from 'node:crypto';
import test from 'node:test';
import { createApp } from '../../../src/app.js';
import { loadDatabaseConfig, assertTestDatabase } from '../../../src/infrastructure/database/config.js';
import { createDatabasePool, verifyDatabaseConnection } from '../../../src/infrastructure/database/connection.js';
import { loadSecurityConfig } from '../../../src/infrastructure/security/config.js';
import { hashPassword } from '../../../src/infrastructure/security/password.js';
import * as authRepository from '../../../src/modules/auth/auth.repository.js';
import { emitirPreparacion } from '../../../src/modules/asesor/cotizaciones.service.js';
import { guardarCliente } from '../../../src/modules/asesor/clientes.service.js';
import { startTestServer } from '../../helpers/http.js';
import { evidence, quotationSnapshot } from '../../helpers/evidence.js';

const enabled = process.env.RUN_DB_TESTS === '1';

test('ASESOR real: AUTH HTTP, propiedad, cálculo, emisión y trazabilidad histórica', { skip: !enabled }, async t => {
  const config = loadDatabaseConfig(); assertTestDatabase(config);
  const pool = createDatabasePool(config);
  await verifyDatabaseConnection(pool, 'matista_test');
  const security = loadSecurityConfig({ ...process.env, NODE_ENV: 'test', JWT_SECRET: randomBytes(48).toString('base64url') });
  const owned = [], clientes = [];
  const sufijo = randomBytes(8).toString('hex');
  // Cada identidad queda registrada inmediatamente tras INSERT exitoso para limpiar solo datos propios.
  t.after(async () => {
    try {
      if (owned.length) {
        const c = await pool.getConnection();
        const marks = owned.map(() => '?').join(',');
        try {
          assert.equal((await c.query('SELECT DATABASE() AS db'))[0][0].db, 'matista_test');
          await c.beginTransaction();
          await c.execute(`DELETE a FROM asesor_auditoria a JOIN clientes cl ON cl.id=a.cliente_id WHERE cl.asesor_legajo IN (${marks})`, owned);
          await c.execute(`DELETE m FROM miembros_cotizacion m JOIN cotizaciones q ON q.id=m.cotizacion_id WHERE q.asesor_legajo IN (${marks})`, owned);
          // Primero hijas, luego originales: se conserva la FK de recotización durante la limpieza.
          await c.execute(`DELETE FROM cotizaciones WHERE asesor_legajo IN (${marks}) AND origen_id IS NOT NULL`, owned);
          await c.execute(`DELETE FROM cotizaciones WHERE asesor_legajo IN (${marks})`, owned);
          await c.execute(`DELETE FROM clientes WHERE asesor_legajo IN (${marks})`, owned);
          for (const tabla of ['empleados_auditoria', 'auth_sesiones', 'auth_tokens', 'empleados_correos', 'empleados']) {
            await c.execute(`DELETE FROM ${tabla} WHERE legajo IN (${marks})`, owned);
          }
          await c.commit();
          for (const tabla of ['clientes', 'cotizaciones', 'asesor_auditoria']) {
            const columna = tabla === 'asesor_auditoria' ? 'actor_legajo' : 'asesor_legajo';
            assert.equal(Number((await c.execute(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${columna} IN (${marks})`, owned))[0][0].n), 0);
          }
        } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
      }
    } finally { await pool.end(); }
  });
  const context = { pool, repository: authRepository, security, dummyPasswordHash: await hashPassword('sin-usuario', security),
    /** El flujo usa reloj UTC real sin cambiar MySQL. */
    now: () => new Date(),
    /** No envía correo real desde integración. */
    notify: async () => {},
    /** No registra secretos ni datos personales. */
    reportIncident: () => {} };
  const request = await startTestServer(t, createApp({ env: { ...process.env, FRONTEND_ORIGIN: 'http://localhost:5173' }, authContext: context }));
  const cookies = [];
  for (let i = 0; i < 3; i++) {
    const legajo = String(randomInt(1_000_000_000, 9_000_000_000));
    const passwordHash = await hashPassword('clave-test-asesor', security);
    await pool.execute("INSERT INTO empleados (legajo,nombre,apellido,password_hash,rol,estado) VALUES (?,'Prueba','Rol Test',?,?,'ACTIVO')", [legajo, passwordHash, i === 2 ? 'ADMIN' : 'ASESOR']);
    owned.push(legajo);
    const email = `asesor-${sufijo}-${i}@example.test`;
    await pool.execute("INSERT INTO empleados_correos (legajo,email,estado,verificado_at) VALUES (?,?,'ACTUAL',UTC_TIMESTAMP(6))", [legajo, email]);
    const login = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password: 'clave-test-asesor' }), headers: { origin: 'http://localhost:5173' } });
    assert.equal(login.status, 200);
    cookies.push(login.headers['set-cookie'][0].split(';')[0]);
  }
  /** Envía HTTP real con cookie del asesor elegido y origen confiable. */
  const api = (ruta, body, method = 'POST', actor = 0) => request(`/api/asesor/${ruta}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }), headers: { origin: 'http://localhost:5173', cookie: cookies[actor] },
  });
  let cliente, q, entrada;
  const nacimiento = `${new Date().getUTCFullYear() - 27}-01-01`;

  await t.test('ADMIN no ingresa a ASESOR; ambos roles consultan y exportan el catálogo compartido', async () => {
    for (const [ruta, metodo] of [['planes', 'GET'], ['clientes', 'POST'], ['cotizaciones', 'GET'], ['cotizaciones', 'POST'], ['cotizaciones/1/contacto', 'PATCH'], ['cotizaciones/1/anulacion', 'POST'], ['cotizaciones/1/recotizaciones', 'POST'], ['cotizaciones/1/calculo', 'POST'], ['cotizaciones/1/emision', 'POST'], ['cotizaciones/1/pdf', 'GET']]) {
      const r = await api(ruta, metodo === 'GET' ? undefined : {}, metodo, 2);
      assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ROLE_FORBIDDEN');
    }
    for (const actor of [0, 2]) {
      const headers = { cookie: cookies[actor] };
      const planes = await request('/api/catalogo/planes', { headers }); assert.equal(planes.status, 200);
      const planId = planes.body.planes[0].id;
      assert.equal((await request('/api/catalogo/condiciones', { headers })).status, 200);
      const lista = await request(`/api/catalogo/tarifario/planes/${planId}/Voluntario`, { headers }); assert.equal(lista.status, 200);
      for (const ruta of [`planes/${planId}/pdf`, `listas/${planId}/Voluntario/pdf`]) {
        const pdf = await request('/api/catalogo/' + ruta, { headers, responseType: 'buffer' });
        assert.equal(pdf.status, 200); assert.match(pdf.headers['content-type'], /application\/pdf/);
        assert.equal(pdf.body.subarray(0, 8).toString(), '%PDF-1.4'); assert.ok(pdf.body.length > 800);
        assert.match(pdf.body.toString('latin1'), /\/Subtype \/Image/);
      }
      const csv = await request(`/api/catalogo/listas/${planId}/Voluntario/csv`, { headers, responseType: 'buffer' });
      assert.equal(csv.status, 200); assert.ok(csv.body.toString().includes(lista.body.tarifas[0].precio));
      assert.equal((await request('/api/catalogo/planes', { method: 'POST', headers: { ...headers, origin: 'http://localhost:5173' }, body: '{}' })).status, 404);
    }
    const adminDenegado = await request('/api/admin/planes', { headers: { cookie: cookies[0] } }); assert.equal(adminDenegado.status, 403);
  });

  await t.test('lecturas reutilizan ADMIN y escrituras administrativas siguen prohibidas', async () => {
    assert.equal((await request('/api/asesor/planes')).status, 401);
    const planes = await api('planes', undefined, 'GET'); assert.equal(planes.status, 200); assert.equal(planes.body.planes.length, 4);
    const planId = String(planes.body.planes[0].id);
    const lista = await api(`tarifario/planes/${planId}/Voluntario`, undefined, 'GET'); assert.equal(lista.status, 200); assert.ok(lista.body.tarifas.length);
    const condiciones = await api('condiciones', undefined, 'GET'); assert.equal(condiciones.status, 200); assert.equal(condiciones.body.motor_disponible, true); assert.ok(condiciones.body.categorias_monotributo.includes('A')); assert.equal(condiciones.body.aportes, undefined);
    const prohibido = await request('/api/admin/planes', { headers: { cookie: cookies[0] } }); assert.equal(prohibido.status, 403);
    assert.equal((await api('politica-comercial/1', {}, 'PUT')).status, 404);
    entrada = { cliente_id: '', plan_id: planId, modalidad: 'Voluntario', familia: { titular: { edad: 27, estado_civil: 'SOLTERO' }, miembros: [{ parentesco: 'HIJO', edad: 5 }] },
      aportes: {}, condiciones: { tramos: [], tdc: false, beneficios: { solicita_afinidad: false } } };
  });
  /** Comprueba normalización en POST/PUT reales además de propiedad y revisión optimista. */
  await t.test('registro/búsqueda de cliente, pertenencia y acceso por ID', async () => {
    const dni = String(randomInt(10_000_000, 99_999_999));
    assert.equal((await api(`clientes/busqueda/${dni}`, undefined, 'GET')).body.encontrado, false);
    const r = await api('clientes', { dni, nombres: 'maría josé', apellidos: 'pérez muñoz', email: `cliente-${sufijo}@example.test`, fecha_nacimiento: nacimiento, provincia: 'Córdoba', localidad: 'Villa María' });
    assert.equal(r.status, 201); cliente = r.body; clientes.push(cliente.id); entrada.cliente_id = String(cliente.id);
    assert.equal(cliente.fecha_nacimiento, nacimiento); assert.equal(cliente.familia, null);
    assert.equal(cliente.provincia, 'Córdoba'); assert.equal(cliente.localidad, 'Villa María');
    assert.equal(cliente.nombres, 'MARÍA JOSÉ'); assert.equal(cliente.apellidos, 'PÉREZ MUÑOZ');
    const otro = await api(`clientes/busqueda/${dni}`, undefined, 'GET', 1);
    assert.equal(otro.body.autorizado, false); assert.equal(otro.body.cliente, undefined); assert.ok(otro.body.asesor); assert.ok(otro.body.registrado_at);
    assert.equal((await api(`clientes/${cliente.id}`, undefined, 'GET', 1)).status, 404);
    assert.equal((await api('clientes', undefined, 'GET', 1)).body.clientes.length, 0);
    assert.equal((await api('clientes', { dni, nombres: 'Duplicado', apellidos: 'Test', email: 'duplicado@example.test', fecha_nacimiento: nacimiento }, 'POST', 1)).status, 409);
    const body = { dni, nombres: 'juan carlos', apellidos: 'pérez gómez', fecha_nacimiento: nacimiento, revision: cliente.revision };
    const actualizado = await api(`clientes/${cliente.id}`, body, 'PUT');
    assert.equal(actualizado.status, 200);
    assert.equal(actualizado.body.nombres, 'JUAN CARLOS'); assert.equal(actualizado.body.apellidos, 'PÉREZ GÓMEZ');
    const [[persistido]] = await pool.execute('SELECT nombres,apellidos FROM clientes WHERE id=?', [cliente.id]);
    assert.equal(persistido.nombres, 'JUAN CARLOS'); assert.equal(persistido.apellidos, 'PÉREZ GÓMEZ');
    assert.equal((await api(`clientes/${cliente.id}`, body, 'PUT')).status, 409);
  });
  await t.test('cliente anterior sin fecha permanece editable y conserva familia histórica', async () => {
    const dni = String(randomInt(10_000_000, 99_999_999));
    const [insertado] = await pool.execute('INSERT INTO clientes (dni,nombres,apellidos,familia,asesor_legajo) VALUES (?,?,?,?,?)',
      [dni, 'Anterior', 'Prueba', JSON.stringify(entrada.familia), owned[0]]);
    const editado = await api(`clientes/${insertado.insertId}`, { dni, nombres: 'Anterior editado', apellidos: 'Prueba', revision: 1 }, 'PUT');
    assert.equal(editado.status, 200); assert.equal(editado.body.fecha_nacimiento, null);
    assert.deepEqual(editado.body.familia, entrada.familia);
    assert.equal((await api('clientes', { dni: String(randomInt(10_000_000, 99_999_999)), nombres: 'Sin fecha', apellidos: 'Prueba' })).status, 400);
  });
  await t.test('vista previa real conserva propiedad y no persiste cotizaciones ni auditorías', async () => {
    const [[antes]] = await pool.query('SELECT (SELECT COUNT(*) FROM cotizaciones) AS cotizaciones, (SELECT COUNT(*) FROM asesor_auditoria) AS auditorias');
    const preview = await api('cotizaciones/previsualizacion', entrada);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.match(preview.body.resultado.total, /^\d+\.\d{2}$/);
    assert.equal((await api('cotizaciones/previsualizacion', entrada, 'POST', 1)).status, 404);
    assert.equal((await api('cotizaciones/previsualizacion', { ...entrada, total: '1.00' })).status, 400);
    const [[despues]] = await pool.query('SELECT (SELECT COUNT(*) FROM cotizaciones) AS cotizaciones, (SELECT COUNT(*) FROM asesor_auditoria) AS auditorias');
    assert.deepEqual(despues, antes);
  });
  /** Verifica que el nuevo snapshot capture la identidad normalizada persistida y no la entrada HTTP. */
  await t.test('persistencia de borrador real y relectura desde conexión distinta', async () => {
    const r = await api('cotizaciones', { ...entrada, familia: { ...entrada.familia, titular: { ...entrada.familia.titular, edad: 1 } } }); assert.equal(r.status, 201); q = r.body;
    assert.equal(q.solicitud.entrada.familia.titular.edad, 1);
    assert.equal(q.solicitud.cliente.nombres, 'JUAN CARLOS'); assert.equal(q.solicitud.cliente.apellidos, 'PÉREZ GÓMEZ');
    assert.equal(Number((await pool.execute("SELECT edad FROM miembros_cotizacion WHERE cotizacion_id=? AND parentesco='TITULAR'", [q.id]))[0][0].edad), 1);
    assert.equal(q.estado, 'BORRADOR'); assert.equal(q.resultado, null); assert.equal(q.numero, null); assert.equal(q.vence_at, null);
    const c1 = await pool.getConnection(), c2 = await pool.getConnection();
    try {
      assert.notEqual(c1.threadId, c2.threadId);
      const [[fila]] = await c2.execute('SELECT estado,solicitud FROM cotizaciones WHERE id=?', [q.id]);
      assert.equal(fila.estado, 'BORRADOR');
      assert.equal((await c1.execute('SELECT COUNT(*) AS n FROM miembros_cotizacion WHERE cotizacion_id=?', [q.id]))[0][0].n, 2);
    } finally { c1.release(); c2.release(); }
    const observation = evidence('ESC-03');
    const before = await quotationSnapshot(pool, observation, q.id, 'antes');
    const calculation = await api(`cotizaciones/${q.id}/calculo`, {});
    assert.equal(calculation.status, 200);
    for (const [route, body, method] of [
      [`cotizaciones/${q.id}`, undefined, 'GET'],
      [`cotizaciones/${q.id}`, { ...entrada, revision: q.revision }, 'PUT'],
      [`cotizaciones/${q.id}/contacto`, { revision: q.revision, contacto: { telefono: '3333333' } }, 'PATCH'],
      [`cotizaciones/${q.id}/calculo`, {}, 'POST'],
      [`cotizaciones/${q.id}/emision`, { revision: calculation.body.revision, huella: calculation.body.huella }, 'POST'],
    ]) {
      const denied = observation.http(method, `/api/asesor/${route}`, body, await api(route, body, method, 1));
      assert.equal(denied.status, 404);
      assert.equal(denied.body.error.code, 'ASESOR_NO_ENCONTRADO');
    }
    assert.deepEqual(await quotationSnapshot(pool, observation, q.id, 'despues'), before);
    observation.accepted('Otro ASESOR no consulta, edita, calcula ni emite; cotización, miembros y auditoría permanecen idénticos.');
    assert.equal((await api('cotizaciones', entrada, 'POST', 1)).status, 404);
    assert.equal((await api('cotizaciones', { ...entrada, total: '123.45' })).status, 400);
    assert.equal((await api('cotizaciones', { ...entrada, condiciones: { ...entrada.condiciones, tramos: [{ porcentaje_id: '999999999', meses: 3 }] } })).status, 422);
    await assert.rejects(pool.execute("UPDATE cotizaciones SET estado='EMITIDA' WHERE id=?", [q.id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    // NULL no debe eludir la guardia SQL de emisión: ambos intentos fallan sin alterar el borrador.
    await assert.rejects(pool.execute("UPDATE cotizaciones SET estado='EMITIDA',numero=?,resultado=JSON_OBJECT(),emitida_at=UTC_TIMESTAMP(6) WHERE id=?", [`prueba-${sufijo}`, q.id]), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' });
    assert.equal((await api(`cotizaciones/${q.id}`, undefined, 'GET')).body.estado, 'BORRADOR');
  });
  await t.test('cálculo y emisión HTTP reales, huella, vigencia, PDF y protección de resultados', async () => {
    const actualizado = await api(`cotizaciones/${q.id}`, { ...entrada, modalidad: 'Obligatorio', aportes: { sueldo_bruto: '100000.00' }, revision: q.revision }, 'PUT');
    assert.equal(actualizado.status, 200); q = actualizado.body;
    const calculo = await api(`cotizaciones/${q.id}/calculo`, {});
    assert.equal(calculo.status, 200, JSON.stringify(calculo.body));
    assert.match(calculo.body.resultado.total, /^\d+\.\d{2}$/);
    assert.equal((await api(`cotizaciones/${q.id}/emision`, {})).status, 400);
    assert.equal((await api(`cotizaciones/${q.id}/emision`, { total: '1.00' })).status, 400);
    assert.equal((await api(`cotizaciones/${q.id}/pdf`, undefined, 'GET')).status, 409);
    const confirmacion = { revision: calculo.body.revision, huella: calculo.body.huella };
    assert.equal((await api(`cotizaciones/${q.id}/emision`, { ...confirmacion, huella: '0'.repeat(64) })).status, 409);
    const observation = evidence('ESC-05');
    await quotationSnapshot(pool, observation, q.id, 'antes');
    const emitida = observation.http('POST', `/api/asesor/cotizaciones/${q.id}/emision`, confirmacion,
      await api(`cotizaciones/${q.id}/emision`, confirmacion));
    assert.equal(emitida.status, 200, JSON.stringify(emitida.body)); q = emitida.body;
    assert.equal(q.estado, 'EMITIDA'); assert.ok(q.numero); assert.deepEqual(q.resultado, calculo.body.resultado);
    assert.equal(new Date(q.vence_at) - new Date(q.emitida_at), 15 * 86400000);
    const first = await quotationSnapshot(pool, observation, q.id, 'primera-emision');
    const reintento = observation.http('POST', `/api/asesor/cotizaciones/${q.id}/emision`, confirmacion,
      await api(`cotizaciones/${q.id}/emision`, confirmacion));
    assert.equal(reintento.status, 200); assert.equal(reintento.body.numero, q.numero); assert.equal(reintento.body.revision, q.revision);
    assert.deepEqual(await quotationSnapshot(pool, observation, q.id, 'reintento'), first);
    const [count] = await observation.sql(pool, 'reintento', "SELECT COUNT(*) AS total FROM asesor_auditoria WHERE cotizacion_id=? AND evento='COTIZACION_EMITIDA'", [q.id]);
    assert.equal(Number(count.total), 1);
    observation.accepted('La segunda emisión conserva toda la fila, número y revisión; exactamente un evento COTIZACION_EMITIDA.');
    const pdf = await request(`/api/asesor/cotizaciones/${q.id}/pdf`, { headers: { cookie: cookies[0] }, responseType: 'buffer' });
    assert.equal(pdf.status, 200); assert.match(pdf.headers['content-type'], /application\/pdf/);
    assert.equal((await api(`cotizaciones/${q.id}`, { ...entrada, revision: q.revision }, 'PUT')).status, 409);
    const mono = await api('cotizaciones', { ...entrada, modalidad: 'Monotributo', aportes: { categoria: 'A', adherentes: 1 } });
    assert.equal(mono.status, 201); assert.equal(mono.body.solicitud.entrada.modalidad, 'Monotributo');
  });
  /** Filtra por la identidad del snapshot del fixture actual, sin depender de apellidos de versiones anteriores del test. */
  await t.test('contacto conserva snapshot, recotización conserva origen e historial', async () => {
    const detalle = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    const r = await api(`cotizaciones/${q.id}/contacto`, { revision: detalle.revision, contacto: { email: `corregido-${sufijo}@example.test` } }, 'PATCH');
    assert.equal(r.status, 200); assert.deepEqual(r.body.solicitud, detalle.solicitud); assert.deepEqual(r.body.resultado, detalle.resultado); assert.equal(r.body.numero, detalle.numero);
    assert.equal((await api(`cotizaciones/${q.id}/contacto`, { revision: detalle.revision, contacto: {} }, 'PATCH')).status, 409);
    assert.equal((await api(`cotizaciones/${q.id}/contacto`, { revision: r.body.revision, contacto: { plan_id: '2' } }, 'PATCH')).status, 400);
    const rec = await api(`cotizaciones/${q.id}/recotizaciones`, entrada); assert.equal(rec.status, 201); assert.equal(String(rec.body.origen_id), String(q.id));
    const original = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    assert.deepEqual(original.solicitud, detalle.solicitud); assert.equal(original.recotizaciones.length, 1);
    const porNumero = await api(`cotizaciones?cliente=${encodeURIComponent(original.numero)}&plan=${entrada.plan_id}`, undefined, 'GET');
    assert.equal(porNumero.status, 200); assert.equal(porNumero.body.cotizaciones.length, 1);
    assert.equal(porNumero.body.cotizaciones[0].total, original.resultado.total);
    assert.equal((await api('cotizaciones?estado=BORRADOR', undefined, 'GET')).body.cotizaciones.length, 2);
    const apellido = encodeURIComponent(original.solicitud.cliente.apellidos);
    assert.equal((await api(`cotizaciones?cliente=${apellido}`, undefined, 'GET')).body.cotizaciones.length, 3);
    const sinApellido = await api(`cotizaciones?cliente=${encodeURIComponent('MUÑOZ')}`, undefined, 'GET');
    assert.equal(sinApellido.status, 200); assert.equal(sinApellido.body.cotizaciones.length, 0);
    assert.equal((await api('cotizaciones?cliente=SinCoincidenciasSPEC21', undefined, 'GET')).body.cotizaciones.length, 0);
    assert.equal((await api('cotizaciones', undefined, 'GET', 1)).body.cotizaciones.length, 0);
    q = original;
  });
  await t.test('dos ediciones concurrentes no sobrescriben una revisión confirmada', async () => {
    const observation = evidence('ESC-04');
    const before = await quotationSnapshot(pool, observation, q.id, 'antes');
    const revision = q.revision;
    const bodies = ['1111111', '2222222'].map(telefono => ({ revision, contacto: { telefono } }));
    const resultados = await Promise.all(bodies.map(async body => observation.http('PATCH', `/api/asesor/cotizaciones/${q.id}/contacto`, body,
      await api(`cotizaciones/${q.id}/contacto`, body, 'PATCH'))));
    assert.deepEqual(resultados.map(r => r.status).sort(), [200, 409]);
    assert.equal(resultados.find(r => r.status === 409).body.error.code, 'ASESOR_CONCURRENCIA');
    q = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    assert.equal(q.revision, revision + 1);
    const after = await quotationSnapshot(pool, observation, q.id, 'despues');
    const winner = bodies[resultados.findIndex(r => r.status === 200)].contacto;
    const persistedContact = after.cotizaciones[0].contacto;
    assert.deepEqual(typeof persistedContact === 'string' ? JSON.parse(persistedContact) : persistedContact, { email: null, direccion: null, ...winner });
    assert.equal(after.cotizaciones[0].revision, revision + 1);
    assert.equal(after.auditoria.length, before.auditoria.length + 1);
    assert.equal(after.auditoria.at(-1).evento, 'CONTACTO_EDITADO');
    assert.deepEqual(after.miembros, before.miembros);
    observation.accepted('Una respuesta 200 y otra 409; MySQL conserva el contacto ganador, una revisión y una sola auditoría adicional.');
  });
  await t.test('cambio de nacimiento no recalcula emisión ni reemplaza la edad declarada de recotización', async () => {
    const emitida = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    const personal = (await api(`clientes/${cliente.id}`, undefined, 'GET')).body;
    const fechaCorregida = `${new Date().getUTCFullYear() - 28}-01-01`;
    const camposCliente = { dni: personal.dni, nombres: personal.nombres, apellidos: personal.apellidos, fecha_nacimiento: fechaCorregida, revision: personal.revision };
    assert.equal((await api(`clientes/${cliente.id}`, camposCliente, 'PUT')).status, 200);
    const historica = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    assert.deepEqual(historica.solicitud, emitida.solicitud); assert.deepEqual(historica.resultado, emitida.resultado);
    const nueva = await api(`cotizaciones/${q.id}/recotizaciones`, entrada);
    assert.equal(nueva.status, 201); assert.equal(nueva.body.solicitud.entrada.familia.titular.edad, entrada.familia.titular.edad);
    assert.equal(Number((await pool.execute("SELECT edad FROM miembros_cotizacion WHERE cotizacion_id=? AND parentesco='TITULAR'", [q.id]))[0][0].edad), emitida.solicitud.entrada.familia.titular.edad);
  });
  await t.test('anulación lógica, auditoría y revisión no permiten posteriores ediciones', async () => {
    const r = await api(`cotizaciones/${q.id}/anulacion`, { revision: q.revision, motivo: 'Cancelación de prueba' });
    assert.equal(r.status, 200); assert.equal(r.body.estado, 'ANULADA');
    assert.equal((await api(`cotizaciones/${q.id}/contacto`, { revision: r.body.revision, contacto: {} }, 'PATCH')).status, 409);
    assert.equal((await api(`cotizaciones/${q.id}`, { ...entrada, revision: r.body.revision }, 'PUT')).status, 409);
    assert.equal((await api(`cotizaciones/${q.id}/recotizaciones`, entrada)).status, 409);
    const d = (await api(`cotizaciones/${q.id}`, undefined, 'GET')).body;
    assert.ok(d.eventos.some(e => e.evento === 'COTIZACION_ANULADA')); assert.deepEqual(d.solicitud, q.solicitud);
  });
  await t.test('tres modalidades reales, categoría informativa y equivalencia bruto/recibo con grupo familiar', async () => {
    const condiciones = (await api('condiciones', undefined, 'GET')).body;
    assert.equal(Number(condiciones.politica.aporte_adherente), 23892);
    assert.equal(Number(condiciones.politica.iva_voluntario_pct), 10.5);
    const mono = [], emitidasMono = [];
    for (const categoria of ['A', 'K']) {
      const borrador = await api('cotizaciones', { ...entrada, modalidad: 'Monotributo', aportes: { categoria, adherentes: 1 } });
      assert.equal(borrador.status, 201);
      const calculo = await api(`cotizaciones/${borrador.body.id}/calculo`, {});
      assert.equal(calculo.status, 200, JSON.stringify(calculo.body)); mono.push(calculo.body.resultado);
      const emitida = await api(`cotizaciones/${borrador.body.id}/emision`, { revision: calculo.body.revision, huella: calculo.body.huella });
      assert.equal(emitida.status, 200); assert.equal(emitida.body.solicitud.entrada.aportes.categoria, categoria);
      assert.equal(emitida.body.resultado.integrantes.length, 2); emitidasMono.push(emitida.body);
    }
    assert.deepEqual(mono[0], mono[1]);
    const nueva = await api(`cotizaciones/${emitidasMono[0].id}/recotizaciones`, { ...entrada, modalidad: 'Monotributo', aportes: { categoria: 'K', adherentes: 0 } });
    assert.equal(nueva.status, 201);
    const recalculo = await api(`cotizaciones/${nueva.body.id}/calculo`, {});
    const recotizada = await api(`cotizaciones/${nueva.body.id}/emision`, { revision: recalculo.body.revision, huella: recalculo.body.huella });
    assert.equal(recotizada.status, 200); assert.equal(String(recotizada.body.origen_id), String(emitidasMono[0].id));
    assert.notEqual(recotizada.body.numero, emitidasMono[0].numero); assert.notEqual(recotizada.body.resultado.total, emitidasMono[0].resultado.total);
    const anterior = await api(`cotizaciones/${emitidasMono[0].id}`, undefined, 'GET');
    assert.deepEqual(anterior.body.resultado, emitidasMono[0].resultado); assert.equal(anterior.body.numero, emitidasMono[0].numero);

    assert.equal(mono[0].aportes[0].importe, '23892.00'); assert.equal(mono[0].aportes[1].importe, '23892.00');
    const voluntario = await api('cotizaciones', entrada);
    const calculoVol = await api(`cotizaciones/${voluntario.body.id}/calculo`, {});
    assert.equal(calculoVol.status, 200); assert.equal(calculoVol.body.resultado.impuestos[0].porcentaje, '10.50');
    const resultados = [];
    for (const aportes of [{ sueldo_bruto: '1000000.00' }, { opcion_aporte: 'PERSONAL_RECIBO', aporte_personal: '30000.00' }]) {
      const borrador = await api('cotizaciones', { ...entrada, modalidad: 'Obligatorio', aportes });
      const calculo = await api(`cotizaciones/${borrador.body.id}/calculo`, {});
      assert.equal(calculo.status, 200); resultados.push(calculo.body.resultado);
    }
    assert.deepEqual(resultados[0], resultados[1]);
  });
  await t.test('fallo de auditoría de emisión revierte número, estado y snapshot conjuntamente', async () => {
    const observation = evidence('ESC-06');
    const borrador = await api('cotizaciones', { ...entrada, modalidad: 'Obligatorio', aportes: { sueldo_bruto: '1000000.00' } });
    const calculo = await api(`cotizaciones/${borrador.body.id}/calculo`, {});
    assert.equal(borrador.status, 201); assert.equal(calculo.status, 200);
    observation.http('POST', '/api/asesor/cotizaciones', { ...entrada, modalidad: 'Obligatorio', aportes: { sueldo_bruto: '1000000.00' } }, borrador);
    observation.http('POST', `/api/asesor/cotizaciones/${borrador.body.id}/calculo`, {}, calculo);
    const before = await quotationSnapshot(pool, observation, borrador.body.id, 'antes');
    const c = await pool.getConnection();
    let updated = false, failedAudit = false;
    const fachada = { query: c.query.bind(c), beginTransaction: c.beginTransaction.bind(c), commit: c.commit.bind(c), rollback: c.rollback.bind(c), release() {},
      /** Falla después del UPDATE de emisión; el rollback debe conservar el borrador íntegro. */
      async execute(sql, valores) {
        if (sql.includes('INSERT INTO asesor_auditoria')) {
          assert.equal(updated, true); failedAudit = true;
          observation.record('fault', { operation: 'emitirPreparacion', cotizacion_id: borrador.body.id, afterUpdate: updated, error: 'Fallo de auditoría de emisión' });
          throw new Error('Fallo de auditoría de emisión');
        }
        const result = await c.execute(sql, valores);
        if (sql.includes("SET estado='EMITIDA'")) { assert.equal(result[0].affectedRows, 1); updated = true; }
        return result;
      } };
    try {
      await assert.rejects(emitirPreparacion({ getConnection: async () => fachada }, owned[0], borrador.body.id, { revision: calculo.body.revision, huella: calculo.body.huella }), /Fallo de auditoría de emisión/);
      const detalle = (await api(`cotizaciones/${borrador.body.id}`, undefined, 'GET')).body;
      assert.equal(detalle.estado, 'BORRADOR'); assert.equal(detalle.numero, null); assert.equal(detalle.resultado, null); assert.equal(detalle.emitida_at, null);
      assert.equal(detalle.revision, borrador.body.revision); assert.ok(!detalle.eventos.some(e => e.evento === 'COTIZACION_EMITIDA'));
      assert.equal(failedAudit, true);
      assert.deepEqual(await quotationSnapshot(pool, observation, borrador.body.id, 'despues'), before);
      observation.accepted('Fallo inyectado después de UPDATE efectivo y antes de auditoría; todas las columnas, miembros y auditoría coinciden antes/después desde otra conexión.');
    } finally { c.release(); }
  });
  await t.test('fallo de auditoría revierte alta de cliente sin residuo', async () => {
    const dni = String(randomInt(10_000_000, 99_999_999));
    const c = await pool.getConnection();
    // La fachada falla solo en la auditoría de esta operación de prueba; no altera el esquema.
    const fachada = { query: c.query.bind(c), beginTransaction: c.beginTransaction.bind(c), commit: c.commit.bind(c), rollback: c.rollback.bind(c), release() {},
      /** Inyecta fallo antes de escribir auditoría y conserva las demás operaciones reales. */
      execute(sql, values) { if (sql.includes('INSERT INTO asesor_auditoria')) throw new Error('Fallo de auditoría de prueba'); return c.execute(sql, values); } };
    try {
      await assert.rejects(guardarCliente({ getConnection: async () => fachada }, owned[0], { dni, nombres: 'Rollback', apellidos: 'Test', email: 'rollback@example.test', fecha_nacimiento: nacimiento }), /Fallo de auditoría/);
      assert.equal((await c.execute('SELECT COUNT(*) AS n FROM clientes WHERE dni=?', [dni]))[0][0].n, 0);
    } finally { c.release(); }
  });
  await t.test('asesor desactivado no consulta ni modifica recursos con su cookie anterior', async () => {
    const observation = evidence('ESC-01');
    const createdClient = await api('clientes', { dni: String(randomInt(10_000_000, 99_999_999)), nombres: 'Control', apellidos: 'Revocación', email: `revocacion-${sufijo}@example.test`, fecha_nacimiento: nacimiento }, 'POST', 1);
    assert.equal(createdClient.status, 201);
    const draft = await api('cotizaciones', { ...entrada, cliente_id: String(createdClient.body.id) }, 'POST', 1);
    assert.equal(draft.status, 201);
    const route = `cotizaciones/${draft.body.id}`;
    assert.equal(observation.http('GET', `/api/asesor/${route}`, undefined, await api(route, undefined, 'GET', 1)).status, 200);
    const before = await quotationSnapshot(pool, observation, draft.body.id, 'antes');
    const sessions = phase => observation.sql(pool, phase, 'SELECT legajo, issued_at, expires_at, revoked_at, revocation_reason FROM auth_sesiones WHERE legajo=? ORDER BY issued_at, jti', [owned[1]]);
    assert.ok((await sessions('antes')).some(row => row.revoked_at === null));
    const path = `/api/admin/employees/${owned[1]}/estado`;
    const disabled = observation.http('PATCH', path, { estado: 'INACTIVO' }, await request(path, {
      method: 'PATCH', body: JSON.stringify({ estado: 'INACTIVO' }), headers: { origin: 'http://localhost:5173', cookie: cookies[2] },
    }));
    assert.equal(disabled.status, 200);
    for (const [method, suffix, body] of [['GET', '', undefined], ['PATCH', '/contacto', { revision: draft.body.revision, contacto: { telefono: '4444444' } }]]) {
      const denied = observation.http(method, `/api/asesor/${route}${suffix}`, body, await api(route + suffix, body, method, 1));
      assert.equal(denied.status, 401); assert.equal(denied.body.error.code, 'SESSION_INVALID');
    }
    assert.deepEqual(await quotationSnapshot(pool, observation, draft.body.id, 'despues'), before);
    const finalSessions = await sessions('despues');
    assert.ok(finalSessions.length > 0);
    assert.ok(finalSessions.every(row => row.revoked_at !== null && row.revocation_reason === 'ACCOUNT_DISABLED'));
    const [employee] = await observation.sql(pool, 'despues', 'SELECT legajo, rol, estado FROM empleados WHERE legajo=?', [owned[1]]);
    assert.equal(employee.estado, 'INACTIVO');
    observation.accepted('Una cookie antes válida recibe 401 en lectura y escritura; sesión ACCOUNT_DISABLED y cotización, miembros y auditoría sin cambios.');
  });
});

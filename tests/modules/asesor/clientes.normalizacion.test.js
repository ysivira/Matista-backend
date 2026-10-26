import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../../src/app.js';
import { validarCliente } from '../../../src/modules/asesor/asesor.validation.js';
import { guardarCliente, obtenerCliente } from '../../../src/modules/asesor/clientes.service.js';
import { guardarPreparacion, calcularPreparacion, emitirPreparacion, consultarHistorial } from '../../../src/modules/asesor/cotizaciones.service.js';
import { cotizacionHtml, cotizacionPdf } from '../../../src/modules/asesor/documentos.js';
import { memoryContext, fixtureSession, localEnv } from '../../auth/fixtures.js';
import { startTestServer } from '../../helpers/http.js';
import { solicitudMonotributo } from '../../helpers/monotributo.js';
import { casosDocumentosPdf } from '../../helpers/pdf.fixtures.js';

const entradaCliente = { dni: '12345678', nombres: 'maría josé', apellidos: 'pérez muñoz', email: 'Maria.Jose@example.test',
  telefono: '+54 000', direccion: 'Calle Álamo', provincia: 'Córdoba', localidad: 'Villa María' };

for (const [nombre, esperado] of [['juan carlos', 'JUAN CARLOS'], ['maría josé', 'MARÍA JOSÉ'], ['muñoz', 'MUÑOZ'],
  ["ana-maría d'angelo", "ANA-MARÍA D'ANGELO"], ['MARÍA', 'MARÍA']]) {
  /** Comprueba Unicode, nombres compuestos y caracteres ya admitidos sin ampliar la validación. */
  test(`SPEC20 normaliza nombre y apellido: ${nombre}`, () => {
    const datos = { ...entradaCliente, nombres: nombre, apellidos: nombre };
    const antes = structuredClone(datos), validado = validarCliente(datos);
    assert.equal(validado.nombres, esperado); assert.equal(validado.apellidos, esperado);
    assert.deepEqual(datos, antes);
    for (const campo of ['dni', 'email', 'telefono', 'direccion', 'provincia', 'localidad']) assert.equal(validado[campo], datos[campo]);
  });
}

/** La conversión nunca convierte números/objetos a texto ni sustituye obligatoriedad o longitud. */
test('SPEC20 rechaza identidad inválida antes de abrir conexión y controla expansión Unicode', async () => {
  const pool = { /** Cualquier intento de abrir conexión con entrada inválida es un fallo. */
    getConnection() { assert.fail('No debe persistir entrada inválida'); } };
  for (const campo of ['nombres', 'apellidos']) {
    for (const valor of [null, undefined, '', '  ', 123, {}, [], 'a'.repeat(101), 'ß'.repeat(51)]) {
      await assert.rejects(guardarCliente(pool, '12345678', { ...entradaCliente, [campo]: valor }), { code: 'ASESOR_VALIDACION' });
    }
  }
  assert.equal(validarCliente({ ...entradaCliente, nombres: ' á '.trim() }).nombres, 'Á');
});

/**
 * Reutiliza servicios/repositorios reales sobre SQL doble estricto y datos sintéticos.
 * @returns {object} Pool sin sockets, estado observable y cotización histórica independiente.
 * No valida restricciones MySQL: cualquier SQL no contemplado falla, nunca llega a una base.
 */
function entornoClientes() {
  const base = solicitudMonotributo(), historica = { ...casosDocumentosPdf()[0].datos, id: '90', cliente_id: '1', asesor_legajo: '12345678' };
  const estado = { clientes: [], cotizaciones: [historica], auditorias: [], consultas: [] };
  let respaldo;
  const columnas = ['dni', 'nombres', 'apellidos', 'email', 'telefono', 'direccion', 'fecha_nacimiento', 'provincia', 'localidad', 'asesor_legajo'];
  /** Interpreta solo las sentencias de los caminos ejercitados, conservando JSON y parámetros. */
  async function ejecutar(sql, valores = []) {
    const s = sql.replace(/\s+/g, ' ').trim(); estado.consultas.push(s);
    if (s.startsWith('SET time_zone')) return [[]];
    if (s.startsWith('INSERT INTO clientes')) {
      const fila = Object.fromEntries(columnas.map((campo, indice) => [campo, valores[indice]]));
      fila.id = String(estado.clientes.length + 1); fila.revision = 0; fila.familia = null;
      estado.clientes.push(fila); return [{ insertId: fila.id }];
    }
    if (s.startsWith('UPDATE clientes SET')) {
      const fila = estado.clientes.find(c => c.id === valores[8] && c.asesor_legajo === valores[9]);
      assert.ok(fila);
      columnas.slice(1, 9).forEach((campo, indice) => { fila[campo] = valores[indice]; });
      fila.revision++; return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT clientes.*')) return [structuredClone(estado.clientes.filter(c => c.id === valores[0] && c.asesor_legajo === valores[1]))];
    if (s.startsWith('INSERT INTO asesor_auditoria')) { estado.auditorias.push(structuredClone(valores)); return [{}]; }
    if (s.includes('FROM politica_comercial')) return [s.includes("'PROGRAMADA'") ? [] : [base.catalogo.politica]];
    if (s.includes('FROM tarifario_versiones')) return [[{ id: '8', estado: 'ACTIVA' }]];
    if (s.includes('FROM porcentajes_comerciales')) return [base.catalogo.porcentajes];
    if (s.includes('FROM tarifas')) return [base.catalogo.tarifas];
    if (s.includes('FROM planes')) return [[{ ...base.plan, activa: 1, detalles: 'Prestaciones sintéticas' }]];
    if (s.includes('FROM empleados')) return [[base.asesor]];
    if (s.startsWith('INSERT INTO cotizaciones')) {
      estado.cotizaciones.push({ id: '91', cliente_id: valores[5], asesor_legajo: valores[6], solicitud: JSON.parse(valores[4]),
        contacto: JSON.parse(valores[7]), resultado: null, revision: 0, estado: 'BORRADOR', modalidad: valores[1] });
      return [{ insertId: 91 }];
    }
    if (s.startsWith('INSERT INTO miembros_cotizacion') || s.startsWith('UPDATE miembros_cotizacion')) return [{}];
    if (s.startsWith('UPDATE cotizaciones SET estado=')) {
      const fila = estado.cotizaciones.find(q => q.id === valores[4]);
      Object.assign(fila, { solicitud: JSON.parse(valores[2]), resultado: JSON.parse(valores[3]), estado: 'EMITIDA', numero: 'MAT-91',
        emitida_at: '2026-10-26T15:00:00Z', vence_at: '2026-11-10T15:00:00Z', revision: 1 });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('SELECT * FROM cotizaciones')) return [structuredClone(estado.cotizaciones.filter(q => q.id === valores[0] && q.asesor_legajo === valores[1]))];
    if (s.startsWith('SELECT q.id')) {
      assert.match(s, /JSON_EXTRACT\(q.solicitud,'\$\.cliente.nombres'\)/);
      return [estado.cotizaciones.map(q => ({ id: q.id, nombres: q.solicitud.cliente.nombres, apellidos: q.solicitud.cliente.apellidos, aportes: '[]' }))];
    }
    assert.fail(`SQL no previsto en el doble: ${s}`);
  }
  const conexion = { query: ejecutar, execute: ejecutar,
    /** Conserva una copia para comprobar rollback del servicio, sin motor real. */
    async beginTransaction() { respaldo = structuredClone(estado); },
    /** Confirma únicamente el estado en memoria del doble. */
    async commit() { respaldo = null; },
    /** Restaura exclusivamente el doble si el servicio propaga un error. */
    async rollback() { if (respaldo) Object.assign(estado, respaldo); },
    /** No mantiene conexiones ni recursos externos. */
    release() {} };
  return { estado, historica, entrada: base.entrada, pool: {
    /** Entrega la única conexión de SQL simulado; no crea mysql2 pools. */
    async getConnection() { return conexion; } } };
}

/** Prueba POST/PUT directos, validación y autorización con HTTP real y persistencia simulada explícita. */
test('SPEC20 API directa normaliza alta/edición y conserva contacto, propietario, revisión e historia', async t => {
  const fixture = memoryContext(), sesion = await fixtureSession(fixture), entorno = entornoClientes();
  fixture.context.pool = entorno.pool;
  const request = await startTestServer(t, createApp({ env: localEnv, authContext: fixture.context }));
  const headers = { origin: localEnv.FRONTEND_ORIGIN, cookie: `matista_session=${sesion.token}` };
  const antes = structuredClone(entorno.historica);
  const creado = await request('/api/asesor/clientes', { method: 'POST', headers, body: JSON.stringify(entradaCliente) });
  assert.equal(creado.status, 201); assert.equal(creado.body.nombres, 'MARÍA JOSÉ'); assert.equal(creado.body.apellidos, 'PÉREZ MUÑOZ');
  const datos = { ...entradaCliente, nombres: 'juan carlos', apellidos: 'pérez gómez', revision: 0 };
  const editado = await request('/api/asesor/clientes/1', { method: 'PUT', headers, body: JSON.stringify(datos) });
  assert.equal(editado.status, 200); assert.equal(editado.body.nombres, 'JUAN CARLOS'); assert.equal(editado.body.apellidos, 'PÉREZ GÓMEZ');
  for (const campo of ['dni', 'email', 'telefono', 'direccion', 'provincia', 'localidad']) assert.equal(editado.body[campo], entradaCliente[campo]);
  assert.equal(editado.body.revision, 1); assert.equal(editado.body.asesor_legajo, '12345678');
  assert.equal((await obtenerCliente(entorno.pool, '12345678', '1')).nombres, 'JUAN CARLOS');
  await assert.rejects(obtenerCliente(entorno.pool, 'otro', '1'), { code: 'ASESOR_NO_ENCONTRADO' });
  const invalido = await request('/api/asesor/clientes', { method: 'POST', headers, body: JSON.stringify({ ...entradaCliente, nombres: 123 }) });
  assert.equal(invalido.status, 400);
  const conflicto = await request('/api/asesor/clientes/1', { method: 'PUT', headers, body: JSON.stringify(datos) });
  assert.equal(conflicto.status, 409);
  assert.deepEqual(entorno.estado.cotizaciones[0], antes);
  assert.equal(entorno.estado.auditorias.length, 2);
  assert.equal(JSON.parse(entorno.estado.auditorias[1][5]).nombres, 'JUAN CARLOS');
});

/** Guardado explícito alimenta nuevas emisiones; lecturas, PDF e historial no reescriben snapshots previos. */
test('SPEC20 nueva cotización/emisión usa nombres persistidos y mantiene historia anterior', async t => {
  const entorno = entornoClientes(), actor = '12345678';
  const antes = structuredClone(entorno.historica), htmlAnterior = await cotizacionHtml(antes);
  await guardarCliente(entorno.pool, actor, entradaCliente);
  // Un cliente legado consultado sin editar no se convierte ni se persiste por leerlo.
  entorno.estado.clientes.push({ id: '2', asesor_legajo: actor, nombres: 'Legado', apellidos: 'Sin editar', familia: null });
  assert.equal((await obtenerCliente(entorno.pool, actor, '2')).nombres, 'Legado');
  const borrador = await guardarPreparacion(entorno.pool, actor, entorno.entrada);
  assert.equal(borrador.solicitud.cliente.nombres, 'MARÍA JOSÉ');
  const calculo = await calcularPreparacion(entorno.pool, actor, borrador.id);
  const emitida = await emitirPreparacion(entorno.pool, actor, borrador.id, { revision: calculo.revision, huella: calculo.huella });
  assert.equal(emitida.solicitud.cliente.apellidos, 'PÉREZ MUÑOZ');
  assert.match(await cotizacionHtml(emitida), /MARÍA JOSÉ PÉREZ MUÑOZ/);
  const historial = await consultarHistorial(entorno.pool, actor, {});
  assert.equal(historial.cotizaciones.find(q => q.id === '91').nombres, 'MARÍA JOSÉ');
  assert.equal(historial.cotizaciones.find(q => q.id === '90').nombres, antes.solicitud.cliente.nombres);
  assert.deepEqual(entorno.estado.cotizaciones[0], antes);
  assert.equal(await cotizacionHtml(entorno.estado.cotizaciones[0]), htmlAnterior);
  /** Imprime y extrae texto con Chrome real, sin confundirlo con persistencia MySQL. */
  await t.test('SPEC20 PDF nuevo conserva mayúsculas y PDF histórico conserva texto original', { skip: process.env.RUN_PDF_TESTS !== '1' }, async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'spec20-pdf-'));
    try {
      for (const [nombre, q, texto] of [['nuevo', emitida, 'MARÍA JOSÉ PÉREZ MUÑOZ'], ['anterior', antes, 'Titular Prueba']]) {
        const archivo = path.join(tmp, `${nombre}.pdf`);
        await writeFile(archivo, await cotizacionPdf(q));
        assert.ok(execFileSync('pdftotext', ['-layout', archivo, '-'], { encoding: 'utf8' }).includes(texto));
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  });
});

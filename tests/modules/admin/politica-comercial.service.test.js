import assert from 'node:assert/strict';
import test from 'node:test';

import {
  activarPoliticasProgramadas,
  actualizarPoliticaComercial,
  cancelarProgramacionPoliticaComercial,
  listarEventosPoliticaComercial,
  listarHistorialPoliticaComercial,
  obtenerDetallePoliticaComercial,
  obtenerPoliticaComercial,
  recuperarPoliticaComercial,
} from '../../../src/modules/admin/politica-comercial.service.js';

const ACTOR = Object.freeze({ legajo: '1234567' });
const AHORA = new Date('2026-10-22T12:00:00.000Z');
const FUTURO = '2026-11-01T12:00:00.000Z';

/**
 * Construye una política sintética completa con el nuevo ciclo de vida.
 * @param {number} id Identificador de versión.
 * @param {string} estado Estado del ciclo de vida.
 * @param {object} cambios Sobrescrituras puntuales del fixture.
 * @returns {object} Fila equivalente a politica_comercial con responsable unido.
 */
function crearPolitica(id, estado, cambios = {}) {
  return {
    id,
    estado,
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
    aporte_adherente: null,
    iva_voluntario_pct: null,
    fecha_vigencia: `2026-10-${10 + id} 12:00:00.000000`,
    vigente_hasta: estado === 'HISTORICA' ? `2026-10-${12 + id} 12:00:00.000000` : null,
    cancelada_en: null,
    cancelada_por: null,
    motivo_cancelacion: null,
    actor_legajo: ACTOR.legajo,
    actor_nombre: 'David',
    actor_apellido: 'Diaz',
    created_at: `2026-10-${10 + id} 12:00:00.000000`,
    ...cambios,
  };
}

/**
 * Construye un pool mysql2 en memoria que interpreta el SQL del repositorio.
 * @returns {{pool: object, state: object}} Doble transaccional y estado observable.
 */
function crearPoolPolitica() {
  const state = {
    policies: [
      crearPolitica(1, 'HISTORICA', { joven_porcentaje: '8.00' }),
      crearPolitica(2, 'VIGENTE'),
    ],
    percentages: [
      { id: 1, politica_comercial_id: 1, porcentaje: '7.00', descripcion: null, fecha_vigencia: '2026-10-11', vigente_hasta: '2026-10-12', actor_legajo: ACTOR.legajo, created_at: '2026-10-11' },
      { id: 2, politica_comercial_id: 2, porcentaje: '10.00', descripcion: null, fecha_vigencia: '2026-10-12', vigente_hasta: null, actor_legajo: ACTOR.legajo, created_at: '2026-10-12' },
      { id: 3, politica_comercial_id: 2, porcentaje: '20.00', descripcion: null, fecha_vigencia: '2026-10-12', vigente_hasta: null, actor_legajo: ACTOR.legajo, created_at: '2026-10-12' },
    ],
    events: [],
    sqls: [],
    commits: 0,
    rollbacks: 0,
  };

  /** Busca una política abierta según el estado pedido en el SQL. */
  function buscar(estado) {
    return [state.policies.find((fila) => fila.estado === estado)].filter(Boolean);
  }

  /** Devuelve la identidad del actor tal como vive en empleados. */
  function snapshotActor(legajo) {
    return { legajo, nombre: 'David', apellido: 'Diaz' };
  }

  const connection = {
    /** Simula la inicialización de zona horaria y rechaza SQL no contemplado. */
    async query(sql, params = []) {
      state.sqls.push({ sql, params });
      if (sql.includes('SET time_zone')) return [[], []];
      if (sql.includes('FROM politica_comercial')) {
        if (sql.includes("p.estado = 'VIGENTE'") || sql.includes("p.estado = 'PROGRAMADA'")) {
          const estado = sql.includes("'VIGENTE'") ? 'VIGENTE' : 'PROGRAMADA';
          return [estado === 'VIGENTE' ? buscar(estado) : buscar(estado), []];
        }
        if (sql.includes('WHERE p.id = ?')) {
          return [[state.policies.find((fila) => Number(fila.id) === Number(params[0]))].filter(Boolean), []];
        }
        if (sql.includes('ORDER BY p.created_at DESC')) {
          return [[...state.policies].sort((a, b) => Number(b.id) - Number(a.id)), []];
        }
      }
      if (sql.includes('FROM porcentajes_comerciales')) {
        if (sql.includes('politica_comercial_id IN')) {
          const ids = params.map(Number);
          const filas = state.percentages.filter((fila) => ids.includes(Number(fila.politica_comercial_id)));
          return [[...filas].sort((a, b) => Number(b.porcentaje) - Number(a.porcentaje)), []];
        }
        if (sql.includes('DELETE FROM porcentajes_comerciales')) {
          state.percentages = state.percentages.filter(
            (fila) => Number(fila.politica_comercial_id) !== Number(params[0]),
          );
          return [{ affectedRows: 1 }, []];
        }
      }
      if (sql.includes('FROM politica_comercial_eventos')) {
        const eventoEstado = Number(params[0]);
        return [state.events.filter((evento) => evento.politica_comercial_id === eventoEstado), []];
      }
      throw new Error(`Query no contemplada: ${sql}`);
    },
    /** Interpreta el SQL acotado de escritura del repositorio. */
    async execute(sql, params = []) {
      if (sql.includes('UPDATE porcentajes_comerciales')) {
        const politicaId = Number(params[1]);
        for (const fila of state.percentages) {
          if (fila.politica_comercial_id === politicaId && fila.vigente_hasta === null) {
            fila.vigente_hasta = '2026-10-22 12:00:00.000000';
          }
        }
        return [{ affectedRows: 2 }];
      }
      if (sql.includes('DELETE FROM porcentajes_comerciales')) {
        state.percentages = state.percentages.filter(
          (fila) => Number(fila.politica_comercial_id) !== Number(params[0]),
        );
        return [{ affectedRows: 1 }];
      }
      // El insert de eventos va primero: su tabla incluye 'politica_comercial'.
      if (sql.includes('INSERT INTO politica_comercial_eventos')) {
        const evento = {
          id: state.events.length + 1,
          politica_comercial_id: params[0],
          tipo_evento: params[1],
          actor_legajo: params[2],
          actor_nombre: params[3],
          actor_apellido: params[4],
          detalle: params[5],
          evento_en: '2026-10-22 12:00:00.000000',
        };
        state.events.push(evento);
        return [{ insertId: evento.id }];
      }
      if (sql.includes('INSERT INTO politica_comercial')) {
        const id = Math.max(...state.policies.map((fila) => Number(fila.id))) + 1;
        state.policies.push(crearPolitica(id, params[0], {
          version_base_id: params[1],
          porcentaje_aporte_reconocido: params[2],
          tope_sueldo_bruto: params[3],
          joven_porcentaje: params[4],
          comercial_fijo_max_pct: params[5],
          comercial_fijo_meses_max: params[6],
          comercial_escalonado_max_pct: params[7],
          comercial_escalonado_tramos_max: params[8],
          comercial_escalonado_total_meses_max: params[9],
          primer_tramo_50_meses_max: params[10],
          tdc_pct: params[11],
          tdc_habilitado: params[12],
          tope_comercial_tdc_pct: params[13],
          afinidad_pct: params[14],
          aporte_monotributo: params[15],
          aporte_adherente: params[16],
          iva_voluntario_pct: params[17],
          fecha_vigencia: params[18],
          actor_legajo: params[19],
          revision: 0,
        }));
        return [{ insertId: id }];
      }
      if (sql.includes('INSERT INTO porcentajes_comerciales')) {
        state.percentages.push({
          id: state.percentages.length + 1,
          politica_comercial_id: params[0],
          porcentaje: params[1],
          descripcion: null,
          fecha_vigencia: params[2],
          vigente_hasta: null,
          actor_legajo: params[3],
          created_at: '2026-10-22 12:00:00.000000',
        });
        return [{ insertId: state.percentages.length }];
      }
      if (sql.includes('UPDATE politica_comercial')) {
        // Cada escritura se distingue por su SET; el id viaja en distinta posición.
        if (sql.includes("SET estado = 'HISTORICA'")) {
          const politica = state.policies.find((fila) => Number(fila.id) === Number(params[1]));
          if (!politica || politica.estado !== 'VIGENTE') return [{ affectedRows: 0 }];
          politica.estado = 'HISTORICA';
          politica.vigente_hasta = String(params[0]);
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SET estado = 'VIGENTE'")) {
          const politica = state.policies.find((fila) => Number(fila.id) === Number(params[0]));
          if (!politica || politica.estado !== 'PROGRAMADA') return [{ affectedRows: 0 }];
          politica.estado = 'VIGENTE';
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SET estado = 'CANCELADA'")) {
          if (Number.isInteger(params[3] ?? null)) {
            const politicaCancelada = state.policies.find(
              (fila) => Number(fila.id) === Number(params[2])
                && fila.estado === 'PROGRAMADA'
                && Number(fila.revision) === Number(params[3]),
            );
            if (!politicaCancelada) return [{ affectedRows: 0 }];
            politicaCancelada.estado = 'CANCELADA';
            politicaCancelada.cancelada_en = '2026-10-22 12:00:00.000000';
            politicaCancelada.cancelada_por = String(params[0]);
            politicaCancelada.motivo_cancelacion = String(params[1]);
            return [{ affectedRows: 1 }];
          }
          const politicaCancelada = state.policies.find(
            (fila) => Number(fila.id) === Number(params[2]) && fila.estado === 'PROGRAMADA',
          );
          if (!politicaCancelada) return [{ affectedRows: 0 }];
          politicaCancelada.estado = 'CANCELADA';
          politicaCancelada.cancelada_en = '2026-10-22 12:00:00.000000';
          politicaCancelada.cancelada_por = String(params[0]);
          politicaCancelada.motivo_cancelacion = String(params[1]);
          return [{ affectedRows: 1 }];
        }
        // Escritura de programación (revisión optimista): id y revisión van al final.
        const politicaEditada = state.policies.find(
          (fila) => Number(fila.id) === Number(params[params.length - 2]),
        );
        const esperada = params[params.length - 1];
        if (!politicaEditada
          || politicaEditada.estado !== 'PROGRAMADA'
          || Number(politicaEditada.revision) !== Number(esperada)) {
          return [{ affectedRows: 0 }];
        }
        politicaEditada.porcentaje_aporte_reconocido = params[0];
        politicaEditada.tope_sueldo_bruto = params[1];
        politicaEditada.joven_porcentaje = params[2];
        politicaEditada.comercial_fijo_max_pct = params[3];
        politicaEditada.comercial_fijo_meses_max = params[4];
        politicaEditada.comercial_escalonado_max_pct = params[5];
        politicaEditada.comercial_escalonado_tramos_max = params[6];
        politicaEditada.comercial_escalonado_total_meses_max = params[7];
        politicaEditada.primer_tramo_50_meses_max = params[8];
        politicaEditada.tdc_pct = params[9];
        politicaEditada.tdc_habilitado = params[10];
        politicaEditada.tope_comercial_tdc_pct = params[11];
        politicaEditada.afinidad_pct = params[12];
        politicaEditada.aporte_monotributo = params[13];
        politicaEditada.aporte_adherente = params[14];
        politicaEditada.iva_voluntario_pct = params[15];
        politicaEditada.fecha_vigencia = params[16];
        politicaEditada.actor_legajo = params[17];
        politicaEditada.actor_nombre = 'David';
        politicaEditada.actor_apellido = 'Diaz';
        politicaEditada.revision = Number(politicaEditada.revision) + 1;
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('INSERT INTO politica_comercial_eventos')) {
        const evento = {
          id: state.events.length + 1,
          politica_comercial_id: params[0],
          tipo_evento: params[1],
          actor_legajo: params[2],
          actor_nombre: params[3],
          actor_apellido: params[4],
          detalle: params[5],
          evento_en: '2026-10-22 12:00:00.000000',
        };
        state.events.push(evento);
        return [{ insertId: evento.id }];
      }
      if (sql.includes('FROM empleados')) {
        // snapshotActor usa execute sobre empleados.
        return [[snapshotActor(params[0])], []];
      }
      throw new Error(`Execute no contemplado: ${sql}`);
    },
    /** Marca el inicio transaccional del doble. */
    async beginTransaction() {},
    /** Registra commits exitosos sin persistencia real. */
    async commit() { state.commits += 1; },
    /** Registra rollbacks para comprobar fallos transaccionales. */
    async rollback() { state.rollbacks += 1; },
    /** Imita la liberación de una conexión mysql2. */
    release() {},
  };
  return {
    pool: {
      /** Entrega siempre la conexión aislada del fixture. */
      async getConnection() { return connection; },
    },
    state,
  };
}

test('guarda una política con activación inmediata y cierra la vigente', async () => {
  const { pool, state } = crearPoolPolitica();
  const nueva = await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 12,
    aporte_monotributo: 25000,
    porcentajes_comerciales: [5, 10.5, 100],
  }, ACTOR, AHORA);

  assert.equal(nueva.estado, 'VIGENTE');
  assert.equal(nueva.joven_porcentaje, 12);
  assert.equal(nueva.aporte_monotributo, 25000);
  assert.deepEqual(nueva.porcentajes_comerciales, ['100.00', '10.50', '5.00']);
  assert.equal(state.policies.filter((fila) => fila.estado === 'VIGENTE').length, 1);
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'HISTORICA');
  assert.ok(state.events.some((evento) => evento.tipo_evento === 'CREACION'));
  assert.equal(state.commits, 1);
});

test('programa una versión futura conservando la vigente y la cancelación sustituye', async () => {
  const { pool, state } = crearPoolPolitica();
  const programada = await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 15,
    porcentajes_comerciales: [10, 20.5, 100],
    activacion: { modo: 'PROGRAMADA', fecha: FUTURO },
  }, ACTOR, AHORA);

  assert.equal(programada.estado, 'PROGRAMADA');
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'VIGENTE');
  assert.equal(state.policies.filter((fila) => fila.estado === 'PROGRAMADA').length, 1);

  const cancelada = await cancelarProgramacionPoliticaComercial(pool, programada.id, {
    revision: programada.revision ?? 0,
    motivo: 'Cambio de plan comercial',
  }, ACTOR);
  const snapshot = cancelada.version;
  assert.equal(snapshot.estado, 'CANCELADA');
  assert.ok(state.events.some((evento) => evento.tipo_evento === 'CANCELACION'));
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'VIGENTE');
});

test('rechaza guardados sin cambios reales respecto de la vigente', async () => {
  const { pool, state } = crearPoolPolitica();
  await assert.rejects(
    actualizarPoliticaComercial(pool, 2, { joven_porcentaje: 10 }, ACTOR, AHORA),
    (error) => error.code === 'ADMIN_ESTADO' && error.status === 409,
  );
  assert.equal(state.commits, 0);
});

test('edita la programación con revisión optimista y activa vencida automáticamente', async () => {
  const { pool, state } = crearPoolPolitica();
  const programada = await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 15,
    porcentajes_comerciales: [10, 20.5, 100],
    activacion: { modo: 'PROGRAMADA', fecha: FUTURO },
  }, ACTOR, AHORA);
  const revisionProgramada = state.policies.find((fila) => fila.id === programada.id).revision;

  const actualizada = await actualizarPoliticaComercial(pool, programada.id, {
    joven_porcentaje: 18,
    revision: revisionProgramada,
    activacion: { modo: 'PROGRAMADA', fecha: '2026-11-02T12:00:00.000Z' },
  }, ACTOR, AHORA);
  assert.equal(actualizada.joven_porcentaje, 18);
  assert.equal(state.policies.find((fila) => fila.id === programada.id).revision, revisionProgramada + 1);

  // La activación automática requiere que la fecha programada haya vencido.
  const temprana = await activarPoliticasProgramadas(pool, AHORA);
  assert.equal(temprana, null, 'no debe activar cuando la fecha de vigencia es futura');
  assert.equal(state.policies.find((fila) => fila.id === programada.id).estado, 'PROGRAMADA');
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'VIGENTE');

  const activada = await activarPoliticasProgramadas(
    pool,
    new Date('2026-11-02T13:00:00.000Z'),
  );
  assert.equal(activada.estado, 'VIGENTE');
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'HISTORICA');
  assert.equal(state.policies.filter((fila) => fila.estado === 'VIGENTE').length, 1);
  assert.ok(state.events.some((evento) => evento.tipo_evento === 'ACTIVACION'));
});

test('rechaza ediciones de programación con revisión desfasada', async () => {
  const { pool } = crearPoolPolitica();
  const programada = await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 15,
    porcentajes_comerciales: [10, 20.5, 100],
    activacion: { modo: 'PROGRAMADA', fecha: FUTURO },
  }, ACTOR, AHORA);
  await assert.rejects(
    actualizarPoliticaComercial(pool, programada.id, {
      joven_porcentaje: 16,
      revision: 999,
    }, ACTOR, AHORA),
    (error) => error.code === 'ADMIN_CONCURRENCIA' && error.status === 409,
  );
});

test('mantiene el orden de bloqueo programada antes de vigente para evitar deadlocks', async () => {
  const { pool, state } = crearPoolPolitica();
  await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 15,
  }, ACTOR, AHORA);

  const lecturasBloqueantes = state.sqls.filter(
    (s) => s.sql.includes('FOR UPDATE') && s.sql.includes('FROM politica_comercial'),
  );
  assert.equal(lecturasBloqueantes.length, 2);
  assert.ok(lecturasBloqueantes[0].sql.includes("p.estado = 'PROGRAMADA'"),
    'la primera lectura bloqueante debe pedir la política programada');
  assert.ok(lecturasBloqueantes[1].sql.includes("p.estado = 'VIGENTE'"),
    'la segunda lectura bloqueante debe pedir la política vigente');
});

test('lista historial con responsable completo y recupera una histórica con aporte', async () => {
  const { pool, state } = crearPoolPolitica();
  const historial = await listarHistorialPoliticaComercial(pool, AHORA);
  assert.deepEqual(historial.historial.map((fila) => fila.id), [2, 1]);
  assert.equal(historial.historial[1].actor_nombre, 'David');
  assert.equal(historial.historial[1].actor_apellido, 'Diaz');
  assert.equal(historial.historial[1].actor_legajo, ACTOR.legajo);

  const detalle = await obtenerDetallePoliticaComercial(pool, 1);
  assert.deepEqual(detalle.porcentajes_comerciales, ['7.00']);
  assert.equal(detalle.aporte_monotributo, '23892.00');

  const eventos = await listarEventosPoliticaComercial(pool, 1);
  assert.ok(Array.isArray(eventos));

  const recuperada = await recuperarPoliticaComercial(pool, 1, {}, ACTOR, AHORA);
  assert.equal(recuperada.estado, 'VIGENTE');
  assert.equal(recuperada.joven_porcentaje, '8.00');
  assert.equal(recuperada.aporte_monotributo, '23892.00');
  assert.deepEqual(recuperada.porcentajes_comerciales, ['7.00']);
  assert.equal(state.policies.find((fila) => fila.id === 1).estado, 'HISTORICA');
  assert.ok(state.events.some((evento) => evento.tipo_evento === 'RECUPERACION'));
});

test('recupera una histórica programada sin cancelar la vigente', async () => {
  const { pool, state } = crearPoolPolitica();
  const recuperada = await recuperarPoliticaComercial(pool, 1, {
    activacion: { modo: 'PROGRAMADA', fecha: FUTURO },
  }, ACTOR, AHORA);
  assert.equal(recuperada.estado, 'PROGRAMADA');
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'VIGENTE');
  assert.equal(state.policies.filter((fila) => fila.estado === 'PROGRAMADA').length, 1);
});

test('expone la política vigente con su programación pendiente y responsable', async () => {
  const { pool } = crearPoolPolitica();
  await actualizarPoliticaComercial(pool, 2, {
    joven_porcentaje: 15,
    porcentajes_comerciales: [10, 20.5, 100],
    activacion: { modo: 'PROGRAMADA', fecha: FUTURO },
  }, ACTOR, AHORA);
  const politica = await obtenerPoliticaComercial(pool, AHORA);
  assert.equal(politica.estado, 'VIGENTE');
  assert.equal(politica.actor_nombre, 'David');
  assert.equal(politica.actor_legajo, ACTOR.legajo);
  assert.equal(politica.aporte_monotributo, '23892.00');
  assert.equal(politica.programacion_pendiente.estado, 'PROGRAMADA');
});

test('rechaza catálogos inválidos y fechas programadas pasadas', async () => {
  const { pool, state } = crearPoolPolitica();
  for (const porcentajes of [[5, 5.0], [0], [100.01], ['5'], [1.005]]) {
    await assert.rejects(
      actualizarPoliticaComercial(pool, 2, { porcentajes_comerciales: porcentajes }, ACTOR, AHORA),
      (error) => error.code === 'ADMIN_VALIDACION' && error.status === 400,
    );
  }
  await assert.rejects(
    actualizarPoliticaComercial(pool, 2, {
      activacion: { modo: 'PROGRAMADA', fecha: '2026-10-20T12:00:00.000Z' },
    }, ACTOR, AHORA),
    (error) => error.code === 'ADMIN_VALIDACION',
  );
  await assert.rejects(
    actualizarPoliticaComercial(pool, 2, {
      activacion: { modo: 'PROGRAMADA', fecha: FUTURO.slice(0, -1) },
    }, ACTOR, AHORA),
    (error) => error.code === 'ADMIN_VALIDACION',
  );
  assert.equal(state.commits, 0);
});

test('agrega un aporte de monotributo configurable y versionado', async () => {
  const { pool, state } = crearPoolPolitica();
  const nueva = await actualizarPoliticaComercial(pool, 2, {
    aporte_monotributo: 24500.5,
  }, ACTOR, AHORA);
  assert.equal(nueva.aporte_monotributo, 24500.5);
  assert.equal(state.policies.filter((fila) => fila.estado === 'VIGENTE').length, 1);
  assert.equal(state.policies.find((fila) => fila.id === 2).estado, 'HISTORICA');
});

test('versiona aporte adherente e IVA y conserva intacta la política histórica al recuperar', async () => {
  const { pool, state } = crearPoolPolitica();
  const nueva = await actualizarPoliticaComercial(pool, 2, { aporte_adherente: 23892, iva_voluntario_pct: 10.5 }, ACTOR, AHORA);
  assert.equal(nueva.aporte_adherente, 23892); assert.equal(nueva.iva_voluntario_pct, 10.5);
  assert.equal(state.policies.find(p => p.id === 2).aporte_adherente, null);
  const recuperada = await recuperarPoliticaComercial(pool, 2, {}, ACTOR, AHORA);
  assert.equal(recuperada.aporte_adherente, null); assert.equal(recuperada.iva_voluntario_pct, null);
  assert.ok(state.events.length >= 2);
});

test('rechaza parámetros nuevos negativos, fuera de rango o con precisión no monetaria', async () => {
  const { pool } = crearPoolPolitica();
  for (const datos of [{ aporte_adherente: -1 }, { aporte_adherente: 1.001 }, { iva_voluntario_pct: 100.01 }, { iva_voluntario_pct: -0.01 }]) {
    await assert.rejects(actualizarPoliticaComercial(pool, 2, datos, ACTOR, AHORA), { code: 'ADMIN_VALIDACION' });
  }
});

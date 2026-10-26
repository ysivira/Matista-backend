import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  crearPorcentajeComercial,
  actualizarPorcentajeComercial,
  eliminarPorcentajeComercial,
  listarPorcentajesComerciales,
  obtenerHistorialPorcentaje,
} from '../../../src/modules/admin/porcentajes-comerciales.service.js';

const ACTOR = { legajo: '1234567' };
const FECHA = '2026-10-22 12:00:00.000000';

/** Normaliza únicamente espacios SQL para observar sentencias sin depender de su indentación. */
function normalizar(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * Simula mysql2 con repositorios reales y el withConnection real, nunca una base de datos.
 * @param {object} opciones Falla inyectada por etapa, error, actor ausente o resultado de lectura vacío.
 * @returns {object} Pool de una sola conexión, estado reversible y traza del orden de operaciones.
 */
function crearDoble(opciones = {}) {
  const estado = {
    porcentajes: [{ id: 1, porcentaje: '10.00', descripcion: opciones.descripcionInicial ?? 'Inicial',
      vigente_hasta: null, actor_legajo: '1', fecha_vigencia: FECHA, created_at: FECHA }],
    auditoria: [], operaciones: [], consultas: [], conexiones: 0,
    begins: 0, commits: 0, rollbacks: 0, releases: 0,
  };
  let abierta = false;
  let liberada = false;
  let respaldo;
  const error = opciones.error ?? new Error('Fallo sintético de persistencia');

  /** Registra la etapa y propaga el error sintético en el punto preciso solicitado. */
  function etapa(nombre) {
    assert.equal(liberada, false, 'no se utiliza una conexión liberada');
    estado.operaciones.push(nombre);
    if (opciones.fallarEn === nombre) throw error;
  }

  /**
   * Interpreta solo el SQL conocido del módulo y conserva resultados DECIMAL/proyecciones.
   * Admite la versión anterior (literales de auditoría) para ejecutar los mismos casos contra HEAD.
   */
  async function ejecutar(sql, parametros = []) {
    const s = normalizar(sql);
    estado.consultas.push({ sql: s, parametros: structuredClone(parametros) });
    if (s.startsWith('SET time_zone')) { etapa('zona'); return [[], []]; }
    if (s.includes('FROM empleados')) {
      etapa('actor');
      return [opciones.actorAusente ? [] : [{ legajo: parametros[0], nombre: 'David', apellido: 'Diaz' }], []];
    }
    if (s.startsWith('SELECT 1')) {
      etapa('existencia');
      const existe = estado.porcentajes.some(f => Number(f.porcentaje) === Number(parametros[0]) && f.vigente_hasta === null);
      return [existe ? [{ 1: 1 }] : [], []];
    }
    if (s.includes('FOR UPDATE')) {
      assert.equal(abierta, true, 'el bloqueo pertenece a la transacción');
      etapa('bloqueo');
      const fila = estado.porcentajes.find(f => Number(f.porcentaje) === Number(parametros[0]) && f.vigente_hasta === null);
      if (!fila) return [[], []];
      return [[s.startsWith('SELECT id, porcentaje, descripcion')
        ? { id: fila.id, porcentaje: fila.porcentaje, descripcion: fila.descripcion }
        : { id: fila.id, porcentaje: fila.porcentaje }], []];
    }
    if (s.startsWith('INSERT INTO porcentajes_comerciales')) {
      assert.equal(abierta, true);
      etapa('insertar');
      const id = estado.porcentajes.length + 1;
      estado.porcentajes.push({ id, porcentaje: Number(parametros[0]).toFixed(2),
        descripcion: parametros[1], fecha_vigencia: FECHA, vigente_hasta: null,
        actor_legajo: parametros[2], created_at: FECHA });
      return [{ insertId: id }, []];
    }
    if (s.startsWith('UPDATE porcentajes_comerciales')) {
      assert.equal(abierta, true);
      etapa('cerrar');
      const filas = estado.porcentajes.filter(f => Number(f.porcentaje) === Number(parametros[0]) && f.vigente_hasta === null);
      for (const fila of filas) fila.vigente_hasta = FECHA;
      return [{ affectedRows: filas.length }, []];
    }
    if (s.startsWith('INSERT INTO empleados_auditoria')) {
      assert.equal(abierta, true);
      etapa('auditar');
      // La versión anterior incluye evento/campo y ELIMINADO como literales;
      // se interpretan ambos formatos sin confundir valores con posiciones.
      const literalEvento = s.match(/'(PORCENTAJE_COMERCIAL_\w+)'/)?.[1];
      const evento = literalEvento ?? parametros[2];
      const campo = literalEvento ? (evento.endsWith('ACTUALIZADO') ? 'DESCRIPCION' : 'PORCENTAJE') : parametros[3];
      const anterior = parametros[literalEvento ? 2 : 4];
      const nuevo = literalEvento && evento.endsWith('ELIMINADO') ? 'ELIMINADO' : parametros[literalEvento ? 3 : 5];
      estado.auditoria.push({ legajo: parametros[0], actor_legajo: parametros[1], evento,
        campo, valor_anterior: anterior, valor_nuevo: nuevo, created_at: FECHA });
      return [{ affectedRows: 1 }, []];
    }
    if (s.includes('WHERE id = ?')) {
      etapa('porId');
      const fila = estado.porcentajes.find(f => f.id === parametros[0]);
      return [fila && !opciones.sinResultado ? [structuredClone(fila)] : [], []];
    }
    if (s.includes('ORDER BY porcentaje DESC')) {
      etapa('listar');
      return [structuredClone(estado.porcentajes.filter(f => f.vigente_hasta === null)), []];
    }
    if (s.includes('ORDER BY fecha_vigencia DESC')) {
      etapa('historial');
      return [structuredClone(estado.porcentajes.filter(f => Number(f.porcentaje) === Number(parametros[0]))), []];
    }
    throw new Error(`SQL no contemplado por el doble: ${s}`);
  }

  const connection = {
    query: ejecutar,
    execute: ejecutar,
    /** Captura los datos antes de cualquier escritura en la misma conexión. */
    async beginTransaction() {
      assert.equal(abierta, false);
      etapa('begin');
      respaldo = structuredClone({ porcentajes: estado.porcentajes, auditoria: estado.auditoria });
      abierta = true;
      estado.begins += 1;
    },
    /** Confirma solo si no se inyectó un fallo al cerrar la transacción. */
    async commit() {
      assert.equal(abierta, true);
      etapa('commit');
      abierta = false;
      estado.commits += 1;
    },
    /** Restaura filas y auditoría, no solo un contador de rollbacks. */
    async rollback() {
      assert.equal(abierta, true);
      etapa('rollback');
      estado.porcentajes = structuredClone(respaldo.porcentajes);
      estado.auditoria = structuredClone(respaldo.auditoria);
      abierta = false;
      estado.rollbacks += 1;
    },
    /** Comprueba que la conexión se libera una sola vez y sin transacción abierta. */
    release() {
      assert.equal(abierta, false);
      etapa('release');
      liberada = true;
      estado.releases += 1;
    },
  };
  const pool = {
    /** Impide adquisiciones paralelas o repositorios que abran otra conexión por su cuenta. */
    async getConnection() {
      assert.equal(estado.conexiones, 0);
      estado.conexiones += 1;
      return connection;
    },
  };
  return { pool, estado, error };
}

const OPERACIONES = {
  /** Crea un valor nuevo con los parámetros del contrato existente. */
  crear: pool => crearPorcentajeComercial(pool, { porcentaje: '25.00', descripcion: 'Nueva' }, ACTOR),
  /** Versiona la descripción sin modificar el porcentaje de la fila anterior. */
  actualizar: pool => actualizarPorcentajeComercial(pool, '10.00', { descripcion: 'Nueva' }, ACTOR),
  /** Cierra la vigencia manteniendo el historial. */
  eliminar: pool => eliminarPorcentajeComercial(pool, '10.00', ACTOR),
};

describe('porcentajes comerciales: contratos y transacciones reales con mysql2 simulado', () => {
  for (const [nombre, operar] of Object.entries(OPERACIONES)) {
    test(`${nombre}: conserva conexión, orden, resultado y auditoría exacta`, async () => {
      const { pool, estado } = crearDoble();
      const resultado = await operar(pool);
      const etapas = nombre === 'crear'
        ? ['existencia', 'actor', 'insertar', 'auditar', 'porId']
        : nombre === 'actualizar' ? ['bloqueo', 'actor', 'cerrar', 'insertar', 'auditar', 'porId']
          : ['bloqueo', 'actor', 'cerrar', 'auditar'];
      assert.deepEqual(estado.operaciones, ['zona', 'begin', ...etapas, 'commit', 'release']);
      assert.equal(estado.conexiones, 1);
      assert.equal(estado.begins, 1);
      assert.equal(estado.commits, 1);
      assert.equal(estado.rollbacks, 0);
      assert.equal(estado.releases, 1);
      assert.deepEqual(estado.auditoria, [{ legajo: ACTOR.legajo, actor_legajo: ACTOR.legajo,
        evento: `PORCENTAJE_COMERCIAL_${nombre === 'crear' ? 'CREADO' : nombre === 'actualizar' ? 'ACTUALIZADO' : 'ELIMINADO'}`,
        campo: nombre === 'actualizar' ? 'DESCRIPCION' : 'PORCENTAJE',
        valor_anterior: nombre === 'crear' ? 'N/A' : nombre === 'actualizar' ? 'Inicial' : 'porcentaje#1:10.00%',
        valor_nuevo: nombre === 'crear' ? 'porcentaje#2:25%' : nombre === 'actualizar' ? 'Nueva' : 'ELIMINADO', created_at: FECHA }]);
      if (nombre === 'eliminar') {
        assert.equal(resultado, undefined);
        assert.equal(estado.porcentajes.length, 1);
      } else {
        assert.deepEqual(resultado, { id: 2, porcentaje: nombre === 'crear' ? '25.00' : '10.00',
          descripcion: 'Nueva', fecha_vigencia: FECHA, vigente_hasta: null,
          actor_legajo: ACTOR.legajo, created_at: FECHA });
        assert.equal(estado.porcentajes.length, 2);
      }
      assert.equal(estado.porcentajes[0].vigente_hasta, nombre === 'crear' ? null : FECHA);
    });

    test(`${nombre}: actor no encontrado conserva el legajo del snapshot anterior`, async () => {
      const { pool, estado } = crearDoble({ actorAusente: true });
      await operar(pool);
      // El snapshot anterior devolvía el legajo solicitado y nombres vacíos.
      // Solo legajo era consumido por estos eventos; no se omite ni modifica la lectura.
      assert.equal(estado.operaciones.filter(e => e === 'actor').length, 1);
      assert.equal(estado.auditoria[0].legajo, ACTOR.legajo);
      assert.equal(estado.auditoria[0].actor_legajo, ACTOR.legajo);
    });

    const etapasFallo = nombre === 'crear'
      ? ['actor', 'insertar', 'auditar', 'porId', 'commit']
      : nombre === 'actualizar' ? ['bloqueo', 'actor', 'cerrar', 'insertar', 'auditar', 'porId', 'commit']
        : ['bloqueo', 'actor', 'cerrar', 'auditar', 'commit'];
    for (const fallarEn of etapasFallo) {
      test(`${nombre}: fallo en ${fallarEn} revierte datos y auditoría y libera conexión`, async () => {
        const { pool, estado, error } = crearDoble({ fallarEn });
        const antes = structuredClone(estado.porcentajes);
        await assert.rejects(operar(pool), e => e === error);
        assert.deepEqual(estado.porcentajes, antes);
        assert.deepEqual(estado.auditoria, []);
        assert.equal(estado.commits, 0);
        assert.equal(estado.rollbacks, 1);
        assert.equal(estado.releases, 1);
        assert.deepEqual(estado.operaciones.slice(-2), ['rollback', 'release']);
      });
    }
  }

  test('porcentaje duplicado conserva el error y no escribe', async () => {
    const { pool, estado } = crearDoble();
    await assert.rejects(crearPorcentajeComercial(pool, { porcentaje: '10.00' }, ACTOR),
      { code: 'ADMIN_ESTADO', status: 409, message: 'Ya existe un porcentaje comercial vigente con el valor 10%.' });
    assert.deepEqual(estado.operaciones, ['zona', 'begin', 'existencia', 'rollback', 'release']);
    assert.equal(estado.porcentajes.length, 1);
    assert.deepEqual(estado.auditoria, []);
  });

  test('actualizar y eliminar un valor inexistente conservan 404 y no escriben', async () => {
    for (const operar of [pool => actualizarPorcentajeComercial(pool, '99.99', { descripcion: 'x' }, ACTOR),
      pool => eliminarPorcentajeComercial(pool, '99.99', ACTOR)]) {
      const { pool, estado } = crearDoble();
      await assert.rejects(operar(pool), { code: 'ADMIN_NO_ENCONTRADO', status: 404,
        message: 'No existe un porcentaje comercial vigente con el valor 99.99%.' });
      assert.deepEqual(estado.operaciones, ['zona', 'begin', 'bloqueo', 'rollback', 'release']);
      assert.equal(estado.porcentajes.length, 1);
      assert.deepEqual(estado.auditoria, []);
    }
  });

  test('conserva undefined cuando la relectura por id no encuentra fila', async () => {
    const { pool } = crearDoble({ sinResultado: true });
    assert.equal(await OPERACIONES.crear(pool), undefined);
  });

  test('mantiene N/A en auditoría de descripciones nulas', async () => {
    const { pool, estado } = crearDoble();
    estado.porcentajes[0].descripcion = null;
    await actualizarPorcentajeComercial(pool, '10.00', { descripcion: null }, ACTOR);
    assert.equal(estado.auditoria[0].valor_anterior, 'N/A');
    assert.equal(estado.auditoria[0].valor_nuevo, 'N/A');
  });

  test('conserva los mapeos de integridad existentes sin modificar AUTH', async () => {
    for (const [codigo, esperado] of [['ER_DUP_ENTRY', 'IDENTITY_CONFLICT'], ['ER_NO_REFERENCED_ROW_2', 'ADMIN_INTEGRIDAD']]) {
      const error = Object.assign(new Error('Fallo sintético'), { code: codigo });
      const { pool, estado } = crearDoble({ fallarEn: 'auditar', error });
      await assert.rejects(OPERACIONES.actualizar(pool), { code: esperado, status: 409 });
      assert.equal(estado.porcentajes.length, 1);
      assert.equal(estado.porcentajes[0].vigente_hasta, null);
      assert.deepEqual(estado.auditoria, []);
    }
  });

  test('entradas inválidas se rechazan antes de adquirir conexión', async () => {
    for (const porcentaje of ['0', '101', '', null, 'abc']) {
      const { pool, estado } = crearDoble();
      await assert.rejects(crearPorcentajeComercial(pool, { porcentaje }, ACTOR), { code: 'ADMIN_VALIDACION', status: 400 });
      assert.equal(estado.conexiones, 0);
    }
    const { pool, estado } = crearDoble();
    await assert.rejects(actualizarPorcentajeComercial(pool, '10.00', { porcentaje: 20 }, ACTOR), { code: 'ADMIN_VALIDACION' });
    assert.equal(estado.conexiones, 0);
  });

  test('listado e historial conservan lectura sin transacciones adicionales', async () => {
    for (const consultar of [listarPorcentajesComerciales, pool => obtenerHistorialPorcentaje(pool, '10.00')]) {
      const { pool, estado } = crearDoble();
      assert.deepEqual(await consultar(pool), estado.porcentajes);
      assert.equal(estado.begins, 0);
      assert.equal(estado.commits, 0);
      assert.equal(estado.rollbacks, 0);
      assert.equal(estado.releases, 1);
    }
  });
});

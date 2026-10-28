/**
 * ============================================================
 * MATISTA | PRUEBAS DE SERVICIOS DEL TARIFARIO
 * ============================================================
 *
 * Archivo: tarifario.service.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Probar consultas y ciclo completo de versiones, incluidas
 * revisiones, redondeo, auditoría y deshacer con dobles aislados.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  crearBorradorDesdeHistorica,
  descartarVersionTarifario,
  deshacerUltimoCambioEconomico,
  reanudarEdicionVersion,
  gestionarPlanes,
  gestionarTarifario,
  listarTarifasDeLaVersion,
  listarVersionesTarifario,
  obtenerDetalleVersion,
  reconstruirTarifarioHistorico,
  resumirEventosDeVersion,
} from '../../../src/modules/admin/tarifario.service.js';
import {
  validarFechaVersion,
  validarIdVersion,
  validarParametrosTarifario,
} from '../../../src/modules/admin/tarifario.validators.js';

/**
 * Crea dependencias en memoria para observar el caso de uso sin abrir MySQL.
 * @param {object} overrides Resultados o funciones que cada prueba necesita variar.
 * @returns {object} Bolsa compatible con el servicio y llamadas observables.
 */
function dependenciasFalsas(overrides = {}) {
  const llamadas = [];
  const dependencias = {
    async withConnection(pool, operation) {
      llamadas.push({ metodo: 'withConnection', pool });
      return operation({ prueba: true });
    },
    async listarPlanesActivos() {
      return [{ id: 1, nombre: 'PLAN', detalles: null, condiciones_generales: null }];
    },
    async obtenerPlanPorId(connection, planId) {
      llamadas.push({ metodo: 'obtenerPlanPorId', planId });
      return { id: planId, nombre: 'PLAN', activa: 1 };
    },
    async resolverVersionVigente(connection, fechaReferencia) {
      llamadas.push({ metodo: 'resolverVersionVigente', fechaReferencia });
      return {
        id: 9007199254740991n,
        tipo: 'CARGA_INICIAL',
        estado: 'ACTIVA',
        fecha_activacion: new Date('2026-10-19T12:00:00.000Z'),
      };
    },
    async listarTarifasActivas(connection, filtro) {
      llamadas.push({ metodo: 'listarTarifasActivas', filtro });
      return [
        { rango_clave: 'HIJO 0-1', rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '30.00' },
        { rango_clave: '66+', rango_etario: '66-00', rango_nota: null, precio: '20.10' },
        { rango_clave: '0-25', rango_etario: '0-25', rango_nota: null, precio: '10.00' },
      ];
    },
    ...overrides,
  };
  return { dependencias, llamadas };
}

describe('servicio de consulta tarifaria SL-2', () => {
  test('lista planes activos sin transformar el contrato persistido', async () => {
    const { dependencias } = dependenciasFalsas();
    const planes = await gestionarPlanes({ pool: true }, dependencias);

    assert.deepEqual(planes, [
      { id: 1, nombre: 'PLAN', detalles: null, condiciones_generales: null },
    ]);
  });

  test('compone version, precio decimal, notas y orden comercial', async () => {
    const { dependencias, llamadas } = dependenciasFalsas();
    const resultado = await gestionarTarifario(
      { pool: true },
      { planId: '1', tipoIngreso: 'Obligatorio' },
      new Date('2026-10-20T13:14:49.123Z'),
      dependencias,
    );

    assert.deepEqual(resultado.plan, { id: 1, nombre: 'PLAN' });
    assert.equal(resultado.tipo_ingreso, 'Obligatorio');
    assert.deepEqual(resultado.version, {
      id: '9007199254740991',
      tipo: 'CARGA_INICIAL',
      estado: 'ACTIVA',
      fecha_activacion: '2026-10-19T12:00:00.000Z',
    });
    assert.deepEqual(
      resultado.tarifas.map((tarifa) => tarifa.rango_clave),
      ['0-25', '66+', 'HIJO 0-1'],
    );
    assert.equal(resultado.tarifas[1].precio, '20.10');
    assert.equal(resultado.tarifas[2].rango_nota, '(*)');
    assert.equal(
      llamadas.find((llamada) => llamada.metodo === 'resolverVersionVigente').fechaReferencia,
      '2026-10-20 13:14:49.123000',
    );
    assert.deepEqual(
      llamadas.find((llamada) => llamada.metodo === 'listarTarifasActivas').filtro,
      { versionId: 9007199254740991n, planId: 1, tipoIngreso: 'Obligatorio' },
    );
  });

  test('acepta una coleccion activa vacia como resultado valido', async () => {
    const { dependencias } = dependenciasFalsas({
      listarTarifasActivas: async () => [],
    });
    const resultado = await gestionarTarifario(
      {},
      { planId: '2', tipoIngreso: 'Voluntario' },
      new Date('2026-10-20T12:00:00Z'),
      dependencias,
    );

    assert.deepEqual(resultado.tarifas, []);
  });

  test('distingue plan inexistente, inactivo y ausencia de version vigente', async () => {
    for (const escenario of ['inexistente', 'inactivo', 'sin-version']) {
      const { dependencias } = dependenciasFalsas({
        obtenerPlanPorId: async () => escenario === 'inexistente'
          ? undefined
          : { id: 1, nombre: 'PLAN', activa: escenario === 'inactivo' ? 0 : 1 },
        resolverVersionVigente: async () => escenario === 'sin-version' ? null : {
          id: 1,
          tipo: 'CARGA_INICIAL',
          estado: 'ACTIVA',
          fecha_activacion: new Date(),
        },
      });

      await assert.rejects(
        gestionarTarifario(
          {},
          { planId: '1', tipoIngreso: 'Obligatorio' },
          new Date('2026-10-20T12:00:00Z'),
          dependencias,
        ),
        escenario === 'inexistente'
          ? { code: 'ADMIN_NO_ENCONTRADO', status: 404 }
          : { code: 'ADMIN_ESTADO', status: 409 },
      );
    }
  });

  test('rechaza identificadores y modalidades fuera del contrato antes de consultar', async () => {
    for (const parametros of [
      { planId: '0', tipoIngreso: 'Obligatorio' },
      { planId: '01', tipoIngreso: 'Obligatorio' },
      { planId: '65536', tipoIngreso: 'Obligatorio' },
      { planId: '1', tipoIngreso: 'obligatorio' },
      { planId: '1', tipoIngreso: 'Ambas' },
    ]) {
      assert.throws(
        () => validarParametrosTarifario(parametros),
        (error) => error.code === 'ADMIN_VALIDACION'
          && error.status === 400
          && error.details.length >= 1,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// SL-3 · Consulta de historial, detalle, lista completa y reconstruccion.
// ─────────────────────────────────────────────────────────────────────

/**
 * Crea dependencias en memoria para los casos de lectura de versiones.
 * @param {object} overrides Funciones o resultados a variar por prueba.
 * @returns {object} Bolsa con dependencias falsas y llamadas observables.
 */
function dependenciasVersiones(overrides = {}) {
  const llamadas = [];
  const dependencias = {
    async withConnection(pool, operation) {
      llamadas.push({ metodo: 'withConnection', pool });
      return operation({ prueba: true });
    },
    async listarVersiones() {
      return [
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
    },
    async obtenerVersionPorId(connection, versionId) {
      llamadas.push({ metodo: 'obtenerVersionPorId', versionId });
      return (await this.listarVersiones()).find(
        (fila) => Number(fila.id) === Number(versionId),
      );
    },
    async listarTarifasDeVersion(connection, versionId, opciones = {}) {
      llamadas.push({ metodo: 'listarTarifasDeVersion', versionId, opciones });
      // Igual que el repositorio real: soloActivas filtra bajas logicas.
      const snapshot = [
        { plan_id: 2, plan_nombre: 'ESMERALDA', tipo_ingreso: 'Voluntario', rango_clave: '66+', rango_etario: '66-00', rango_nota: null, precio: '80.00', activa: 0 },
        { plan_id: 1, plan_nombre: 'RUBI', tipo_ingreso: 'Obligatorio', rango_clave: '0-25', rango_etario: '0-25', rango_nota: null, precio: '10.00', activa: 1 },
        { plan_id: 1, plan_nombre: 'RUBI', tipo_ingreso: 'Obligatorio', rango_clave: 'HIJO 0-1', rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '50.25', activa: 1 },
      ];
      return opciones.soloActivas
        ? snapshot.filter((fila) => Number(fila.activa) === 1)
        : snapshot;
    },
    async resolverVersionVigente(connection, fechaReferencia) {
      llamadas.push({ metodo: 'resolverVersionVigente', fechaReferencia });
      return {
        id: 1,
        tipo: 'CARGA_INICIAL',
        estado: 'ACTIVA',
        fecha_activacion: new Date('2026-10-19T16:37:36Z'),
      };
    },
    ...overrides,
  };
  return { dependencias, llamadas };
}

describe('servicio de consultas de versiones SL-3', () => {
  test('presenta el historial cronologico con responsable y trazabilidad', async () => {
    const { dependencias } = dependenciasVersiones();
    const resultado = await listarVersionesTarifario({ pool: true }, dependencias);

    assert.deepEqual(resultado.versiones, [
      {
        id: '7',
        tipo: 'EDICION_LISTA',
        estado: 'PREPARACION',
        revision: 0,
        fecha_activacion: null,
        version_base_id: '1',
        created_at: '2026-10-21T14:00:00.000Z',
        actor_legajo: '1234567',
        actor_nombre: 'Marcelo',
        actor_apellido: 'Suarez',
      },
      {
        id: '1',
        tipo: 'CARGA_INICIAL',
        estado: 'ACTIVA',
        revision: 0,
        fecha_activacion: '2026-10-19T16:37:36.000Z',
        version_base_id: null,
        created_at: '2026-10-19T16:20:00.000Z',
        actor_legajo: null,
        actor_nombre: null,
        actor_apellido: null,
      },
    ]);
  });

  test('responde el detalle de la version pedida y rechaza ids invalidos', async () => {
    const { dependencias, llamadas } = dependenciasVersiones();
    const detalle = await obtenerDetalleVersion({ pool: true }, { id: '7' }, dependencias);
    assert.equal(detalle.version.id, '7');
    assert.equal(detalle.version.actor_legajo, '1234567');

    await assert.rejects(
      obtenerDetalleVersion({ pool: true }, { id: '11' }, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
    for (const idInvalido of ['0', '01', '-3', 'abc', '9007199254740992']) {
      assert.throws(() => validarIdVersion(idInvalido), { code: 'ADMIN_VALIDACION' });
    }
    assert.equal(llamadas[0].metodo, 'withConnection');
    assert.equal(
      llamadas.find((llamada) => llamada.metodo === 'obtenerVersionPorId').versionId,
      7,
    );
  });

  test('lista el snapshot completo en orden comercial con activa booleano', async () => {
    const { dependencias, llamadas } = dependenciasVersiones();
    const resultado = await listarTarifasDeLaVersion(
      { pool: true },
      { id: '7' },
      dependencias,
    );

    assert.deepEqual(
      resultado.tarifas.map((tarifa) => tarifa.rango_clave),
      ['0-25', 'HIJO 0-1', '66+'],
    );
    assert.equal(resultado.tarifas[2].activa, false);
    assert.equal(resultado.tarifas[2].precio, '80.00');
    assert.equal(resultado.tarifas[1].plan_nombre, 'RUBI');
    assert.deepEqual(
      llamadas.find((llamada) => llamada.metodo === 'listarTarifasDeVersion'),
      { metodo: 'listarTarifasDeVersion', versionId: 7, opciones: {} });

    await assert.rejects(
      listarTarifasDeLaVersion({ pool: true }, { id: '99' }, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });

  test('reconstruye el tarifario efectivo de la fecha pedida sin estados', async () => {
    const { dependencias, llamadas } = dependenciasVersiones();
    const resultado = await reconstruirTarifarioHistorico(
      { pool: true },
      { fecha: '2026-10-20T09:30:00-03:00' },
      dependencias,
    );

    // La fecha -03:00 se normaliza a UTC junto al resolver.
    assert.equal(resultado.fecha, '2026-10-20T12:30:00.000Z');
    assert.equal(
      llamadas.find((llamada) => llamada.metodo === 'resolverVersionVigente').fechaReferencia,
      '2026-10-20 12:30:00.000000',
    );
    assert.deepEqual(
      llamadas.find((llamada) => llamada.metodo === 'listarTarifasDeVersion').opciones,
      { soloActivas: true },
    );
    assert.equal(resultado.version.id, '1');
    assert.deepEqual(
      resultado.tarifas.map((tarifa) => tarifa.rango_clave),
      ['0-25', 'HIJO 0-1'],
    );

    await assert.rejects(
      reconstruirTarifarioHistorico({ pool: true }, { fecha: '2026-10-01T00:00:00Z' },
        dependenciasVersiones({ resolverVersionVigente: async () => null }).dependencias),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
  });

  test('exige la fecha historica completa, con zona y calendario posible', () => {
    assert.equal(validarFechaVersion('2026-10-19T16:37:36.370Z').toISOString(),
      '2026-10-19T16:37:36.370Z');
    for (const fechaInvalida of [
      '2026-10-19T16:37:36', // sin zona
      '2026-10-19 16:37', // sin zona
      '2026-13-19T16:37:36Z', // calendario ingredible
      '2026-02-30T00:00:00Z', // dia inexistente
      '2026-10-19T24:01:00Z', // hora invalida
      '2026-10-19T16:37:36.1234Z', // fraccion mayor a milisegundo
      null,
      'ayer',
    ]) {
      assert.throws(() => validarFechaVersion(fechaInvalida), {
        code: 'ADMIN_VALIDACION',
        status: 400,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// SL-4 · Escritura en borradores. El doble simula el ciclo transacional
// guardando estado en memoria: los guardas de estado, la revision
// optimista y la exclusividad de borrador son responsabilidad del
// servicio (y del esquema); el doble solo es capaz de registrarla.
// ─────────────────────────────────────────────────────────────────────

import {
  activarVersionTarifario,
  aumentarVersionTarifario,
  crearBorradorTarifario,
  editarTarifaVersion,
  finalizarVersionTarifario,
} from '../../../src/modules/admin/tarifario.service.js';
import {
  validarModalidadOpcional,
  validarPorcentajeAumento,
  validarPrecioEdicion,
  validarRevision,
} from '../../../src/modules/admin/tarifario.validators.js';

const ACTOR_PRUEBA = Object.freeze({ legajo: '1234567' });

/**
 * Crea un entorno en memoria del ciclo de vida de versiones: una
 * versión ACTIVA con tarifa base, un contador de revision y aproxima
 * las garantías que en MySQL sostienen los guardas de la migración 015.
 * @param {object} overrides Estado inicial distinto para cada caso.
 * @returns {object} Dependencias falsas, estado observable y eventos.
 */
function entornoEscritura(overrides = {}) {
  const estado = {
    activa: {
      id: 1, tipo: 'CARGA_INICIAL', estado: 'ACTIVA', revision: 0,
      created_at: new Date('2026-10-19T16:20:00Z'), actor_legajo: null,
    },
    borrador: null,
    versiones: [],
    proximoId: 7,
    revision: 0,
    tarifas: [
      { id: 101, version_id: 1, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' },
      { id: 102, version_id: 1, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '50.25' },
    ],
    eventos: [],
    logBloqueos: [],
    siguienteEvento: 1,
    ...overrides,
  };
  const dependencias = {
    async withConnection(pool, operation) {
      // Connection falsa con soporte del snapshotActor, del listado de
      // filas del borrador y del conteo de integridad de la activacion.
      const connection = {
        async execute(sql, parametros = []) {
          if (sql.startsWith('SELECT nombre, apellido FROM empleados')) {
            return [[{ nombre: 'Marcelo', apellido: 'Suarez' }], []];
          }
          if (sql.startsWith('SELECT COUNT(*) AS filas')) {
            const versionId = Number(parametros[0]);
            const filas = estado.tarifas.filter(
              (fila) => Number(fila.version_id) === versionId,
            ).length;
            return [[{ filas }], []];
          }
          throw new Error(`SQL no contemplado: ${sql}`);
        },
        async query(sql, parametros = []) {
          if (sql.includes('FROM tarifas')) {
            const versionId = Number(parametros[0]);
            const modalidad = parametros[1];
            return [estado.tarifas.filter(
              (fila) => Number(fila.version_id) === versionId
                && (!modalidad || fila.tipo_ingreso === modalidad),
            ), []];
          }
          throw new Error(`SQL no contemplado: ${sql}`);
        },
      };
      return operation(connection);
    },
    async obtenerEmpleado(conexion, legajo) {
      return { legajo, nombre: 'Marcelo', apellido: 'Suarez' };
    },
    async contarTarifasDeVersion(conexion, versionId) {
      return estado.tarifas.filter(
        (fila) => Number(fila.version_id) === Number(versionId),
      ).length;
    },
    async listarTarifasDeVersion(conexion, versionId) {
      return estado.tarifas
        .filter((fila) => Number(fila.version_id) === Number(versionId))
        .map((fila) => ({
          ...fila,
          plan_nombre: `PLAN ${fila.plan_id}`,
          rango_nota: fila.rango_nota ?? null,
        }));
    },
    /** Registra la solicitud de bloqueo de la ACTIVA y devuelve la version simulada. */
    async bloquearVersionActiva() {
      estado.logBloqueos.push('SELECT ... FROM versiones WHERE estado = \'ACTIVA\' FOR UPDATE');
      return estado.activa;
    },
    async bloquearBorradorAbierto() { return estado.borrador; },
    async insertarBorrador(conexion, datos) {
      const id = estado.proximoId;
      estado.proximoId += 1;
      estado.versiones.push({
        id, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: datos.versionBaseId,
        actor_legajo: datos.actorLegajo, observacion: datos.observacion,
      });
      return id;
    },
    async copiarTarifas(conexion, { origenId, destinoId }) {
      estado.tarifas.push(...estado.tarifas
        .filter((fila) => Number(fila.version_id) === Number(origenId))
        .map((fila) => ({ ...fila, version_id: destinoId })));
      return estado.tarifas.filter((fila) => Number(fila.version_id) === Number(destinoId)).length;
    },
    /** Registra el bloqueo solicitado para `id` y devuelve la version simulada o null. */
    async bloquearVersion(conexion, id) {
      estado.logBloqueos.push(`SELECT ... FROM versiones WHERE id = ${id} FOR UPDATE`);
      return Number(id) === 1 ? estado.activa
        : estado.versiones.find((fila) => Number(fila.id) === Number(id)) ?? null;
    },
    async bloquearTarifa(conexion, { versionId, tarifaId }) {
      return estado.tarifas.find((fila) => Number(fila.id) === Number(tarifaId)
        && Number(fila.version_id) === Number(versionId)) ?? null;
    },
    async incrementarRevision(conexion, { id, revision }) {
      const version = Number(id) === 1 ? estado.activa
        : estado.versiones.find((fila) => Number(fila.id) === Number(id));
      if (!version || Number(version.revision) !== revision) {
        return 0;
      }
      version.revision = revision + 1;
      return 1;
    },
    async actualizarPrecioTarifa(conexion, { tarifaId, precio }) {
      const tarifa = estado.tarifas.find((fila) => Number(fila.id) === Number(tarifaId));
      if (tarifa) tarifa.precio = precio;
      return tarifa ? 1 : 0;
    },
    async aumentarPrecios(conexion, { importes }) {
      for (const [tarifaId, precio] of importes) {
        const tarifa = estado.tarifas.find((fila) => Number(fila.id) === tarifaId);
        if (tarifa) tarifa.precio = precio;
      }
      return importes.length;
    },
    async actualizarEstadoVersion(conexion, { id, estado: nuevo, activar }) {
      const version = Number(id) === 1 ? estado.activa
        : estado.versiones.find((fila) => Number(fila.id) === Number(id));
      if (!version) return 0;
      version.estado = nuevo;
      if (activar) version.fecha_activacion = new Date('2026-10-21T18:00:00Z');
      return 1;
    },
    async insertarEvento(conexion, evento) {
      const id = estado.siguienteEvento;
      estado.siguienteEvento += 1;
      estado.eventos.push({ id, ...evento });
      return id;
    },
    async obtenerVersionConResponsable(conexion, id) {
      return Number(id) === 1 ? estado.activa
        : estado.versiones.find((fila) => Number(fila.id) === Number(id)) ?? null;
    },
  };
  return { dependencias, estado };
}

describe('servicio de escritura SL-4', () => {
  test('crea el borrador copiando la version activa y deja evento CREACION', async () => {
    const { dependencias, estado } = entornoEscritura();
    const resultado = await crearBorradorTarifario({ pool: true }, ACTOR_PRUEBA, dependencias);

    assert.deepEqual(resultado.version, {
      id: '7',
      tipo: 'EDICION_LISTA',
      estado: 'PREPARACION',
      version_base_id: '1',
      actor_legajo: '1234567',
      evento: { id: '1', tipo: 'CREACION' },
    });
    // Copia integridad: el snapshot base viaja completo al borrador.
    assert.equal(estado.versiones[0].estado, 'PREPARACION');
    assert.equal(estado.tarifas[2].version_id, 7);
    assert.equal(estado.tarifas[2].precio, '100.00');
    assert.equal(estado.tarifas[3].precio, '50.25');
    assert.equal(estado.eventos[0].tipoEvento, 'CREACION');
    assert.equal(estado.eventos[0].actorNombre, 'Marcelo');
    assert.match(estado.eventos[0].detalle, /Copia de la version vigente 1/);
  });

  test('exclusividad: el borrador abierto devuelve 409 con origen humano', async () => {
    const { dependencias } = entornoEscritura({
      borrador: {
        id: 9, estado: 'PREPARACION', actor_legajo: '7654321',
        created_at: new Date('2026-10-20T20:30:00Z'),
        nombre: 'Ana', apellido: 'Gomez',
      },
    });

    await assert.rejects(
      crearBorradorTarifario({ pool: true }, ACTOR_PRUEBA, dependencias),
      (error) => {
        assert.equal(error.code, 'ADMIN_ESTADO');
        assert.equal(error.status, 409);
        assert.match(error.message, /Ana Gomez/);
        assert.match(error.message, /legajo 7654321/);
        // 20:30 UTC = 17:30 en Buenos Aires (UTC-3) al 20/10.
        assert.match(error.message, /20\/10\/2026 17:30/);
        return true;
      },
    );
  });

  test('la carrera de creacion devuelve 409 con el borrador ganador', async () => {
    const { dependencias } = entornoEscritura();
    const ganador = {
      id: 10, estado: 'PREPARACION', actor_legajo: '7654321',
      created_at: new Date('2026-10-20T20:30:00Z'),
      nombre: 'Ana', apellido: 'Gomez',
    };
    let lecturas = 0;
    dependencias.bloquearBorradorAbierto = async () => {
      lecturas += 1;
      return lecturas === 1 ? null : ganador;
    };
    dependencias.insertarBorrador = async () => {
      throw Object.assign(new Error('duplicado'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    };

    await assert.rejects(
      crearBorradorTarifario({ pool: true }, ACTOR_PRUEBA, dependencias),
      (error) => {
        assert.equal(error.code, 'ADMIN_ESTADO');
        assert.equal(error.status, 409);
        assert.match(error.message, /Ana Gomez/);
        return true;
      },
    );
  });

  test('sin version activa no hay de donde copiar: 409', async () => {
    const { dependencias } = entornoEscritura({ activa: null });
    await assert.rejects(
      crearBorradorTarifario({ pool: true }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
  });

  test('aumento masivo calcula HALF-UP, filtra modalidad y audita hijo por hijo', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [
        { id: 201, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' },
        { id: 202, version_id: 7, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '50.25' },
      ],
    });
    const resultado = await aumentarVersionTarifario(
      { pool: true },
      { id: '7' },
      { porcentaje: '5', tipoIngreso: null, revision: '0' },
      ACTOR_PRUEBA,
      dependencias,
    );

    assert.equal(resultado.filas, 2);
    assert.equal(resultado.revision, 1);
    const obligatoria = estado.tarifas.find((fila) => fila.id === 201);
    const voluntaria = estado.tarifas.find((fila) => fila.id === 202);
    assert.equal(obligatoria.precio, '105.00');
    // 50.25 * 1.05 = 52.7625 -> 52.76 (HALF-UP sobre centavos exactos).
    assert.equal(voluntaria.precio, '52.76');
    const agrupador = estado.eventos[0];
    assert.equal(agrupador.tipoEvento, 'MODIFICACION');
    assert.equal(agrupador.tipoOperacion, 'AUMENTO_MASIVO');
    assert.equal(agrupador.agrupadorId, null);
    assert.equal(estado.eventos.length, 3);
    const hijo = estado.eventos[1];
    assert.equal(hijo.tipoEvento, 'MODIFICACION');
    assert.equal(hijo.tipoOperacion, 'PRECIO');
    assert.equal(hijo.agrupadorId, agrupador.id);
    assert.equal(hijo.planId, 2);
    assert.equal(hijo.rangoClave, '0-25');
    assert.equal(hijo.valorAnterior, '100.00');
    assert.equal(hijo.valorNuevo, '105.00');
  });

  test('medio centavo classico: 99.99 mas 5% es 104.99', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [{ id: 201, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '99.99' }],
    });
    await aumentarVersionTarifario(
      { pool: true }, { id: '7' }, { porcentaje: '5', revision: '0' },
      ACTOR_PRUEBA, dependencias,
    );
    assert.equal(estado.tarifas[0].precio, '104.99');
  });

  test('el aumento omite filas sin cambio economico despues del redondeo', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [
        { id: 201, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '0.01' },
        { id: 202, version_id: 7, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '100.00' },
      ],
    });

    const resultado = await aumentarVersionTarifario(
      { pool: true }, { id: '7' }, { porcentaje: '0.01', revision: '0' },
      ACTOR_PRUEBA, dependencias,
    );

    assert.equal(resultado.filas, 1);
    assert.equal(estado.tarifas.find((fila) => fila.id === 201).precio, '0.01');
    assert.equal(estado.tarifas.find((fila) => fila.id === 202).precio, '100.01');
    assert.equal(estado.eventos.filter((evento) => evento.tipoOperacion === 'PRECIO').length, 1);
  });

  test('revision optimista y estados cerrados bloquean ediciones', async () => {
    const borrador = {
      id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
      version_base_id: 1, actor_legajo: '1234567', revision: 3,
    };
    const { dependencias } = entornoEscritura({ versiones: [borrador] });
    for (const revision of ['2', '4']) {
      await assert.rejects(
        aumentarVersionTarifario(
          { pool: true }, { id: '7' }, { porcentaje: '5', revision },
          ACTOR_PRUEBA, dependencias,
        ),
        { code: 'ADMIN_CONCURRENCIA', status: 409 },
      );
    }
    borrador.estado = 'LISTA_PARA_ACTIVAR';
    await assert.rejects(
      aumentarVersionTarifario(
        { pool: true }, { id: '7' }, { porcentaje: '5', revision: '4' },
        ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
  });

  test('aumento que excede el tope de la columna aborta sin escribir', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [{ id: 101, version_id: 1, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '99999999.00' }],
    });
    await assert.rejects(
      aumentarVersionTarifario(
        { pool: true }, { id: '7' }, { porcentaje: '1', revision: '0' },
        ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(estado.tarifas[0].precio, '99999999.00');
    assert.equal(estado.eventos.length, 0);
  });

  test('ediciones individuales actualizar precio y registran evento PRECIO', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [{ id: 101, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' }],
    });
    const resultado = await editarTarifaVersion(
      { pool: true },
      { id: '7', tarifaId: '101' },
      { precio: '120.50', revision: '0' },
      ACTOR_PRUEBA,
      dependencias,
    );

    assert.equal(resultado.tarifa.precio, '120.50');
    assert.equal(resultado.revision, 1);
    assert.equal(estado.tarifas[0].precio, '120.50');
    const evento = estado.eventos[0];
    assert.equal(evento.tipoEvento, 'MODIFICACION');
    assert.equal(evento.agrupadorId, null);
    assert.equal(evento.tipoOperacion, 'PRECIO');
    assert.equal(evento.planId, 2);
    assert.equal(evento.tipoIngreso, 'Obligatorio');
    assert.equal(evento.rangoClave, '0-25');
    assert.equal(evento.valorAnterior, '100.00');
    assert.equal(evento.valorNuevo, '120.50');

    await assert.rejects(
      editarTarifaVersion(
        { pool: true }, { id: '7', tarifaId: '505' }, { precio: '1.00', revision: '1' },
        ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });

  test('rechaza un precio economicamente igual sin revision ni auditoria', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
      tarifas: [{
        id: 101, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio',
        rango_clave: '0-25', precio: '120.50',
      }],
    });

    await assert.rejects(
      editarTarifaVersion(
        { pool: true }, { id: '7', tarifaId: '101' },
        { precio: '120.5', revision: '0' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(estado.versiones[0].revision, 0);
    assert.equal(estado.tarifas[0].precio, '120.50');
    assert.equal(estado.eventos.length, 0);
  });

  test('finalizacion pasa a LISTA_PARA_ACTIVAR y deja evento tipado', async () => {
    const { dependencias, estado } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 1,
      }],
    });
    const resultado = await finalizarVersionTarifario(
      { pool: true }, { id: '7' }, { revision: '1' }, ACTOR_PRUEBA, dependencias,
    );
    assert.equal(resultado.version.estado, 'LISTA_PARA_ACTIVAR');
    assert.equal(estado.versiones[0].estado, 'LISTA_PARA_ACTIVAR');
    const evento = estado.eventos[0];
    assert.equal(evento.tipoEvento, 'FINALIZACION');
    assert.equal(evento.tipoOperacion, null);
    assert.equal(evento.agrupadorId, null);
    assert.match(evento.detalle, /quedo lista para activacion manual/);

    // Segunda finalizacion: el estado ya no es editable (409 transicion).
    await assert.rejects(
      finalizarVersionTarifario({ pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
  });

  test('validadores de escritura cierran 400 antes de abrir transaccion', () => {
    for (const caso of [
      () => validarRevision('01'),
      () => validarRevision('-1'),
      () => validarRevision(null),
      () => validarPrecioEdicion('0'),
      () => validarPrecioEdicion('-5.00'),
      () => validarPrecioEdicion('10.999'),
      () => validarPrecioEdicion('100000000.00'),
      () => validarPorcentajeAumento('0'),
      () => validarPorcentajeAumento('100'),
      () => validarPorcentajeAumento('-3'),
      () => validarModalidadOpcional('Ambas'),
    ]) {
      assert.throws(caso, { code: 'ADMIN_VALIDACION', status: 400 });
    }
    assert.equal(validarModalidadOpcional(undefined), null);
    assert.equal(validarModalidadOpcional('Voluntario'), 'Voluntario');
    assert.equal(validarRevision('7'), 7);
  });
});

// ─────────────────────────────────────────────────────────────────────
// SL-5 · Activacion manual transaccional: reemplazo de vigencia sin
// canciones de reversion; un fallo deja la version activa anterior en pie.
// ─────────────────────────────────────────────────────────────────────

describe('servicio de activacion SL-5', () => {
  test('conmuta la vigencia con estado, fecha y evento ACTIVACION', async () => {
    const borrador = {
      id: 7, tipo: 'EDICION_LISTA', estado: 'LISTA_PARA_ACTIVAR',
      version_base_id: 1, actor_legajo: '1234567', revision: 2,
    };
  const { dependencias, estado } = entornoEscritura({
    versiones: [borrador],
    tarifas: [{ id: 201, version_id: 7, plan_id: 2, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '100.00' }],
  });
  const resultado = await activarVersionTarifario(
    { pool: true }, { id: '7' }, { legajo: '7654321' }, dependencias,
  );

  assert.equal(estado.logBloqueos[0], 'SELECT ... FROM versiones WHERE estado = \'ACTIVA\' FOR UPDATE');
  assert.equal(estado.logBloqueos[1], 'SELECT ... FROM versiones WHERE id = 7 FOR UPDATE');

  assert.equal(resultado.versionReemplazada, '1');
    assert.equal(resultado.version.id, '7');
    assert.equal(resultado.version.estado, 'ACTIVA');
    assert.equal(resultado.version.fecha_activacion, '2026-10-21T18:00:00.000Z');
    assert.equal(estado.activa.estado, 'HISTORICA');
    const evento = estado.eventos[0];
    assert.equal(evento.tipoEvento, 'ACTIVACION');
    assert.equal(evento.tipoOperacion, null);
    assert.equal(evento.agrupadorId, null);
    assert.match(evento.detalle, /reemplaza a la version 1/);
  });

  test('rechaza activar estados no finales, sin filas o sin version activa', async () => {
    const { dependencias } = entornoEscritura({
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
    });
    await assert.rejects(
      activarVersionTarifario({ pool: true }, { id: '7' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_ESTADO', status: 409 },
    );

    const sinVersion = entornoEscritura({
      activa: null,
      versiones: [{
        id: 7, tipo: 'EDICION_LISTA', estado: 'LISTA_PARA_ACTIVAR',
        version_base_id: 1, actor_legajo: '1234567', revision: 0,
      }],
    });
    // Sin tarifas en el snapshot del borrador: rechaza antes de conmutar.
    await assert.rejects(
      activarVersionTarifario({ pool: true }, { id: '7' }, ACTOR_PRUEBA, sinVersion.dependencias),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    await assert.rejects(
      activarVersionTarifario({ pool: true }, { id: '500' }, ACTOR_PRUEBA, sinVersion.dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// Trazabilidad: resumen de eventos reales (014) y deshacer del ultimo
// cambio economico de un borrador. Entorno en memoria con semantica de
// transaccion (restaura estado si el caso de uso aborta).
// ─────────────────────────────────────────────────────────────────────

/**
 * Construye el entorno basico con un borrador POST-aumento y POST-edicion:
 * eventos 3 y 4 son los hijos del aumento masivo (agrupador 2) y el 5 es
 * una edicion individual posterior. Los precios de las tarifas reflejan
 * el estado despues de esas operaciones.
 * @param {object} overrides Mutaciones puntuales del entorno por prueba.
 * @returns {{estado: object, dependencias: object, llamadas: object[]}}
 */
function entornoDeshacer(overrides = {}) {
  const llamadas = [];
  const estado = {
    borrador: {
      id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 2,
      fecha_activacion: null, version_base_id: 1,
      actor_legajo: '1234567', created_at: new Date('2026-10-21T14:00:00Z'),
      nombre: 'Marcelo', apellido: 'Suarez',
    },
    tarifas: [
      { id: 501, version_id: 7, plan_id: 1, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '110.00' },
      { id: 502, version_id: 7, plan_id: 1, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '55.28' },
      { id: 503, version_id: 7, plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', precio: '45.50' },
    ],
    // Fuente historica para las pruebas de recuperacion funcional.
    fuente: {
      id: 5, tipo: 'EDICION_LISTA', estado: 'HISTORICA', revision: 7,
      fecha_activacion: new Date('2026-09-01T12:00:00Z'), version_base_id: 1,
      actor_legajo: '1234567', created_at: new Date('2026-08-30T10:00:00Z'),
      nombre: 'Marcelo', apellido: 'Suarez',
    },
    tarifasFuente: [
      { id: 401, version_id: 5, plan_id: 9, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', precio: '99.00' },
      { id: 402, version_id: 5, plan_id: 9, tipo_ingreso: 'Voluntario', rango_clave: '66+', precio: '49.99' },
    ],
    borradorAbierto: null,
    versiones: [],
    proximoBorradorId: 8,
    eventos: [
      { id: 1, version_id: 7, agrupador_id: null, tipo_evento: 'CREACION', tipo_operacion: null, plan_id: null, tipo_ingreso: null, rango_clave: null, valor_anterior: null, valor_nuevo: null, detalle: 'Creacion de la version 7.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:01:00Z') },
      { id: 2, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'AUMENTO_MASIVO', plan_id: null, tipo_ingreso: null, rango_clave: null, valor_anterior: null, valor_nuevo: null, detalle: 'Se aumento un 10% el valor. Obligatorio, Voluntario.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:02:00Z') },
      { id: 3, version_id: 7, agrupador_id: 2, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 1, tipo_ingreso: 'Obligatorio', rango_clave: '0-25', valor_anterior: '100.00', valor_nuevo: '110.00', detalle: 'mod. PRECIO del rango 0-25.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:02:01Z') },
      { id: 4, version_id: 7, agrupador_id: 2, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 1, tipo_ingreso: 'Voluntario', rango_clave: '66+', valor_anterior: '50.25', valor_nuevo: '55.28', detalle: 'mod. PRECIO del rango 66+.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:02:02Z') },
      { id: 5, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', valor_anterior: '30.00', valor_nuevo: '45.50', detalle: 'mod. PRECIO del rango HIJO 0-1.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:03:00Z') },
    ],
    siguienteEvento: 10,
    ...overrides,
  };
  //transaction semantics: abort rolls back revision, prices, and audited events.
  const dependencias = {
    async withConnection(pool, operation) {
      llamadas.push({ metodo: 'withConnection', pool });
      const revisionAntes = estado.borrador.revision;
      const preciosAntes = estado.tarifas.map((tarifa) => tarifa.precio);
      const eventosAntes = estado.eventos.length;
      const proximoAntes = estado.siguienteEvento;
      try {
        return await operation({
          async execute(sql) {
            if (sql.startsWith('SELECT nombre, apellido FROM empleados')) {
              return [[{ nombre: 'Marcelo', apellido: 'Suarez' }], []];
            }
            throw new Error(`SQL no contemplado: ${sql}`);
          },
        });
      } catch (error) {
        estado.borrador.revision = revisionAntes;
        estado.tarifas.forEach((tarifa, indice) => { tarifa.precio = preciosAntes[indice]; });
        estado.eventos = estado.eventos.slice(0, eventosAntes);
        estado.siguienteEvento = proximoAntes;
        throw error;
      }
    },
    async obtenerEmpleado(conexion, legajo) {
      return { legajo, nombre: 'Marcelo', apellido: 'Suarez' };
    },
    async bloquearVersion(conexion, id) {
      llamadas.push({ metodo: 'bloquearVersion', id });
      if (Number(id) === estado.borrador.id) return estado.borrador;
      if (Number(id) === estado.fuente.id) return estado.fuente;
      return null;
    },
    async bloquearBorradorAbierto(conexion) {
      llamadas.push({ metodo: 'bloquearBorradorAbierto' });
      return estado.borradorAbierto;
    },
    async insertarBorrador(conexion, datos) {
      llamadas.push({ metodo: 'insertarBorrador', ...datos });
      const id = estado.proximoBorradorId;
      estado.proximoBorradorId += 1;
      estado.versiones.push({
        id,
        tipo: 'EDICION_LISTA',
        estado: 'PREPARACION',
        version_base_id: datos.versionBaseId,
        actor_legajo: datos.actorLegajo,
        observacion: datos.observacion,
      });
      return id;
    },
    async copiarTarifas(conexion, { origenId, destinoId }) {
      llamadas.push({ metodo: 'copiarTarifas', origenId, destinoId });
      const origen = Number(origenId) === estado.fuente.id
        ? estado.tarifasFuente
        : estado.tarifas.filter((fila) => Number(fila.version_id) === Number(origenId));
      for (const fila of [...origen]) {
        estado.tarifas.push({ ...fila, id: fila.id + 100, version_id: Number(destinoId) });
      }
      return origen.length;
    },
    async incrementarRevision(conexion, { id, revision }) {
      const version = estado.borrador;
      if (Number(id) === version.id && Number(version.revision) === revision) {
        version.revision = revision + 1;
        return 1;
      }
      return 0;
    },
    async obtenerVersionPorId(conexion, versionId) {
      return Number(versionId) === estado.borrador.id ? estado.borrador : null;
    },
    async listarEventosDeVersion(conexion, versionId) {
      llamadas.push({ metodo: 'listarEventosDeVersion', versionId });
      return estado.eventos;
    },
    async resolverTarifaPorClave(conexion, clave) {
      llamadas.push({ metodo: 'resolverTarifaPorClave', ...clave });
      return estado.tarifas.find((tarifa) =>
        Number(tarifa.version_id) === Number(clave.versionId)
        && Number(tarifa.plan_id) === Number(clave.planId)
        && tarifa.tipo_ingreso === clave.tipoIngreso
        && tarifa.rango_clave === clave.rangoClave,
      ) ?? null;
    },
    async actualizarPrecioTarifa(conexion, { tarifaId, precio }) {
      llamadas.push({ metodo: 'actualizarPrecioTarifa', tarifaId, precio });
      const tarifa = estado.tarifas.find(
        (fila) => Number(fila.id) === Number(tarifaId),
      );
      if (tarifa) tarifa.precio = precio;
      return tarifa ? 1 : 0;
    },
    async insertarEvento(conexion, evento) {
      const id = estado.siguienteEvento;
      estado.siguienteEvento += 1;
      estado.eventos.push({ id, ...evento });
      return id;
    },
  };
  return { estado, dependencias, llamadas };
}
describe('recuperacion de versiones historicas', () => {
  test('crea el borrador copiando la fuente, conserva origen y audita CREACION', async () => {
    const { estado, dependencias, llamadas } = entornoDeshacer();
    const resultado = await crearBorradorDesdeHistorica(
      { pool: true }, { id: '5' }, ACTOR_PRUEBA, dependencias,
    );

    assert.equal(resultado.version.tipo, 'EDICION_LISTA');
    assert.equal(resultado.version.estado, 'PREPARACION');
    assert.equal(resultado.version.version_base_id, '5');
    assert.equal(resultado.version.evento.tipo, 'CREACION');
    const insertada = estado.versiones.find((v) => Number(v.id) === Number(resultado.version.id));
    assert.equal(insertada.version_base_id, 5);
    assert.ok(insertada.observacion.includes('historica'));
    // Copia completa de la fuente en el borrador nuevo.
    const copiadas = estado.tarifas.filter(
      (fila) => Number(fila.version_id) === Number(resultado.version.id),
    );
    assert.equal(copiadas.length, estado.tarifasFuente.length);
    assert.ok(llamadas.some((c) => c.metodo === 'copiarTarifas'
      && Number(c.origenId) === 5 && Number(c.destinoId) === Number(resultado.version.id)));
  });

  test('rechaza reanudar borradores o activas: solo el historial cerrado', async () => {
    const { dependencias } = entornoDeshacer();
    await assert.rejects(
      crearBorradorDesdeHistorica({ pool: true }, { id: '7' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
  });

  test('responde 409 si ya existe un borrador abierto de cualquier origen', async () => {
    const { estado, dependencias } = entornoDeshacer();
    // La exclusividad (uq_guard_borrador_version) se refleja a nivel de
    // servicio con un borrador abierto previo, sea regular o recuperado.
    estado.borradorAbierto = {
      ...estado.borrador,
      id: 99,
      observacion: 'Recuperacion de la version historica 5 al crear el borrador.',
    };
    await assert.rejects(
      crearBorradorDesdeHistorica({ pool: true }, { id: '5' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    await assert.rejects(
      crearBorradorDesdeHistorica({ pool: true }, { id: '9' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });

  test('la carrera de recuperacion devuelve 409 con el borrador ganador', async () => {
    const { dependencias } = entornoDeshacer();
    const ganador = {
      id: 10, estado: 'PREPARACION', actor_legajo: '7654321',
      created_at: new Date('2026-10-20T20:30:00Z'),
      nombre: 'Ana', apellido: 'Gomez',
    };
    let lecturas = 0;
    dependencias.bloquearBorradorAbierto = async () => {
      lecturas += 1;
      return lecturas === 1 ? null : ganador;
    };
    dependencias.insertarBorrador = async () => {
      throw Object.assign(new Error('duplicado'), { code: 'ER_DUP_ENTRY', errno: 1062 });
    };

    await assert.rejects(
      crearBorradorDesdeHistorica(
        { pool: true }, { id: '5' }, ACTOR_PRUEBA, dependencias,
      ),
      (error) => {
        assert.equal(error.code, 'ADMIN_ESTADO');
        assert.equal(error.status, 409);
        assert.match(error.message, /Ana Gomez/);
        return true;
      },
    );
  });
});


describe('trazabilidad: resumen de eventos y deshacer', () => {
  test('el resumen presenta los eventos reales, mas recientes primero', async () => {
    const { dependencias } = entornoDeshacer();
    const resultado = await resumirEventosDeVersion({ pool: true }, { id: '7' }, dependencias);

    assert.equal(resultado.version.id, '7');
    assert.equal(resultado.eventos.length, 5);
    // El mas reciente es la edicion individual (id 5).
    assert.deepEqual(resultado.eventos[0], {
      id: '5',
      tipo_evento: 'MODIFICACION',
      tipo_operacion: 'PRECIO',
      agrupador: null,
      filas_agrupadas: undefined,
      entidad: { plan_id: '2', tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1' },
      valor_anterior: '30.00',
      valor_nuevo: '45.50',
      detalle: 'mod. PRECIO del rango HIJO 0-1.',
      actor_legajo: '1234567',
      actor_nombre: 'Marcelo',
      actor_apellido: 'Suarez',
      evento_en: '2026-10-21T14:03:00.000Z',
    });
    // El cabezal del ritmo masivo reporta la cantidad real de hijos.
    const agrupador = resultado.eventos.find((evento) => evento.id === '2');
    assert.equal(agrupador.tipo_operacion, 'AUMENTO_MASIVO');
    assert.equal(agrupador.filas_agrupadas, 2);
    assert.equal(agrupador.entidad, null);
    // los hijos PRECIO agrupados reportan su grupo.
    const hijo = resultado.eventos.find((evento) => evento.id === '3');
    assert.equal(hijo.agrupador, '2');
    assert.equal(hijo.valor_anterior, '100.00');
  });

  test('el resumen responde 404 si la version no existe', async () => {
    const { dependencias } = entornoDeshacer();
    await assert.rejects(
      resumirEventosDeVersion({ pool: true }, { id: '9' }, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });

  test('deshace la edicion individual y restaura el precio auditado', async () => {
    const { estado, dependencias, llamadas } = entornoDeshacer();
    const resultado = await deshacerUltimoCambioEconomico(
      { pool: true },
      { id: '7' },
      { revision: '2' },
      ACTOR_PRUEBA,
      dependencias,
    );

    assert.equal(resultado.filas, 1);
    assert.equal(resultado.revision, 3);
    assert.equal(resultado.evento.tipo, 'DESHACER_EDICION');

    assert.equal(estado.tarifas.find((t) => t.id === 503).precio, '30.00');
    assert.equal(estado.tarifas.find((t) => t.id === 501).precio, '110.00');
    const registrado = estado.eventos.find(
      (evento) => Number(evento.id) === Number(resultado.evento.id),
    );
    assert.equal(registrado.tipoOperacion, 'PRECIO');
    assert.equal(registrado.agrupadorId, null);
    assert.equal(registrado.valorAnterior, '45.50');
    assert.equal(registrado.valorNuevo, '30.00');
    assert.ok(registrado.detalle.startsWith('DESHACE:'));
    assert.equal(llamadas.some((c) => c.metodo === 'resolverTarifaPorClave'), true);
  });

  test('deshace el ultimo aumento masivo completo con auditoria agrupada', async () => {
    // Primer deshacer (edicion individual) deja revision 3; el segundo
    // golpe debe deshacer el AUMENTO_MASIVO guardado en la auditoria.
    // Los eventos DESHACE y los cambios ya revertidos no se re-deshacen.
    const { estado, dependencias } = entornoDeshacer();
    await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias,
    );
    const resultado = await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '3' }, ACTOR_PRUEBA, dependencias,
    );

    assert.equal(resultado.filas, 2);
    assert.equal(resultado.revision, 4);
    assert.equal(resultado.evento.tipo, 'DESHACER_GRUPO');
    assert.equal(estado.tarifas.find((t) => t.id === 501).precio, '100.00');
    assert.equal(estado.tarifas.find((t) => t.id === 502).precio, '50.25');
    assert.equal(estado.tarifas.find((t) => t.id === 503).precio, '30.00');

    const grupo = estado.eventos.find(
      (evento) => Number(evento.id) === Number(resultado.evento.id),
    );
    assert.equal(grupo.tipoOperacion, 'AUMENTO_MASIVO');
    assert.equal(grupo.agrupadorId, null);
    assert.ok(grupo.detalle.startsWith('DESHACE:'));
    const hijos = estado.eventos.filter(
      (evento) => String(evento.agrupadorId ?? '') === String(grupo.id)
        && evento.tipoOperacion === 'PRECIO',
    );
    assert.equal(hijos.length, 2);
    for (const hijo of hijos) {
      assert.ok(hijo.detalle.startsWith('DESHACE:'));
      assert.equal(hijo.tipoOperacion, 'PRECIO');
    }
  });

  test('deshace por capas dos cambios consecutivos sobre la misma tarifa', async () => {
    const eventos = [
      { id: 1, version_id: 7, agrupador_id: null, tipo_evento: 'CREACION', tipo_operacion: null, detalle: 'Creacion.', evento_en: new Date('2026-10-21T14:01:00Z') },
      { id: 2, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', valor_anterior: '10.00', valor_nuevo: '20.00', detalle: 'Primer cambio.', evento_en: new Date('2026-10-21T14:02:00Z') },
      { id: 3, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', valor_anterior: '20.00', valor_nuevo: '30.00', detalle: 'Segundo cambio.', evento_en: new Date('2026-10-21T14:03:00Z') },
      { id: 4, version_id: 7, agrupador_id: null, tipo_evento: 'MODIFICACION', tipo_operacion: 'PRECIO', plan_id: 2, tipo_ingreso: 'Voluntario', rango_clave: 'HIJO 0-1', valor_anterior: '30.00', valor_nuevo: '20.00', detalle: 'DESHACE: segundo cambio.', evento_en: new Date('2026-10-21T14:04:00Z') },
    ];
    const { estado, dependencias } = entornoDeshacer({
      borrador: {
        id: 7, tipo: 'EDICION_LISTA', estado: 'PREPARACION', revision: 3,
        fecha_activacion: null, version_base_id: 1,
      },
      tarifas: [{
        id: 503, version_id: 7, plan_id: 2, tipo_ingreso: 'Voluntario',
        rango_clave: 'HIJO 0-1', precio: '20.00',
      }],
      eventos,
      siguienteEvento: 5,
    });

    const resultado = await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '3' }, ACTOR_PRUEBA, dependencias,
    );

    assert.equal(resultado.filas, 1);
    assert.equal(resultado.revision, 4);
    assert.equal(estado.tarifas[0].precio, '10.00');
    const registrado = estado.eventos.at(-1);
    assert.equal(registrado.valorAnterior, '20.00');
    assert.equal(registrado.valorNuevo, '10.00');
  });

  test('agarra la revision desfasada y rechaza el deshacer', async () => {
    const { estado, dependencias } = entornoDeshacer();
    await assert.rejects(
      deshacerUltimoCambioEconomico(
        { pool: true }, { id: '7' }, { revision: '0' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_CONCURRENCIA', status: 409 },
    );
    assert.equal(estado.borrador.revision, 2);
  });

  test('rechaza deshacer si el borrador no tiene cambios economicos', async () => {
    const { estado, dependencias } = entornoDeshacer({
      eventos: [
        { id: 1, version_id: 7, agrupador_id: null, tipo_evento: 'CREACION', tipo_operacion: null, plan_id: null, tipo_ingreso: null, rango_clave: null, valor_anterior: null, valor_nuevo: null, detalle: 'Creacion.', actor_legajo: '1234567', actor_nombre: 'Marcelo', actor_apellido: 'Suarez', evento_en: new Date('2026-10-21T14:01:00Z') },
      ],
    });
    await assert.rejects(
      deshacerUltimoCambioEconomico(
        { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(estado.borrador.revision, 2);
    assert.equal(estado.tarifas.find((t) => t.id === 503).precio, '45.50');
  });

  test('aborta sin aplicar nada si la fila ya no coincide con la auditoria', async () => {
    const { estado, dependencias } = entornoDeshacer();
    // Drift manual: alguien cambio la fila fuera de los casos de uso.
    estado.tarifas.find((t) => t.id === 503).precio = '99.99';
    await assert.rejects(
      deshacerUltimoCambioEconomico(
        { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(estado.borrador.revision, 2);
    assert.equal(estado.tarifas.find((t) => t.id === 503).precio, '99.99');
    assert.equal(estado.eventos.length, 5);
  });

  test('aborta sin aplicar nada si la fila del evento ya no existe', async () => {
    const { estado, dependencias, llamadas } = entornoDeshacer();
    dependencias.resolverTarifaPorClave = async (conexion, clave) => {
      llamadas.push({ metodo: 'resolverTarifaPorClave', clave });
      return null;
    };
    await assert.rejects(
      deshacerUltimoCambioEconomico(
        { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_ESTADO', status: 409 },
    );
    assert.equal(estado.borrador.revision, 2);
    assert.equal(estado.eventos.length, 5);
    assert.ok(llamadas.some((c) => c.metodo === 'resolverTarifaPorClave'));
  });

  test('no deshace versiones cerradas: solo borradores en preparacion', async () => {
    const { estado, dependencias } = entornoDeshacer({
      borrador: {
        id: 7, tipo: 'EDICION_LISTA', estado: 'LISTA_PARA_ACTIVAR', revision: 2,
        fecha_activacion: null, version_base_id: 1,
        actor_legajo: '1234567', created_at: new Date('2026-10-21T14:00:00Z'),
        nombre: 'Marcelo', apellido: 'Suarez',
      },
    });
    await assert.rejects(
      deshacerUltimoCambioEconomico(
        { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
    assert.equal(estado.tarifas.find((t) => t.id === 503).precio, '45.50');
  });
});

describe('reanudacion de edicion (Volver a edicion)', () => {
  test('LISTA_PARA_ACTIVAR vuelve a PREPARACION con evento REANUDACION y revision intacta', async () => {
    const entorno = entornoDeshacer();
    const { dependencias, llamadas, estado } = entorno;
    // La reapertura exige el estado LISTA_PARA_ACTIVAR; el doble del
    // entorno devolvia PREPARACION, asi que se reescribe la copia.
    estado.borrador = {
      id: 7, tipo: 'EDICION_LISTA', estado: 'LISTA_PARA_ACTIVAR', revision: 2,
      fecha_activacion: null, version_base_id: 1, actor_legajo: '1234567',
      created_at: new Date('2026-10-21T15:00:00Z'),
      nombre: 'Marcelo', apellido: 'Suarez',
    };
    // Reemplaza bloquearVersion para esta corrida puntual.
    dependencias.bloquearVersion = async (conexion, id) => {
      llamadas.push({ metodo: 'bloquearVersion', id });
      return Number(id) === estado.borrador.id ? estado.borrador : null;
    };
    dependencias.actualizarEstadoVersion = async (conexion, { id, estado: nuevoEstado }) => {
      llamadas.push({ metodo: 'actualizarEstadoVersion', id, estado: nuevoEstado });
    };

    const resultado = await reanudarEdicionVersion(
      { pool: true }, { id: '7' }, ACTOR_PRUEBA, dependencias,
    );

    assert.equal(resultado.version.tipo, 'EDICION_LISTA');
    assert.equal(resultado.version.estado, 'PREPARACION');
    assert.equal(resultado.version.revision, 2);
    assert.equal(resultado.evento.tipo, 'REANUDACION');
    const insertado = estado.eventos.find((e) => e.tipoEvento === 'REANUDACION');
    assert.ok(insertado, 'el evento REANUDACION queda registrado');
    assert.equal(insertado.tipoOperacion, null);
    assert.ok(insertado.detalle.includes('volvio a preparacion'));
    const aplastada = llamadas.find((c) => c.metodo === 'actualizarEstadoVersion');
    assert.equal(aplastada.estado, 'PREPARACION');
  });

  test('rechaza versiones que no estan listas para activar', async () => {
    const { dependencias } = entornoDeshacer();
    await assert.rejects(
      reanudarEdicionVersion({ pool: true }, { id: '7' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_TRANSICION', status: 409 },
    );
    await assert.rejects(
      reanudarEdicionVersion({ pool: true }, { id: '9' }, ACTOR_PRUEBA, dependencias),
      { code: 'ADMIN_NO_ENCONTRADO', status: 404 },
    );
  });

  test('el scanner del deshacer ignora los eventos REANUDACION', async () => {
    // Corrida base: detecta la ultima edicion solitaria disponible.
    const base = entornoDeshacer();
    await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, base.dependencias,
    );
    const referencia = base.llamadas.find((c) => c.metodo === 'resolverTarifaPorClave');

    // Mismo escenario con un evento REANUDACION al final: el candidato
    // del deshacer debe ser identico (no es un cambio economico).
    const conReanudacion = entornoDeshacer();
    conReanudacion.estado.eventos.push({
      id: conReanudacion.estado.siguienteEvento,
      version_id: 7,
      agrupador_id: null,
      tipo_evento: 'REANUDACION',
      tipo_operacion: null,
      plan_id: null,
      tipo_ingreso: null,
      rango_clave: null,
      valor_anterior: null,
      valor_nuevo: null,
      detalle: 'La version 7 volvio a preparacion (reapertura).',
      actor_legajo: '1234567',
      actor_nombre: 'Marcelo',
      actor_apellido: 'Suarez',
      evento_en: new Date('2026-10-21T17:00:00Z'),
    });
    conReanudacion.estado.siguienteEvento += 1;
    await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, conReanudacion.dependencias,
    );
    const candidato = conReanudacion.llamadas.find((c) => c.metodo === 'resolverTarifaPorClave');
    assert.deepEqual(candidato, referencia);
  });
});

describe('descarte de versiones no activadas', () => {
  /**
   * Prepara el entorno comun del descarte: borrador editable (o lista
   * para activar segun el estado pedido) y captura del cambio de estado.
   * @param {string} estadoBorrador Estado inicial de la version 7.
   * @param {number|null} revision Revision optica del doble (null para desfasar).
   * @returns {object} Entorno con estado, dependencias y llamadas.
   */
  function entornoDescarte(estadoBorrador, revision = 2) {
    const entorno = entornoDeshacer();
    entorno.estado.borrador = {
      ...entorno.estado.borrador,
      estado: estadoBorrador,
      revision,
      fecha_activacion: null,
    };
    entorno.dependencias.bloquearVersion = async (conexion, id) => {
      entorno.llamadas.push({ metodo: 'bloquearVersion', id });
      return Number(id) === entorno.estado.borrador.id ? entorno.estado.borrador : null;
    };
    entorno.dependencias.actualizarEstadoVersion = async (conexion, { estado: nuevoEstado }) => {
      entorno.llamadas.push({ metodo: 'actualizarEstadoVersion', estado: nuevoEstado });
      return 1;
    };
    return entorno;
  }

  test('descarta PREPARACION conservando tipo y numeracion, con evento DESCARTE y motivo', async () => {
    const entorno = entornoDescarte('PREPARACION');
    const resultado = await descartarVersionTarifario(
      { pool: true }, { id: '7' },
      { revision: '2', motivo: 'Lista provisoria para discutir con el cliente.' },
      ACTOR_PRUEBA, entorno.dependencias,
    );

    // El estado interno reutiliza el valor heredado CANCELADA; la
    // pantalla lo muestra como Descartada (sin estados redundantes).
    assert.equal(resultado.version.estado, 'CANCELADA');
    assert.equal(resultado.version.tipo, 'EDICION_LISTA');
    assert.equal(resultado.version.id, '7');
    assert.equal(resultado.evento.tipo, 'DESCARTE');
    const aplastada = entorno.llamadas.find((c) => c.metodo === 'actualizarEstadoVersion');
    assert.equal(aplastada.estado, 'CANCELADA');
    const insertado = entorno.estado.eventos.find(
      (evento) => evento.tipoEvento === 'DESCARTE',
    );
    assert.ok(insertado, 'el evento DESCARTE queda registrado');
    assert.equal(insertado.tipoOperacion, null);
    assert.ok(insertado.detalle.includes('Descarte de la version 7'));
    assert.ok(insertado.detalle.includes('Motivo: Lista provisoria'));
    // Responsable real del actor de la transaccion.
    assert.equal(insertado.actorLegajo, '1234567');
  });

  test('descarta LISTA_PARA_ACTIVAR con el mismo flujo', async () => {
    const entorno = entornoDescarte('LISTA_PARA_ACTIVAR');
    const resultado = await descartarVersionTarifario(
      { pool: true }, { id: '7' },
      { revision: '2', motivo: 'Se soinieron los precios del nuevo ano.' },
      ACTOR_PRUEBA, entorno.dependencias,
    );
    assert.equal(resultado.version.estado, 'CANCELADA');
    assert.ok(
      entorno.estado.eventos.some((evento) => evento.tipoEvento === 'DESCARTE'),
      'el evento del descarte quedo auditado',
    );
  });

  test('rechaza ACTIVA, HISTORICA y versiones ya descartadas', async () => {
    for (const estadoProhibido of ['ACTIVA', 'HISTORICA', 'CANCELADA']) {
      const entorno = entornoDescarte(estadoProhibido);
      await assert.rejects(
        descartarVersionTarifario(
          { pool: true }, { id: '7' },
          { revision: '2', motivo: 'Prueba de rechazo.' },
          ACTOR_PRUEBA, entorno.dependencias,
        ),
        { code: 'ADMIN_TRANSICION', status: 409 },
      );
    }
  });

  test('rechaza revision desfasada frente a como concurrente', async () => {
    const { dependencias } = entornoDescarte('PREPARACION', 3);
    await assert.rejects(
      descartarVersionTarifario(
        { pool: true }, { id: '7' },
        { revision: '2', motivo: 'Motivo con revision vieja.' },
        ACTOR_PRUEBA, dependencias,
      ),
      { code: 'ADMIN_CONCURRENCIA', status: 409 },
    );
  });

  test('exige motivo de negocio dentro del rango', async () => {
    const entorno = entornoDescarte('PREPARACION');
    await assert.rejects(
      descartarVersionTarifario(
        { pool: true }, { id: '7' },
        { revision: '2', motivo: '   ' },
        ACTOR_PRUEBA, entorno.dependencias,
      ),
      { code: 'ADMIN_VALIDACION', status: 400 },
    );
    await assert.rejects(
      descartarVersionTarifario(
        { pool: true }, { id: '7' },
        { revision: '2', motivo: 'x'.repeat(201) },
        ACTOR_PRUEBA, entorno.dependencias,
      ),
      { code: 'ADMIN_VALIDACION', status: 400 },
    );
  });

  test('el scanner del deshacer ignora los eventos DESCARTE como REANUDACION', async () => {
    // El evento del descarte es de ciclo de vida (sin entidad): no puede
    // habilitar reversiones reales ni generar cambios reversibles falsos.
    const base = entornoDeshacer();
    await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, base.dependencias,
    );
    const referencia = base.llamadas.find((c) => c.metodo === 'resolverTarifaPorClave');

    const conDescarte = entornoDeshacer();
    conDescarte.estado.eventos.push({
      id: conDescarte.estado.siguienteEvento,
      version_id: 7,
      agrupador_id: null,
      tipo_evento: 'DESCARTE',
      tipo_operacion: null,
      plan_id: null,
      tipo_ingreso: null,
      rango_clave: null,
      valor_anterior: null,
      valor_nuevo: null,
      detalle: 'Descarte de la version 7. Motivo: prueba.',
      actor_legajo: '1234567',
      actor_nombre: 'Marcelo',
      actor_apellido: 'Suarez',
      evento_en: new Date('2026-10-21T18:00:00Z'),
    });
    conDescarte.estado.siguienteEvento += 1;
    await deshacerUltimoCambioEconomico(
      { pool: true }, { id: '7' }, { revision: '2' }, ACTOR_PRUEBA, conDescarte.dependencias,
    );
    const candidato = conDescarte.llamadas.find((c) => c.metodo === 'resolverTarifaPorClave');
    assert.deepEqual(candidato, referencia);
  });
});

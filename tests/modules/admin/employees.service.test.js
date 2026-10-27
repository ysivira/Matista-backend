// Pruebas unitarias del servicio ADMIN de empleados (SL-1) contra un
// repositorio sintetico con el mismo contrato que las bolsas AUTH y ADMIN
// (sin base de datos ni drivers). Comprueban la matriz de transiciones
// aprobada, los guardias de seguridad, la auditoria en la misma
// transaccion, la revocacion de sesiones y el rollback ante fallos.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  gestionarDetalle, gestionarEstado, gestionarListado, gestionarRol,
  permitirTransicion,
} from '../../../src/modules/admin/employees.service.js';
import { createAppError } from '../../../src/shared/errors/app-error.js';

const NOW = new Date('2026-10-15T12:00:00Z');

/** Crea un estado sintetico y su repositorio doble con rollback real.
 * `variantes` permite seeds por prueba.
 */
function crearDoble({ empleados = [], sesiones = [], correos = [] } = {}) {
  const estado = { empleados, correos, sesiones, auditoria: [], escrituras: [] };
  let sequence = 1;
  // Candado del conjunto de ADMIN activos: simula el FOR UPDATE real. La
  // operacion siguiente espera a que la anterior termine (commit o
  // rollback), y el snapshot de rollback se toma en ese punto de
  // serializacion para no deshacer cambios ya confirmados por otra.
  let candado = Promise.resolve();

  const repositorio = {
    /** Ejecuta `operacion` con control transaccional propio y restaura los datos ante un error. */
    async withConnection(pool, operacion, { transaction = false } = {}) {
      const antes = structuredClone(estado);
      // Cada conexion conserva su snapshot y su liberador fuera de los datos
      // clonables; una operacion no puede liberar el candado de otra.
      const connection = { conexion: true };
      try {
        const resultado = await operacion(connection);
        estado.comit = transaction ? 'COMMIT' : 'AUTO';
        return resultado;
      } catch (error) {
        // El punto de serializacion del bloqueo es el equivalente real al
        // inicio de la transaccion: si se tomo ahi, el rollback no revierte
        // cambios confirmados por otra operacion concurrente.
        if (transaction) Object.assign(estado, structuredClone(connection.antesBloqueo ?? antes));
        throw error;
      } finally {
        connection.soltarCandado?.();
      }
    },
    /** Serializa los ADMIN activos y guarda en `connection` el snapshot y liberador propios. */
    async bloquearAdminsActivos(connection) {
      estado.escrituras.push({ op: 'bloquearAdminsActivos' });
      const esperarPrevia = candado;
      let soltar;
      candado = new Promise((resolver) => { soltar = resolver; });
      await esperarPrevia;
      connection.soltarCandado = soltar;
      connection.antesBloqueo = structuredClone(estado);
    },
    /** Igual a AUTH: fila interna completa, sin distinguir lock en memoria. */
    async findEmployee(connection, legajo, lock) {
      estado.escrituras.push({ op: 'findEmployee', legajo, lock });
      return structuredClone(estado.empleados.find((e) => e.legajo === legajo));
    },
    /** Igual a AUTH: correos del legajo con estado y verificacion. */
    async findEmails(connection, legajo, lock) {
      estado.escrituras.push({ op: 'findEmails', legajo, lock });
      return structuredClone(estado.correos.filter((c) => c.legajo === legajo));
    },
    /** Cuenta ADMIN activos excluyendo al objetivo, como el SQL real. */
    async contarAdminsActivos(connection, legajoExcluido) {
      estado.escrituras.push({ op: 'contarAdminsActivos', legajoExcluido });
      return estado.empleados.filter((e) => e.legajo !== legajoExcluido
        && e.rol === 'ADMIN' && e.estado === 'ACTIVO').length;
    },
    /** Escribe el nuevo estado y queda observable para la prueba. */
    async actualizarEstado(connection, legajo, nuevo) {
      estado.escrituras.push({ op: 'actualizarEstado', legajo, nuevo });
      Object.assign(estado.empleados.find((e) => e.legajo === legajo), { estado: nuevo });
    },
    /** Escribe el nuevo rol y queda observable para la prueba. */
    async actualizarRol(connection, legajo, nuevo) {
      estado.escrituras.push({ op: 'actualizarRol', legajo, nuevo });
      Object.assign(estado.empleados.find((e) => e.legajo === legajo), { rol: nuevo });
    },
    /** Revoca las sesiones abiertas del legajo con el motivo recibido. */
    async revokeSessions(connection, legajo, reason, date) {
      estado.escrituras.push({ op: 'revokeSessions', legajo, reason, date });
      for (const sesion of estado.sesiones) {
        if (sesion.legajo === legajo && !sesion.revoked_at) {
          sesion.revoked_at = date;
          sesion.revocation_reason = reason;
        }
      }
    },
    /** Registra auditoria observable para las pruebas. */
    async audit(connection, legajo, actor, evento, campo, previa, nueva, date) {
      estado.escrituras.push({ op: 'audit', legajo, acto: actor, evento, campo, previa, nueva, date });
      estado.auditoria.push({ legajo, actor, evento, campo, previa, nueva, date: date });
    },
    /** Pasarela de busqueda: mantiene el patron tal como llega. */
    escaparBusqueda(texto) { return texto.trim().replace(/([%_\\])/g, '\\$1'); },
    /** Lista con los mismos filtros del SQL real (subconjunto verificado). */
    async listarEmpleados(connection, filtros) {
      let filas = structuredClone(estado.empleados).map((e) => ({
        ...e, email: estado.correos.find((c) => c.legajo === e.legajo)?.email ?? null,
      }));
      if (filtros.estado) filas = filas.filter((e) => e.estado === filtros.estado);
      if (filtros.rol) filas = filas.filter((e) => e.rol === filtros.rol);
      if (filtros.busqueda) {
        const patron = filtros.busqueda.toLowerCase();
        filas = filas.filter((e) => (e.legajo)?.toLowerCase().includes(patron)
          || (e.nombre ?? '').toLowerCase().includes(patron)
          || (e.apellido ?? '').toLowerCase().includes(patron)
          || (e.email ?? '').toLowerCase().includes(patron));
      }
      return filas.map(({ password_hash: _omit, ...publica }) => publica);
    },
    /** Detalle de un legajo o undefined, imitando la consulta LEFT JOIN. */
    async obtenerEmpleado(connection, legajo) {
      const fila = estado.empleados.find((e) => e.legajo === legajo);
      if (!fila) return undefined;
      const { password_hash: _omit, ...publica } = fila;
      return { ...publica, email: estado.correos.find((c) => c.legajo === legajo)?.email ?? null };
    },
  };
  return { estado, repositorio };
}

/** Empleado sintetico estandar. */
function empleado(legajo, { rol = 'ASESOR', estado = 'ACTIVO' } = {}) {
  return {
    legajo, nombre: 'Nombre', apellido: `Apellido-${legajo}`, password_hash: 'hash',
    rol, estado,
  };
}

/** Afirma que la promesa rechaza con el codigo publico esperado. */
async function rechazaCon(promise, codigo, httpStatus) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, codigo);
    assert.equal(error.status, httpStatus);
    return true;
  });
}

test('la matriz de transiciones solo permite los pares aprobados', () => {
  const paresPermitidos = [
    ['PENDIENTE', 'ACTIVO'],
    ['ACTIVO', 'INACTIVO'], ['ACTIVO', 'BAJA'],
    ['INACTIVO', 'ACTIVO'], ['INACTIVO', 'BAJA'],
  ];
  for (const [desde, hasta] of paresPermitidos) {
    assert.equal(permitirTransicion(desde, hasta), true, `${desde} -> ${hasta}`);
  }
  const todos = ['PENDIENTE', 'ACTIVO', 'INACTIVO', 'BAJA'];
  for (const desde of todos) {
    for (const hasta of todos) {
      if (!paresPermitidos.some(([d, h]) => d === desde && h === hasta)) {
        assert.equal(permitirTransicion(desde, hasta), false, `${desde} -> ${hasta}`);
      }
    }
  }
});

/** Correo ACTUAL verificado sintetico del legajo dado. */
function correoVerificado(legajo) {
  return {
    id: 1, legajo, email: `${legajo}@matista.test`, estado: 'ACTUAL', verificado_at: NOW,
  };
}

test('activa PENDIENTE dejando auditoria y sin tocar sesiones', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { estado: 'PENDIENTE' })],
    sesiones: [{ jti: 'j1', legajo: '0000000099', revoked_at: null }],
    correos: [correoVerificado('0000000099')],
  });
  const resultado = await gestionarEstado({}, '0000000001', '0000000099', 'ACTIVO', NOW, doble.repositorio);

  assert.deepEqual(resultado, { legajo: '0000000099', estado: 'ACTIVO', rol: 'ASESOR' });
  assert.deepEqual(estadoFinal(doble, '0000000099'), { estado: 'ACTIVO', rol: 'ASESOR' });
  assert.deepEqual(doble.estado.auditoria, [{
    legajo: '0000000099', actor: '0000000001', evento: 'ESTADO_CAMBIADO', campo: 'ESTADO',
    previa: 'PENDIENTE', nueva: 'ACTIVO', date: NOW,
  }]);
  assert.ok(!doble.estado.escrituras.some((e) => e.op === 'revokeSessions'),
    'la activacion no debe revocar sesiones');
  // La regla SPEC-25 consulta los correos con lock antes de activar.
  assert.deepEqual(doble.estado.escrituras.filter((e) => e.op === 'findEmails'), [{
    op: 'findEmails', legajo: '0000000099', lock: true,
  }]);
});

test('exige correo ACTUAL verificado para activar una cuenta PENDIENTE', async () => {
  // Casos sin correo habilitante: sin correos, solo correo PENDIENTE y solo
  // correo ANTERIOR ya verificado; ninguno reemplaza al ACTUAL verificado.
  const casos = [
    ['sin correos', []],
    ['solo correo pendiente sin verificar', [
      { id: 7, legajo: '0000000099', email: 'n@matista.test', estado: 'PENDIENTE', verificado_at: null },
    ]],
    ['solo correo anterior verificado', [{
      id: 8, legajo: '0000000099', email: 'vieja@matista.test', estado: 'ANTERIOR', verificado_at: NOW,
    }]],
  ];
  for (const [nombre, correos] of casos) {
    const doble = crearDoble({
      empleados: [empleado('0000000001', { rol: 'ADMIN' }),
        empleado('0000000099', { estado: 'PENDIENTE' })],
      correos,
    });
    await rechazaCon(
      gestionarEstado({}, '0000000001', '0000000099', 'ACTIVO', NOW, doble.repositorio),
      'ADMIN_ESTADO', 409,
    );
    assert.equal(
      doble.estado.escrituras.filter((e) => e.op === 'actualizarEstado').length, 0,
      `no debe escribir el estado en el caso ${nombre}`,
    );
    assert.equal(doble.estado.auditoria.length, 0, `sin auditoria en el caso ${nombre}`);
    assert.equal(estadoFinal(doble, '0000000099')?.estado, 'PENDIENTE');
  }
});

test('exige correo ACTUAL verificado para reactivar una cuenta INACTIVO', async () => {
  const sin = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { estado: 'INACTIVO' })],
  });
  await rechazaCon(
    gestionarEstado({}, '0000000001', '0000000099', 'ACTIVO', NOW, sin.repositorio),
    'ADMIN_ESTADO', 409,
  );
  assert.equal(estadoFinal(sin, '0000000099')?.estado, 'INACTIVO');

  const con = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { estado: 'INACTIVO' })],
    correos: [correoVerificado('0000000099')],
  });
  const resultado = await gestionarEstado({}, '0000000001', '0000000099', 'ACTIVO', NOW, con.repositorio);
  assert.equal(resultado.estado, 'ACTIVO');
});

/** Atajo de lectura del doble. */
function estadoFinal(doble, legajo) {
  const fila = doble.estado.empleados.find((e) => e.legajo === legajo);
  return { estado: fila?.estado, rol: fila?.rol };
}

test('desactiva ACTIVO revocando todas las sesiones con ACCOUNT_DISABLED', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099')],
    sesiones: [
      { jti: 'j1', legajo: '0000000099', revoked_at: null },
      { jti: 'j2', legajo: '0000000099', revoked_at: NOW },
    ],
  });
  await gestionarEstado({}, '0000000001', '0000000099', 'INACTIVO', NOW, doble.repositorio);

  assert.equal(estadoFinal(doble, '0000000099').estado, 'INACTIVO');
  const revocada = doble.estado.sesiones.find((s) => s.jti === 'j1');
  assert.equal(revocada.revocation_reason, 'ACCOUNT_DISABLED');
  assert.ok(revocada.revoked_at);
  assert.equal(doble.estado.auditoria[0]?.evento, 'ESTADO_CAMBIADO');
});

test('la BAJA es terminal: BAJA a cualquier destino rechaza 409 sin escribir', async () => {
  for (const destino of ['ACTIVO', 'INACTIVO', 'BAJA', 'PENDIENTE']) {
    const doble = crearDoble({
      empleados: [empleado('0000000001', { rol: 'ADMIN' }),
        empleado('0000000099', { estado: 'BAJA', rol: 'ASESOR' })],
    });
    await rechazaCon(
      gestionarEstado({}, '0000000001', '0000000099', destino, NOW, doble.repositorio),
      'ADMIN_TRANSICION', 409,
    );
    assert.equal(doble.estado.escrituras.filter((e) => e.op === 'actualizarEstado').length, 0);
  }
});

test('rechaza transiciones no aprobadas y deja los datos intactos', async () => {
  const casos = [
    ['PENDIENTE', 'INACTIVO'], ['PENDIENTE', 'BAJA'],
    ['INACTIVO', 'PENDIENTE'], ['ACTIVO', 'PERCLE'],
  ];
  for (const [desde, destino] of casos) {
    if (destino === 'PERCLE') continue;
    const doble = crearDoble({
      empleados: [empleado('0000000001', { rol: 'ADMIN' }),
        empleado('0000000099', { estado: desde })],
    });
    await rechazaCon(
      gestionarEstado({}, '0000000001', '0000000099', destino, NOW, doble.repositorio),
      'ADMIN_TRANSICION', 409,
    );
    assert.equal(estadoFinal(doble, '0000000099').estado, desde);
  }
});

test('prohibe desactivar o dar de baja al ultimo ADMIN activo', async () => {
  for (const destino of ['INACTIVO', 'BAJA']) {
    const doble = crearDoble({
      empleados: [empleado('0000000001', { rol: 'ADMIN' })],
    });
    await rechazaCon(
      gestionarEstado({}, '9000000001', '0000000001', destino, NOW, doble.repositorio),
      'ULTIMO_ADMIN_PROTEGIDO', 409,
    );
    assert.equal(estadoFinal(doble, '0000000001').estado, 'ACTIVO');
  }
});

test('permite desactivar un ADMIN cuando existe otro ADMIN activo', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('9000000002', { rol: 'ADMIN' }),
      empleado('0000000099', { rol: 'ADMIN' })],
  });
  await gestionarEstado({}, '0000000001', '0000000099', 'INACTIVO', NOW, doble.repositorio);
  assert.equal(estadoFinal(doble, '0000000099').estado, 'INACTIVO');
});

test('dos desactivaciones concurrentes del par de ADMIN no dejan cero activos', async () => {
  // Reproduce la carrera de la auditoria: sin bloquear el conjunto de ADMIN
  // activos, cada desactivacion cuenta al otro como activo y ambas se
  // aprueban mutuamente. Con la correccion, exactamente una gana y la otra
  // se rechaza con ULTIMO_ADMIN_PROTEGIDO.
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000002', { rol: 'ADMIN' })],
  });
  const resultados = await Promise.allSettled([
    gestionarEstado({}, '9000000009', '0000000001', 'INACTIVO', NOW, doble.repositorio),
    gestionarEstado({}, '9000000009', '0000000002', 'INACTIVO', NOW, doble.repositorio),
  ]);
  const exitosas = resultados.filter((r) => r.status === 'fulfilled');
  const rechazadas = resultados.filter((r) => r.status === 'rejected');

  assert.equal(exitosas.length, 1, 'exactamente una desactivacion debe confirmarse');
  assert.equal(rechazadas.length, 1, 'la otra debe rechazarse por ultimo ADMIN');
  assert.equal(rechazadas[0].reason.code, 'ULTIMO_ADMIN_PROTEGIDO');
  assert.equal(
    doble.estado.empleados.filter((e) => e.rol === 'ADMIN' && e.estado === 'ACTIVO').length,
    1,
    'siempre queda un ADMIN activo',
  );
});

test('dos degradaciones de rol concurrentes del par de ADMIN no dejan cero activos', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000002', { rol: 'ADMIN' })],
  });
  const resultados = await Promise.allSettled([
    gestionarRol({}, '9000000009', '0000000001', 'ASESOR', NOW, doble.repositorio),
    gestionarRol({}, '9000000009', '0000000002', 'ASESOR', NOW, doble.repositorio),
  ]);
  const exitosas = resultados.filter((r) => r.status === 'fulfilled');
  const rechazadas = resultados.filter((r) => r.status === 'rejected');

  assert.equal(exitosas.length, 1);
  assert.equal(rechazadas.length, 1);
  assert.equal(rechazadas[0].reason.code, 'ULTIMO_ADMIN_PROTEGIDO');
  assert.equal(
    doble.estado.empleados.filter((e) => e.rol === 'ADMIN' && e.estado === 'ACTIVO').length,
    1,
  );
});

test('prohibe operar la propia cuenta por estado o rol', async () => {
  const doble = crearDoble({ empleados: [empleado('0000000001', { rol: 'ADMIN' })] });
  await rechazaCon(
    gestionarEstado({}, '0000000001', '0000000001', 'INACTIVO', NOW, doble.repositorio),
    'OPERACION_PROPIA_NO_PERMITIDA', 409,
  );
  await rechazaCon(
    gestionarRol({}, '0000000001', '0000000001', 'ASESOR', NOW, doble.repositorio),
    'OPERACION_PROPIA_NO_PERMITIDA', 409,
  );
  assert.equal(doble.estado.escrituras.length, 0, 'sin escrituras ni consultas');
});

test('valida los valores antes de tocar la base', async () => {
  const doble = crearDoble({ empleados: [empleado('0000000001', { rol: 'ADMIN' })] });
  await rechazaCon(
    gestionarEstado({}, '0000000001', '0000000099', 'EXTRAÑO', NOW, doble.repositorio),
    'ADMIN_VALIDACION', 400,
  );
  await rechazaCon(
    gestionarRol({}, '0000000001', '0000000099', 'BOSS', NOW, doble.repositorio),
    'ADMIN_VALIDACION', 400,
  );
  await rechazaCon(
    gestionarListado({}, { estado: 'FERIADO' }, doble.repositorio),
    'ADMIN_VALIDACION', 400,
  );
  await rechazaCon(
    gestionarListado({}, { rol: 'JEFE' }, doble.repositorio),
    'ADMIN_VALIDACION', 400,
  );
});

test('responde 404 canonico para cuentas inexistentes', async () => {
  const doble = crearDoble({ empleados: [empleado('0000000001', { rol: 'ADMIN' })] });
  await rechazaCon(
    gestionarEstado({}, '0000000001', '9999999999', 'INACTIVO', NOW, doble.repositorio),
    'ADMIN_NO_ENCONTRADO', 404,
  );
  await rechazaCon(
    gestionarDetalle({}, '9999999999', doble.repositorio),
    'ADMIN_NO_ENCONTRADO', 404,
  );
});

test('cambia rol entre ACTIVO, audita ROL_CAMBIADO y protege al ultimo ADMIN', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { rol: 'ASESOR' })],
  });
  const promovio = await gestionarRol({}, '0000000001', '0000000099', 'ADMIN', NOW, doble.repositorio);
  assert.deepEqual(promovio, { legajo: '0000000099', rol: 'ADMIN', estado: 'ACTIVO' });
  assert.deepEqual(doble.estado.auditoria[0], {
    legajo: '0000000099', actor: '0000000001', evento: 'ROL_CAMBIADO', campo: 'ROL',
    previa: 'ASESOR', nueva: 'ADMIN', date: NOW,
  });

  // El objetivo ahora es ADMIN activo y hay otro ADMIN activo: degradar funciona.
  const degrado = await gestionarRol({}, '0000000001', '0000000099', 'ASESOR', NOW, doble.repositorio);
  assert.equal(degrado.rol, 'ASESOR');

  // Dejar de ser el ultimo ADMIN activo esta prohibido.
  const ultimo = crearDoble({ empleados: [empleado('0000000001', { rol: 'ADMIN' })] });
  await rechazaCon(
    gestionarRol({}, '9000009002', '0000000001', 'ASESOR', NOW, ultimo.repositorio),
    'ULTIMO_ADMIN_PROTEGIDO', 409,
  );
});

test('rechaza cambiar rol a cuentas no activas o con el mismo rol', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { estado: 'PENDIENTE' })],
  });
  await rechazaCon(
    gestionarRol({}, '0000000001', '0000000099', 'ADMIN', NOW, doble.repositorio),
    'ADMIN_ESTADO', 409,
  );
  const doble2 = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }), empleado('0000000099', { rol: 'ASESOR' })],
  });
  await rechazaCon(
    gestionarRol({}, '0000000001', '0000000099', 'ASESOR', NOW, doble2.repositorio),
    'ADMIN_VALIDACION', 400,
  );
});

test('el rollback de la transaccion deshace UPDATE, revocaciones y auditoria', async () => {
  const doble = crearDoble({
    empleados: [empleado('0000000001', { rol: 'ADMIN' }), empleado('0000000099')],
    sesiones: [{ jti: 'j1', legajo: '0000000099', revoked_at: null }],
  });
  // Un repositorio parcialmente roto: el UPDATE funciona pero la auditoria falla.
  const roto = { ...doble.repositorio };
  roto.audit = () => { throw createAppError('ADMIN_INTEGRIDAD', 'Fallo forzado.', 409); };

  await rechazaCon(
    gestionarEstado({}, '0000000001', '0000000099', 'INACTIVO', NOW, roto),
    'ADMIN_INTEGRIDAD', 409,
  );
  assert.equal(estadoFinal(doble, '0000000099').estado, 'ACTIVO', 'rollback revertio el estado');
  assert.ok(!doble.estado.sesiones[0].revoked_at, 'rollback revertio la revocacion');
  assert.equal(doble.estado.auditoria.length, 0);
});

test('listar filtra por estado, rol y busqueda, exponiendo solo datos publicos', async () => {
  const doble = crearDoble({
    empleados: [
      empleado('0000000001', { rol: 'ADMIN' }),
      empleado('0000000099', { estado: 'PENDIENTE' }),
      empleado('0000000098', { estado: 'BAJA' }),
    ],
    correos: [{ legajo: '0000000001', email: 'admin@matista.test', estado: 'ACTUAL' }],
  });
  doble.estado.correos[0] = { legajo: '0000000001', email: 'admin@matista.test', estado: 'ACTUAL' };

  const todos = await gestionarListado({}, {}, doble.repositorio);
  assert.equal(todos.length, 3);
  assert.ok(!todos.some((f) => 'password_hash' in f), 'sin credenciales en el listado');

  const pendientes = await gestionarListado({}, { estado: 'PENDIENTE' }, doble.repositorio);
  assert.deepEqual(pendientes.map((f) => f.legajo), ['0000000099']);

  const admins = await gestionarListado({}, { rol: 'ADMIN' }, doble.repositorio);
  assert.deepEqual(admins.map((f) => f.legajo), ['0000000001']);

  const porBusqueda = await gestionarListado({}, { busqueda: 'admin@matista' }, doble.repositorio);
  assert.deepEqual(porBusqueda.map((f) => f.legajo), ['0000000001']);
  assert.equal(porBusqueda[0].email, 'admin@matista.test');

  const detalle = await gestionarDetalle({}, '0000000001', doble.repositorio);
  assert.equal(detalle.email, 'admin@matista.test');
  assert.ok(!('password_hash' in detalle));
});

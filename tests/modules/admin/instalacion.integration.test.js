/** Opt-in: solo matista_local. Nunca crea, borra ni limpia bases existentes. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { loadDatabaseConfig } from '../../../src/infrastructure/database/config.js';
import { assertLocalInstallationTarget } from '../../../src/infrastructure/database/local-installation.js';
import { createDatabasePool } from '../../../src/infrastructure/database/connection.js';
import { loadSecurityConfig } from '../../../src/infrastructure/security/config.js';
import { hashPassword, verifyPassword } from '../../../src/infrastructure/security/password.js';
import { ejecutarCargaAutonoma } from '../../../src/modules/admin/instalacion.service.js';
import { ADMIN_DEMO } from '../../../src/modules/admin/admin-demo.service.js';
import * as repository from '../../../src/modules/auth/auth.repository.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const archivo = fileURLToPath(new URL('../../../database/seed/carga_inicial_autonoma.json', import.meta.url));
const habilitada = process.env.RUN_INSTALL_DB_TESTS === '1';
const tablasCatalogo = [
  'planes', 'tarifario_versiones', 'tarifas', 'monotributo_aportes',
  'politica_comercial', 'porcentajes_comerciales', 'empleados',
  'empleados_correos', 'empleados_auditoria', 'schema_migrations'
];

/** Compara contenidos completos sin imprimir datos personales, hashes o credenciales. */
async function fingerprint(pool) {
  const hash = createHash('sha256');
  for (const tabla of tablasCatalogo) {
    const [rows] = await pool.query(`SELECT * FROM ${tabla} ORDER BY 1`);
    hash.update(JSON.stringify(rows));
  }
  return hash.digest('hex');
}

test('instalación autónoma sobre MySQL local descartable (CA-01 a CA-11)', {
  skip: !habilitada, timeout: 120000
}, async t => {
  const config = loadDatabaseConfig(process.env);
  assertLocalInstallationTarget(config); // antes de abrir el pool o ejecutar cualquier comando
  const pool = createDatabasePool(config);
  t.after(() => pool.end());
  const env = {
    ...process.env, NODE_ENV: 'development', DB_NAME: 'matista_local', DB_HOST: config.host,
    DB_SSL: 'false', PASSWORD_MIN_LENGTH: '4', JWT_SECRET: randomBytes(32).toString('base64url'),
    FRONTEND_ORIGIN: 'http://localhost:5173',
    // No hay credenciales SIGEC utilizables: ningún paso debe intentar conectarse.
    SIGEC_DB_HOST: 'source-not-available.invalid', SIGEC_DB_USER: '', SIGEC_DB_PASSWORD: ''
  };
  const cli = (script, overrides = {}, expected = 0) => {
    const result = spawnSync(process.execPath, [`scripts/${script}.js`], {
      cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 30000
    });
    assert.equal(result.status, expected, `Falló ${script}: ${result.stderr}`);
    return result.stdout;
  };

  await t.test('CA-01: esquema completo y checksums; repetir migraciones no altera el historial', async () => {
    const salida = cli('migrate');
    assert.match(salida, /Base validada: matista_local/);
    const [[migrations]] = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations');
    assert.equal(migrations.n, 30);
    const before = await fingerprint(pool);
    assert.match(cli('migrate'), /Migraciones aplicadas: ninguna/);
    assert.equal(await fingerprint(pool), before);
  });

  await t.test('CA-05/07: ADMIN verificado con hash bcrypt real', async () => {
    cli('admin-demo');
    const [[cuenta]] = await pool.execute(
      `SELECT e.rol, e.estado, e.password_hash, c.estado AS correo_estado, c.verificado_at
       FROM empleados e JOIN empleados_correos c ON c.legajo = e.legajo
       WHERE e.legajo = ? AND c.email = ?`, [ADMIN_DEMO.legajo, ADMIN_DEMO.email]
    );
    assert.equal(cuenta.rol, 'ADMIN'); assert.equal(cuenta.estado, 'ACTIVO');
    assert.equal(cuenta.correo_estado, 'ACTUAL'); assert.ok(cuenta.verificado_at);
    assert.ok(/^\$2[aby]\$12\$/.test(cuenta.password_hash), 'Hash bcrypt costo 12');
    assert.ok(await verifyPassword(ADMIN_DEMO.password, cuenta.password_hash), 'Contraseña demo válida');
  });

  await t.test('transacción: fallo después de insertar tarifas revierte todo el catálogo', async st => {
    const [[previas]] = await pool.query('SELECT COUNT(*) AS n FROM planes');
    if (previas.n !== 0) return st.skip('Catálogo ya instalado: no se borra ni reinicializa.');
    let falloInyectado = false;
    const poolConFallo = {
      async getConnection() {
        const c = await pool.getConnection();
        return new Proxy(c, {
          get(target, prop) {
            if (prop === 'query') return async (sql, values) => {
              if (/INSERT INTO monotributo_aportes/.test(sql)) {
                falloInyectado = true;
                throw new Error('Fallo simulado después de tarifas');
              }
              return target.query(sql, values);
            };
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });
      }
    };
    await assert.rejects(() => ejecutarCargaAutonoma({
      matistaPool: poolConFallo, config, archivo, actorLegajo: ADMIN_DEMO.legajo
    }), /Fallo simulado/);
    assert.ok(falloInyectado);
    for (const tabla of tablasCatalogo.slice(0, 6)) {
      const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
      assert.equal(fila.n, 0, `Rollback completo: ${tabla}`);
    }
  });

  await t.test('CA-02/03/04: carga autónoma 4/160/12/1/9 sin SIGEC', async () => {
    cli('carga-autonoma');
    const expected = [4, 1, 160, 12, 1, 9];
    for (const [i, tabla] of tablasCatalogo.slice(0, 6).entries()) {
      const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
      assert.equal(fila.n, expected[i], tabla);
    }
    const [[politica]] = await pool.query("SELECT id FROM politica_comercial WHERE estado='VIGENTE'");
    const [[catalogo]] = await pool.query(
      'SELECT COUNT(*) AS n FROM porcentajes_comerciales WHERE politica_comercial_id = ? AND vigente_hasta IS NULL',
      [politica.id]
    );
    assert.equal(catalogo.n, 9);
    for (const tabla of ['clientes', 'cotizaciones', 'miembros_cotizacion']) {
      const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
      assert.equal(fila.n, 0, 'La instalación no incluye datos operativos');
    }
  });

  await t.test('CA-08/09/11: repetición y concurrencia sin cambios; producción rechazada antes de conexión', async () => {
    const before = await fingerprint(pool);
    cli('admin-demo'); cli('carga-autonoma');
    await Promise.all([1, 2].map(() => ejecutarCargaAutonoma({
      matistaPool: pool, config, archivo, actorLegajo: ADMIN_DEMO.legajo
    })));
    assert.equal(await fingerprint(pool), before, 'Idempotencia de todos los campos, fechas y hashes');
    for (const script of ['admin-demo', 'carga-autonoma', 'migrate']) {
      cli(script, { NODE_ENV: 'production', DB_NAME: 'matista_local', DB_HOST: 'remote.invalid' }, 1);
      cli(script, { NODE_ENV: 'development', DB_NAME: 'matista_local', DB_HOST: 'remote.invalid' }, 1);
      for (const database of ['matista_dev', 'matista_db']) {
        cli(script, { NODE_ENV: 'production', DB_NAME: database, DB_HOST: 'remote.invalid' }, 1);
      }
    }
    assert.equal(await fingerprint(pool), before);
  });

  await t.test('CA-06/10: login, catálogo, alta de asesor y cotización HTTP real sin contaminar el seed', async () => {
    const before = await fingerprint(pool);
    const c = await pool.getConnection();
    await c.beginTransaction();
    // Fixtures bajo una transacción exterior: SQL y servicios reales; los commits
    // de cada solicitud no finalizan el fixture. Al terminar se revierte TODO,
    // incluidos sesiones, asesor sintético, cliente y cotización de prueba.
    const fixtureConnection = new Proxy(c, {
      get(target, prop) {
        if (['beginTransaction', 'commit', 'rollback', 'release'].includes(prop)) return async () => {};
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const fixturePool = {
      getConnection: async () => fixtureConnection,
      query: c.query.bind(c), execute: c.execute.bind(c)
    };
    const security = loadSecurityConfig(env);
    let notice;
    const context = {
      pool: fixturePool, repository, security, now: () => new Date(),
      dummyPasswordHash: await hashPassword('no-es-una-cuenta', security),
      notify: async n => { notice = n; return true; }, reportIncident: () => {}
    };
    const { createApp } = await import('../../../src/app.js');
    const server = createApp({ env, authContext: context }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    async function api(path, method = 'GET', body, cookie) {
      const response = await fetch(origin + path, {
        method, headers: { Origin: env.FRONTEND_ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const result = await response.json();
      return { status: response.status, body: result, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    try {
      assert.equal((await api('/api/health')).status, 200);
      const admin = await api('/api/auth/login', 'POST', { email: ADMIN_DEMO.email, password: ADMIN_DEMO.password });
      assert.equal(admin.status, 200); assert.ok(admin.cookie, 'Cookie de sesión emitida');
      assert.equal((await api('/api/auth/me', 'GET', undefined, admin.cookie)).status, 200);
      const planes = await api('/api/catalogo/planes', 'GET', undefined, admin.cookie);
      assert.equal(planes.status, 200); assert.equal(planes.body.planes.length, 4);
      const condiciones = await api('/api/catalogo/condiciones', 'GET', undefined, admin.cookie);
      assert.equal(condiciones.status, 200);
      assert.equal(condiciones.body.politica.porcentajes_comerciales.length, 9);
      const lista = await api('/api/catalogo/tarifario/planes/1/Obligatorio', 'GET', undefined, admin.cookie);
      assert.equal(lista.status, 200); assert.equal(lista.body.tarifas.length, 20);
      // Se preserva la separación de roles: ADMIN no cotiza.
      assert.equal((await api('/api/asesor/cotizaciones', 'GET', undefined, admin.cookie)).status, 403);
      const legajo = String(randomInt(700000000, 799999999));
      const email = `asesor-${legajo}@example.test`;
      const password = randomBytes(15).toString('base64url');
      const registrado = await api('/api/auth/register', 'POST', { legajo, email, password, nombre: 'Asesor', apellido: 'Instalación' });
      assert.equal(registrado.status, 201);
      assert.equal((await api('/api/auth/verify-email', 'POST', { token: notice.token })).status, 200);
      assert.equal((await api(`/api/admin/employees/${legajo}/estado`, 'PATCH', { estado: 'ACTIVO' }, admin.cookie)).status, 200);
      const asesor = await api('/api/auth/login', 'POST', { email, password });
      assert.equal(asesor.status, 200);
      const cliente = await api('/api/asesor/clientes', 'POST', {
        dni: String(randomInt(10000000, 99999999)), nombres: 'Persona', apellidos: 'Sintética',
        email: `cliente-${legajo}@example.test`,
        fecha_nacimiento: '1990-01-01', provincia: 'Córdoba', localidad: 'Villa María'
      }, asesor.cookie);
      assert.equal(cliente.status, 201);
      const entrada = {
        cliente_id: String(cliente.body.id), plan_id: '1', modalidad: 'Obligatorio',
        familia: { titular: { edad: 36, estado_civil: 'SOLTERO' }, miembros: [] },
        aportes: { sueldo_bruto: '100000.00' },
        condiciones: { tramos: [], tdc: false, beneficios: { solicita_afinidad: false } }
      };
      const preview = await api('/api/asesor/cotizaciones/previsualizacion', 'POST', entrada, asesor.cookie);
      assert.equal(preview.status, 200); assert.match(preview.body.resultado.total, /^\d+\.\d{2}$/);
      const mono = await api('/api/asesor/cotizaciones/previsualizacion', 'POST', {
        ...entrada, modalidad: 'Monotributo', aportes: { categoria: 'A', adherentes: 1 }
      }, asesor.cookie);
      assert.equal(mono.status, 200);
      const voluntario = await api('/api/asesor/cotizaciones/previsualizacion', 'POST', {
        ...entrada, modalidad: 'Voluntario', aportes: {}
      }, asesor.cookie);
      assert.equal(voluntario.status, 422, 'No se inventa el IVA faltante');
      const borrador = await api('/api/asesor/cotizaciones', 'POST', entrada, asesor.cookie);
      assert.equal(borrador.status, 201);
      const calculo = await api(`/api/asesor/cotizaciones/${borrador.body.id}/calculo`, 'POST', {}, asesor.cookie);
      assert.equal(calculo.status, 200);
      const emitida = await api(`/api/asesor/cotizaciones/${borrador.body.id}/emision`, 'POST', {
        revision: calculo.body.revision, huella: calculo.body.huella
      }, asesor.cookie);
      assert.equal(emitida.status, 200); assert.equal(emitida.body.estado, 'EMITIDA');
    } finally {
      await new Promise(resolve => server.close(resolve));
      await c.rollback(); c.release();
    }
    assert.equal(await fingerprint(pool), before, 'El fixture se revierte sin tocar el catálogo');
    for (const tabla of ['clientes', 'cotizaciones', 'auth_sesiones']) {
      const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
      assert.equal(fila.n, 0, 'Sin residuos operativos de la aceptación');
    }
  });
});

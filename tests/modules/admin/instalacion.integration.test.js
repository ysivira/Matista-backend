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
import { POLITICA_INICIAL } from '../../../src/modules/admin/carga-inicial.service.js';
import { PORCENTAJES_COMERCIALES_INICIALES } from '../../../src/modules/admin/carga-inicial.repository.js';
import { ADMIN_DEMO } from '../../../src/modules/admin/admin-demo.service.js';
import * as repository from '../../../src/modules/auth/auth.repository.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const archivo = fileURLToPath(new URL('../../../database/seed/carga_inicial_autonoma.json', import.meta.url));
const habilitada = process.env.RUN_INSTALL_DB_TESTS === '1';
const tablasCatalogo = [
  'planes', 'tarifario_versiones', 'tarifas', 'monotributo_aportes',
  'politica_comercial', 'porcentajes_comerciales', 'empleados',
  'empleados_correos', 'empleados_auditoria', 'schema_migrations', 'politica_comercial_eventos'
];
const tablasOperativas = [
  'clientes', 'cotizaciones', 'miembros_cotizacion', 'asesor_auditoria', 'auth_sesiones', 'auth_tokens'
];

/** Compara contenidos completos sin imprimir datos personales, hashes o credenciales. */
async function fingerprint(pool, tablas = tablasCatalogo) {
  const hash = createHash('sha256');
  for (const tabla of tablas) {
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

  await t.test('CA-02/03/04: catálogo E2 sin SIGEC; conserva políticas publicadas por ADMIN', async () => {
    const [[previo]] = await pool.query('SELECT COUNT(*) AS n FROM planes');
    const before = previo.n ? await fingerprint(pool) : null;
    cli('carga-autonoma');
    if (before !== null) assert.equal(await fingerprint(pool), before, 'No restablece la política E2');
    const expected = [4, 1, 160, 12];
    for (const [i, tabla] of tablasCatalogo.slice(0, 4).entries()) {
      const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
      assert.equal(fila.n, expected[i], tabla);
    }
    // La política E2 puede ser HISTORICA: no confundir filas históricas con duplicados.
    const [[inicial]] = await pool.query('SELECT * FROM politica_comercial ORDER BY id LIMIT 1');
    assert.ok(inicial, 'Existe la política inicial');
    for (const [campo, valor] of Object.entries(POLITICA_INICIAL)) {
      if (valor === null) assert.equal(inicial[campo], null, `Parámetro E2 conservado: ${campo}`);
      else assert.equal(Number(inicial[campo]), Number(valor), `Parámetro E2 conservado: ${campo}`);
    }
    assert.equal(inicial.iva_voluntario_pct, null, 'El IVA no se inventa en el seed E2');
    assert.equal(inicial.aporte_adherente, null);
    const [descuentosIniciales] = await pool.execute(
      'SELECT porcentaje FROM porcentajes_comerciales WHERE politica_comercial_id = ? ORDER BY porcentaje DESC',
      [inicial.id]
    );
    assert.deepEqual(descuentosIniciales.map(d => Number(d.porcentaje)),
      PORCENTAJES_COMERCIALES_INICIALES.map(Number));
    const [vigentes] = await pool.query("SELECT id FROM politica_comercial WHERE estado='VIGENTE'");
    assert.equal(vigentes.length, 1, 'Una sola política vigente, no necesariamente una sola versión');
    const [[catalogo]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM porcentajes_comerciales WHERE politica_comercial_id = ? AND vigente_hasta IS NULL',
      [vigentes[0].id]
    );
    assert.ok(catalogo.n > 0, 'La política vigente conserva su propio catálogo configurable');
    if (Number(vigentes[0].id) === Number(inicial.id)) {
      assert.equal(inicial.estado, 'VIGENTE');
      assert.equal(catalogo.n, PORCENTAJES_COMERCIALES_INICIALES.length);
    } else {
      assert.equal(inicial.estado, 'HISTORICA');
      assert.ok(inicial.vigente_hasta, 'La versión inicial conserva su cierre histórico');
    }
    if (before === null) {
      for (const tabla of tablasOperativas) {
        const [[fila]] = await pool.query(`SELECT COUNT(*) AS n FROM ${tabla}`);
        assert.equal(fila.n, 0, 'La instalación no incluye datos operativos');
      }
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

  await t.test('CA-06/10: login, catálogo, alta de asesor y cotización HTTP real sin contaminar el seed', async st => {
    const before = await fingerprint(pool);
    const operativasBefore = await fingerprint(pool, tablasOperativas);
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
      assert.ok(condiciones.body.politica.porcentajes_comerciales.length > 0);
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
      const entradaVoluntario = { ...entrada, modalidad: 'Voluntario', aportes: {} };
      async function verificarVoluntario(politica) {
        const respuesta = await api('/api/asesor/cotizaciones/previsualizacion', 'POST', entradaVoluntario, asesor.cookie);
        if (politica.iva_voluntario_pct == null) {
          assert.equal(respuesta.status, 422, 'Sin IVA publicado, no se inventa una tasa');
          assert.equal(respuesta.body.error.code, 'COTIZACION_REGLA');
          assert.match(respuesta.body.error.message, /IVA Voluntario/);
          return;
        }
        assert.equal(respuesta.status, 200, 'Con IVA publicado, Voluntario está disponible');
        const resultado = respuesta.body.resultado;
        assert.equal(String(resultado.referencias.politica_id), String(politica.id));
        const centavos = valor => BigInt(String(valor).replace('.', ''));
        const desglose = resultado.tramos[0].desglose;
        const deducciones = ['descuento_joven', 'descuento_comercial', 'descuento_tdc',
          'descuento_afinidad', 'aporte_base', 'aporte_adherentes'];
        const subtotal = centavos(desglose.precio_base) -
          deducciones.reduce((total, campo) => total + centavos(desglose[campo]), 0n);
        const ivaEsperado = (subtotal * centavos(politica.iva_voluntario_pct) + 5000n) / 10000n;
        assert.equal(centavos(desglose.iva), ivaEsperado, 'IVA configurable con HALF-UP a centavos');
        assert.equal(centavos(resultado.total), subtotal + ivaEsperado);
        assert.equal(Number(resultado.impuestos[0].porcentaje), Number(politica.iva_voluntario_pct));
        assert.equal(centavos(resultado.impuestos[0].importe), ivaEsperado);
      }
      // El catálogo presenta objetos; las publicaciones ADMIN devuelven valores.
      const politicaAdmin = await api('/api/admin/politica-comercial', 'GET', undefined, admin.cookie);
      assert.equal(politicaAdmin.status, 200);
      assert.equal(String(politicaAdmin.body.id), String(condiciones.body.politica.id));
      assert.deepEqual(condiciones.body.politica.porcentajes_comerciales.map(p => p.porcentaje),
        politicaAdmin.body.porcentajes_comerciales, 'Catálogo y ADMIN conservan los mismos porcentajes');
      let politica = politicaAdmin.body;
      await st.test('Voluntario respeta la política realmente instalada', () => verificarVoluntario(politica));

      // Ambos estados se prueban siempre mediante ADMIN real, dentro del fixture
      // reversible. No se modifica ni reconstruye la política histórica del seed.
      await st.test('sin IVA publicado rechaza Voluntario', async () => {
        if (politica.iva_voluntario_pct != null) {
          const sinIva = await api(`/api/admin/politica-comercial/${politica.id}`, 'PUT', {
            iva_voluntario_pct: null, activacion: { modo: 'INMEDIATA' }
          }, admin.cookie);
          assert.equal(sinIva.status, 200);
          politica = sinIva.body;
        }
        await verificarVoluntario(politica);
      });
      await st.test('ADMIN publica IVA 10,50 % y aporte adherente sin alterar otros parámetros', async () => {
        const publicada = await api(`/api/admin/politica-comercial/${politica.id}`, 'PUT', {
          iva_voluntario_pct: '10.50', aporte_adherente: '23892.00', activacion: { modo: 'INMEDIATA' }
        }, admin.cookie);
        assert.equal(publicada.status, 200);
        const anterior = await api(`/api/admin/politica-comercial/${politica.id}`, 'GET', undefined, admin.cookie);
        assert.equal(anterior.status, 200);
        assert.equal(anterior.body.estado, 'HISTORICA');
        assert.ok(anterior.body.vigente_hasta);
        const nueva = publicada.body;
        assert.equal(nueva.estado, 'VIGENTE');
        assert.equal(String(nueva.version_base_id), String(politica.id));
        assert.equal(nueva.iva_voluntario_pct, '10.50');
        assert.equal(nueva.aporte_adherente, '23892.00');
        for (const campo of [...Object.keys(POLITICA_INICIAL), 'porcentajes_comerciales']) {
          assert.deepEqual(nueva[campo], politica[campo], `Parámetro vigente conservado: ${campo}`);
        }
        politica = nueva;
        await verificarVoluntario(politica);
      });
      const borrador = await api('/api/asesor/cotizaciones', 'POST', entradaVoluntario, asesor.cookie);
      assert.equal(borrador.status, 201);
      const calculo = await api(`/api/asesor/cotizaciones/${borrador.body.id}/calculo`, 'POST', {}, asesor.cookie);
      assert.equal(calculo.status, 200);
      assert.equal(calculo.body.resultado.impuestos[0].porcentaje, '10.50');
      assert.equal(String(calculo.body.resultado.referencias.politica_id), String(politica.id));
      const emitida = await api(`/api/asesor/cotizaciones/${borrador.body.id}/emision`, 'POST', {
        revision: calculo.body.revision, huella: calculo.body.huella
      }, asesor.cookie);
      assert.equal(emitida.status, 200); assert.equal(emitida.body.estado, 'EMITIDA');
      assert.deepEqual(emitida.body.resultado, calculo.body.resultado);
    } finally {
      await new Promise(resolve => server.close(resolve));
      await c.rollback(); c.release();
    }
    assert.equal(await fingerprint(pool), before, 'El fixture se revierte sin tocar el catálogo');
    assert.equal(await fingerprint(pool, tablasOperativas), operativasBefore, 'Sin residuos ni cambios en datos operativos previos');
  });
});

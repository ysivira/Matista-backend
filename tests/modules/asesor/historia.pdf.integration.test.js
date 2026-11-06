/** SPEC-08: HTTP/MySQL/Chromium reales; solo tablas TEMPORARY y catálogo copiado en sesión aislada. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../../src/app.js';
import * as authRepository from '../../../src/modules/auth/auth.repository.js';
import { hashPassword } from '../../../src/infrastructure/security/password.js';
import { pesos } from '../../../src/infrastructure/pdf/formato-documental.js';
import { securityConfig } from '../../helpers/security.js';
import { startTestServer } from '../../helpers/http.js';
import { evidence, quotationSnapshot } from '../../helpers/evidence.js';
import { localTestPool, permanentSnapshot, commercialSeed, temporarySession, sha256 } from '../../helpers/spec08.js';

const enabled = process.env.RUN_SPEC08 === '1';
test('SPEC08 historia, recotización vinculada y PDF Chromium real sin alterar datos compartidos', { skip: !enabled }, async t => {
  const directory = process.env.SPEC08_EVIDENCE_DIR;
  assert.ok(directory && path.isAbsolute(directory));
  assert.equal(process.env.VERCEL, '');
  assert.equal(process.env.CHROME_BIN, '/usr/bin/google-chrome');
  const observation = evidence('SPEC08');
  const save = (name, value) => writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const matrix = [];
  function accepted(id, expected, observed) {
    matrix.push({ id, expected, observed, state: 'APROBADA' });
    observation.record('verification', matrix.at(-1));
  }
  const realPool = localTestPool();
  let isolated;
  const before = await permanentSnapshot(realPool);
  await save('permanentes-antes.json', before);
  t.after(async () => {
    try {
      isolated?.close();
      const after = await permanentSnapshot(realPool);
      await save('permanentes-despues.json', after);
      const unchanged = JSON.stringify(after.fingerprint) === JSON.stringify(before.fingerprint);
      await save('integridad-mysql.json', { unchanged, permanentTables: before.fingerprint.length, scope: 'Contenido y SHOW CREATE TABLE, conexión independiente sin sombras' });
      assert.equal(unchanged, true, 'Detener: diferencia de datos/esquema permanente');
    } finally { await realPool.end(); await save('matriz-verificaciones.json', matrix); }
  });
  const commercial = await commercialSeed(realPool);
  isolated = await temporarySession(realPool, commercial, observation, directory);
  const independent = await permanentSnapshot(realPool);
  assert.notEqual(isolated.connectionId, independent.identity.connectionId);
  assert.deepEqual(independent.fingerprint, before.fingerprint);
  await save('control-conexion-independiente.json', independent);
  const c = isolated.connection;
  const policy = commercial.seed.politica_comercial[0];
  const version = commercial.seed.tarifario_versiones[0];
  const security = securityConfig();
  const password = 'clave-sintetica-spec08';
  const passwordHash = await hashPassword(password, security);
  const actors = ['9900000001', '9900000002', '9900000003'];
  for (const [i, actor] of actors.entries()) {
    await c.execute("INSERT INTO empleados (legajo,nombre,apellido,password_hash,rol,estado) VALUES (?,'SPEC OCHO','SINTETICO',?,?,'ACTIVO')", [actor, passwordHash, i === 2 ? 'ADMIN' : 'ASESOR']);
    await c.execute("INSERT INTO empleados_correos (legajo,email,estado,verificado_at) VALUES (?,?,'ACTUAL',UTC_TIMESTAMP(6))", [actor, `spec08-${i}@example.test`]);
  }
  const context = { pool: isolated.pool, repository: authRepository, security, dummyPasswordHash: passwordHash,
    now: () => new Date(), notify: async () => {}, reportIncident: incident => observation.record('incident', { code: incident.code }) };
  const request = await startTestServer(t, createApp({ env: { NODE_ENV: 'test', FRONTEND_ORIGIN: 'http://localhost:5173' }, authContext: context }));
  const cookies = [];
  for (let i = 0; i < actors.length; i++) {
    const response = await request('/api/auth/login', { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: JSON.stringify({ email: `spec08-${i}@example.test`, password }) });
    observation.http('POST', '/api/auth/login', { email: `spec08-${i}@example.test`, password: '[OCULTO]' }, response);
    assert.equal(response.status, 200);
    cookies.push(response.headers['set-cookie'][0].split(';')[0]);
  }
  async function http(route, body, method = 'POST', actor = 0, pdf = false) {
    const response = await request(route, { method, headers: { origin: 'http://localhost:5173', cookie: cookies[actor] },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(pdf ? { responseType: 'buffer' } : {}) });
    if (pdf && response.status === 200) observation.record('http-pdf', { method, path: route, status: response.status,
      contentType: response.headers['content-type'], disposition: response.headers['content-disposition'], bytes: response.body.length, sha256: sha256(response.body) });
    else observation.http(method, route, body, pdf ? { ...response, body: JSON.parse(response.body.toString()) } : response);
    return response;
  }
  const clientResponse = await http('/api/asesor/clientes', { dni: '98123456', nombres: 'Historia SPEC', apellidos: 'Sintetica', fecha_nacimiento: '1985-01-01', email: 'titular-spec08@example.test' });
  assert.equal(clientResponse.status, 201);
  const input = { cliente_id: String(clientResponse.body.id), plan_id: '4', modalidad: 'Monotributo',
    familia: { titular: { edad: 41, estado_civil: 'CASADO' }, miembros: [{ parentesco: 'CONYUGE', edad: 41 }, { parentesco: 'HIJO', edad: 12 }] },
    aportes: { categoria: 'A', adherentes: 2 }, condiciones: { tramos: [], tdc: false, beneficios: { solicita_afinidad: false } } };
  const root = '/api/asesor/cotizaciones';
  const draftResponse = await http(root, input);
  assert.equal(draftResponse.status, 201);
  const draft = draftResponse.body;
  assert.equal(draft.estado, 'BORRADOR');
  assert.equal((await http(`${root}/${draft.id}/pdf`, undefined, 'GET', 0, true)).status, 409);
  accepted('EST-BORRADOR', 'BORRADOR sin PDF oficial', { status: 409, estado: draft.estado });
  async function emit(id) {
    const calculation = await http(`${root}/${id}/calculo`, {});
    assert.equal(calculation.status, 200);
    const response = await http(`${root}/${id}/emision`, { revision: calculation.body.revision, huella: calculation.body.huella });
    assert.equal(response.status, 200);
    assert.equal(response.body.estado, 'EMITIDA');
    return response.body;
  }
  const original = await emit(draft.id);
  assert.equal(String(original.tarifa_version_id), String(version.id));
  assert.equal(String(original.politica_id), String(policy.id));
  assert.equal(original.resultado.referencias.politica_id, String(policy.id));
  assert.ok(original.solicitud.plan.condiciones_generales);
  await save('original-emitida.json', original);
  const originalSnapshot = await quotationSnapshot(c, observation, original.id, 'original-antes');
  accepted('HIST-EMISION', 'Emisión con versiones actuales y snapshots persistidos', { id: original.id, numero: original.numero, estado: original.estado, total: original.resultado.total, tarifa: original.tarifa_version_id, politica: original.politica_id });

  const popplerEnv = { ...process.env, LC_ALL: 'C' };
  async function pdfDocument(q, name) {
    const response = await http(`${root}/${q.id}/pdf`, undefined, 'GET', 0, true);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^application\/pdf/);
    assert.match(response.body.subarray(0, 8).toString(), /^%PDF-1\./);
    const file = path.join(directory, name + '.pdf');
    await writeFile(file, response.body, { mode: 0o600 });
    const commands = [];
    function tool(bin, args) {
      const stdout = execFileSync(bin, args, { encoding: 'utf8', env: popplerEnv, timeout: 30000 });
      commands.push({ bin, args, exit: 0 });
      return stdout;
    }
    const info = tool('pdfinfo', [file]);
    await writeFile(path.join(directory, name + '.pdfinfo.txt'), info, { mode: 0o600 });
    assert.match(info, /Page size:.*A4/);
    const pages = Number(info.match(/Pages:\s+(\d+)/)[1]);
    assert.ok(pages >= 2);
    const text = tool('pdftotext', ['-layout', file, '-']);
    await writeFile(path.join(directory, name + '.txt'), text, { mode: 0o600 });
    const normalized = text.normalize('NFC').replace(/\s+/g, ' ').trim();
    // -layout intercala columnas cuando una celda ocupa dos líneas; -raw conserva el orden de dibujo de la celda.
    const readingOrder = tool('pdftotext', ['-raw', file, '-']);
    await writeFile(path.join(directory, name + '.lectura.txt'), readingOrder, { mode: 0o600 });
    const normalizedReading = readingOrder.normalize('NFC').replace(/\s+/g, ' ').trim();
    for (const value of [q.numero, q.solicitud.plan.nombre, q.modalidad, 'Cotización comercial', 'Condiciones generales',
      `Tarifa ${q.tarifa_version_id}`, `Política ${q.politica_id}`, pesos(q.resultado.total), pesos(q.resultado.precio_base),
      ...q.resultado.aportes.map(aporte => pesos(aporte.importe))]) assert.ok(normalized.includes(value.replace(/\s+/g, ' ')), value);
    const conditions = q.solicitud.plan.condiciones_generales.replace(/\s+/g, ' ').trim();
    assert.ok(normalized.includes(conditions), 'Condiciones comerciales completas');
    for (const cell of q.solicitud.plan.detalles.split(/[\n|]/).map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
      assert.ok(normalizedReading.includes(cell), `Prestación/cobertura: ${cell}`);
    }
    // Render real de todas las páginas. PPM facilita validar dimensiones y píxeles no blancos sin bibliotecas añadidas.
    tool('pdftoppm', ['-r', '40', file, path.join(directory, name + '-render')]);
    const render = [];
    for (let page = 1; page <= pages; page++) {
      const raster = path.join(directory, name + '-render-' + String(page).padStart(String(pages).length, '0') + '.ppm');
      const bytes = await readFile(raster);
      assert.match(bytes.subarray(0, 2).toString(), /P6/);
      const header = bytes.toString('latin1', 0, 100).match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
      assert.ok(header);
      const width = Number(header[1]), height = Number(header[2]);
      const pixels = bytes.subarray(header[0].length);
      assert.equal(pixels.length, width * height * 3);
      const dark = pixels.reduce((count, value) => count + (value < 200 ? 1 : 0), 0);
      assert.ok(dark > 1000, 'Página renderizada no vacía');
      // También se adjunta una imagen PNG por página para revisión visual.
      tool('pdftoppm', ['-f', String(page), '-l', String(page), '-r', '72', '-png', '-singlefile', file, path.join(directory, `${name}-pagina-${page}`)]);
      render.push({ page, width, height, nonWhiteChannels: dark, sha256: sha256(bytes) });
    }
    const document = { file: name + '.pdf', bytes: response.body.length, sha256: sha256(response.body), textSha256: sha256(text), normalizedTextSha256: sha256(normalized), readingOrderSha256: sha256(normalizedReading), pages, render, commands };
    observation.record('pdf-analysis', document);
    await save(name + '.analisis.json', document);
    return { buffer: response.body, text, normalized, normalizedReading, document };
  }
  const firstPdf = await pdfDocument(original, 'historica-original');
  const unit = BigInt(String(policy.aporte_monotributo).replace('.', '')) + 100000n;
  const newUnit = `${unit / 100n}.${String(unit % 100n).padStart(2, '0')}`;
  const policyResponse = await http(`/api/admin/politica-comercial/${policy.id}`, { aporte_monotributo: newUnit }, 'PUT', 2);
  assert.equal(policyResponse.status, 200);
  const updatedPolicy = policyResponse.body;
  assert.notEqual(String(updatedPolicy.id), String(policy.id));
  assert.equal(updatedPolicy.estado, 'VIGENTE');
  const policyRows = await observation.sql(c, 'politicas-despues', 'SELECT id,estado,version_base_id,aporte_monotributo,fecha_vigencia,vigente_hasta FROM politica_comercial ORDER BY id');
  assert.equal(policyRows.find(row => String(row.id) === String(policy.id)).estado, 'HISTORICA');
  assert.equal(String(updatedPolicy.version_base_id), String(policy.id));
  accepted('VERSION-CAMBIO', 'Nueva política activa, anterior histórica; tarifa sin cambios', { anterior: policy.id, nueva: updatedPolicy.id, aporteAnterior: policy.aporte_monotributo, aporteNuevo: newUnit, tarifa: version.id });

  const historicResponse = await http(`${root}/${original.id}`, undefined, 'GET');
  assert.equal(historicResponse.status, 200);
  for (const field of ['id', 'estado', 'numero', 'tarifa_version_id', 'politica_id', 'solicitud', 'resultado', 'revision', 'emitida_at', 'vence_at']) assert.deepEqual(historicResponse.body[field], original[field], field);
  assert.deepEqual(await quotationSnapshot(c, observation, original.id, 'original-tras-cambio'), originalSnapshot);
  accepted('HIST-REGISTRO', 'Original sin cambios económicos/documentales/estado/versiones tras nueva política', { identicalFullRowMembersAudit: true });
  const secondPdf = await pdfDocument(historicResponse.body, 'historica-despues');
  const comparison = { binaryEqual: firstPdf.buffer.equals(secondPdf.buffer), rawTextEqual: firstPdf.text === secondPdf.text,
    normalizedTextEqual: firstPdf.normalized === secondPdf.normalized, pageCountEqual: firstPdf.document.pages === secondPdf.document.pages,
    readingOrderEqual: firstPdf.normalizedReading === secondPdf.normalizedReading,
    rasterPagesEqual: firstPdf.document.render.every((page, i) => page.sha256 === secondPdf.document.render[i]?.sha256),
    original: firstPdf.document, after: secondPdf.document,
    interpretation: 'Se exige contenido histórico igual; igualdad binaria solo se observa y no constituye garantía general del generador.' };
  await save('comparacion-pdf.json', comparison);
  assert.equal(comparison.normalizedTextEqual, true);
  assert.equal(comparison.readingOrderEqual, true);
  assert.equal(comparison.pageCountEqual, true);
  accepted('HIST-PDF', 'PDF real válido, contenido económico/comercial igual; comparación binaria independiente', comparison);
  assert.equal((await http(`${root}/${original.id}/pdf`, undefined, 'GET', 1, true)).status, 404);
  accepted('AUTH-PDF-AJENO', 'Otro asesor recibe 404 sin PDF', { status: 404 });
  assert.equal((await http(`${root}/${original.id}`, { ...input, revision: original.revision }, 'PUT')).status, 409);
  accepted('EST-EMITIDA', 'No admite reemplazo económico directo', { status: 409 });

  const recResponse = await http(`${root}/${original.id}/recotizaciones`, input);
  assert.equal(recResponse.status, 201);
  const rec = recResponse.body;
  assert.notEqual(String(rec.id), String(original.id));
  assert.equal(String(rec.origen_id), String(original.id));
  assert.equal(String(rec.politica_id), String(updatedPolicy.id));
  assert.equal(String(rec.tarifa_version_id), String(version.id));
  const newQuotation = await emit(rec.id);
  assert.equal(String(newQuotation.origen_id), String(original.id));
  assert.equal(String(newQuotation.politica_id), String(updatedPolicy.id));
  assert.notEqual(newQuotation.numero, original.numero);
  assert.equal(BigInt(original.resultado.total.replace('.', '')) - BigInt(newQuotation.resultado.total.replace('.', '')), 300000n);
  assert.equal(newQuotation.resultado.aportes[0].importe, newUnit);
  assert.equal(String(newQuotation.solicitud.referencias.politica_id), String(updatedPolicy.id));
  await save('recotizacion-emitida.json', newQuotation);
  // MySQL TEMPORARY no permite auto-JOIN: ambos registros y el origen se consultan sin reabrir la tabla.
  const links = await observation.sql(c, 'vinculo-recotizacion',
    'SELECT id,origen_id,asesor_legajo,estado,numero,tarifa_version_id,politica_id,solicitud,resultado,revision FROM cotizaciones WHERE id IN (?,?) ORDER BY id', [original.id, newQuotation.id]);
  assert.equal(links.length, 2);
  const source = links.find(row => String(row.id) === String(original.id));
  const child = links.find(row => String(row.id) === String(newQuotation.id));
  assert.equal(String(child.origen_id), String(source.id));
  assert.equal(child.asesor_legajo, source.asesor_legajo);
  assert.deepEqual(await quotationSnapshot(c, observation, original.id, 'original-tras-recotizacion'), originalSnapshot);
  const related = await http(`${root}/${original.id}`, undefined, 'GET');
  assert.ok(related.body.recotizaciones.some(row => String(row.id) === String(newQuotation.id)));
  accepted('RECOT-TRAZA', 'Nueva cotización emitida, origen persistido, original intacto y nueva política utilizada', { originalId: original.id, newId: newQuotation.id, origenId: child.origen_id, oldPolicy: policy.id, newPolicy: updatedPolicy.id, oldTotal: original.resultado.total, newTotal: newQuotation.resultado.total, originalUnchanged: true });
  await pdfDocument(newQuotation, 'recotizacion-nueva');
  accepted('RECOT-PDF', 'PDF real de la recotización emitida con nueva política y economía', { id: newQuotation.id, politica: newQuotation.politica_id, total: newQuotation.resultado.total });
  const annulled = await http(`${root}/${newQuotation.id}/anulacion`, { revision: newQuotation.revision, motivo: 'Control de estado SPEC08 en sesión temporal' });
  assert.equal(annulled.status, 200); assert.equal(annulled.body.estado, 'ANULADA');
  for (const [suffix, payload, method] of [
    ['/pdf', undefined, 'GET'], ['/calculo', {}, 'POST'], ['/recotizaciones', input, 'POST'],
    ['/contacto', { revision: annulled.body.revision, contacto: {} }, 'PATCH'],
    ['/emision', { revision: annulled.body.revision, huella: 'a'.repeat(64) }, 'POST'],
  ]) assert.equal((await http(`${root}/${newQuotation.id}${suffix}`, payload, method, 0, suffix === '/pdf')).status, 409);
  assert.deepEqual(await quotationSnapshot(c, observation, original.id, 'original-final'), originalSnapshot);
  accepted('EST-ANULADA', 'Anulación lógica impide PDF, cálculo, recotización, contacto y emisión; original intacto', { estado: 'ANULADA', rejectedStatuses: [409, 409, 409, 409, 409] });
  await save('matriz-verificaciones.json', matrix);
  observation.accepted('SPEC08: historial preservado, recotización SQL vinculada y tres PDF Chromium reales; integración confinada a sesión TEMPORARY sin FKs, CHECK e índices conservados.');
});

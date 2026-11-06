/** SPEC-06: observación opt-in; las consultas de evidencia nunca escriben datos. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const secrets = /password|contrase|token|cookie|authorization|secret|jti|hash/i;
const personal = /^(?:email|to|nombre|nombres|apellido|apellidos|segundo_nombre|dni|telefono|direccion|fecha_nacimiento|provincia|localidad|actor_nombre|actor_apellido)$/i;

/** Oculta secretos; las huellas de datos sintéticos permiten comparar sin publicarlos. */
export function redactEvidence(value, key = '') {
  if (secrets.test(key)) return '[OCULTO]';
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'string' && /^(solicitud|contacto|resultado|anterior|nuevo)$/.test(key)) {
    try { return redactEvidence(JSON.parse(value)); } catch { /* Texto no JSON: conservar el contrato original. */ }
  }
  if (personal.test(key)) return { oculto: true, sha256: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(entry => redactEvidence(entry));
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactEvidence(v, k)]));
  return value;
}

/** Registra únicamente cuando el ejecutor configura un archivo dedicado de evidencia. */
export function evidence(scenario) {
  const record = (type, data) => {
    if (!process.env.MATISTA_EVIDENCE_FILE) return;
    appendFileSync(process.env.MATISTA_EVIDENCE_FILE, JSON.stringify({ scenario, type, at: new Date().toISOString(), ...redactEvidence(data) }) + '\n', { mode: 0o600 });
  };
  return {
    record,
    async sql(connection, phase, sql, parameters = []) {
      assert.match(sql, /^\s*SELECT\b/i);
      assert.ok(!sql.includes(';'), 'Solo una consulta de lectura de evidencia');
      const [rows] = await connection.execute(sql, parameters);
      record('sql', { phase, sql, parameters, rows });
      return rows;
    },
    http(method, path, body, response) {
      record('http', { method, path, request: body ?? null, status: response.status, response: response.body,
        ...(response.headers?.['set-cookie'] ? { sessionHeader: { present: true, expired: response.headers['set-cookie'].some(v => /Expires=Thu, 01 Jan 1970/.test(v)) } } : {}) });
      return response;
    },
    accepted(criterion) { record('acceptance', { criterion }); },
  };
}

/** Lee todas las columnas, conservando además microsegundos de fechas que mysql2 convierte a Date. */
export async function quotationSnapshot(pool, observation, id, phase) {
  return {
    cotizaciones: await observation.sql(pool, phase,
      'SELECT q.*, CAST(q.created_at AS CHAR) AS created_at_exacto, CAST(q.updated_at AS CHAR) AS updated_at_exacto, CAST(q.emitida_at AS CHAR) AS emitida_at_exacto, CAST(q.vence_at AS CHAR) AS vence_at_exacto FROM cotizaciones q WHERE q.id=?', [id]),
    miembros: await observation.sql(pool, phase, 'SELECT * FROM miembros_cotizacion WHERE cotizacion_id=? ORDER BY orden', [id]),
    auditoria: await observation.sql(pool, phase, 'SELECT *, CAST(created_at AS CHAR) AS created_at_exacto FROM asesor_auditoria WHERE cotizacion_id=? ORDER BY id', [id]),
  };
}

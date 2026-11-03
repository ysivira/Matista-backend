/**
 * ============================================================
 * MATISTA | CARGA AUTÓNOMA DE CATÁLOGO
 * ============================================================
 *
 * Archivo: carga-autonoma.js
 * Módulo: Mantenimiento
 *
 * Responsabilidad:
 * Sembrar el catálogo comercial E2 aprobado en la base destino
 * SIN conexión a SIGEC, leyendo el JSON versionado del repo y
 * presentando el resumen de la operación.
 *
 * Consideraciones técnicas:
 * - Este script realiza escrituras; no es un diagnóstico.
 * - Solo development/matista_local en MySQL loopback; nunca producción.
 * - Requiere un legajo responsable existente en la base: si no se
 *   define IMPORT_ACTOR_LEGAJO se usa el legajo del administrador
 *   de demostración (db:admin-demo), que es el caso de instalación
 *   documentado. La versión CARGA_INICIAL queda con actor NULL.
 * - Idempotente: si el catálogo ya existe y es consistente, no escribe.
 *
 * ============================================================
 */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabasePool } from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';
import { ejecutarCargaAutonoma } from '../src/modules/admin/instalacion.service.js';
import { ADMIN_DEMO } from '../src/modules/admin/admin-demo.service.js';
import { assertLocalInstallationTarget } from '../src/infrastructure/database/local-installation.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fuentePorDefecto = path.resolve(
  currentDirectory,
  '../database/seed/carga_inicial_autonoma.json'
);
const fuente = fuentePorDefecto;
const matistaConfig = loadDatabaseConfig(process.env);
assertLocalInstallationTarget(matistaConfig);
const actorLegajo = process.env.IMPORT_ACTOR_LEGAJO?.trim() || ADMIN_DEMO.legajo;
const pool = createDatabasePool(matistaConfig);
/** Imprime una línea de éxito con prefijo [OK]. */
const exito = mensaje => console.log(`[OK] ${mensaje}`);
/** Imprime una línea de error por la salida de error. */
const advertencia = mensaje => console.error(`[ERROR] ${mensaje}`);

try {
  const resumen = await ejecutarCargaAutonoma({
    matistaPool: pool,
    config: matistaConfig,
    archivo: fuente,
    actorLegajo
  });

  if (!resumen.aplicada) {
    exito('La carga ya existe y es consistente: no se volvio a cargar (idempotencia).');
  } else {
    exito(`Carga autonoma aplicada en ${matistaConfig.database} (sin SIGEC).`);
    exito(
      `Version CARGA_INICIAL id=${resumen.versionCargaInicialId} con ` +
        `${resumen.tarifas} tarifas.`
    );
  }
  exito(
    `Planes: ${resumen.planes} · Tarifas: ${resumen.tarifas} · ` +
      `Monotributo: ${resumen.aportesMonotributo} · Politica comercial: ` +
      `${resumen.politicaComercial} · Porcentajes comerciales: ` +
      `${resumen.porcentajesComerciales}.`
  );
  exito(`Responsable registrado: legajo ${actorLegajo}.`);
} catch (error) {
  advertencia(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}

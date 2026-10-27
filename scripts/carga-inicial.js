/**
 * Carga inicial de MATISTA: argumentos, ejecución y resumen de resultados.
 */
import 'dotenv/config';
import { createDatabasePool } from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';
import { ejecutarCargaInicial } from '../src/modules/admin/carga-inicial.service.js';
import { abrirConexionSigec } from '../src/modules/admin/carga-inicial.repository.js';

const matistaConfig = loadDatabaseConfig(process.env);
const pool = createDatabasePool(matistaConfig);
const actorLegajo = process.env.IMPORT_ACTOR_LEGAJO?.trim() ?? '';
/** Imprime una línea de éxito con prefijo [OK]. */
const exito = mensaje => console.log(`[OK] ${mensaje}`);
/** Imprime una línea de detalle con sangría bajo el paso en curso. */
const detalle = mensaje => console.log(`     ${mensaje}`);
/** Imprime una línea de error con prefijo [ERROR] por la salida de error. */
const advertencia = mensaje => console.error(`[ERROR] ${mensaje}`);

let sigecConnection = null;
try {
  if (actorLegajo === '') {
    throw new Error(
      'Defina IMPORT_ACTOR_LEGAJO con el legajo real responsable de la ' +
        'carga (se registra en politica comercial y aportes de monotributo).'
    );
  }
  sigecConnection = await abrirConexionSigec();
  const resumen = await ejecutarCargaInicial({
    matistaPool: pool,
    sigecConnection,
    actorLegajo
  });

  if (!resumen.aplicada) {
    advertencia(
      'La carga inicial ya existe y es consistente: no se volvio a cargar ' + '(idempotencia).'
    );
    exito(
      `Planes: ${resumen.planes} · Tarifas: ${resumen.tarifas} · ` +
        `Monotributo: ${resumen.aportesMonotributo} · ` +
        `Politica comercial: ${resumen.politicaComercial}.`
    );
  } else {
    exito(`Carga aplicada en ${matistaConfig.database}.`);
    exito(
      `Version CARGA_INICIAL id=${resumen.versionCargaInicialId} ` +
        `con ${resumen.tarifas} tarifas.`
    );
    exito(
      `Planes: ${resumen.planes} · Monotributo: ` +
        `${resumen.aportesMonotributo} · Politica comercial: ` +
        `${resumen.politicaComercial} fila abierta.`
    );
    exito(`Excluidos con trazabilidad: ${resumen.excluidos.length}.`);
    for (const excluido of resumen.excluidos) {
      detalle(`SIGEC id=${excluido.id} - ${excluido.motivo}`);
    }
  }
} catch (error) {
  advertencia(error.message);
  process.exitCode = 1;
} finally {
  if (sigecConnection) await sigecConnection.end();
  await pool.end();
}

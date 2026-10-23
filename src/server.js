import 'dotenv/config';
import app from './app.js';
import { closeSharedEmailTransport } from './infrastructure/email/email.service.js';
import { iniciarActivadorPoliticas, detenerActivadorPoliticas } from './modules/admin/admin.scheduler.js';
import { initializeRuntime } from './modules/auth/auth.routes.js';
import { loadAuthHttpPolicy } from './modules/auth/auth.constants.js';
import { activarPoliticasProgramadas } from './modules/admin/politica-comercial.service.js';

const PORT = process.env.PORT || 3000;

/** Runtime compartido del proceso, capturado al inicializar para cerrar su pool al apagar. */
let runtimeProceso;

app.listen(PORT, () => {
  console.log(`MATISTA API funcionando en http://localhost:${PORT}`);
});

// Apagado ordenado: detiene el activador, libera el pool SMTP compartido y
// cierra el pool MySQL del runtime compartido antes de terminar.
async function apagar() {
  detenerActivadorPoliticas();
  closeSharedEmailTransport();
  // El pool nunca debe quedar con conexiones TCP colgadas; si ya estaba
  // cerrado o nunca se inicializó, el apagado continúa igual.
  try {
    await runtimeProceso?.pool?.end();
  } catch {
    // Un fallo al cerrar el pool no impide terminar el proceso.
  }
  process.exit(0);
}
process.on('SIGINT', apagar);
process.on('SIGTERM', apagar);

// El activador comparte el pool AUTH/ADMIN ya memoizado; la activación vencida
// también se resuelve de forma preventiva en cada lectura, el intervalo solo adelanta.
initializeRuntime(process.env, loadAuthHttpPolicy(process.env))
  .then((runtime) => {
    runtimeProceso = runtime;
    iniciarActivadorPoliticas(runtime.pool);
    return activarPoliticasProgramadas(runtime.pool);
  })
  .catch((error) => {
    console.warn('Activador de políticas no iniciado:', error.code ?? 'ERROR_INESPERADO');
  });

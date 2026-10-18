import 'dotenv/config';
import app from './app.js';
import { closeSharedEmailTransport } from './infrastructure/email/email.service.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`MATISTA API funcionando en http://localhost:${PORT}`);
});

// Apagado ordenado: libera el pool SMTP compartido (conexiones TLS en espera)
// y preserva el comportamiento previo de terminación del proceso.
function shutdownEmail() {
  closeSharedEmailTransport();
  process.exit(0);
}
process.on('SIGINT', shutdownEmail);
process.on('SIGTERM', shutdownEmail);
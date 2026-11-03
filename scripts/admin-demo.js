/**
 * ============================================================
 * MATISTA | ADMIN DEMO DE INSTALACIÓN LOCAL
 * ============================================================
 *
 * Archivo: admin-demo.js
 * Módulo: Mantenimiento
 *
 * Responsabilidad:
 * Crear el usuario ADMIN de demostración exclusivo de bases
 * locales y de evaluación, con el hash bcrypt del proyecto.
 *
 * Consideraciones técnicas:
 * - Este script realiza escrituras; no es un diagnóstico.
 * - Solo development/matista_local en MySQL loopback; cualquier otro
 *   destino falla antes de abrir conexiones.
 * - Idempotente: si la cuenta ya existe consistente, informa y no
 *   escribe nada.
 *
 * ============================================================
 */
import 'dotenv/config';
import { createDatabasePool } from '../src/infrastructure/database/connection.js';
import { loadDatabaseConfig } from '../src/infrastructure/database/config.js';
import { loadSecurityConfig } from '../src/infrastructure/security/config.js';
import {
  crearAdminDemo,
  exigirEntornoNoProduccion
} from '../src/modules/admin/admin-demo.service.js';

const exito = mensaje => console.log(`[OK] ${mensaje}`);
const advertencia = mensaje => console.error(`[ERROR] ${mensaje}`);

try {
  exigirEntornoNoProduccion(process.env);
  const config = loadDatabaseConfig(process.env);
  const security = loadSecurityConfig(process.env);
  const pool = createDatabasePool(config);
  let resultado;
  try {
    resultado = await crearAdminDemo({ matistaPool: pool, config, security });
  } finally {
    await pool.end();
  }
  if (resultado.creado) {
    exito(`Administrador de demostración creado en ${config.database}:`);
    exito(`  legajo=${resultado.legajo} email=${resultado.email}`);
    exito(
      'La contraseña es la de demostración acordada; NO utilizar esta ' +
        'cuenta ni esta base en producción.'
    );
  } else {
    exito(
      `El administrador de demostración ya existe y es consistente ` +
        `(legajo=${resultado.legajo}, email=${resultado.email}): nada por hacer.`
    );
  }
} catch (error) {
  advertencia(error.message);
  process.exitCode = 1;
}

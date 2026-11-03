/** Cuenta conocida exclusiva de la instalación local de evaluación. Nunca producción. */
import { loadDatabaseConfig } from '../../infrastructure/database/config.js';
import {
  assertLocalInstallationTarget, withLocalInstallation
} from '../../infrastructure/database/local-installation.js';
import { loadSecurityConfig } from '../../infrastructure/security/config.js';
import { hashPassword } from '../../infrastructure/security/password.js';
import { findEmployee, findEmails, findReservedEmail, audit } from '../auth/auth.repository.js';

export const ADMIN_DEMO = Object.freeze({
  legajo: '900000001', email: 'admin@matista.test', password: 'admin2026*',
  nombre: 'Administrador', apellido: 'Demostración'
});

/** Validar antes de abrir el pool; se revalida dentro del servicio. */
export function exigirEntornoNoProduccion(env = process.env) {
  assertLocalInstallationTarget(loadDatabaseConfig(env));
}

/** No cambia contraseña, rol, estado ni correo de cuentas preexistentes. */
export async function crearAdminDemo({
  matistaPool, config = loadDatabaseConfig(), security = loadSecurityConfig(),
  now = () => new Date()
}) {
  assertLocalInstallationTarget(config);
  if (security.nodeEnv !== 'development') {
    throw new Error('El administrador de demostración no puede crearse en producción.');
  }
  return withLocalInstallation(matistaPool, config, async destino => {
    const cuenta = await findEmployee(destino, ADMIN_DEMO.legajo, true);
    const reservado = await findReservedEmail(destino, ADMIN_DEMO.email);
    if (cuenta) {
      const correos = await findEmails(destino, ADMIN_DEMO.legajo, true);
      const actual = correos.find(c => c.estado === 'ACTUAL');
      if (cuenta.rol !== 'ADMIN' || cuenta.estado !== 'ACTIVO' ||
        actual?.email !== ADMIN_DEMO.email || !actual.verificado_at) {
        throw new Error('La cuenta demo existente es inconsistente; no se repara automáticamente.');
      }
      return { creado: false, legajo: ADMIN_DEMO.legajo, email: ADMIN_DEMO.email };
    }
    if (reservado) throw new Error('El correo demo está reservado por otro legajo; no se crea la cuenta.');
    const hash = await hashPassword(ADMIN_DEMO.password, security);
    const instante = now();
    await destino.execute(
      `INSERT INTO empleados (legajo, nombre, apellido, password_hash, rol,
         estado, password_changed_at, created_at)
       VALUES (?, ?, ?, ?, 'ADMIN', 'ACTIVO', ?, ?)`,
      [ADMIN_DEMO.legajo, ADMIN_DEMO.nombre, ADMIN_DEMO.apellido, hash, instante, instante]
    );
    await destino.execute(
      `INSERT INTO empleados_correos (legajo, email, estado, verificado_at, created_at)
       VALUES (?, ?, 'ACTUAL', ?, ?)`,
      [ADMIN_DEMO.legajo, ADMIN_DEMO.email, instante, instante]
    );
    await audit(destino, ADMIN_DEMO.legajo, null, 'REGISTRO', 'CUENTA', null, 'ACTIVO', instante);
    return { creado: true, legajo: ADMIN_DEMO.legajo, email: ADMIN_DEMO.email };
  });
}

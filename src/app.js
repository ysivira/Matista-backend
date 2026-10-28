/**
 * ============================================================
 * MATISTA | APLICACIÓN HTTP
 * ============================================================
 *
 * Archivo: app.js
 * Módulo: Composición del backend
 *
 * Responsabilidad:
 * Componer Express, CORS, parsers y módulos de negocio con
 * controles HTTP y un manejador centralizado de errores.
 *
 * ============================================================
 */
import express from 'express';
import cors from 'cors';
import { errorHandler } from './shared/errors/error-handler.js';
import { createAppError } from './shared/errors/app-error.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { createAsesorRouter } from './modules/asesor/asesor.routes.js';
import { createCatalogoRouter } from './modules/admin/catalogo.routes.js';
import { loadAuthHttpPolicy } from './modules/auth/auth.constants.js';

/**
 * Compone Express con AUTH, ADMIN y ASESOR sin inicializar MySQL o SMTP al importar.
 * @param {object} options Entorno y contexto AUTH opcional para pruebas aisladas.
 * @returns {object} Aplicación sin listener; server.js conserva su responsabilidad de arranque.
 * @throws {Error} Si el origen HTTP configurado no cumple la política del entorno.
 */
export function createApp({ env = process.env, authContext } = {}) {
  const app = express();
  /** Confia unicamente en proxies de loopback: el Vite de desarrollo y el
   *  relay del tunnel Dev Tunnels llegan al backend por 127.0.0.1. Con este
   *  ajuste Express resuelve la IP del cliente en la primera entrada no
   *  confiable desde la derecha de X-Forwarded-For, de modo que un cliente
   *  remoto no puede falsear su IP y el keying por IP de express-rate-limit
   *  funciona detras del proxy (ERR_ERL_UNEXPECTED_X_FORWARDED_FOR) sin
   *  aceptar confianza indiscriminada en encabezados de clientes directos.
   *  No afecta CORS, requireTrustedOrigin ni la cookie de sesion. */
  app.set('trust proxy', 'loopback');
  const httpPolicy = loadAuthHttpPolicy(env);
  app.use(
    cors({
      /** Permite únicamente el origen exacto; solicitudes sin Origin no reciben permiso CORS. */
      origin(origin, callback) {
        if (!origin) return callback(null, false);
        if (origin === httpPolicy.origin) return callback(null, httpPolicy.origin);
        return callback(
          createAppError('ORIGIN_NOT_ALLOWED', 'El origen de la solicitud no está permitido.', 403)
        );
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type']
    })
  );
  app.use(express.json());

  /** Conserva el contrato de salud; no comprueba servicios ni requiere secretos AUTH. */
  app.get('/api/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      application: 'MATISTA',
      service: 'backend'
    });
  });
  app.use(
    '/api/auth',
    createAuthRouter({
      env,
      httpPolicy,
      context: authContext
    })
  );
  /** ADMIN comparte contexto, guardias y fallback entre todos sus slices. */
  app.use(
    '/api/admin',
    createAdminRouter({
      env,
      context: authContext
    })
  );
  app.use(
    '/api/asesor',
    createAsesorRouter({
      env,
      context: authContext
    })
  );
  app.use(
    '/api/catalogo',
    createCatalogoRouter({
      env,
      context: authContext
    })
  );
  app.use(errorHandler);
  return app;
}
const app = createApp();
export default app;

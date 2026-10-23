// Pruebas de la inicialización compartida del runtime AUTH/ADMIN
// (corrección B de la estabilización SPEC-03): initializeRuntime debe
// memoizar la PROMESA, de modo que las llamadas concurrentes de AUTH, ADMIN
// y el activador programado de políticas esperen la misma inicialización y
// compartan un único pool MySQL. Sin esta corrección, cada llamada
// concurrente construía su propio pool mientras la primera seguía en curso.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';

import { initializeRuntime } from '../../../src/modules/auth/auth.routes.js';
import { loadAuthHttpPolicy } from '../../../src/modules/auth/auth.constants.js';

/**
 * Entorno sintético completo: configuraciones válidas de seguridad y base
 * sin apuntar a ninguna instancia real (el pool de mysql2 no abre
 * conexiones hasta que se ejecuta la primera consulta).
 * @returns {object} Variables de entorno de prueba.
 */
function entornoPrueba() {
  return {
    NODE_ENV: 'test',
    DB_NAME: 'matista_test',
    DB_USER: 'matista_prueba',
    DB_PASSWORD: 'sin-conexion-real',
    DB_HOST: '127.0.0.1',
    DB_PORT: '3306',
    JWT_SECRET: randomBytes(32).toString('base64url'),
    FRONTEND_ORIGIN: 'http://localhost:5173',
  };
}

test('las llamadas concurrentes a initializeRuntime comparten un unico runtime', async () => {
  const env = entornoPrueba();
  const politica = loadAuthHttpPolicy(env);

  // Tres inicializaciones simultáneas: deben resolverse al mismo objeto,
  // no a tres runtimes con pools paralelos.
  const [primera, segunda, tercera] = await Promise.all([
    initializeRuntime(env, politica),
    initializeRuntime(env, politica),
    initializeRuntime(env, politica),
  ]);

  assert.strictEqual(primera, segunda, 'la segunda llamada debe reutilizar la primera');
  assert.strictEqual(segunda, tercera, 'la tercera llamada debe reutilizar la primera');
  assert.ok(primera.pool, 'el runtime expone el pool compartido');
  assert.ok(primera.dummyPasswordHash, 'el runtime conserva las dependencias de AUTH');

  // Ya inicializado: una llamada posterior resuelve exactamente el mismo runtime.
  const posterior = await initializeRuntime(env, politica);
  assert.strictEqual(posterior, primera, 'la promesa memoizada persiste tras inicializar');

  // El pool sintético no deja recursos vivos en el proceso de pruebas.
  await primera.pool.end();
});

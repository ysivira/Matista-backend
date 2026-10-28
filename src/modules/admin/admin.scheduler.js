/**
 * ============================================================
 * MATISTA | ACTIVADOR DE POLÍTICAS
 * ============================================================
 *
 * Archivo: admin.scheduler.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Programar ciclos de activación de políticas comerciales y
 * delegar sus escrituras al servicio transaccional.
 *
 * ============================================================
 */

/*
 * Activador programado del ciclo de vida de políticas comerciales.
 * Toda escritura real la resuelve el servicio transaccional: este módulo
 * solo consulta el scheduler del proceso e ignora activaciones vencidas
 * (la lectura hace activación preventiva, el intervalo solo la adelanta).
 */
import { activarPoliticasProgramadas } from './politica-comercial.service.js';

/** Referencia al intervalo activo del proceso, si existe. */
let temporizadorActivo = null;

/**
 * Inicia el intervalo que activa políticas programadas vencidas.
 * @param {object} pool Pool MySQL compartido por AUTH/ADMIN.
 * @param {{intervaloMs?: number}} opciones Frecuencia del ciclo (por defecto 30 s).
 * @returns {Function} Función `detener` que cancela el intervalo.
 */
export function iniciarActivadorPoliticas(pool, { intervaloMs = 30000 } = {}) {
  /**
   * Ejecuta un ciclo de activación seguro sin detener el scheduler.
   * @returns {Promise<void>}
   */
  async function ciclo() {
    try {
      await activarPoliticasProgramadas(pool);
    } catch (error) {
      // Nunca interrumpe el proceso: solo reporta el código para diagnóstico.
      console.warn('Activador de políticas:', error.code ?? 'ERROR_INESPERADO');
    }
  }
  const temporizador = setInterval(ciclo, intervaloMs);
  // No debe impedir el apagado ordenado del proceso.
  temporizador.unref?.();
  temporizadorActivo = temporizador;
  return () => clearInterval(temporizador);
}

/**
 * Detiene el activador de políticas del proceso sin lanzar fallos si nunca inició.
 * @returns {void}
 */
export function detenerActivadorPoliticas() {
  if (temporizadorActivo) {
    clearInterval(temporizadorActivo);
    temporizadorActivo = null;
  }
}

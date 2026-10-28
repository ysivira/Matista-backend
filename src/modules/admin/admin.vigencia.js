/**
 * ============================================================
 * MATISTA | COMPATIBILIDAD DE VIGENCIA
 * ============================================================
 *
 * Archivo: admin.vigencia.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Reexportar la consulta de vigencia, estado y tarifas desde el
 * repositorio del tarifario, conservando contratos de consumo.
 *
 * ============================================================
 */

/*
 * Mecanismos de vigencia e historial compartidos de ADMIN.
 * El acceso SQL reside ahora en src/modules/admin/tarifario.repository.js;
 * este modulo re-exporta para conservar los contratos de consumo existentes
 * (servicios ADMIN y ASESOR, y pruebas de mecanismos).
 * Nunca escriben ni recalculan versiones historicas (inmutabilidad).
 */
export {
  resolverVersionVigente,
  estadoEfectivoVersion,
  obtenerTarifasDeVersion
} from './tarifario.repository.js';

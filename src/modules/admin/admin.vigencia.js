/**
 * Resuelve la vigencia y activación de versiones administrativas.
 */

/*
 * Mecanismos de vigencia e historial compartidos de SPEC-03 ADMIN.
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

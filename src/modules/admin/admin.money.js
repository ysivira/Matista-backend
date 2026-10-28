/**
 * ============================================================
 * MATISTA | COMPATIBILIDAD MONETARIA ADMIN
 * ============================================================
 *
 * Archivo: admin.money.js
 * Módulo: Administración
 *
 * Responsabilidad:
 * Reexportar las utilidades monetarias compartidas conservando
 * los nombres y la identidad de la interfaz pública de ADMIN.
 *
 * ============================================================
 */

/*
 * Compatibilidad de la interfaz pública ADMIN: las funciones tienen una única implementación
 * neutral.
 */
export {
  parseDecimal,
  dividirHalfUp,
  importeACentavos,
  centavosAImporte,
  redondearImporte,
  aplicarPorcentaje,
  compararImportes,
  esImporteValido,
  esPorcentajeValido
} from '../../shared/lib/money.js';

// Compatibilidad de la interfaz pública ADMIN: las funciones tienen una única implementación neutral.
export {
  parseDecimal,
  dividirHalfUp,
  importeACentavos,
  centavosAImporte,
  redondearImporte,
  aplicarPorcentaje,
  compararImportes,
  esImporteValido,
  esPorcentajeValido,
} from '../../shared/lib/money.js';

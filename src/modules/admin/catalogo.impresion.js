/**
 * ============================================================
 * MATISTA | IMPRESIÓN DEL CATÁLOGO
 * ============================================================
 *
 * Archivo: catalogo.impresion.js
 * Módulo: Catálogo compartido
 *
 * Responsabilidad:
 * Preparar títulos, color y columnas para la plantilla del
 * catálogo, sin recalcular precios ni beneficios comerciales.
 *
 * ============================================================
 */
import { colorPlanPdf } from '../../infrastructure/pdf/documento.js';
import { renderizarCatalogo } from './documentos/catalogo.plantilla.js';

/**
 * Prepara la presentación del catálogo autorizado y delega el HTML autónomo para PDF e impresión.
 * @param {object} datos Plan o matriz de tarifas obtenida mediante servicios autorizados.
 * @param {'plan'|'precios'|'cotizacion'} tipo Contenido a presentar; no calcula tarifas ni beneficios.
 * @param {boolean} imprimir Abre el diálogo de impresión al completar la paginación.
 * @returns {Promise<string>} HTML autónomo sin menús, URLs visibles ni recursos externos.
 */
export async function documentoCatalogoHtml(datos, tipo, imprimir = false) {
  const plan = tipo === 'plan' ? datos : datos.plan;
  const color = colorPlanPdf(plan.nombre);
  const titulo = tipo === 'cotizacion'
    ? 'Cotización comercial'
    : tipo === 'plan'
      ? 'Prestaciones y coberturas'
      : 'Lista de precios';
  const encabezados = tipo === 'cotizacion'
    ? ['Concepto', 'Detalle', 'Importe']
    : tipo === 'plan'
      ? ['Prestación', 'Cobertura', 'Observaciones']
      : ['Segmento tarifario', 'Precio vigente'];
  return renderizarCatalogo({ datos, tipo, imprimir, plan, color, titulo, encabezados });
}

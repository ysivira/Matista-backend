import { imprimirHtmlPdf } from '../../infrastructure/pdf/html-pdf.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { esResultadoEconomico } from './motor.contract.js';
import { renderizarCotizacion } from './documentos/cotizacion.plantilla.js';

/**
 * Prepara el snapshot autorizado y delega su presentación sin recalcular economía histórica.
 * @param {object} q Cotización emitida autorizada; sus importes nunca se recalculan.
 * @param {object} contexto Catálogo/asesor de respaldo para metadatos ausentes en snapshots anteriores.
 * @returns {Promise<string>} HTML autónomo con paginación medida y contenido oficial escapado.
 * @throws {Error} ASESOR_ESTADO si no es una emisión válida.
 */
export async function cotizacionHtml(q, contexto = {}) {
  if (
    q.estado !== 'EMITIDA' ||
    !q.numero ||
    !q.emitida_at ||
    !esResultadoEconomico(q.resultado)
  )
    throw createAppError(
      'ASESOR_ESTADO',
      'El PDF requiere una cotización emitida válida y no anulada.',
      409
    );
  const r = q.resultado,
    solicitud = q.solicitud;
  const asesor = solicitud.asesor ?? contexto.asesor;
  const tieneCondiciones = Object.hasOwn(solicitud.plan, 'condiciones_generales');
  const tieneDetalles = Object.hasOwn(solicitud.plan, 'detalles');
  const condiciones = tieneCondiciones
    ? solicitud.plan.condiciones_generales
    : contexto.plan?.condiciones_generales;
  const detalles = tieneDetalles ? solicitud.plan.detalles : contexto.plan?.detalles;
  const lineas = [
    ['Valor base del plan', r.precio_base],
    ...r.beneficios.filter(b => Number(b.porcentaje) > 0 && Number(b.importe) > 0).map(b => [`${b.concepto === 'Comercial' ? 'Descuento comercial' : 'Beneficio ' + b.concepto} (${Number(b.porcentaje).toLocaleString('es-AR')} %)`, b.importe, 'descuento']),
    ...r.aportes.filter(a => Number(a.importe) > 0).map(a => ['Aporte ' + a.concepto, a.importe, 'aporte']),
    ...(r.impuestos ?? []).filter(i => Number(i.importe) > 0).map(i => [`${i.concepto.startsWith('IVA') ? 'IVA' : i.concepto} (${Number(i.porcentaje).toLocaleString('es-AR')} %)`, i.importe]),
  ];
  const periodos = r.tramos.filter(t => Number(t.porcentaje_comercial) > 0);
  return renderizarCotizacion({
    q,
    asesor,
    tieneCondiciones,
    tieneDetalles,
    condiciones,
    detalles,
    lineas,
    periodos
  });
}

/**
 * Delega al ejecutor Chrome existente sin calcular importes ni alterar la paginación.
 * @param {object} cotizacion Emisión autorizada que se presenta desde su snapshot.
 * @param {object} contexto Metadatos de respaldo para emisiones anteriores.
 * @returns {Promise<Buffer>} PDF A4 con todas las hojas necesarias.
 * @throws {Error} ASESOR_ESTADO, PDF_CONTENIDO_EXTENSO o PDF_NO_DISPONIBLE según el contrato existente.
 */
export async function cotizacionPdf(cotizacion, contexto = {}) {
  return imprimirHtmlPdf(await cotizacionHtml(cotizacion, contexto), {
    errorDesbordamiento: createAppError(
      'PDF_CONTENIDO_EXTENSO',
      'Un elemento del catálogo excede el área imprimible. No se omitió contenido; revise su organización para permitir una paginación legible.',
      422
    )
  });
}

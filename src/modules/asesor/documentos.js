import { readFile } from 'node:fs/promises';
import { imprimirHtmlPdf } from '../../infrastructure/pdf/html-pdf.js';
import { createAppError } from '../../shared/errors/app-error.js';
import { esResultadoEconomico } from './motor.contract.js';

const logo = readFile(new URL('../../infrastructure/pdf/assets/logo-matista.png', import.meta.url)).then(b => b.toString('base64'));

/** Escapa texto oficial y datos personales sin interpretar HTML recibido. */
function html(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
/** Presenta DECIMAL persistido sin calcular ni redondear importes. */
function pesos(value) { const [entero, centavos = '00'] = String(value).split('.'); return '$ ' + entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + centavos.padEnd(2, '0'); }
/** Presenta fechas oficiales en Argentina. */
function fecha(value) { return new Date(value).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' }); }

/**
 * Compone economía histórica y contenido completo disponible del catálogo, con hojas adicionales legibles.
 * @param {object} q Cotización emitida autorizada; sus importes nunca se recalculan.
 * @param {object} contexto Catálogo/asesor de respaldo para metadatos ausentes en snapshots anteriores.
 * @returns {Promise<string>} HTML autónomo con paginación medida y contenido oficial escapado.
 * @throws {Error} ASESOR_ESTADO si no es una emisión válida.
 */
export async function cotizacionHtml(q, contexto = {}) {
  if (q.estado !== 'EMITIDA' || !q.numero || !q.emitida_at || !esResultadoEconomico(q.resultado)) throw createAppError('ASESOR_ESTADO', 'El PDF requiere una cotización emitida válida y no anulada.', 409);
  const r = q.resultado, solicitud = q.solicitud, cliente = solicitud.cliente;
  const asesor = solicitud.asesor ?? contexto.asesor;
  const tieneCondiciones = Object.hasOwn(solicitud.plan, 'condiciones_generales');
  const tieneDetalles = Object.hasOwn(solicitud.plan, 'detalles');
  const condiciones = tieneCondiciones ? solicitud.plan.condiciones_generales : contexto.plan?.condiciones_generales;
  const detalles = tieneDetalles ? solicitud.plan.detalles : contexto.plan?.detalles;
  const filasPlan = String(detalles ?? '').split('\n').filter(l => l.trim()).map(linea => {
    const columnas = linea.split('|');
    return columnas.length === 3 ? `<tr>${columnas.map(c => `<td>${html(c)}</td>`).join('')}</tr>` : `<tr><td colspan="3">${html(linea)}</td></tr>`;
  }).join('');
  const lineas = [
    ['Valor base del plan', r.precio_base],
    ...r.beneficios.filter(b => Number(b.porcentaje) > 0 && Number(b.importe) > 0).map(b => [`${b.concepto === 'Comercial' ? 'Descuento comercial' : 'Beneficio ' + b.concepto} (${Number(b.porcentaje).toLocaleString('es-AR')} %)`, b.importe, 'descuento']),
    ...r.aportes.filter(a => Number(a.importe) > 0).map(a => ['Aporte ' + a.concepto, a.importe, 'aporte']),
    ...(r.impuestos ?? []).filter(i => Number(i.importe) > 0).map(i => [`${i.concepto.startsWith('IVA') ? 'IVA' : i.concepto} (${Number(i.porcentaje).toLocaleString('es-AR')} %)`, i.importe]),
  ];
  const periodos = r.tramos.filter(t => Number(t.porcentaje_comercial) > 0);
  const marca = `<header class="marca"><img src="data:image/png;base64,${await logo}" alt="MATISTA"><div>GESTIÓN COMERCIAL<strong>Cotización oficial</strong><span>${html(q.numero)}</span></div></header>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>MATISTA · ${html(q.numero)}</title><style>
    @page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#eeebf5;color:#202236;font:10pt Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .hoja{position:relative;width:210mm;height:297mm;padding:12mm 13mm 16mm;background:white;margin:8mm auto;break-after:page}.hoja:last-child{break-after:auto}
    .marca{height:22mm;background:#202236;border-bottom:1.2mm solid #8b5cf6;border-radius:4mm;display:flex;align-items:center;justify-content:space-between;padding:2mm 5mm}.marca img{width:42mm;height:19mm;object-fit:contain}.marca div{text-align:right;color:#e9ddff;font-size:8pt;line-height:1.5}.marca strong{display:block;color:white;font-size:12pt}
    .contenido{margin-top:5mm}h1{font-size:22pt;letter-spacing:-.03em;color:#5516be;margin:0 0 2mm}h2{font-size:10.5pt;margin:4mm 0 2mm;color:#5516be}p{margin:1.5mm 0;line-height:1.45}.meta{font-size:8.5pt;color:#5d607e;margin-bottom:3mm}
    .identidad{background:#f7f3ff;border:1px solid #e8def7;border-radius:3mm;padding:3mm;display:grid;grid-template-columns:1.2fr 1fr;gap:2mm 5mm}.identidad div{overflow-wrap:anywhere}.identidad small{display:block;color:#5d607e;font-size:7.5pt;margin-bottom:1mm}.identidad strong{font-size:10pt}
    .plan{display:flex;justify-content:space-between;border-bottom:1px solid #ddd6e9;padding:3mm 0;font-size:10pt}.plan strong{color:#5516be}table{width:100%;border-collapse:collapse;font-size:9pt}th{text-align:left;background:#eee8f8;color:#5d4380;font-size:7.5pt;text-transform:uppercase;padding:2mm}td{padding:1.8mm 2mm;border-bottom:1px solid #eee9f5;line-height:1.3}tr{break-inside:avoid}.valor{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.descuento{color:#6d28d9}.aporte{color:#047857}
    .total{display:flex;align-items:center;justify-content:space-between;background:linear-gradient(100deg,#5516be,#8b5cf6);border-radius:3mm;color:white;padding:4mm;margin:4mm 0}.total small{display:block;font-size:8pt;color:#e9ddff}.total strong{font-size:21pt;white-space:nowrap}.tramos{display:flex;flex-wrap:wrap;gap:2mm}.tramo{background:#f5f0ff;border:1px solid #e2d6f7;border-radius:2mm;padding:2mm 3mm;min-width:30mm;font-size:8.5pt}.tramo strong{display:block;color:#5516be;font-size:11pt}
    .nota{font-size:8pt;color:#5d607e;line-height:1.45;margin-top:3mm}.texto-oficial{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11pt;line-height:1.5;margin:3mm 0}.prestaciones{table-layout:fixed}.prestaciones th:first-child{width:45%}.prestaciones th:nth-child(2){width:25%}.prestaciones td{font-size:10pt;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;padding:2mm}.ausencia{padding:4mm;background:#fffbeb;border:1px solid #fde68a;color:#92400e}
    footer{position:absolute;bottom:7mm;left:13mm;right:13mm;border-top:1px solid #ddd6e9;padding-top:3mm;display:flex;justify-content:space-between;color:#77758a;font-size:7pt}@media print{body{background:white}.hoja{margin:0}}
  </style></head><body><main id="documento"></main><template id="marca">${marca}</template>
  <template id="comercial"><h1>Cotización comercial</h1><p class="meta">${html(q.numero)} · Emisión ${fecha(q.emitida_at)}${q.vence_at ? ` · Vigencia hasta ${fecha(q.vence_at)}` : ''}</p>
    <div class="identidad"><div><small>TITULAR</small><strong>${html(cliente.nombres)} ${html(cliente.apellidos)}</strong><p>DNI ${html(cliente.dni)}</p></div><div><small>ASESOR COMERCIAL RESPONSABLE</small><strong>${asesor ? html(`${asesor.nombre} ${asesor.apellido}`) : 'No registrado en el snapshot'}</strong>${asesor?.legajo ? `<p>Legajo ${html(asesor.legajo)}</p>` : ''}</div>${q.contacto?.email ? `<div><small>CORREO ELECTRÓNICO</small>${html(q.contacto.email)}</div>` : ''}${q.contacto?.telefono ? `<div><small>TELÉFONO</small>${html(q.contacto.telefono)}</div>` : ''}</div>
    <div class="plan"><span>Plan <strong>${html(solicitud.plan.nombre)}</strong></span><span>Modalidad <strong>${html(q.modalidad)}</strong></span></div>
    <h2>Grupo familiar cotizado</h2><table><thead><tr><th>Integrante / vínculo</th><th>Edad utilizada</th><th class="valor">Valor base individual</th></tr></thead><tbody>${(r.integrantes ?? []).map((m, i) => `<tr><td>${i === 0 ? html(`${cliente.nombres} ${cliente.apellidos} · Titular`) : html(m.parentesco)}</td><td>${html(m.edad)} años</td><td class="valor">${pesos(m.precio)}</td></tr>`).join('')}</tbody></table>
    <h2>Liquidación del primer período</h2><table><tbody>${lineas.map(([concepto, importe, clase = '']) => `<tr class="${clase}"><td>${html(concepto)}</td><td class="valor">${clase ? '− ' : ''}${pesos(importe)}</td></tr>`).join('')}</tbody></table>
    <div class="total"><div>IMPORTE MENSUAL INICIAL<small>Primer período: meses ${html(r.tramos[0].desde_mes)} a ${html(r.tramos[0].hasta_mes)}</small></div><strong>${pesos(r.total)}</strong></div>
    ${periodos.length ? `<h2>Descuentos Comerciales Pactados</h2><div class="tramos">${periodos.map(t => `<div class="tramo">Meses ${html(t.desde_mes)} a ${html(t.hasta_mes)}<strong>${html(String(t.porcentaje_comercial).replace('.', ','))} %</strong></div>`).join('')}</div>` : ''}
    <p class="nota">Los importes pueden variar por los aumentos autorizados que correspondan, respetando los porcentajes comerciales pactados durante su vigencia. No constituye factura.</p><p class="nota">Tarifa ${html(r.referencias.tarifa_version_id)} · Política ${html(r.referencias.politica_id)} · Motor ${html(r.motor_version)}</p>
  </template><template id="catalogo"><h1>Condiciones del plan</h1><h2>Plan ${html(solicitud.plan.nombre)}</h2><p class="meta">Fuente: catálogo oficial MATISTA · Prestaciones, coberturas, condiciones y referencias${!tieneDetalles || !tieneCondiciones ? ' · Incluye contenido actual no capturado en la emisión anterior' : ' · Contenido capturado al preparar la emisión'}</p>
    ${filasPlan ? `<h2>Prestaciones y coberturas</h2><table class="prestaciones"><thead><tr><th>Prestación</th><th>Cobertura</th><th>Observaciones</th></tr></thead><tbody>${filasPlan}</tbody></table>` : '<p class="ausencia">No hay prestaciones detalladas registradas para este plan en el catálogo.</p>'}
    <h2>Condiciones generales y referencias</h2>${condiciones && String(condiciones).trim() ? String(condiciones).split(/\n\n/).map(p => `<p class="texto-oficial">${html(p)}</p>`).join('') : '<p class="ausencia">El catálogo oficial no contiene condiciones generales registradas para este plan.</p>'}
  </template><script>
    // Distribuye texto/filas sin cálculo económico, sin omitir contenido y sin reducir la tipografía.
    addEventListener('load',async()=>{
      await document.fonts.ready;
      const destino=document.getElementById('documento');let contenido,modo;
      /** Crea una hoja y mide el espacio real por encima del pie. */
      function nueva(){const hoja=document.createElement('section');hoja.className='hoja';hoja.innerHTML=document.getElementById('marca').innerHTML+'<div class="contenido"></div><footer><span></span><span class="numeracion"></span></footer>';hoja.querySelector('footer span').textContent=${JSON.stringify(`MATISTA · ${q.numero} · ${solicitud.plan.nombre}`).replace(/</g, '\\u003c')};destino.append(hoja);contenido=hoja.querySelector('.contenido');contenido.style.height=(hoja.querySelector('footer').offsetTop-contenido.offsetTop-12)+'px';}
      /** Comprueba la altura disponible sin ocultar desbordamientos. */
      function excede(){return contenido.scrollHeight>contenido.clientHeight+1;}
      /** Parte únicamente párrafos demasiado largos, preservando todos sus caracteres. */
      function textoLargo(original){let resto=original.textContent;while(resto){const nodo=original.cloneNode(false);nodo.textContent=resto;contenido.append(nodo);if(!excede())return;nodo.remove();if(contenido.children.length){nueva();continue;}let min=1,max=resto.length,limite=0;contenido.append(nodo);while(min<=max){const medio=Math.floor((min+max)/2);nodo.textContent=resto.slice(0,medio);if(excede())max=medio-1;else{limite=medio;min=medio+1;}}if(!limite){document.documentElement.dataset.documentoError='elemento_no_paginable';return;}const salto=resto.lastIndexOf('\\n',limite-1),espacio=resto.lastIndexOf(' ',limite-1);if(salto>0)limite=salto+1;else if(espacio>0)limite=espacio+1;nodo.textContent=resto.slice(0,limite);resto=resto.slice(limite);if(resto)nueva();}}
      /** Distribuye tablas por filas, repitiendo sus encabezados. */
      function tabla(original){let copia=original.cloneNode(true);copia.querySelector('tbody').replaceChildren();contenido.append(copia);for(const fila of original.querySelectorAll('tbody>tr')){const nodo=fila.cloneNode(true);copia.querySelector('tbody').append(nodo);if(excede()){nodo.remove();if(!copia.querySelector('tbody').children.length)copia.remove();nueva();copia=original.cloneNode(true);copia.querySelector('tbody').replaceChildren(nodo);contenido.append(copia);if(excede()){document.documentElement.dataset.documentoError='fila_no_paginable';return;}}}}
      /** Agrega un bloque completo o inicia su continuación sin descartar información. */
      function agregar(original){if(original.tagName==='TABLE'){tabla(original);return;}const nodo=original.cloneNode(true);contenido.append(nodo);if(!excede())return;nodo.remove();if(contenido.children.length)nueva();contenido.append(nodo);if(excede()){nodo.remove();if(original.tagName==='P')textoLargo(original);else document.documentElement.dataset.documentoError='bloque_no_paginable';}}
      for(modo of ['comercial','catalogo']){nueva();for(const bloque of document.getElementById(modo).content.children)agregar(bloque);}
      const hojas=[...destino.children];hojas.forEach((hoja,i)=>hoja.querySelector('.numeracion').textContent='Página '+(i+1)+' de '+hojas.length);
      await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
      if([...document.querySelectorAll('.contenido')].some(c=>c.scrollHeight>c.clientHeight+1))document.documentElement.dataset.documentoError='desbordamiento';
      document.documentElement.dataset.documentoListo='true';
    });
  </script></body></html>`;
}

/** Imprime tantas hojas como necesite el catálogo; solo rechaza elementos individuales imposibles de paginar legiblemente. */
export async function cotizacionPdf(cotizacion, contexto = {}) {
  return imprimirHtmlPdf(await cotizacionHtml(cotizacion, contexto), { errorDesbordamiento: createAppError('PDF_CONTENIDO_EXTENSO', 'Un elemento del catálogo excede el área imprimible. No se omitió contenido; revise su organización para permitir una paginación legible.', 422) });
}

import { readFile } from 'node:fs/promises';
import { colorPlanPdf } from '../../infrastructure/pdf/documento.js';

const logo = readFile(new URL('../../infrastructure/pdf/assets/logo-matista.png', import.meta.url)).then(b => b.toString('base64'));

/** Escapa texto del catálogo antes de incorporarlo al documento HTML imprimible. */
function html(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Presenta un DECIMAL persistido con formato argentino, sin alterar su valor económico. */
function pesos(valor) {
  const [entero, centavos = '00'] = String(valor).split('.');
  return '$ ' + entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + centavos.padEnd(2, '0');
}

/** Presenta la fecha de vigencia en Argentina; no expone el formato ISO técnico. */
function fecha(valor) {
  return new Date(valor).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Construye un único documento para PDF e impresión desde el catálogo real de ADMIN.
 * @param {object} datos Plan o matriz de tarifas obtenida mediante servicios autorizados.
 * @param {'plan'|'precios'|'cotizacion'} tipo Contenido a presentar; no calcula tarifas ni beneficios.
 * @param {boolean} imprimir Abre el diálogo de impresión al completar la paginación.
 * @returns {Promise<string>} HTML autónomo sin menús, URLs visibles ni recursos externos.
 */
export async function documentoCatalogoHtml(datos, tipo, imprimir = false) {
  const plan = tipo === 'plan' ? datos : datos.plan;
  const color = colorPlanPdf(plan.nombre);
  const titulo = tipo === 'cotizacion' ? 'Cotización comercial' : tipo === 'plan' ? 'Prestaciones y coberturas' : 'Lista de precios';
  const encabezados = tipo === 'cotizacion' ? ['Concepto', 'Detalle', 'Importe'] : tipo === 'plan' ? ['Prestación', 'Cobertura', 'Observaciones'] : ['Segmento tarifario', 'Precio vigente'];
  const filas = tipo === 'cotizacion' ? datos.filas_documento.map(f => (f[0] === 'IMPORTE FINAL INICIAL' ? '<tr class="total">' : '<tr>') + f.map(c => `<td>${html(c)}</td>`).join('') + '</tr>') : tipo === 'plan' ? String(datos.detalles ?? '').split('\n').filter(l => l.trim()).map(l => {
    const partes = l.split('|');
    return partes.length === 3 ? '<tr>' + partes.map(p => `<td>${html(p.trim())}</td>`).join('') + '</tr>'
      : `<tr><td colspan="3" class="original">${html(l)}</td></tr>`;
  }) : datos.tarifas.map(t => `<tr><td>${html(t.rango_etario)}${t.rango_nota && !t.rango_etario.includes(t.rango_nota) ? `<small>${html(t.rango_nota)}</small>` : ''}</td><td class="precio">${html(pesos(t.precio))}</td></tr>`);
  const metadatos = tipo === 'cotizacion' ? html(datos.metadatos_documento) : tipo === 'plan' ? 'Catálogo oficial · Información del plan'
    : `${html(datos.tipo_ingreso === 'Obligatorio' ? 'Obligatorio / Monotributo' : datos.tipo_ingreso)} &nbsp;·&nbsp; Versión ${html(datos.version.id)} &nbsp;·&nbsp; Vigente desde ${fecha(datos.version.fecha_activacion)}`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>MATISTA · ${html(plan.nombre)} · ${titulo}</title><style>
    @page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#24263a;font-family:Arial,Helvetica,sans-serif;font-size:10pt;background:#e9e6f1;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .pagina{width:210mm;height:297mm;background:#fff;position:relative;padding:12mm 13mm 15mm;break-after:page;overflow:hidden;margin:8mm auto;box-shadow:0 4px 24px #25253820}.pagina:last-child{break-after:auto}
    .marca{height:28mm;border-radius:4mm;background:#202236;display:flex;align-items:center;justify-content:space-between;padding:3mm 6mm;border-bottom:1mm solid #8b5cf6}.marca img{width:43mm;height:23mm;object-fit:contain}.marca div{text-align:right;color:#ddd6fe;font-size:8pt;letter-spacing:.06em;line-height:1.7}.marca b{display:block;color:white;font-size:12pt;letter-spacing:0}
    .titulo{display:flex;gap:4mm;align-items:center;margin:7mm 0 4mm}.gema{height:14mm;width:14mm;background:color-mix(in srgb,var(--plan) 10%,white);border:1px solid color-mix(in srgb,var(--plan) 24%,white);border-radius:3mm;display:grid;place-items:center;color:var(--plan)}.gema svg{width:9mm;height:9mm}
    .eyebrow{font-size:7.5pt;font-weight:bold;letter-spacing:.13em;color:#7c3aed;text-transform:uppercase;margin:0 0 1.8mm}h1{font-size:22pt;letter-spacing:-.02em;margin:0;color:var(--plan)}h2{font-size:11pt;margin:0;color:#303149;font-weight:600}.meta{border:1px solid #e7e1f2;border-left:1mm solid var(--plan);border-radius:2mm;background:#f8f6fc;padding:3.5mm;margin:4mm 0 5mm;font-size:8.5pt;color:#5e6076;line-height:1.5}
    .contenido{max-height:203mm;overflow:hidden}table{width:100%;border-collapse:collapse;table-layout:fixed}thead{display:table-header-group}th{background:#ece7f8;color:#544078;font-size:8pt;text-align:left;letter-spacing:.03em;padding:3.5mm 3mm;border-bottom:1px solid #d8cceb}td{padding:3mm;vertical-align:top;border-bottom:1px solid #e9e5f0;font-size:9pt;line-height:1.5;overflow-wrap:anywhere}tr:nth-child(even) td{background:#faf9fd}tr{break-inside:avoid}td+td,th+th{border-left:1px solid #eeebf5}.plan td{padding:1mm 3mm;font-size:9.5pt;line-height:1.2}.plan th:nth-child(1){width:43%}.plan th:nth-child(2){width:20%}.plan th:nth-child(3){width:37%}.precios td{padding:1.8mm 3mm;font-size:9.5pt;line-height:1.4}.precios th:first-child{width:69%}.precios th:last-child,.precio{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.cotizacion .total td{background:#ede9fe;font-weight:700;color:#54249c;border-top:1px solid #c4b5fd;border-bottom:1px solid #c4b5fd}.cotizacion th:first-child{width:38%}.cotizacion th:nth-child(2){width:33%}.cotizacion th:last-child{width:29%}.cotizacion td:last-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.original{color:#55586d}small{display:block;color:#73768c;font-size:8pt;margin-top:1mm}
    body[data-documento="plan"] .marca{height:20mm}body[data-documento="plan"] .marca img{height:17mm}body[data-documento="plan"] .titulo{margin:4mm 0 2mm}body[data-documento="plan"] .gema{height:12mm;width:12mm}body[data-documento="plan"] .meta{padding:2mm;margin:2mm 0 3mm}body[data-documento="plan"] .condiciones{margin-top:3mm}body[data-documento="plan"] .nota{padding:2mm}
    .condiciones{margin-top:5mm}.contenido>h3{font-size:10pt;color:#6d28d9;margin:0 0 2mm}.nota{white-space:pre-wrap;font-size:8.5pt;line-height:1.55;color:#626579;margin:0;padding:3mm;border-left:.7mm solid #d9cafa;background:#faf8fe}
    footer{position:absolute;bottom:7mm;left:13mm;right:13mm;display:flex;justify-content:space-between;border-top:1px solid #ddd6eb;padding-top:3mm;font-size:7pt;color:#7b7d91}.continuacion .marca{height:20mm}.continuacion .marca img{height:17mm}.continuacion .titulo{margin:4mm 0 3mm}.continuacion h1{font-size:16pt}.continuacion .contenido{max-height:223mm}.continuacion .meta{display:none}
    @media print{html,body{background:white}.pagina{margin:0;box-shadow:none}}@media screen and (max-width:800px){body{width:210mm}}
    </style></head><body data-documento="${tipo}" style="--plan:${color}"><main id="documento"></main><template id="cabecera"><header class="marca"><img src="data:image/png;base64,${await logo}" alt="MATISTA"><div>GESTIÓN COMERCIAL<b>${titulo}</b>${tipo === 'cotizacion' ? 'Emisión histórica' : 'Documento de consulta'}</div></header><div class="titulo"><span class="gema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><polygon points="6 3 18 3 22 9 12 22 2 9 6 3"/><path d="M11 3 8 9l4 13M13 3l3 6-4 13M2 9h20"/></svg></span><div><p class="eyebrow">MATISTA · ${tipo === 'cotizacion' ? html(datos.titulo_documento) : tipo === 'plan' ? 'Catálogo de planes' : 'Tarifario vigente'}</p><h1>${html(plan.nombre)}</h1></div></div><div class="meta">${metadatos}</div></template>
    <template id="tabla"><table class="${tipo}"><thead><tr>${encabezados.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody></tbody></table></template>
    <template id="filas">${filas.length ? '<table><tbody>' + filas.join('') + '</tbody></table>' : '<table><tbody><tr><td>Sin información disponible.</td></tr></tbody></table>'}</template>
    <template id="notas">${tipo !== 'precios' && datos.condiciones_generales ? `<section class="condiciones"><h3>Condiciones generales y referencias</h3>${String(datos.condiciones_generales).split('\n').filter(l => l.trim()).map(l => `<p class="nota">${html(l)}</p>`).join('')}</section>` : ''}</template>
    <script>
    // La paginación solo distribuye contenido visual: nunca calcula valores de negocio.
    addEventListener('load',async()=>{
      await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));
      const destino=document.getElementById('documento');let pagina,contenido,cuerpo;
      /** Crea una hoja con marca, pie y área útil medida antes de distribuir filas. */
      function nueva(tabla=true){pagina=document.createElement('section');pagina.className='pagina'+(destino.children.length?' continuacion':'');pagina.innerHTML=document.getElementById('cabecera').innerHTML+'<div class="contenido"></div><footer><span>MATISTA · '+${JSON.stringify(titulo)}+'</span><span class="numeracion"></span></footer>';destino.append(pagina);contenido=pagina.querySelector('.contenido');contenido.style.height=(pagina.querySelector('footer').offsetTop-contenido.offsetTop-14)+'px';contenido.style.maxHeight='none';if(tabla){contenido.append(document.getElementById('tabla').content.cloneNode(true));cuerpo=contenido.querySelector('tbody');}}
      /** Comprueba si el bloque ocupa más altura que el área imprimible disponible. */
      function excede(){return contenido.scrollHeight>contenido.clientHeight+1;}
      nueva();
      for(const fila of document.getElementById('filas').content.querySelectorAll('tr')){const clon=fila.cloneNode(true);cuerpo.append(clon);if(excede()&&cuerpo.children.length>1){clon.remove();nueva();cuerpo.append(clon);}}
      const notas=document.getElementById('notas').content.querySelector('section');
      if(notas){const titulo=notas.querySelector('h3');contenido.append(titulo.cloneNode(true));for(const parrafo of notas.querySelectorAll('p')){const clon=parrafo.cloneNode(true);contenido.append(clon);if(excede()){clon.remove();if(contenido.lastElementChild.tagName==='H3')contenido.lastElementChild.remove();nueva(false);contenido.append(titulo.cloneNode(true),clon);}}}
      const paginas=[...destino.children];paginas.forEach((p,i)=>p.querySelector('.numeracion').textContent=(i+1)+' / '+paginas.length);
      await Promise.all([...document.images].map(i=>i.decode().catch(()=>{})));if([...document.querySelectorAll('.contenido')].some(c=>c.scrollHeight>c.clientHeight+1))document.documentElement.dataset.documentoError='desbordamiento';document.documentElement.dataset.documentoListo='true';${imprimir ? 'window.print();' : ''}
    });
    </script></body></html>`;
}

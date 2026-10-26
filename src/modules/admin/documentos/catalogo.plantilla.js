import { readFile } from 'node:fs/promises';
import { html, pesos, fecha } from '../../../infrastructure/pdf/formato-documental.js';

// Estos recursos se incorporan al HTML final, sin enlaces externos ni rutas del navegador del usuario.
const recursos = Promise.all([
  readFile(new URL('./catalogo.css', import.meta.url), 'utf8'),
  readFile(new URL('./catalogo.paginacion.js', import.meta.url), 'utf8'),
  readFile(new URL('../../../infrastructure/pdf/assets/logo-matista.png', import.meta.url)),
]);

/**
 * Renderiza filas, metadatos y notas del catálogo con sus estilos y paginación independientes.
 * @param {object} vista Catálogo autorizado, tipo, textos, color e indicación de impresión preparados.
 * @returns {Promise<string>} HTML autónomo equivalente al usado por PDF e impresión antes de la extracción.
 * @throws {Error} Propaga errores de lectura de los recursos documentales del servidor.
 */
export async function renderizarCatalogo(vista) {
  const { datos, tipo, imprimir, plan, color, titulo, encabezados } = vista;
  const [estilos, paginacion, imagen] = await recursos;
  const logo = imagen.toString('base64');
  const filas = tipo === 'cotizacion' ? datos.filas_documento.map(f => (f[0] === 'IMPORTE FINAL INICIAL' ? '<tr class="total">' : '<tr>') + f.map(c => `<td>${html(c)}</td>`).join('') + '</tr>') : tipo === 'plan' ? String(datos.detalles ?? '').split('\n').filter(l => l.trim()).map(l => {
    const partes = l.split('|');
    return partes.length === 3 ? '<tr>' + partes.map(p => `<td>${html(p.trim())}</td>`).join('') + '</tr>'
      : `<tr><td colspan="3" class="original">${html(l)}</td></tr>`;
  }) : datos.tarifas.map(t => `<tr><td>${html(t.rango_etario)}${t.rango_nota && !t.rango_etario.includes(t.rango_nota) ? `<small>${html(t.rango_nota)}</small>` : ''}</td><td class="precio">${html(pesos(t.precio))}</td></tr>`);
  const metadatos = tipo === 'cotizacion' ? html(datos.metadatos_documento) : tipo === 'plan' ? 'Catálogo oficial · Información del plan'
    : `${html(datos.tipo_ingreso === 'Obligatorio' ? 'Obligatorio / Monotributo' : datos.tipo_ingreso)} &nbsp;·&nbsp; Versión ${html(datos.version.id)} &nbsp;·&nbsp; Vigente desde ${fecha(datos.version.fecha_activacion)}`;
  // Solo se sustituyen dos puntos explícitos; no se evalúan plantillas ni datos como código del servidor.
  const script = paginacion.trimEnd().replace('/* MATISTA_TITULO */null', () => JSON.stringify(titulo))
    .replace('/* MATISTA_IMPRIMIR */', () => imprimir ? 'window.print();' : '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>MATISTA · ${html(plan.nombre)} · ${titulo}</title><style>
${estilos.trimEnd()}
    </style></head><body data-documento="${tipo}" style="--plan:${color}"><main id="documento"></main><template id="cabecera"><header class="marca"><img src="data:image/png;base64,${logo}" alt="MATISTA"><div>GESTIÓN COMERCIAL<b>${titulo}</b>${tipo === 'cotizacion' ? 'Emisión histórica' : 'Documento de consulta'}</div></header><div class="titulo"><span class="gema"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><polygon points="6 3 18 3 22 9 12 22 2 9 6 3"/><path d="M11 3 8 9l4 13M13 3l3 6-4 13M2 9h20"/></svg></span><div><p class="eyebrow">MATISTA · ${tipo === 'cotizacion' ? html(datos.titulo_documento) : tipo === 'plan' ? 'Catálogo de planes' : 'Tarifario vigente'}</p><h1>${html(plan.nombre)}</h1></div></div><div class="meta">${metadatos}</div></template>
    <template id="tabla"><table class="${tipo}"><thead><tr>${encabezados.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody></tbody></table></template>
    <template id="filas">${filas.length ? '<table><tbody>' + filas.join('') + '</tbody></table>' : '<table><tbody><tr><td>Sin información disponible.</td></tr></tbody></table>'}</template>
    <template id="notas">${tipo !== 'precios' && datos.condiciones_generales ? `<section class="condiciones"><h3>Condiciones generales y referencias</h3>${String(datos.condiciones_generales).split('\n').filter(l => l.trim()).map(l => `<p class="nota">${html(l)}</p>`).join('')}</section>` : ''}</template>
    <script>
${script}
    </script></body></html>`;
}

import { readFile } from 'node:fs/promises';
import { html, pesos, fecha } from '../../../infrastructure/pdf/formato-documental.js';

// Los archivos se leen en el servidor y se embeben: el navegador nunca recibe rutas locales.
const recursos = Promise.all([
  readFile(new URL('./cotizacion.css', import.meta.url), 'utf8'),
  readFile(new URL('./cotizacion.paginacion.js', import.meta.url), 'utf8'),
  readFile(new URL('../../../infrastructure/pdf/assets/logo-matista.png', import.meta.url))
]);

/**
 * Renderiza la presentación del snapshot preparado, con CSS, paginación y marca embebidos.
 * @param {object} vista Datos documentales autorizados y conceptos históricos, sin cálculos nuevos.
 * @returns {Promise<string>} HTML autónomo con contenido histórico, estilos y paginación embebidos.
 * @throws {Error} Propaga errores de lectura de los recursos documentales del servidor.
 */
export async function renderizarCotizacion(vista) {
  const { q, asesor, tieneCondiciones, tieneDetalles, condiciones, detalles, lineas, periodos } =
    vista;
  const r = q.resultado,
    solicitud = q.solicitud,
    cliente = solicitud.cliente;
  const [estilos, paginacion, imagen] = await recursos;
  const logo = imagen.toString('base64');
  const filasPlan = String(detalles ?? '')
    .split('\n')
    .filter(l => l.trim())
    .map(linea => {
      const columnas = linea.split('|');
      return columnas.length === 3
        ? `<tr>${columnas.map(c => `<td>${html(c)}</td>`).join('')}</tr>`
        : `<tr><td colspan="3">${html(linea)}</td></tr>`;
    })
    .join('');
  // La función de reemplazo conserva literalmente $& y el escape de < evita cerrar el script desde datos.
  const script = paginacion
    .trimEnd()
    .replace('/* MATISTA_PIE */null', () =>
      JSON.stringify(`MATISTA · ${q.numero} · ${solicitud.plan.nombre}`).replace(/</g, '\\u003c')
    );
  const marca = `<header class="marca">
  <img src="data:image/png;base64,${logo}" alt="MATISTA">
  <div>GESTIÓN COMERCIAL<strong>Cotización oficial</strong><span>${html(q.numero)}</span></div>
</header>`;
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <title>MATISTA · ${html(q.numero)}</title>
    <style>
${estilos.trimEnd()}
  </style>
  </head>
  <body>
    <main id="documento"></main>
    <template id="marca">
      ${marca}
    </template>
    <template id="comercial">
      <h1>Cotización comercial</h1>
      <p class="meta">${html(q.numero)} · Emisión ${fecha(q.emitida_at)}${q.vence_at ? ` · Vigencia hasta ${fecha(q.vence_at)}` : ''}</p>
      <div class="identidad">
        <div><small>TITULAR</small><strong>${html(cliente.nombres)} ${html(cliente.apellidos)}</strong><p>DNI ${html(cliente.dni)}</p></div>
        <div><small>ASESOR COMERCIAL RESPONSABLE</small><strong>${asesor ? html(`${asesor.nombre} ${asesor.apellido}`) : 'No registrado en el snapshot'}</strong>${asesor?.legajo ? `<p>Legajo ${html(asesor.legajo)}</p>` : ''}</div>
        ${q.contacto?.email ? `<div><small>CORREO ELECTRÓNICO</small>${html(q.contacto.email)}</div>` : ''}
        ${q.contacto?.telefono ? `<div><small>TELÉFONO</small>${html(q.contacto.telefono)}</div>` : ''}
      </div>
      <div class="plan">
        <span>Plan <strong>${html(solicitud.plan.nombre)}</strong></span>
        <span>Modalidad <strong>${html(q.modalidad)}</strong></span>
      </div>
      <h2>Grupo familiar cotizado</h2>
      <table>
        <thead>
          <tr>
            <th>Integrante / vínculo</th>
            <th>Edad utilizada</th>
            <th class="valor">Valor base individual</th>
          </tr>
        </thead>
        <tbody>
          ${(r.integrantes ?? []).map((m, i) => `<tr><td>${i === 0 ? html(`${cliente.nombres} ${cliente.apellidos} · Titular`) : html(m.parentesco)}</td><td>${html(m.edad)} años</td><td class="valor">${pesos(m.precio)}</td></tr>`).join('')}
        </tbody>
      </table>
      <h2>Liquidación del primer período</h2>
      <table>
        <tbody>
          ${lineas.map(([concepto, importe, clase = '']) => `<tr class="${clase}"><td>${html(concepto)}</td><td class="valor">${clase ? '− ' : ''}${pesos(importe)}</td></tr>`).join('')}
        </tbody>
      </table>
      <div class="total">
        <div>IMPORTE MENSUAL INICIAL<small>Primer período: meses ${html(r.tramos[0].desde_mes)} a ${html(r.tramos[0].hasta_mes)}</small></div>
        <strong>${pesos(r.total)}</strong>
      </div>
      ${periodos.length ? `<h2>Descuentos Comerciales Pactados</h2><div class="tramos">${periodos.map(t => `<div class="tramo">Meses ${html(t.desde_mes)} a ${html(t.hasta_mes)}<strong>${html(String(t.porcentaje_comercial).replace('.', ','))} %</strong></div>`).join('')}</div>` : ''}
      <p class="nota">Los importes pueden variar por los aumentos autorizados que correspondan, respetando los porcentajes comerciales pactados durante su vigencia. No constituye factura.</p>
      <p class="nota">Tarifa ${html(r.referencias.tarifa_version_id)} · Política ${html(r.referencias.politica_id)} · Motor ${html(r.motor_version)}</p>
    </template>
    <template id="catalogo">
      <h1>Condiciones del plan</h1>
      <h2>Plan ${html(solicitud.plan.nombre)}</h2>
      <p class="meta">Fuente: catálogo oficial MATISTA · Prestaciones, coberturas, condiciones y referencias${!tieneDetalles || !tieneCondiciones ? ' · Incluye contenido actual no capturado en la emisión anterior' : ' · Contenido capturado al preparar la emisión'}</p>
      ${filasPlan ? `<h2>Prestaciones y coberturas</h2><table class="prestaciones"><thead><tr><th>Prestación</th><th>Cobertura</th><th>Observaciones</th></tr></thead><tbody>${filasPlan}</tbody></table>` : '<p class="ausencia">No hay prestaciones detalladas registradas para este plan en el catálogo.</p>'}
      <h2>Condiciones generales y referencias</h2>
      ${condiciones && String(condiciones).trim() ? String(condiciones).split(/\n\n/).map(p => `<p class="texto-oficial">${html(p)}</p>`).join('') : '<p class="ausencia">El catálogo oficial no contiene condiciones generales registradas para este plan.</p>'}
    </template>
    <script>
${script}
  </script>
  </body>
</html>`;
}

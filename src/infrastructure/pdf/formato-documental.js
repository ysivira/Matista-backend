/**
 * Escapa texto oficial o personal antes de incorporarlo al HTML, sin interpretar etiquetas recibidas.
 * @param {unknown} valor Texto o dato escalar; null y undefined se presentan vacíos.
 * @returns {string} Texto seguro para contenido y atributos HTML entre comillas.
 */
export function html(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Presenta un DECIMAL persistido en pesos argentinos sin calcular, convertir ni redondear importes.
 * @param {string|number} valor Importe recibido del catálogo o snapshot histórico.
 * @returns {string} Importe con separador de miles y al menos dos posiciones decimales.
 */
export function pesos(valor) {
  const [entero, centavos = '00'] = String(valor).split('.');
  return '$ ' + entero.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + centavos.padEnd(2, '0');
}

/**
 * Presenta una fecha oficial en Argentina conservando el formato documental existente.
 * @param {Date|string|number} valor Instante recibido del catálogo o snapshot.
 * @returns {string} Fecha localizada como día, mes y año.
 */
export function fecha(valor) {
  return new Date(valor).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', year: 'numeric' });
}

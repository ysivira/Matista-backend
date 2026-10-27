/**
 * Escapa una celda y neutraliza fórmulas al abrir el CSV en una planilla.
 * @param {unknown} valor Dato de la celda; null y undefined se presentan vacíos.
 * @returns {string} Celda entre comillas con sus comillas internas duplicadas.
 */
function celda(valor) {
  const texto = String(valor ?? '');
  return `"${(/^[=+@\-\t\r]/.test(texto) ? "'" : '') + texto.replaceAll('"', '""')}"`;
}

/** Exporta la matriz real de ADMIN sin convertir ni calcular precios DECIMAL. */
export function listaCsv(lista) {
  const filas = [
    ['Plan', 'Modalidad', 'Version', 'Rango', 'Precio', 'Nota'],
    ...lista.tarifas.map(t => [
      lista.plan.nombre,
      lista.tipo_ingreso,
      lista.version.id,
      t.rango_etario,
      t.precio,
      t.rango_nota
    ])
  ];
  return '\uFEFF' + filas.map(f => f.map(celda).join(';')).join('\r\n');
}


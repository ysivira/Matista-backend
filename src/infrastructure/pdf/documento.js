/**
 * ============================================================
 * MATISTA | PDF DE TEXTO
 * ============================================================
 *
 * Archivo: documento.js
 * Módulo: Infraestructura documental
 *
 * Responsabilidad:
 * Generar documentos PDF A4 de texto con codificación WinAnsi,
 * ajuste de líneas, paginación y acentos de color por plan.
 *
 * ============================================================
 */

/** Convierte texto a WinAnsi de PDF, preservando acentos españoles y escapando delimitadores. */
function textoPdf(valor) {
  return String(valor)
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\xff]/g, ' ')
    .replace(/[()\\]/g, '\\$&');
}

/** Devuelve el acento de identidad del plan; la paleta coincide con las gemas del catálogo. */
export function colorPlanPdf(nombre = '') {
  const n = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (n.includes('RUB')) return '#dc2626';
  if (n.includes('ESMERALDA')) return '#059669';
  if (n.includes('ZAFIRO')) return '#2563eb';
  return '#64748b';
}

/**
 * Renderiza texto recibido sin cálculo económico, con ajuste de líneas, acento y paginación.
 * @param {string[]} lineas Contenido real del catálogo o snapshot histórico.
 * @param {string} color Acento hexadecimal de marca o plan, definido por servidor.
 * @returns {Buffer} PDF A4 con fuente estándar y codificación WinAnsi.
 */
export function crearPdfTexto(lineas, color = '#6d28d9') {
  const ajustadas = lineas.flatMap(linea => {
    const texto = String(linea ?? '');
    if (!texto.length) return [''];
    return texto.match(/.{1,88}(?:\s|$)|.{1,88}/gu) ?? [''];
  });
  const paginas = [];
  for (let i = 0; i < ajustadas.length; i += 43) paginas.push(ajustadas.slice(i, i + 43));
  if (!paginas.length) paginas.push(['MATISTA']);
  const rgb = [1, 3, 5]
    .map(i => (parseInt(color.slice(i, i + 2), 16) / 255).toFixed(3))
    .join(' ');
  const objetos = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'];
  const kids = [];

  for (const [indice, pagina] of paginas.entries()) {
    const paginaId = objetos.length + 1,
      contenidoId = paginaId + 1;
    kids.push(`${paginaId} 0 R`);
    objetos.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contenidoId} 0 R >>`);
    const contenido = `${rgb} rg 0 800 595 42 re f\nBT /F1 14 Tf 1 1 1 rg 40 816 Td (MATISTA) Tj ET\n`
      + `BT /F1 10 Tf 0.12 0.13 0.20 rg 40 775 Td 16 TL ${pagina.map(l => `(${textoPdf(l)}) Tj T*`).join('\n')} ET\n`
      + `BT /F1 9 Tf 40 35 Td (${indice + 1} / ${paginas.length}) Tj ET`;
    objetos.push(`<< /Length ${Buffer.byteLength(contenido, 'latin1')} >>\nstream\n${contenido}\nendstream`);
  }
  objetos[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${paginas.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  // Los offsets se miden en bytes de la misma codificación usada al emitir el PDF.
  for (const [i, obj] of objetos.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(pdf + `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, 'latin1');
}

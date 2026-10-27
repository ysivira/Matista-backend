// Distribuye texto/filas sin cálculo económico, sin omitir contenido y sin reducir la tipografía.
addEventListener('load', async () => {
  await document.fonts.ready;
  const destino = document.getElementById('documento');
  let contenido, modo;

  /** Crea una hoja y mide el espacio real por encima del pie. */
  function nueva() {
    const hoja = document.createElement('section');
    hoja.className = 'hoja';
    hoja.innerHTML =
      document.getElementById('marca').innerHTML +
      '<div class="contenido"></div><footer><span></span><span class="numeracion"></span></footer>';
    hoja.querySelector('footer span').textContent = /* MATISTA_PIE */null;
    destino.append(hoja);
    contenido = hoja.querySelector('.contenido');
    contenido.style.height =
      hoja.querySelector('footer').offsetTop - contenido.offsetTop - 12 + 'px';
  }

  /** Comprueba la altura disponible sin ocultar desbordamientos. */
  function excede() {
    return contenido.scrollHeight > contenido.clientHeight + 1;
  }

  /** Parte únicamente párrafos demasiado largos, preservando todos sus caracteres. */
  function textoLargo(original) {
    let resto = original.textContent;
    while (resto) {
      const nodo = original.cloneNode(false);
      nodo.textContent = resto;
      contenido.append(nodo);
      if (!excede()) return;
      nodo.remove();
      if (contenido.children.length) {
        nueva();
        continue;
      }
      let min = 1,
        max = resto.length,
        limite = 0;
      contenido.append(nodo);
      while (min <= max) {
        const medio = Math.floor((min + max) / 2);
        nodo.textContent = resto.slice(0, medio);
        if (excede()) max = medio - 1;
        else {
          limite = medio;
          min = medio + 1;
        }
      }
      if (!limite) {
        document.documentElement.dataset.documentoError = 'elemento_no_paginable';
        return;
      }
      const salto = resto.lastIndexOf('\n', limite - 1),
        espacio = resto.lastIndexOf(' ', limite - 1);
      if (salto > 0) limite = salto + 1;
      else if (espacio > 0) limite = espacio + 1;
      nodo.textContent = resto.slice(0, limite);
      resto = resto.slice(limite);
      if (resto) nueva();
    }
  }

  /** Distribuye tablas por filas, repitiendo sus encabezados. */
  function tabla(original) {
    let copia = original.cloneNode(true);
    copia.querySelector('tbody').replaceChildren();
    contenido.append(copia);
    for (const fila of original.querySelectorAll('tbody>tr')) {
      const nodo = fila.cloneNode(true);
      copia.querySelector('tbody').append(nodo);
      if (excede()) {
        nodo.remove();
        if (!copia.querySelector('tbody').children.length) copia.remove();
        nueva();
        copia = original.cloneNode(true);
        copia.querySelector('tbody').replaceChildren(nodo);
        contenido.append(copia);
        if (excede()) {
          document.documentElement.dataset.documentoError = 'fila_no_paginable';
          return;
        }
      }
    }
  }

  /** Agrega un bloque completo o inicia su continuación sin descartar información. */
  function agregar(original) {
    if (original.tagName === 'TABLE') {
      tabla(original);
      return;
    }
    const nodo = original.cloneNode(true);
    contenido.append(nodo);
    if (!excede()) return;
    nodo.remove();
    if (contenido.children.length) nueva();
    contenido.append(nodo);
    if (excede()) {
      nodo.remove();
      if (original.tagName === 'P') textoLargo(original);
      else document.documentElement.dataset.documentoError = 'bloque_no_paginable';
    }
  }

  for (modo of ['comercial', 'catalogo']) {
    nueva();
    for (const bloque of document.getElementById(modo).content.children) agregar(bloque);
  }

  const hojas = [...destino.children];
  hojas.forEach(
    (hoja, i) =>
      (hoja.querySelector('.numeracion').textContent = 'Página ' + (i + 1) + ' de ' + hojas.length)
  );
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  if ([...document.querySelectorAll('.contenido')].some(c => c.scrollHeight > c.clientHeight + 1))
    document.documentElement.dataset.documentoError = 'desbordamiento';
  document.documentElement.dataset.documentoListo = 'true';
});

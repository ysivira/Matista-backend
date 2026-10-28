/**
 * ============================================================
 * MATISTA | CONTRATOS DOCUMENTALES DE PRUEBA
 * ============================================================
 *
 * Archivo: documentos.contratos.js
 * Módulo: Soporte de pruebas documentales
 *
 * Responsabilidad:
 * Comparar contenido HTML, CSS y JavaScript conservando orden,
 * espacios significativos y sensibilidad ante cambios semánticos.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';

/**
 * Calcula SHA-256 sin alterar bytes.
 * @param {string|Buffer} texto Cadena o bytes del contrato.
 * @returns {string} Digest hexadecimal.
 */
export function sha256(texto) {
  return createHash('sha256').update(texto).digest('hex');
}

/**
 * Separa únicamente el texto de style; conserva etiquetas, atributos y posiciones en fragmentos.
 * Omite comentarios y contenido raw-text (incluido script) al buscar etiquetas reales.
 * @param {string} documento HTML autónomo de los generadores documentales.
 * @returns {{fragmentos: string[], estilos: string[]}} Partes que reconstruyen el HTML exactamente.
 * @throws {AssertionError} Ante etiquetas/comentarios raw-text sin cierre inequívoco.
 */
export function separarEstilos(documento) {
  const fragmentos = [], estilos = [];
  let posicion = 0, inicioFragmento = 0;
  while (posicion < documento.length) {
    const inicio = documento.indexOf('<', posicion);
    if (inicio < 0) break;
    if (documento.startsWith('<!--', inicio)) {
      const fin = documento.indexOf('-->', inicio + 4);
      assert.ok(fin >= 0, 'Comentario HTML sin cierre');
      posicion = fin + 3;
      continue;
    }
    const nombre = /^<([a-z][a-z0-9:-]*)(?=[\t\n\f\r />])/i.exec(documento.slice(inicio));
    if (!nombre) { posicion = inicio + 1; continue; }
    let fin = inicio + nombre[0].length, comilla = '';
    for (; fin < documento.length; fin++) {
      const caracter = documento[fin];
      if (comilla) { if (caracter === comilla) comilla = ''; }
      else if (caracter === '"' || caracter === "'") comilla = caracter;
      else if (caracter === '>') break;
    }
    assert.ok(fin < documento.length, 'Etiqueta HTML sin cierre');
    posicion = fin + 1;
    const etiqueta = nombre[1].toLowerCase();
    if (!['style', 'script', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(etiqueta)) continue;
    const cierre = new RegExp(`</${etiqueta}[\\t\\n\\f\\r ]*>`, 'ig');
    cierre.lastIndex = posicion;
    const coincidencia = cierre.exec(documento);
    assert.ok(coincidencia, `Elemento ${etiqueta} sin cierre inequívoco`);
    if (etiqueta === 'style') {
      fragmentos.push(documento.slice(inicioFragmento, posicion));
      estilos.push(documento.slice(posicion, coincidencia.index));
      inicioFragmento = coincidencia.index;
    }
    posicion = cierre.lastIndex;
  }
  fragmentos.push(documento.slice(inicioFragmento));
  return { fragmentos, estilos };
}

/**
 * Reconstruye el HTML separado; rechaza omisiones de CSS.
 * @param {object} partes Fragmentos y estilos obtenidos de separarEstilos.
 * @param {string[]} reemplazos CSS originales o históricos en el mismo orden.
 * @returns {string} HTML completo sin cambios en los fragmentos no CSS.
 */
export function reconstruirDocumento({ fragmentos, estilos }, reemplazos = estilos) {
  assert.equal(reemplazos.length, estilos.length, 'Cantidad de bloques CSS');
  return fragmentos.map((parte, indice) => parte + (reemplazos[indice] ?? '')).join('');
}

/**
 * Consume un escape CSS sin interpretar su valor; conserva incluso el blanco que termina un hexadecimal.
 * @param {string} css Fuente completa.
 * @param {number} posicion Índice del escape.
 * @returns {number} Primer índice posterior al escape.
 */
function finEscape(css, posicion) {
  let fin = posicion + 1;
  assert.ok(fin < css.length, 'Escape CSS incompleto');
  if (/[0-9a-f]/i.test(css[fin])) {
    let digitos = 0;
    while (digitos < 6 && /[0-9a-f]/i.test(css[fin] ?? '')) { fin++; digitos++; }
    if (css[fin] === '\r' && css[fin + 1] === '\n') fin += 2;
    else if (/[\t\n\f\r ]/.test(css[fin] ?? '')) fin++;
  } else {
    assert.ok(!/[\n\r\f]/.test(css[fin]), 'Escape fuera de cadena con salto de línea');
    fin++;
  }
  return fin;
}

/**
 * Tokeniza conservadoramente CSS: cadenas, escapes, comentarios y URL nunca se normalizan por regex.
 * Los tokens desconocidos se conservan; delimitadores desequilibrados y cadenas inválidas se rechazan.
 * @param {string} css Fuente completa, incluidas declaraciones no reconocidas por Chrome.
 * @returns {object[]} Tokens con texto literal y separación significativa.
 */
function tokensCss(css) {
  const tokens = [];
  let posicion = 0, espacio = false, comentario = false;
  while (posicion < css.length) {
    const inicio = posicion, caracter = css[posicion];
    if (/[\t\n\f\r ]/.test(caracter)) { espacio = true; posicion++; continue; }
    if (css.startsWith('/*', posicion)) {
      const fin = css.indexOf('*/', posicion + 2);
      assert.ok(fin >= 0, 'Comentario CSS sin cierre');
      posicion = fin + 2;
      // No crea espacio, pero puede impedir formar un hash, número o función CSS.
      comentario = true;
      continue;
    }
    if (caracter === '"' || caracter === "'") {
      posicion++;
      while (posicion < css.length && css[posicion] !== caracter) {
        assert.ok(!/[\n\r\f]/.test(css[posicion]), 'Salto de línea sin escape en cadena CSS');
        if (css[posicion] === '\\') {
          if (css[posicion + 1] === '\r' && css[posicion + 2] === '\n') posicion += 3;
          else if (/[\n\r\f]/.test(css[posicion + 1] ?? '')) posicion += 2;
          else posicion = finEscape(css, posicion);
        } else posicion++;
      }
      assert.equal(css[posicion], caracter, 'Cadena CSS sin cierre');
      posicion++;
    } else if (/[a-z0-9_\u0080-\uffff-]/i.test(caracter) || caracter === '\\') {
      while (posicion < css.length) {
        if (css[posicion] === '\\') posicion = finEscape(css, posicion);
        else if (/[a-z0-9_\u0080-\uffff-]/i.test(css[posicion])) posicion++;
        else break;
      }
      assert.ok(!(css.slice(inicio, posicion).includes('\\') && css[posicion] === '('),
        'Nombre de función CSS escapado fuera de la gramática soportada');
      // URL sin comillas tiene reglas léxicas propias: se conserva el interior literalmente.
      if (css.slice(inicio, posicion).toLowerCase() === 'url' && css[posicion] === '(') {
        posicion++;
        let comilla = '';
        while (posicion < css.length) {
          const actual = css[posicion];
          if (actual === '\\') { posicion = finEscape(css, posicion); continue; }
          if (comilla) { if (actual === comilla) comilla = ''; }
          else if (actual === '"' || actual === "'") comilla = actual;
          else if (actual === ')') break;
          posicion++;
        }
        assert.equal(css[posicion], ')', 'URL CSS sin cierre');
        posicion++;
      }
    } else posicion++;
    tokens.push({ texto: css.slice(inicio, posicion), espacio, comentario, inicio, fin: posicion });
    espacio = false;
    comentario = false;
  }
  return tokens;
}

/**
 * Representa una secuencia conservando blancos significativos y límites léxicos.
 * Ignora blancos de listas y, solo fuera de funciones/atributos del selector, junto a combinadores.
 * @param {object[]} tokens Tokens de selector, condición o valor; no se decodifican cadenas/escapes.
 * @param {boolean} selector Permite normalizar separaciones de los combinadores >, + y ~.
 * @param {boolean} condiciones Permite blancos de (propiedad: valor), nunca de selector(...).
 * @returns {Array} Separación, texto y corte por comentario; no fusiona límites léxicos.
 */
function secuencia(tokens, selector = false, condiciones = false) {
  const resultado = [];
  let profundidad = 0;
  const caracteristicas = [];
  for (const [indice, token] of tokens.entries()) {
    const anterior = tokens[indice - 1]?.texto;
    const combinador = selector && profundidad === 0 && ['>', '+', '~'].some(signo => signo === token.texto || signo === anterior);
    const caracteristica = caracteristicas.at(-1);
    const blancoCondicion = caracteristica && (token.texto === ':' || anterior === ':' || anterior === '(' || token.texto === ')');
    resultado.push([indice > 0 && token.espacio && token.texto !== ',' && anterior !== ',' && !combinador && !blancoCondicion,
      token.texto, indice > 0 && token.comentario]);
    if (token.texto === '(') {
      const funcion = anterior && /^[a-z_-]/i.test(anterior) && !token.espacio && !token.comentario
        && !(indice === 2 && tokens[0].texto === '@');
      caracteristicas.push(condiciones && !funcion && /^[a-z-]+$/i.test(tokens[indice + 1]?.texto ?? '')
        && !tokens[indice + 1].texto.startsWith('--') && tokens[indice + 2]?.texto === ':');
    } else if (token.texto === ')') caracteristicas.pop();
    if (token.texto === '(' || token.texto === '[') profundidad++;
    else if (token.texto === ')' || token.texto === ']') profundidad--;
  }
  return resultado;
}

/**
 * Construye un contrato CSS ordenado sin descartar propiedades, prioridades ni duplicados.
 * Reconoce listas de reglas y declaraciones; conserva literalmente bloques de at-rules desconocidas.
 * No pretende ser un parser CSS universal: sintaxis fuera de la gramática soportada falla cerrada.
 * @param {string} css Hoja a comparar.
 * @returns {Array} Árbol conservador de tokens, reglas, condiciones y declaraciones en orden original.
 * @throws {AssertionError} Ante sintaxis incompleta o anidación no soportada, nunca la omite.
 */
export function contratoCss(css) {
  const tokens = tokensCss(css);
  let posicion = 0;

  /** Lee hasta los separadores indicados; retorna tokens y rechaza delimitadores desequilibrados. */
  function leerHasta(separadores) {
    const resultado = [], pendientes = [];
    while (posicion < tokens.length) {
      const token = tokens[posicion], texto = token.texto;
      if (!pendientes.length && separadores.includes(texto)) break;
      if (texto === '(' || texto === '[' || texto === '{') pendientes.push({ '(': ')', '[': ']', '{': '}' }[texto]);
      else if (texto === ')' || texto === ']' || texto === '}') assert.equal(pendientes.pop(), texto, 'Delimitador CSS inesperado');
      resultado.push(token);
      posicion++;
    }
    assert.equal(pendientes.length, 0, 'Delimitador CSS sin cierre');
    return resultado;
  }

  /** Retorna declaraciones desde la posición actual sin ordenarlas ni descartar valores desconocidos. */
  function declaraciones() {
    const resultado = [];
    while (posicion < tokens.length && tokens[posicion].texto !== '}') {
      if (tokens[posicion].texto === ';') { posicion++; continue; }
      const propiedad = leerHasta([':', ';', '}', '{']);
      assert.equal(propiedad.length, 1, 'Propiedad CSS simple requerida');
      assert.match(propiedad[0].texto, /^(?:--|-?[a-z_])[a-z0-9_\\-]*$/i, 'Propiedad CSS no soportada');
      assert.equal(tokens[posicion++]?.texto, ':', 'Declaración CSS sin dos puntos');
      const valor = leerHasta([';', '}']);
      const variable = propiedad[0].texto.startsWith('--');
      const importante = !variable && valor.at(-2)?.texto === '!' && /^important$/i.test(valor.at(-1)?.texto ?? '');
      // En variables CSS incluso los blancos pueden propagarse por var(): no se relajan.
      resultado.push([propiedad[0].texto, variable
        ? [valor.map(token => [token.espacio, token.texto, token.comentario]), tokens[posicion]?.espacio ?? false]
        : secuencia(importante ? valor.slice(0, -2) : valor), importante]);
      if (tokens[posicion]?.texto === ';') posicion++;
    }
    return resultado;
  }

  /** Retorna reglas ordenadas; anidadas permite terminar en }, el nivel raíz exige consumir todo. */
  function reglas(anidadas = false) {
    const resultado = [];
    while (posicion < tokens.length && tokens[posicion].texto !== '}') {
      const preambulo = leerHasta(['{', ';', '}']);
      assert.ok(preambulo.length, 'Regla CSS sin selector/condición');
      const separador = tokens[posicion++]?.texto;
      if (separador === ';') {
        assert.equal(preambulo[0].texto, '@', 'Regla CSS sin bloque');
        resultado.push([secuencia(preambulo), null]);
        continue;
      }
      assert.equal(separador, '{', 'Regla CSS sin bloque');
      const nombre = preambulo[0].texto === '@' ? preambulo[1]?.texto.toLowerCase() : null;
      let contenido;
      if (['media', 'supports', 'layer', 'container', 'keyframes', '-webkit-keyframes'].includes(nombre)) contenido = reglas(true);
      else if (nombre === null || ['page', 'font-face', 'property'].includes(nombre)) contenido = declaraciones();
      else {
        // Una gramática desconocida no se interpreta ni se relaja: conserva incluso sus blancos.
        const inicio = tokens[posicion - 1].fin;
        leerHasta(['}']);
        contenido = css.slice(inicio, tokens[posicion]?.inicio ?? css.length);
      }
      assert.equal(tokens[posicion++]?.texto, '}', 'Bloque CSS sin cierre');
      resultado.push([secuencia(preambulo, nombre === null, ['media', 'supports', 'container'].includes(nombre)), contenido]);
    }
    if (!anidadas) assert.equal(posicion, tokens.length, 'Cierre CSS sobrante');
    return resultado;
  }
  return reglas();
}

/**
 * Tokeniza la gramática usada por los paginadores sin borrar contenido de cadenas.
 * Conserva saltos relevantes para ASI y rechaza construcciones no cubiertas.
 * @param {string} fuente Script completo ya generado para el documento.
 * @returns {string[]} Tokens ordenados con marcas de salto potencialmente significativo.
 * @throws {Error} Si la sintaxis es inválida o contiene literales no soportados.
 */
function tokensPaginacion(fuente) {
  new Script(fuente);
  const tokens = [];
  let posicion = 0, salto = false;
  while (posicion < fuente.length) {
    const inicio = posicion, caracter = fuente[posicion];
    if (/\s/u.test(caracter)) {
      salto ||= /[\n\r\u2028\u2029]/u.test(caracter);
      posicion++;
      continue;
    }
    if (fuente.startsWith('//', posicion)) {
      while (posicion < fuente.length && !/[\n\r\u2028\u2029]/u.test(fuente[posicion])) posicion++;
      continue;
    }
    if (fuente.startsWith('/*', posicion)) {
      const fin = fuente.indexOf('*/', posicion + 2);
      assert.ok(fin >= 0, 'Comentario JavaScript sin cierre');
      salto ||= /[\n\r\u2028\u2029]/u.test(fuente.slice(posicion, fin + 2));
      posicion = fin + 2;
      continue;
    }
    if (caracter === '"' || caracter === "'") {
      posicion++;
      while (posicion < fuente.length && fuente[posicion] !== caracter) {
        if (fuente[posicion] === '\\') posicion++;
        posicion++;
      }
      assert.ok(posicion < fuente.length, 'Cadena JavaScript sin cierre');
      posicion++;
    } else {
      // Los scripts históricos no usan templates, regex ni identificadores escapados.
      // Una ampliación de esa gramática exige revisar el contrato, nunca descartarla.
      const coincidencia = /^(?:[a-zA-Z_$][\w$]*|\d+(?:\.\d+)?|===|!==|=>|\.\.\.|\?\.|\?\?|&&|\|\||\+\+|--|<=|>=|==|!=|\+=|-=|\*=|\/=|[{}()[\].,;:?+*%<>=!&|\/-])/.exec(fuente.slice(posicion));
      assert.ok(coincidencia, `Token JavaScript fuera del contrato en ${posicion}`);
      posicion += coincidencia[0].length;
    }
    const token = fuente.slice(inicio, posicion);
    if (token === '/') {
      // Es la única división de los scripts históricos. No se interpreta una regex como operadores.
      assert.deepEqual(tokens.slice(-5), ['(', 'min', '+', 'max', ')'],
        'División o regex fuera de la gramática histórica');
    }
    if (salto && (['return', 'throw', 'break', 'continue', 'yield', 'async'].includes(tokens.at(-1))
      || ['++', '--', '=>'].includes(token))) tokens.push('SALTO_ASI');
    tokens.push(token);
    salto = false;
  }
  return tokens;
}

/**
 * Compara sintaxis conservando tokens, cadenas y límites relevantes de sentencias.
 * Solo admite los cambios concretos de paréntesis de SPEC-22: alturas y las dos numeraciones.
 * @param {string} fuente Script del documento, sin etiquetas HTML.
 * @returns {string[]} Contrato sintáctico estricto; no ejecuta el script.
 */
export function contratoPaginacion(fuente) {
  let tokens = tokensPaginacion(fuente);
  const equivalencias = [
    ["(pagina.querySelector('footer').offsetTop-contenido.offsetTop-14)+'px'",
      "pagina.querySelector('footer').offsetTop-contenido.offsetTop-14+'px'"],
    ["(hoja.querySelector('footer').offsetTop-contenido.offsetTop-12)+'px'",
      "hoja.querySelector('footer').offsetTop-contenido.offsetTop-12+'px'"],
    ["(p,i)=>p.querySelector('.numeracion').textContent=(i+1)+' / '+paginas.length",
      "(p,i)=>(p.querySelector('.numeracion').textContent=i+1+' / '+paginas.length)"],
    ["(hoja,i)=>hoja.querySelector('.numeracion').textContent='Página '+(i+1)+' de '+hojas.length",
      "(hoja,i)=>(hoja.querySelector('.numeracion').textContent='Página '+(i+1)+' de '+hojas.length)"]
  ];
  for (const [antes, despues] of equivalencias) {
    // Son patrones léxicos cerrados, no eliminación general de paréntesis.
    // Se tokenizan como expresiones válidas para conservar límites de cadenas.
    const patron = tokensPaginacion(antes), reemplazo = tokensPaginacion(despues);
    const resultado = [];
    for (let indice = 0; indice < tokens.length;) {
      if (patron.every((token, desplazamiento) => tokens[indice + desplazamiento] === token)) {
        resultado.push(...reemplazo);
        indice += patron.length;
      } else resultado.push(tokens[indice++]);
    }
    tokens = resultado;
  }
  return tokens;
}

/**
 * Lee un atributo real sin confundirlo con texto dentro de otro atributo.
 * @param {string} etiqueta Apertura HTML completa, conservada literalmente por el contrato.
 * @param {string} nombre Nombre del atributo requerido.
 * @returns {string|undefined} Valor sin comillas, o undefined si el atributo no existe.
 * @throws {AssertionError} Ante atributos duplicados o sintaxis fuera del contrato.
 */
function atributoDocumental(etiqueta, nombre) {
  const apertura = /^<[a-zA-Z][\w:-]*/.exec(etiqueta);
  if (!apertura) return undefined;
  let posicion = apertura[0].length;
  const atributos = new Map();
  while (posicion < etiqueta.length) {
    const espacio = /^[\t\n\f\r ]*/.exec(etiqueta.slice(posicion))[0];
    posicion += espacio.length;
    if (etiqueta[posicion] === '>' || etiqueta.slice(posicion) === '/>') break;
    assert.ok(espacio.length, 'Atributos HTML sin separación');
    const atributo = /^[a-zA-Z_:][\w:.-]*/.exec(etiqueta.slice(posicion));
    assert.ok(atributo, 'Nombre de atributo fuera del contrato');
    const clave = atributo[0].toLowerCase();
    assert.ok(!atributos.has(clave), 'Atributo HTML duplicado');
    posicion += atributo[0].length;
    let valor = '';
    const asignacion = /^[\t\n\f\r ]*=[\t\n\f\r ]*/.exec(etiqueta.slice(posicion));
    if (asignacion) {
      posicion += asignacion[0].length;
      const comilla = etiqueta[posicion++];
      assert.ok(comilla === '"' || comilla === "'", 'El contrato requiere atributos entre comillas');
      const fin = etiqueta.indexOf(comilla, posicion);
      assert.ok(fin >= 0, 'Atributo HTML sin cierre');
      valor = etiqueta.slice(posicion, fin);
      posicion = fin + 1;
    }
    atributos.set(clave, valor);
  }
  return atributos.get(nombre);
}

/**
 * Identifica contenedores cuyo blanco interelemento no participa del diseño histórico.
 * @param {object} padre Elemento abierto, con nombre y etiqueta original.
 * @returns {boolean} Permite omitir solo nodos íntegramente blancos en ese contenedor.
 */
function permiteBlancosDocumentales(padre) {
  const contenedores = {
    '#documento': ['html'],
    html: ['head', 'body'],
    head: ['meta', 'title', 'style'],
    body: ['main', 'template', 'script'],
    table: ['thead', 'tbody', 'tfoot', 'caption', 'colgroup'],
    thead: ['tr'], tbody: ['tr'], tr: ['th', 'td'],
    svg: ['polygon', 'path']
  };
  const plantillas = {
    marca: ['header'], cabecera: ['header', 'div'], tabla: ['table'],
    filas: ['table'], notas: ['section'],
    comercial: ['h1', 'h2', 'p', 'div', 'table'],
    catalogo: ['h1', 'h2', 'p', 'table']
  };
  const grupos = {
    titulo: ['span', 'div'], identidad: ['div'], plan: ['span'],
    total: ['div', 'strong'], tramos: ['div']
  };
  const clase = atributoDocumental(padre.etiqueta, 'class');
  const id = atributoDocumental(padre.etiqueta, 'id');
  const permitidos = padre.nombre === 'template' ? plantillas[id]
    : padre.nombre === 'div' ? grupos[clase]
      : padre.nombre === 'header' && clase === 'marca' ? ['img', 'div']
        : contenedores[padre.nombre];
  if (!permitidos) return false;
  // No se ignoran blancos junto a texto directo ni entre hijos inline desconocidos.
  return padre.hijos.every(hijo => hijo.nombre ? permitidos.includes(hijo.nombre)
    : hijo[0] !== 'texto' || /^[\t\n\f\r ]*$/.test(hijo[1]));
}

/**
 * Representa el HTML sin normalizar atributos, entidades ni texto significativo.
 * Compara CSS con su gramática ordenada y scripts con su contrato sintáctico estricto.
 * @param {string} documento HTML autónomo actual o histórico reconstruido.
 * @returns {Array} Árbol de etiquetas y contenido en el orden original, incluidos templates.
 * @throws {AssertionError} Ante HTML incompleto o anidación fuera del contrato soportado.
 */
export function contratoDocumento(documento) {
  const raiz = { nombre: '#documento', etiqueta: '', hijos: [] };
  const pila = [raiz];
  const vacias = new Set(['meta', 'img', 'br', 'hr', 'input', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr']);
  let posicion = 0;
  while (posicion < documento.length) {
    const padre = pila.at(-1);
    if (documento[posicion] !== '<') {
      const siguiente = documento.indexOf('<', posicion);
      const fin = siguiente < 0 ? documento.length : siguiente;
      const texto = documento.slice(posicion, fin);
      padre.hijos.push(['texto', texto]);
      posicion = fin;
      continue;
    }
    if (documento.startsWith('<!--', posicion)) {
      const fin = documento.indexOf('-->', posicion + 4);
      assert.ok(fin >= 0, 'Comentario HTML sin cierre');
      padre.hijos.push(['comentario', documento.slice(posicion, fin + 3)]);
      posicion = fin + 3;
      continue;
    }
    let fin = posicion + 1, comilla = '';
    for (; fin < documento.length; fin++) {
      const caracter = documento[fin];
      if (comilla) { if (caracter === comilla) comilla = ''; }
      else if (caracter === '"' || caracter === "'") comilla = caracter;
      else if (caracter === '>') break;
    }
    assert.ok(fin < documento.length, 'Etiqueta HTML sin cierre');
    const etiqueta = documento.slice(posicion, fin + 1);
    posicion = fin + 1;
    if (/^<!doctype\s/i.test(etiqueta)) {
      padre.hijos.push(['doctype', etiqueta]);
      continue;
    }
    const coincidencia = /^<(\/)?([a-zA-Z][\w:-]*)(?=[\t\n\f\r />])/.exec(etiqueta);
    assert.ok(coincidencia, 'Etiqueta HTML fuera del contrato');
    const nombre = coincidencia[2].toLowerCase();
    if (coincidencia[1]) {
      assert.equal(padre.nombre, nombre, 'Cierre HTML no corresponde al elemento abierto');
      assert.ok(pila.length > 1, 'Cierre HTML sin apertura');
      padre.hijos.push(['cierre', etiqueta]);
      pila.pop();
      continue;
    }
    const nodo = { nombre, etiqueta, hijos: [] };
    padre.hijos.push(nodo);
    if (['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(nombre)) {
      const cierre = new RegExp(`</${nombre}[\\t\\n\\f\\r ]*>`, 'ig');
      cierre.lastIndex = posicion;
      const encontrado = cierre.exec(documento);
      assert.ok(encontrado, `Elemento ${nombre} sin cierre`);
      const contenido = documento.slice(posicion, encontrado.index);
      nodo.hijos.push(nombre === 'script' ? ['javascript', contratoPaginacion(contenido)]
        : nombre === 'style' ? ['css', contratoCss(contenido)] : ['texto', contenido]);
      nodo.hijos.push(['cierre', encontrado[0]]);
      posicion = cierre.lastIndex;
    } else if (!vacias.has(nombre) && !etiqueta.endsWith('/>')) pila.push(nodo);
  }
  assert.equal(pila.length, 1, 'Elemento HTML sin cierre');
  /**
   * Conserva el árbol y omite blancos autorizados por el contenedor y sus hijos.
   * @param {object} nodo Elemento con sus hijos originales.
   * @returns {object} Representación estricta con los hijos conservados en orden.
   */
  function representar(nodo) {
    const permite = permiteBlancosDocumentales(nodo);
    return {
      nombre: nodo.nombre,
      etiqueta: nodo.etiqueta,
      hijos: nodo.hijos
        .filter(hijo => !(permite && Array.isArray(hijo) && hijo[0] === 'texto'
          && /^[\t\n\f\r ]*$/.test(hijo[1])))
        .map(hijo => hijo.nombre ? representar(hijo) : hijo)
    };
  }
  return representar(raiz).hijos;
}

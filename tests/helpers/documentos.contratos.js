import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

/**
 * Calcula SHA-256 sin alterar bytes.
 * @param {string} texto Cadena de contrato.
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

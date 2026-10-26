// Servicio de la carga inicial controlada E2: lee el catalogo de SIGEC
// (solo SELECT), valida el origen contra los criterios estructurales
// aprobados, normaliza rangos canonicos y escribe planes, la version
// CARGA_INICIAL, las tarifas validas, los aportes de monotributo y la
// politica comercial en una unica transaccion de MATISTA, con rollback
// completo ante cualquier error. Es idempotente: si la carga ya existe y
// es consistente, verifica conteos y no vuelve a escribir.

import {
  assertActorExistente,
  leerEstadoCatalogo,
  leerFuenteSigec,
  insertarPlanes,
  insertarVersionCargaInicial,
  insertarTarifasCargaInicial,
  insertarAportesMonotributo,
  insertarPoliticaComercial,
  insertarCatalogoPorcentajes,
  PORCENTAJES_COMERCIALES_INICIALES,
} from './carga-inicial.repository.js';

// Valores de politica_comercial aprobados para E2 (autorizacion, seccion 3.5).
// Definidos en el repositorio junto al acceso de escritura del catalogo.
const POLITICA_INICIAL = Object.freeze({
  porcentaje_aporte_reconocido: '7.00',
  tope_sueldo_bruto: '4800000.00',
  joven_porcentaje: '26.00',
  comercial_fijo_max_pct: '40.00',
  comercial_fijo_meses_max: 12,
  comercial_escalonado_max_pct: '50.00',
  comercial_escalonado_tramos_max: 4,
  comercial_escalonado_total_meses_max: 12,
  primer_tramo_50_meses_max: 3,
  tdc_pct: '5.00',
  tdc_habilitado: 1,
  tope_comercial_tdc_pct: '55.00',
  afinidad_pct: null,
  aporte_monotributo: '23892.00',
});

// Catalogo comercial inicial aprobado para la carga (RF-D16):
const PLANES_APROBADOS = Object.freeze(
  ['RUBÍ', 'ESMERALDA', 'ZAFIRO', 'DIAMANTE'],
);

// Observacion de procedencia registrada en la cabecera de la version.
const OBSERVACION_CARGA = 'Carga inicial controlada desde SIGEC (E2): '
  + 'planes activos y tarifas validadas; 10 registros excluidos por '
  + 'criterio estructural (6 inactivas, 2 de planes inactivos, '
  + '2 monotributo).';

// Total de tarifas validas y composicion aprobada de la matriz.
const TARIFAS_ESPERADAS = 160;
const CLAVES_POR_GRUPO = 20;
const APORTES_ESPERADOS = 12;
const PLANES_ESPERADOS = 4;

/** Convierte un rango de SIGEC a su clave canonica.
 *
 *  - Parametros: `rangoEtario` (string original de SIGEC).
 *  - Retorna: `{ clave, nota }`; normaliza `66-00` como `66+` y
 *    `HIJO 0-1(*)` como `HIJO 0-1`; `nota` conserva anotaciones
 *    originales (hoy `(*)`), `null` si no tiene anotacion.
 */
export function normalizarRangoClave(rangoEtario) {
  const tieneAnotacion = rangoEtario.includes('(*)');
  const base = rangoEtario.replaceAll('(*)', '').trim();

  return Object.freeze({
    clave: base === '66-00' ? '66+' : base,
    nota: tieneAnotacion ? '(*)' : null,
  });
}

/** Selecciona las referencias validas y produce la trazabilidad de excluidos.
 *
 *  - Parametros: `referencias`: filas completas de `listas_de_precios`
 *    unidas con su plan (columnas `activo`, `plan_activo`, `tipo_ingreso`,
 *    `rango_etario`, `precio`).
 *  - Criterio estructural aprobado: incluye toda fila activa de plan
 *    activo con tipo en (Obligatorio, Voluntario); el resto se excluye y
 *    se documenta con id + motivo (6 inactivas, 2 de planes inactivos,
 *    2 monotributo).
 *  - Retorna: `{ validas, excluidos }`.
 */
export function seleccionarReferenciasValidas(referencias) {
  const validas = [];
  const excluidos = [];

  for (const referencia of referencias) {
    if (referencia.tipo_ingreso === 'monotributo') {
      excluidos.push({
        id: referencia.id,
        motivo: 'Referencia monotributo huérfana (código muerto del origen)',
      });
      continue;
    }

    // El vocabulario de la auditoria aprobada agrupa como inactivas las
    // filas activo=0 aunque su plan tambien este inactivo (6 registros).
    if (!referencia.activo) {
      excluidos.push({ id: referencia.id, motivo: 'Referencia inactiva' });
      continue;
    }

    if (!referencia.plan_activo) {
      excluidos.push({
        id: referencia.id,
        motivo: 'Pertenece a un plan inactivo en SIGEC',
      });
      continue;
    }

    const { clave, nota } = normalizarRangoClave(referencia.rango_etario);

    validas.push({
      ...referencia,
      rango_clave: clave,
      rango_nota: nota,
    });
  }

  return Object.freeze({ validas, excluidos });
}

/** Detecta la primera duplicacion por clave canonica entre referencias.
 *
 *  - Parametros: `validas` (lista ya filtrada).
 *  - Retorna: la clave duplicada `plan|tipo|rango_clave`, o null si no hay.
 */
function buscarDuplicada(validas) {
  const vistas = new Map();

  for (const referencia of validas) {
    const clave = `${referencia.plan_id}|${referencia.tipo_ingreso}`
      + `|${referencia.rango_clave}`;

    if (vistas.has(clave)) {
      return clave;
    }

    vistas.set(clave, referencia.id);
  }

  return null;
}

/** Valida el contenido leido de SIGEC antes de escribir nada en MATISTA.
 *
 *  - Parametros: `fuente` ({ planes, referencias, aportes } de
 *    `leerFuenteSigec`).
 *  - Reglas aprobadas: exactamente 4 planes activos con los nombres
 *    aprobados (RUBI, ESMERALDA, ZAFIRO, DIAMANTE); 160 tarifas validas
 *    con 20 claves unicas por grupo plan/modalidad; precios positivos;
 *    12 aportes con categorias unicas e importes positivos.
 *  - Retorna: `{ planesActivos, validas, excluidos, aportes }`; lanza
 *    error con detalle si alguna regla no se cumple.
 */
export function validarOrigen(fuente) {
  const planesActivos = fuente.planes.filter((plan) => plan.activo === 1);

  if (planesActivos.length !== PLANES_ESPERADOS) {
    throw new Error(
      `SIGEC: se esperaban exactamente ${PLANES_ESPERADOS} planes activos; `
      + `se encontraron ${planesActivos.length}.`,
    );
  }

  const nombresFuera = planesActivos.filter(
    (plan) => !PLANES_APROBADOS.includes(plan.nombre.trim()),
  );

  if (nombresFuera.length > 0) {
    throw new Error(
      'SIGEC: los planes activos no coinciden con la matriz aprobada '
      + `(fuera de matriz: ${nombresFuera.map((p) => p.nombre).join(', ')}).`,
    );
  }

  const { validas, excluidos } = seleccionarReferenciasValidas(
    fuente.referencias,
  );

  if (validas.length !== TARIFAS_ESPERADAS) {
    throw new Error(
      `SIGEC: se esperaban ${TARIFAS_ESPERADAS} tarifas validas; `
      + `se obtuvieron ${validas.length}. No se carga: la matriz no es la `
      + 'aprobada y los importes no se inventan.',
    );
  }

  if (validas.some((referencia) => Number(referencia.precio) <= 0)) {
    throw new Error(
      'SIGEC: existe al menos una tarifa valida con precio no positivo.',
    );
  }

  const duplicada = buscarDuplicada(validas);

  if (duplicada !== null) {
    throw new Error(
      `SIGEC: referencia duplicada por clave canonica (${duplicada}); `
      + 'no se carga hasta resolver el origen.',
    );
  }

  // Cobertura de matriz: cada combinacion plan/modalidad debe tener 20 claves.
  const grupos = new Map();
  const clavesUnicas = new Set();

  for (const referencia of validas) {
    const grupo = `${referencia.plan_id}|${referencia.tipo_ingreso}`;

    grupos.set(grupo, (grupos.get(grupo) ?? 0) + 1);
    clavesUnicas.add(`${grupo}|${referencia.rango_clave}`);
  }

  const gruposIncorrectos = [...grupos.entries()].filter(
    ([, total]) => total !== CLAVES_POR_GRUPO,
  );

  if (grupos.size !== PLANES_ESPERADOS * 2 || gruposIncorrectos.length > 0) {
    throw new Error(
      'SIGEC: la matriz por plan/modalidad no cumple 20 claves por grupo '
      + `(grupos: ${grupos.size}, desviados: `
      + `${gruposIncorrectos.map(([clave]) => clave).join(', ') || 'ninguno'}).`,
    );
  }

  if (clavesUnicas.size !== TARIFAS_ESPERADAS) {
    throw new Error(
      `SIGEC: claves unicas incoherentes (${clavesUnicas.size} `
      + `de ${TARIFAS_ESPERADAS}); no se carga.`,
    );
  }

  const categorias = new Set();

  if (fuente.aportes.length !== APORTES_ESPERADOS) {
    throw new Error(
      `SIGEC: se esperaban ${APORTES_ESPERADOS} aportes de monotributo; `
      + `se obtuvieron ${fuente.aportes.length}.`,
    );
  }

  for (const aporte of fuente.aportes) {
    if (Number(aporte.aporte) <= 0) {
      throw new Error(
        `SIGEC: el aporte de la categoria ${aporte.categoria} no es positivo.`,
      );
    }

    categorias.add(aporte.categoria);
  }

  if (categorias.size !== fuente.aportes.length) {
    throw new Error('SIGEC: categorias de monotributo duplicadas en el origen.');
  }

  return Object.freeze({
    planesActivos,
    validas,
    excluidos,
    aportes: fuente.aportes,
  });
}

/** Clasifica el estado actual del catalogo ADMIN en MATISTA.
 *
 *  - Parametros: `estado` (salida de `leerEstadoCatalogo`).
 *  - Retorna: 'VACIA' (nada cargado aun), 'CARGA_EXISTENTE' (la carga
 *    ya aplicada es consistente y puede omitir re-ejecutar), o lanza
 *    error cuando el catalogo esta en un estado intermedio: la carga
 *    nunca compone parciales.
 */
export function evaluarEstado(estado) {
  const catalogoVacio = estado.planes === 0
    && estado.versiones === 0
    && estado.tarifas === 0
    && estado.aportesAbiertos === 0
    && estado.politicasAbiertas === 0;

  if (catalogoVacio) {
    return 'VACIA';
  }

  const consistente = estado.versionCargaInicialId !== null
    && estado.versionCargaInicialEstado === 'ACTIVA'
    && estado.planes === PLANES_ESPERADOS
    && estado.tarifasCargaInicial === TARIFAS_ESPERADAS
    && estado.versiones >= 1
    && estado.aportesAbiertos >= APORTES_ESPERADOS
    && estado.politicasAbiertas >= 1;

  if (consistente) {
    return 'CARGA_EXISTENTE';
  }

  throw new Error(
    'El catalogo ADMIN esta en un estado intermedio o inconsistente; '
    + 'la carga inicial no repara estados parciales. Conteos: '
    + `planes=${estado.planes}, versiones=${estado.versiones}, `
    + `tarifas=${estado.tarifas} `
    + `(en CARGA_INICIAL: ${estado.tarifasCargaInicial}), `
    + `aportes abiertos=${estado.aportesAbiertos}, `
    + `politicas abiertas=${estado.politicasAbiertas}.`,
  );
}

/** Inserta el catalogo inicial de porcentajes vinculado a la politica vigente.
 *
 *  - Parametros: `destino` conexion transaccional de la base destino;
 *    `politicaId` version propietaria del catalogo; `actorLegajo`
 *    responsable de la operacion (FK a empleados).
 *  - Retorna: nada; las filas quedan vinculadas a la politica indicada con
 *    la marca temporal de vigencia del instante de la insercion.
 *  - Implementacion: delega en el repositorio.
 */
/** Ejecuta la carga inicial completa contra MATISTA.
 *
 *  - Parametros:
 *      - `matistaPool`: pool de la base destino (matista_test hoy); solo
 *        se usa cuando no se pasa `matistaConnection`.
 *      - `matistaConnection`: conexion externa OPCIONAL, ya dentro de una
 *        transaccion del llamador. Con este parametro el servicio NO
 *        hace beginTransaction/commit/rollback ni release: si falla es
 *        el llamador quien decide el rollback (mecanismo de aislamiento
 *        de las pruebas cuando el catalogo inicial es permanente).
 *      - `sigecConnection`: conexion abierta de solo lectura a sigec_db.
 *      - `actorLegajo`: responsable real de la carga (IMPORT_ACTOR_LEGAJO);
 *        se registra en politica y aportes, y la FK lo impone.
 *      - `fallarTrasTarifas`: SOLO pruebas; inyecta un fallo despues de
 *        escribir tarifas para verificar el rollback integral.
 *  - Retorna resumen `{ aplicada, versionCargaInicialId?, planes, tarifas,
 *    aportesMonotributo, politicaComercial, excluidos? }`; cuando la carga
 *    ya existe `aplicada` es false y no hay escrituras (idempotencia).
 */
export async function ejecutarCargaInicial({
  matistaPool,
  matistaConnection,
  sigecConnection,
  actorLegajo,
  fallarTrasTarifas = false,
}) {
  const conexionPropia = matistaConnection
    ? null
    : await matistaPool.getConnection();
  const destino = matistaConnection ?? conexionPropia;

  try {
    await assertActorExistente(destino, actorLegajo);
    const estado = await leerEstadoCatalogo(destino);
    const clasificacion = evaluarEstado(estado);

    if (clasificacion === 'CARGA_EXISTENTE') {
      // Carga preexistente de bases inicializadas antes de esta correccion:
      // la politica vigente puede carecer de catalogo comercial (caso de
      // matista_test). Se completa SOLO cuando esta totalmente vacio y con
      // los valores iniciales aprobados; nunca se sobrescribe un catalogo
      // ya configurado por el negocio (caso de matista_dev).
      let porcentajesComerciales = estado.porcentajesVigenteAbiertos;
      if (estado.politicaVigenteId !== null && estado.porcentajesVigenteAbiertos === 0) {
        if (conexionPropia) {
          await destino.beginTransaction();
        }
        try {
          await insertarCatalogoPorcentajes(
            destino,
            estado.politicaVigenteId,
            actorLegajo,
          );
          if (conexionPropia) {
            await destino.commit();
          }
          porcentajesComerciales = PORCENTAJES_COMERCIALES_INICIALES.length;
        } catch (error) {
          if (conexionPropia) {
            await destino.rollback();
          }
          throw error;
        }
      }
      return Object.freeze({
        aplicada: false,
        planes: estado.planes,
        tarifas: estado.tarifas,
        aportesMonotributo: estado.aportesAbiertos,
        politicaComercial: estado.politicasAbiertas,
        porcentajesComerciales,
      });
    }

    const fuente = await leerFuenteSigec(sigecConnection);
    const { planesActivos, validas, excluidos, aportes } = validarOrigen(fuente);

    if (conexionPropia) {
      await destino.beginTransaction();
    }

    try {
      // 1) planes con ids originales preservados (trazabilidad con SIGEC).
      await insertarPlanes(destino, planesActivos);

      // 2) version CARGA_INICIAL: una sola, actor NULL, fecha y hora actual.
      const versionId = await insertarVersionCargaInicial(
        destino,
        OBSERVACION_CARGA,
      );

      // 3) tarifas validas en lotes de 50 filas.
      await insertarTarifasCargaInicial(destino, versionId, validas);

      if (fallarTrasTarifas) {
        // Punto de inyeccion exclusivo de pruebas: un fallo aqui debe
        // revertir planes, version y tarifas en bloque.
        throw new Error(
          'Falla simulada para verificar el rollback de la carga '
          + '(parametro fallarTrasTarifas).',
        );
      }

      // 4) aportes de monotributo: 12 filas abiertas con vigencia actual.
      await insertarAportesMonotributo(destino, aportes, actorLegajo);

      // 5) politica comercial inicial: version VIGENTE con valores aprobados
      //    y el aporte de monotributo fijo como campo versionado del snapshot.
      const politicaId = await insertarPoliticaComercial(
        destino,
        POLITICA_INICIAL,
        actorLegajo,
      );

      // 6) catalogo comercial inicial vinculado a esa politica VIGENTE: sin
      //    este paso una instalacion nueva quedaria con una politica vigente
      //    sin descuentos autorizados (hallazgo de la auditoria de cierre).
      await insertarCatalogoPorcentajes(destino, politicaId, actorLegajo);

      if (conexionPropia) {
        await destino.commit();
      }

      return Object.freeze({
        aplicada: true,
        versionCargaInicialId: versionId,
        planes: planesActivos.length,
        tarifas: validas.length,
        aportesMonotributo: aportes.length,
        politicaComercial: 1,
        porcentajesComerciales: PORCENTAJES_COMERCIALES_INICIALES.length,
        excluidos,
      });
    } catch (error) {
      // Rollback completo solo si la conexion (y su transaccion) es del
      // servicio; con conexion externa el rollback decide el llamador.
      if (conexionPropia) {
        await destino.rollback();
      }
      throw error;
    }
  } finally {
    if (conexionPropia) {
      conexionPropia.release();
    }
  }
}

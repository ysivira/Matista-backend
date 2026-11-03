/** Instalación autónoma local: misma matriz y escritores E2, sin conexión SIGEC. */
import { loadDatabaseConfig } from '../../infrastructure/database/config.js';
import {
  assertLocalInstallationTarget, withLocalInstallation
} from '../../infrastructure/database/local-installation.js';
import { evaluarEstado, POLITICA_INICIAL, validarOrigen } from './carga-inicial.service.js';
import {
  assertActorExistente,
  insertarAportesMonotributo,
  insertarCatalogoPorcentajes,
  insertarPlanes,
  insertarPoliticaComercial,
  insertarTarifasCargaInicial,
  insertarVersionCargaInicial,
  leerEstadoCatalogo,
  PORCENTAJES_COMERCIALES_INICIALES
} from './carga-inicial.repository.js';
import { leerFuenteVersionada } from './instalacion.repository.js';

/** Adapta la fuente normalizada al validador E2; no replica reglas comerciales. */
export function validarCatalogoVersionado(fuente) {
  if (!Array.isArray(fuente?.planes) || !Array.isArray(fuente.tarifas) ||
    !Array.isArray(fuente.aportes_monotributo)) {
    throw new Error('La fuente versionada requiere arreglos de planes, tarifas y aportes.');
  }
  const ids = new Set(fuente.planes.map(p => p.id));
  if (ids.size !== fuente.planes.length ||
    new Set(fuente.planes.map(p => p.nombre)).size !== fuente.planes.length ||
    fuente.planes.some(p => p.activa !== 1 || !Number.isSafeInteger(p.id) || p.id <= 0 ||
      !p.detalles?.trim() || !p.condiciones_generales?.trim())) {
    throw new Error('Planes duplicados, incompletos o no activos en la fuente versionada.');
  }
  const referencias = fuente.tarifas.map((t, i) => {
    if (!ids.has(t.plan_id) || !['Obligatorio', 'Voluntario'].includes(t.tipo_ingreso) ||
      !t.rango_clave?.trim() || ![null, '(*)'].includes(t.rango_nota) ||
      !/^\d+\.\d{2}$/.test(t.precio) || !Number.isFinite(Number(t.precio))) {
      throw new Error('Tarifa inválida: plan, modalidad, rango_nota o precio no aprobado.');
    }
    // Inversa de la normalización E2: recupera la etiqueta original del rango.
    const rango = t.rango_clave === '66+' ? '66-00' : t.rango_clave;
    return {
      ...t, id: i + 1, activo: 1, plan_activo: 1,
      rango_etario: rango + (t.rango_nota ?? '')
    };
  });
  if (fuente.aportes_monotributo.some(a => !/^(?:[A-K]|Adherente)$/.test(a.categoria) ||
    !/^\d+\.\d{2}$/.test(a.aporte) || !Number.isFinite(Number(a.aporte)))) {
    throw new Error('Categoría o importe de monotributo no aprobado.');
  }
  const { planesActivos, validas, aportes } = validarOrigen({
    planes: fuente.planes.map(p => ({ ...p, activo: p.activa })),
    referencias,
    aportes: fuente.aportes_monotributo
  });
  return { planes: planesActivos, tarifas: validas, aportes };
}

/** Solo inserta en un catálogo totalmente vacío; jamás repara ni sobrescribe datos. */
export async function ejecutarCargaAutonoma({
  matistaPool, config = loadDatabaseConfig(), archivo, actorLegajo
}) {
  assertLocalInstallationTarget(config);
  const fuente = await leerFuenteVersionada(archivo);
  const { planes, tarifas, aportes } = validarCatalogoVersionado(fuente);
  return withLocalInstallation(matistaPool, config, async destino => {
    await assertActorExistente(destino, actorLegajo);
    const estado = await leerEstadoCatalogo(destino);
    const clasificacion = evaluarEstado(estado);
    if (clasificacion === 'CARGA_EXISTENTE') {
      if (estado.porcentajesVigenteAbiertos === 0) {
        throw new Error('Catálogo inconsistente: política sin porcentajes; no se repara automáticamente.');
      }
      return {
        aplicada: false, planes: estado.planes, tarifas: estado.tarifas,
        aportesMonotributo: estado.aportesAbiertos,
        politicaComercial: estado.politicasAbiertas,
        porcentajesComerciales: estado.porcentajesVigenteAbiertos
      };
    }
    // evaluarEstado cuenta filas abiertas: comprobar también históricos y huérfanos.
    const [[totales]] = await destino.query(`SELECT
      (SELECT COUNT(*) FROM monotributo_aportes) AS aportes,
      (SELECT COUNT(*) FROM politica_comercial) AS politicas,
      (SELECT COUNT(*) FROM porcentajes_comerciales) AS porcentajes`);
    if (Number(totales.aportes) || Number(totales.politicas) || Number(totales.porcentajes)) {
      throw new Error('Catálogo parcial: existen datos históricos; instalación cancelada sin cambios.');
    }
    await insertarPlanes(destino, planes);
    const versionId = await insertarVersionCargaInicial(destino,
      'Instalación autónoma local: catálogo E2 verificado, versionado; sin conexión a SIGEC.');
    await insertarTarifasCargaInicial(destino, versionId, tarifas);
    await insertarAportesMonotributo(destino, aportes, actorLegajo);
    const politicaId = await insertarPoliticaComercial(destino, POLITICA_INICIAL, actorLegajo);
    await insertarCatalogoPorcentajes(destino, politicaId, actorLegajo);
    return {
      aplicada: true, versionCargaInicialId: versionId,
      planes: planes.length, tarifas: tarifas.length, aportesMonotributo: aportes.length,
      politicaComercial: 1, porcentajesComerciales: PORCENTAJES_COMERCIALES_INICIALES.length
    };
  });
}

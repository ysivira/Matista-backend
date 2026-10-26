import { withConnection } from '../auth/auth.repository.js';
import { obtenerPoliticaComercial } from './politica-comercial.service.js';
import { listarAportesMonotributo, listarPorcentajesDePoliticas } from './politica-comercial.repository.js';

/** Consulta parámetros reales de ADMIN sin ofrecer operaciones de escritura administrativa. */
export async function consultarCondiciones(pool) {
  const politica = await obtenerPoliticaComercial(pool);
  const { aportes, porcentajes } = await withConnection(pool, async c => {
    return { aportes: await listarAportesMonotributo(c), porcentajes: await listarPorcentajesDePoliticas(c, [politica.id]) };
  });
  const { actor_nombre, actor_apellido, actor_legajo, programacion_pendiente, ...publicada } = politica;
  return { politica: { ...publicada, porcentajes_comerciales: porcentajes.filter(p => p.vigente_hasta == null).map(p => ({ id: String(p.id), porcentaje: p.porcentaje, descripcion: p.descripcion })) },
    categorias_monotributo: aportes.map(a => a.categoria).filter(c => /^[A-K]$/.test(c)).sort(), motor_disponible: true };
}


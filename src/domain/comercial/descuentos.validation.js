import { importeACentavos, centavosAImporte, esPorcentajeValido } from '../../modules/admin/admin.money.js';

/** Devuelve el porcentaje joven configurado para un titular elegible; familia parcial no presume elegibilidad. */
export function porcentajeJoven(familia, politica) {
  const titular = familia?.titular;
  const elegible = titular?.estado_civil === 'SOLTERO' && Number.isInteger(titular.edad)
    && titular.edad >= 18 && titular.edad < 30 && Array.isArray(familia.miembros) && familia.miembros.length === 0;
  return elegible ? politica.joven_porcentaje : '0.00';
}

/**
 * Única validación de campaña y acumulación, compartida por edición inmediata y motor.
 * @param {object} condiciones Opciones declaradas; permite reportar campos parciales sin lanzar errores técnicos.
 * @param {object} politica Límites vigentes obtenidos por servidor.
 * @param {object[]} porcentajes Catálogo autorizado de esa política, no porcentajes enviados por React.
 * @param {object} [familia] Composición declarada para incluir el beneficio joven automático.
 * @returns {Array<{field:string,message:string}>} Errores de campo públicos; no calcula descuentos monetarios.
 */
export function erroresDescuentos(condiciones, politica, porcentajes, familia) {
  const errores = [];
  /** Añade un error contextual sin serializar la entrada recibida. */
  function error(field, message) { errores.push({ field, message }); }
  if (!condiciones || !Array.isArray(condiciones.tramos) || typeof condiciones.tdc !== 'boolean' || typeof condiciones.beneficios?.solicita_afinidad !== 'boolean') {
    return [{ field: 'condiciones', message: 'Complete las condiciones comerciales.' }];
  }
  const tramos = condiciones.tramos;
  const esquema = condiciones.esquema ?? (tramos.length > 1 ? 'TRAMOS' : 'FIJO');
  if (!['FIJO', 'TRAMOS'].includes(esquema)) error('condiciones.esquema', 'Seleccione descuento fijo o por tramos.');
  const escalonado = esquema === 'TRAMOS';
  const maxMeses = Number(escalonado ? politica.comercial_escalonado_total_meses_max : politica.comercial_fijo_meses_max);
  const maxPct = escalonado ? politica.comercial_escalonado_max_pct : politica.comercial_fijo_max_pct;
  if ((!escalonado && tramos.length > 1) || (escalonado && tramos.length > Number(politica.comercial_escalonado_tramos_max))) {
    error('condiciones.tramos', escalonado ? `La política permite como máximo ${politica.comercial_escalonado_tramos_max} tramos.` : 'El esquema fijo permite un único tramo.');
  }
  let meses = 0;
  const pctTdc = condiciones.tdc ? politica.tdc_pct : '0.00';
  const pctAfinidad = condiciones.beneficios.solicita_afinidad ? politica.afinidad_pct : '0.00';
  const pctJoven = porcentajeJoven(familia, politica);
  if (!esPorcentajeValido(String(pctJoven))) error('condiciones', 'ADMIN debe configurar el descuento joven antes de cotizar.');
  if (condiciones.tdc && (!Number(politica.tdc_habilitado) || !esPorcentajeValido(String(pctTdc)))) error('condiciones.tdc', 'TDC no está habilitado o configurado en la política vigente.');
  if (condiciones.beneficios.solicita_afinidad && !esPorcentajeValido(String(pctAfinidad))) error('condiciones.beneficios.solicita_afinidad', 'ADMIN debe configurar afinidad antes de solicitarla.');
  const adicionalesValidos = [pctJoven, pctTdc, pctAfinidad].every(pct => esPorcentajeValido(String(pct)));
  const adicionales = adicionalesValidos ? importeACentavos(String(pctJoven)) + importeACentavos(String(pctTdc)) + importeACentavos(String(pctAfinidad)) : null;
  const maximoValido = esPorcentajeValido(String(politica.tope_comercial_tdc_pct));
  if (!maximoValido) error('condiciones', 'ADMIN debe configurar el límite acumulado de descuentos antes de cotizar.');
  /** Informa la suma contractual exacta y el exceso, sin recortar ni cambiar las selecciones del asesor. */
  function validarAcumulado(comercial, field) {
    if (adicionales == null || !maximoValido) return;
    const total = comercial + adicionales;
    const maximo = importeACentavos(String(politica.tope_comercial_tdc_pct));
    if (total > maximo) error(field, `Joven + Comercial + TDC + Afinidad acumulan ${centavosAImporte(total)} % y superan el tope vigente de ${centavosAImporte(maximo)} %. Exceso: ${centavosAImporte(total - maximo)} puntos porcentuales.`);
  }
  if (!tramos.length) validarAcumulado(0n, 'condiciones');
  for (const [i, tramo] of tramos.entries()) {
    const campo = `condiciones.tramos.${i}`;
    if (!Number.isSafeInteger(tramo?.meses) || tramo.meses < 1) error(`${campo}.meses`, 'Ingrese una cantidad entera de meses mayor que cero.');
    else {
      meses += tramo.meses;
      if (tramo.meses > maxMeses) error(`${campo}.meses`, `Este tramo supera el máximo de ${maxMeses} meses del esquema ${escalonado ? 'por tramos' : 'fijo'}.`);
    }
    const opcion = porcentajes.find(p => String(p.id) === String(tramo?.porcentaje_id) && p.vigente_hasta == null);
    if (!opcion) { error(`${campo}.porcentaje_id`, 'Seleccione un porcentaje publicado para la política vigente.'); continue; }
    if (importeACentavos(String(opcion.porcentaje)) > importeACentavos(String(maxPct))) error(`${campo}.porcentaje_id`, `El esquema ${escalonado ? 'por tramos' : 'fijo'} permite como máximo ${maxPct} %.`);
    if (i === 0 && importeACentavos(String(opcion.porcentaje)) === 5000n && tramo.meses > Number(politica.primer_tramo_50_meses_max)) error(`${campo}.meses`, `El primer tramo del 50 % permite como máximo ${politica.primer_tramo_50_meses_max} meses.`);
    // Esta suma es el límite de acumulación contractual, NO el descuento efectivo sobre el precio.
    // Los importes se siguen aplicando secuencialmente sobre saldos en el motor.
    validarAcumulado(importeACentavos(String(opcion.porcentaje)), `${campo}.porcentaje_id`);
  }
  if (meses > maxMeses) {
    for (let i = 0; i < tramos.length; i++) error(`condiciones.tramos.${i}.meses`, `La duración acumulada supera el máximo de ${maxMeses} meses del esquema ${escalonado ? 'por tramos' : 'fijo'}.`);
  }
  return errores;
}

/**
 * Construye la solicitud sintética del caso DIAMANTE de la SPEC, con importes auditados.
 * @returns {object} Solicitud nueva e independiente; no lee ni modifica configuración MySQL.
 */
export function solicitudMonotributo() {
  return { version_contrato: 1, referencias: { tarifa_version_id: '8', politica_id: '12' },
    cliente: { id: '1', dni: '12345678', nombres: 'Titular', apellidos: 'Prueba' },
    plan: { id: '4', nombre: 'DIAMANTE', condiciones_generales: 'Condiciones sintéticas para prueba de Monotributo.' },
    asesor: { legajo: '999', nombre: 'Asesor', apellido: 'Prueba' },
    entrada: { cliente_id: '1', plan_id: '4', modalidad: 'Monotributo',
      familia: { titular: { edad: 41, estado_civil: 'CASADO' }, miembros: [{ parentesco: 'CONYUGE', edad: 41 }, { parentesco: 'HIJO', edad: 12 }] },
      aportes: { categoria: 'A', adherentes: 2 },
      condiciones: { esquema: 'TRAMOS', tramos: [{ porcentaje_id: '35', meses: 3 }], tdc: false, beneficios: { solicita_afinidad: false } } },
    catalogo: { tarifas: [{ rango_clave: 'MAT 41-50', precio: '1056113.15' }, { rango_clave: '41-50', precio: '555849.74' }, { rango_clave: 'HIJO 2-20', precio: '142815.32' },
      { rango_clave: 'HIJO 0-1', precio: '10000.00' }, { rango_clave: 'HIJO 21-29', precio: '20000.00' }, { rango_clave: 'HIJO 30-39', precio: '30000.00' },
      { rango_clave: 'HIJO 40-49', precio: '40000.00' }, { rango_clave: '51-60', precio: '60000.00' }],
    porcentajes: [{ id: '35', porcentaje: '35.00', vigente_hasta: null }],
    politica: { id: '12', comercial_fijo_max_pct: '40.00', comercial_fijo_meses_max: 12, comercial_escalonado_max_pct: '50.00',
      comercial_escalonado_tramos_max: 4, comercial_escalonado_total_meses_max: 12, primer_tramo_50_meses_max: 3,
      tope_comercial_tdc_pct: '55.00', aporte_monotributo: '23892.00', aporte_adherente: '1.00',
      porcentaje_aporte_reconocido: '7.00', tope_sueldo_bruto: '4800000.00', iva_voluntario_pct: '10.50', joven_porcentaje: '26.00' } } };
}

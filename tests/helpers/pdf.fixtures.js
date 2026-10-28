/**
 * ============================================================
 * MATISTA | FIXTURES DOCUMENTALES
 * ============================================================
 *
 * Archivo: pdf.fixtures.js
 * Módulo: Soporte de pruebas documentales
 *
 * Responsabilidad:
 * Construir planes y cotizaciones sintéticos con texto estable,
 * caracteres escapables y casos de paginación documental.
 *
 * ============================================================
 */

/**
 * Construye un plan sintético con texto estable y caracteres que deben escaparse.
 * @param {string} nombre Nombre del plan cuya identidad visual se comprueba.
 * @returns {object} Plan nuevo, independiente de bases de datos y datos personales reales.
 */
function planReferencia(nombre) {
  return { id: '1', nombre, detalles: 'Consulta médica | 100% | Sin cargo\nInternación | Según plan | Con autorización\nTexto original & <literal> sin tres columnas',
    condiciones_generales: 'Condiciones oficiales sintéticas & referencias.\n\nSegundo párrafo: acentos, ñ y símbolos.' };
}

/**
 * Construye una emisión sintética con importes históricos fijos, sin invocar el motor económico.
 * @param {object} plan Plan ya preparado para el documento.
 * @returns {object} Snapshot emitido nuevo con identidad ficticia y fechas constantes.
 */
function emisionReferencia(plan) {
  return { estado: 'EMITIDA', numero: 'MAT-REFERENCIA-11', emitida_at: '2026-10-24T15:00:00Z', vence_at: '2026-11-08T15:00:00Z',
    modalidad: 'Obligatorio', contacto: { email: 'titular@example.test', telefono: '000000000' },
    solicitud: { cliente: { nombres: 'Titular', apellidos: 'Prueba', dni: '12345678' }, plan,
      asesor: { nombre: 'Asesor', apellido: 'Sintético', legajo: '999' } },
    resultado: { version_contrato: 1, motor_version: 'matista-2', referencias: { tarifa_version_id: '1', politica_id: '2' },
      precio_base: '200000.00', total: '199926.44', integrantes: [{ parentesco: 'TITULAR', edad: 35, precio: '200000.00' }],
      beneficios: [{ concepto: 'Joven', porcentaje: '0.00', importe: '0.00' }, { concepto: 'TDC', porcentaje: '0.00', importe: '0.00' }],
      aportes: [{ concepto: 'Obra social', importe: '73.56' }], impuestos: [],
      tramos: [{ desde_mes: 1, hasta_mes: 1, porcentaje_comercial: '0.00', total: '199926.44' }], advertencias: [] } };
}

/**
 * Entrega casos reproducibles de cotización, catálogo, impresión, historia y paginación extensa.
 * @returns {object[]} Casos independientes; sus snapshots no se recalculan ni requieren servicios externos.
 */
export function casosDocumentosPdf() {
  const casos = [];
  for (const nombre of ['RUBÍ', 'ESMERALDA', 'ZAFIRO', 'DIAMANTE']) {
    const plan = planReferencia(nombre);
    const id = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    casos.push({ id: `cotizacion-${id}`, documento: 'cotizacion', datos: emisionReferencia(plan) });
    casos.push({ id: `catalogo-${id}`, documento: 'catalogo', tipo: 'plan', datos: plan });
  }
  const historica = emisionReferencia({ nombre: 'Histórico' });
  delete historica.solicitud.asesor;
  casos.push({ id: 'cotizacion-historica', documento: 'cotizacion', datos: historica,
    contexto: { plan: planReferencia('Respaldo'), asesor: { nombre: 'Asesor', apellido: 'de respaldo', legajo: '998' } } });
  const ausencias = emisionReferencia({ nombre: 'Sin datos', detalles: null, condiciones_generales: null });
  ausencias.contacto = {};
  casos.push({ id: 'cotizacion-ausencias', documento: 'cotizacion', datos: ausencias, contexto: { plan: planReferencia('No sustituir null') } });
  const escapada = emisionReferencia(planReferencia('Plan <literal> & "comillas"'));
  escapada.numero = 'MAT-$&-</script>-REFERENCIA';
  escapada.solicitud.cliente.nombres = '<script>literal</script> & "Titular"';
  casos.push({ id: 'cotizacion-escape', documento: 'cotizacion', datos: escapada });
  const extensa = planReferencia('DIAMANTE');
  extensa.detalles = Array.from({ length: 90 }, (_, i) => `Prestación ${i + 1} | 100% | Referencia ${i + 1}`).join('\n');
  extensa.condiciones_generales = Array.from({ length: 12 }, (_, i) => `Cláusula ${i + 1}: texto oficial sintético que debe conservarse íntegro.`).join('\n\n');
  casos.push({ id: 'cotizacion-tablas-extensas', documento: 'cotizacion', datos: emisionReferencia(extensa) });
  casos.push({ id: 'cotizacion-parrafo-extenso', documento: 'cotizacion', datos: emisionReferencia({ nombre: 'Extenso',
    detalles: null, condiciones_generales: 'Párrafo extenso que no puede omitirse.\n'.repeat(150) }) });
  const completa = emisionReferencia(planReferencia('DIAMANTE'));
  completa.modalidad = 'Voluntario';
  completa.resultado.beneficios = [{ concepto: 'Comercial', porcentaje: '20.00', importe: '40000.00' },
    { concepto: 'TDC', porcentaje: '5.00', importe: '8000.00' }, { concepto: 'Afinidad', porcentaje: '10.00', importe: '15200.00' }];
  completa.resultado.aportes = [];
  completa.resultado.impuestos = [{ concepto: 'IVA Voluntario', porcentaje: '10.50', importe: '14364.00' }];
  completa.resultado.total = '151164.00';
  completa.resultado.tramos = [{ desde_mes: 1, hasta_mes: 3, porcentaje_comercial: '20.00', total: '151164.00' },
    { desde_mes: 4, hasta_mes: 6, porcentaje_comercial: '15.00', total: '160000.00' }];
  casos.push({ id: 'cotizacion-beneficios-iva-tramos', documento: 'cotizacion', datos: completa });
  for (const tipo_ingreso of ['Obligatorio', 'Voluntario']) {
    casos.push({ id: `lista-${tipo_ingreso.toLowerCase()}`, documento: 'catalogo', tipo: 'precios', datos: {
      plan: planReferencia('RUBÍ'), tipo_ingreso, version: { id: '8', fecha_activacion: '2026-10-23T12:00:00Z' },
      tarifas: [{ rango_etario: 'HIJO 0-1(*)', rango_nota: '(*)', precio: '221788.31' },
        { rango_etario: '66-00', rango_nota: 'Referencia & <literal>', precio: '516075.30' }] } });
  }
  casos.push({ id: 'lista-vacia', documento: 'catalogo', tipo: 'precios', datos: { plan: planReferencia('ZAFIRO'),
    tipo_ingreso: 'Voluntario', version: { id: '8', fecha_activacion: '2026-10-23T12:00:00Z' }, tarifas: [] } });
  casos.push({ id: 'catalogo-vacio', documento: 'catalogo', tipo: 'plan', datos: { nombre: 'Sin datos', detalles: null, condiciones_generales: null } });
  casos.push({ id: 'catalogo-cotizacion-compatible', documento: 'catalogo', tipo: 'cotizacion', datos: { plan: planReferencia('ESMERALDA'),
    titulo_documento: 'Referencia histórica', metadatos_documento: 'Datos & referencias', condiciones_generales: 'Condiciones históricas.',
    filas_documento: [['Valor base', 'Plan', '$ 200.000,00'], ['IMPORTE FINAL INICIAL', 'Primer período', '$ 199.926,44']] } });
  const lista = structuredClone(casos.find(c => c.id === 'lista-obligatorio'));
  casos.push({ ...lista, id: 'lista-impresion', imprimir: true });
  casos.push({ id: 'catalogo-impresion', documento: 'catalogo', tipo: 'plan', imprimir: true, datos: planReferencia('RUBÍ') });
  casos.push({ id: 'catalogo-tablas-extensas', documento: 'catalogo', tipo: 'plan', datos: extensa });
  return casos;
}

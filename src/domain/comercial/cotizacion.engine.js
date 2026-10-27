/**
 * Calcula cotizaciones con tarifas capturadas y aritmética monetaria exacta.
 */
import { createAppError } from '../../shared/errors/app-error.js';
import {
  importeACentavos,
  centavosAImporte,
  aplicarPorcentaje,
  dividirHalfUp
} from '../../shared/lib/money.js';
import { erroresDescuentos, porcentajeJoven } from './descuentos.validation.js';

/** Rechaza una propuesta con mensaje comercial seguro, sin datos personales ni SQL. */
function rechazar(mensaje, field = 'entrada') {
  throw createAppError('COTIZACION_REGLA', mensaje, 422, [
    {
      field,
      message: mensaje
    }
  ]);
}

/**
 * Selecciona la banda etaria individual del tarifario.
 * @param {number} edad Edad ya validada del integrante.
 * @returns {string} Clave de la banda, desde 0-25 hasta 66+.
 */
function banda(edad) {
  if (edad <= 25) return '0-25';
  if (edad <= 35) return '26-35';
  if (edad <= 40) return '36-40';
  if (edad <= 50) return '41-50';
  if (edad <= 60) return '51-60';
  if (edad <= 65) return '61-65';
  return '66+';
}

/**
 * Resuelve la clave exacta del tarifario para un integrante con edad ya validada entre 0 y 120.
 * @param {object} miembro Parentesco y edad utilizados para seleccionar la tarifa.
 * @param {boolean} casado Indica si el titular utiliza la lista matrimonial.
 * @returns {string|null} Clave contractual; null para el cónyuge incluido en la tarifa matrimonial.
 */
export function segmentoIntegrante(miembro, casado) {
  if (miembro.parentesco === 'CONYUGE') return null;
  if (miembro.parentesco === 'ADHERENTE') return 'FAMILIAR A CARGO';
  if (miembro.parentesco === 'HIJO') {
    if (miembro.edad <= 1) return 'HIJO 0-1';
    if (miembro.edad <= 20) return 'HIJO 2-20';
    if (miembro.edad <= 29) return 'HIJO 21-29';
    if (miembro.edad <= 39) return 'HIJO 30-39';
    if (miembro.edad <= 49) return 'HIJO 40-49';
  }

  // El catálogo conserva MAT 66-00 para matrimonio, pero 66+ para el segmento individual.
  if (miembro.parentesco === 'TITULAR' && casado && miembro.edad >= 66) return 'MAT 66-00';
  return `${miembro.parentesco === 'TITULAR' && casado ? 'MAT ' : ''}${banda(miembro.edad)}`;
}

/** Aplica el porcentaje con HALF-UP usando exclusivamente las utilidades monetarias exactas existentes. */
function porcentaje(centavos, pct) {
  return importeACentavos(aplicarPorcentaje(centavosAImporte(centavos), String(pct)));
}

/**
 * Obtiene un parámetro comercial obligatorio sin sustituir valores ausentes.
 * @param {object} politica Política comercial capturada para el cálculo.
 * @param {string} campo Nombre del parámetro que se consulta.
 * @param {string} etiqueta Descripción pública utilizada en el mensaje de error.
 * @returns {*} Valor configurado, incluido cero cuando corresponde.
 * @throws {Error} COTIZACION_REGLA/422 si el valor es null o undefined.
 */
function parametro(politica, campo, etiqueta) {
  if (politica[campo] == null) rechazar(`ADMIN debe configurar ${etiqueta} antes de cotizar.`);
  return politica[campo];
}

/**
 * Calcula una cotización pura desde tarifas/política capturadas por servidor, sin SQL ni HTTP.
 * @param {object} solicitud Entradas validadas y snapshot del catálogo vigente.
 * @param {object} reglas Decisiones comerciales confirmadas de normalización y compatibilidad.
 * @returns {object} Desglose en DECIMAL exactos, con matrimonio tarifado por la edad del mayor y
 * tope acumulado validado.
 * @throws {Error} COTIZACION_REGLA/422 ante configuración incompleta o propuesta incompatible.
 */
export function calcularCotizacion(solicitud, reglas) {
  const { entrada, catalogo, referencias } = solicitud;

  const p = catalogo.politica;
  const errores = erroresDescuentos(entrada.condiciones, p, catalogo.porcentajes, entrada.familia);
  if (errores.length) throw createAppError('COTIZACION_REGLA', errores[0].message, 422, errores);
  const familia = entrada.familia;
  const casado = familia.titular.estado_civil === 'CASADO';

  if (familia.miembros.filter(m => m.parentesco === 'CONYUGE').length > 1)
    rechazar('Solo se admite un cónyuge.', 'familia');
  if (!casado &&
    familia.miembros.some(m => m.parentesco === 'CONYUGE'))
    rechazar('La composición con cónyuge requiere titular casado.', 'familia');

  const conyuge = familia.miembros.find(m => m.parentesco === 'CONYUGE');
  const edadMatrimonial = Math.max(familia.titular.edad, conyuge?.edad ?? familia.titular.edad);

  const integrantes = [
    {
      parentesco: 'TITULAR',
      edad: familia.titular.edad
    },
    ...familia.miembros
  ].map(m => {
    // Solo la selección MAT usa la edad mayor; las edades declaradas permanecen intactas en el
    // resultado.

    const segmento = segmentoIntegrante(
      m.parentesco === 'TITULAR' && casado
        ? {
            ...m,
            edad: edadMatrimonial
          }
        : m,
      casado
    );

    const tarifa = segmento == null ? null : catalogo.tarifas.find(t => t.rango_clave === segmento);
    if (segmento &&
      !tarifa)
      rechazar('No existe tarifa vigente para un segmento del grupo familiar.', 'familia');
    return {
      ...m,
      segmento,
      precio: tarifa ? String(tarifa.precio) : '0.00'
    };
  });

  const base = integrantes.reduce((s, m) => s + importeACentavos(m.precio), 0n);
  if (base <= 0n) rechazar('El precio base debe ser positivo.');
  const pctJoven = porcentajeJoven(familia, p);
  const pctTdc = entrada.condiciones.tdc ? parametro(p, 'tdc_pct', 'TDC') : '0.00';
  if (entrada.condiciones.tdc && !Number(p.tdc_habilitado)) rechazar('TDC no está habilitada.');
  const afinidad = entrada.condiciones.beneficios.solicita_afinidad;
  const pctAfinidad = afinidad ? parametro(p, 'afinidad_pct', 'afinidad') : '0.00';
  const tramos = entrada.condiciones.tramos.map(t => {
    const opcion = catalogo.porcentajes.find(
      v => String(v.id) === String(t.porcentaje_id) &&
        v.vigente_hasta == null
    );
    if (!opcion) rechazar('El porcentaje solicitado no pertenece a la política vigente.');
    return {
      meses: t.meses,
      porcentaje: String(opcion.porcentaje)
    };
  });

  let aporteBase = 0n,
    aporteAdherentes = 0n,
    ivaPct = '0.00';
  if (entrada.modalidad === 'Voluntario')
    ivaPct = parametro(p, 'iva_voluntario_pct', 'IVA Voluntario');
  if (entrada.modalidad === 'Obligatorio') {
    if (entrada.aportes.opcion_aporte === 'DECLARADO')
      rechazar(
        'Identifica el dato anterior como sueldo bruto o aporte personal del recibo antes de calcular.',
        'aportes.opcion_aporte'
      );
    const tope = importeACentavos(String(p.tope_sueldo_bruto));
    if (entrada.aportes.opcion_aporte === 'PERSONAL_RECIBO') {
      const personal = importeACentavos(entrada.aportes.aporte_personal);
      const tasaPersonal = importeACentavos(reglas.aporte_personal_pct);
      // Bruto racional = personal * 100 / tasaPersonal. No se redondea el bruto intermedio.
      // Se compara el tope por productos enteros y se redondea HALF-UP solo el aporte final.
      aporteBase =
        personal * 10000n >= tope * tasaPersonal
          ? porcentaje(tope, p.porcentaje_aporte_reconocido)
          : dividirHalfUp(
              personal * importeACentavos(String(p.porcentaje_aporte_reconocido)),
              tasaPersonal
            );
    } else {
      const sueldo = importeACentavos(entrada.aportes.sueldo_bruto);
      aporteBase = porcentaje(sueldo < tope ? sueldo : tope, p.porcentaje_aporte_reconocido);
    }
  }

  if (entrada.modalidad === 'Monotributo') {
    aporteBase = importeACentavos(
      String(parametro(p, 'aporte_monotributo', 'el aporte monotributo'))
    );
    // La cantidad registrada en Monotributo es independiente de los familiares cotizados.
    // La SPEC vigente usa el mismo aporte unitario del titular para cada adherente registrado.
    aporteAdherentes = aporteBase * BigInt(entrada.aportes.adherentes);
  }

  let inicio = 1;
  const periodos = (
    tramos.length
      ? tramos
      : [
          {
            meses: 1,
            porcentaje: '0.00'
          }
        ]
  ).map(t => {
    let saldo = base;
    const descuentoJoven = porcentaje(saldo, pctJoven);
    saldo -= descuentoJoven;
    const descuentoComercial = porcentaje(saldo, t.porcentaje);
    saldo -= descuentoComercial;
    const descuentoTdc = porcentaje(saldo, pctTdc);
    saldo -= descuentoTdc;
    const descuentoAfinidad = porcentaje(saldo, pctAfinidad);
    saldo -= descuentoAfinidad;
    const aplicadoBase = aporteBase < saldo ? aporteBase : saldo;
    saldo -= aplicadoBase;
    const aplicadoAdherentes = aporteAdherentes < saldo ? aporteAdherentes : saldo;
    saldo -= aplicadoAdherentes;
    const iva = porcentaje(saldo, ivaPct);
    saldo += iva;
    const periodo = {
      desde_mes: inicio,
      hasta_mes: inicio + t.meses - 1,
      porcentaje_comercial: t.porcentaje,
      total: centavosAImporte(saldo),
      desglose: {
        precio_base: centavosAImporte(base),
        descuento_joven: centavosAImporte(descuentoJoven),
        descuento_afinidad: centavosAImporte(descuentoAfinidad),
        descuento_comercial: centavosAImporte(descuentoComercial),
        descuento_tdc: centavosAImporte(descuentoTdc),
        aporte_base: centavosAImporte(aplicadoBase),
        aporte_adherentes: centavosAImporte(aplicadoAdherentes),
        iva: centavosAImporte(iva)
      }
    };

    inicio += t.meses;
    return periodo;
  });

  const primero = periodos[0];
  return {
    version_contrato: 1,
    motor_version: entrada.modalidad === 'Monotributo' ? 'matista-3-monotributo' : 'matista-2',
    referencias,
    precio_base: centavosAImporte(base),
    total: primero.total,
    integrantes,
    tramos: periodos,
    aportes:
      entrada.modalidad === 'Voluntario'
        ? []
        : [
            {
              concepto:
                entrada.modalidad === 'Monotributo' ? 'Monotributo (titular)' : 'Obra social',
              importe: primero.desglose.aporte_base
            },
            ...(entrada.modalidad === 'Monotributo'
              ? [
                  {
                    concepto: 'Adherentes Monotributo',
                    importe: primero.desglose.aporte_adherentes
                  }
                ]
              : [])
          ],
    beneficios: [
      {
        concepto: 'Joven',
        porcentaje: String(pctJoven),
        importe: primero.desglose.descuento_joven
      },
      {
        concepto: 'Comercial',
        porcentaje: primero.porcentaje_comercial,
        importe: primero.desglose.descuento_comercial
      },
      {
        concepto: 'TDC',
        porcentaje: String(pctTdc),
        importe: primero.desglose.descuento_tdc
      },
      {
        concepto: 'Afinidad',
        porcentaje: String(pctAfinidad),
        importe: primero.desglose.descuento_afinidad
      }
    ],
    impuestos:
      entrada.modalidad === 'Voluntario'
        ? [
            {
              concepto: 'IVA Voluntario',
              porcentaje: String(ivaPct),
              importe: primero.desglose.iva
            }
          ]
        : [],
    alcance: 'VALOR_INICIAL',
    advertencias: [
      'Valores iniciales según la tarifa y política indicadas. Los tramos describen condiciones pactadas; la facturación y el tratamiento de aportes después de los primeros tres meses quedan fuera de esta cotización.'
    ]
  };
}

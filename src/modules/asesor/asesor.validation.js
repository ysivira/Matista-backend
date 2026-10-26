import { createAppError } from '../../shared/errors/app-error.js';
import { calcularEdad } from '../../domain/comercial/edad.js';

/** Produce un error de estructura público sin divulgar datos personales recibidos. */
export function invalidar(mensaje = 'Los datos de la solicitud no son válidos.') {
  throw createAppError('ASESOR_VALIDACION', mensaje, 400);
}

/** Valida un objeto cerrado; rechaza arrays, nulos y campos no autorizados. */
export function campos(datos, permitidos) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)
      || Object.keys(datos).some(c => !permitidos.includes(c))) invalidar();
}

/** Devuelve un identificador decimal seguro, sin convertir BIGINT a Number. */
export function validarId(valor) {
  if (!/^[1-9]\d{0,18}$/.test(String(valor))) invalidar('Identificador inválido.');
  return String(valor);
}

/** Valida texto acotado y devuelve su versión sin espacios extremos. */
function texto(valor, max, obligatorio = false) {
  if (valor == null || valor === '') {
    if (obligatorio) invalidar('Completa los datos obligatorios.');
    return null;
  }
  if (typeof valor !== 'string' || !valor.trim() || valor.length > max) invalidar();
  return valor.trim();
}

/** Valida contacto administrativo editable, sin campos que puedan afectar importes. */
export function validarContacto(datos) {
  campos(datos, ['email', 'telefono', 'direccion']);
  const email = texto(datos.email, 254);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalidar('Correo electrónico inválido.');
  return { email, telefono: texto(datos.telefono, 40), direccion: texto(datos.direccion, 255) };
}

/** Valida vínculos, titular único y coherencia de cónyuge/CASADO en nuevas preparaciones, sin reescribir historia. */
export function validarFamilia(datos) {
  campos(datos, ['titular', 'miembros']);
  campos(datos.titular, ['edad', 'estado_civil']);
  if (!['SOLTERO', 'CASADO', 'OTRO'].includes(datos.titular.estado_civil)) invalidar('Estado civil inválido.');
  if (!Array.isArray(datos.miembros) || datos.miembros.length > 30) invalidar('Grupo familiar inválido.');
  const integrantes = [{ parentesco: 'TITULAR', edad: datos.titular.edad }, ...datos.miembros];
  for (const [i, m] of integrantes.entries()) {
    campos(m, ['parentesco', 'edad']);
    if (m.parentesco === 'ADHERENTE') throw createAppError('ASESOR_VALIDACION', 'Declare el vínculo familiar real: cónyuge o hijo/a. Los adherentes registrados en Monotributo se informan por separado.', 400,
      [{ field: `familia.miembros.${i - 1}.parentesco`, message: 'Seleccione cónyuge o hijo/a; adherente no es un vínculo familiar.' }]);
    if (!Number.isInteger(m.edad) || m.edad < 0 || m.edad > 120
        || !(i === 0 ? ['TITULAR'] : ['CONYUGE', 'HIJO']).includes(m.parentesco)) invalidar('Integrante inválido.');
  }
  const conyuges = datos.miembros.filter(m => m.parentesco === 'CONYUGE');
  if (conyuges.length > 1 || (conyuges.length && datos.titular.estado_civil !== 'CASADO')) {
    const mensaje = conyuges.length > 1 ? 'Solo se admite un cónyuge.' : 'La composición con cónyuge requiere titular casado.';
    throw createAppError('ASESOR_VALIDACION', mensaje, 400, [{ field: 'familia', message: mensaje }]);
  }
  return { titular: { ...datos.titular }, miembros: datos.miembros.map(m => ({ ...m })) };
}

/**
 * Valida la fecha de nacimiento del cliente (SPEC-UI-02): opcional para mantener editables
 * los registros históricos sin fecha, pero si se declara debe ser 'AAAA-MM-DD', una fecha
 * de calendario posible y no futura, sin superar el tope de edad del negocio.
 * @returns {string|null} Fecha normalizada o null cuando el cliente no la declara.
 */
export function validarFechaNacimiento(valor) {
  if (valor == null || valor === '') return null;
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) invalidar('Fecha de nacimiento inválida. Formato AAAA-MM-DD.');
  const edad = calcularEdad(valor);
  if (edad == null) invalidar('La fecha de nacimiento no es una fecha posible o es futura.');
  if (edad > 120) invalidar('La fecha de nacimiento declarada no es coherente.');
  return valor;
}

/** Valida alta/actualización de cliente: solo identidad y contacto; la familia pertenece a cada cotización. */
export function validarCliente(datos) {
  campos(datos, ['dni', 'nombres', 'apellidos', 'email', 'telefono', 'direccion', 'fecha_nacimiento', 'provincia', 'localidad', 'revision']);
  if (!/^\d{7,10}$/.test(String(datos.dni))) invalidar('DNI inválido.');
  return { dni: String(datos.dni), nombres: texto(datos.nombres, 100, true), apellidos: texto(datos.apellidos, 100, true),
    ...validarContacto({ email: datos.email, telefono: datos.telefono, direccion: datos.direccion }),
    fecha_nacimiento: validarFechaNacimiento(datos.fecha_nacimiento),
    provincia: texto(datos.provincia, 80), localidad: texto(datos.localidad, 80) };
}

/** Valida entradas del motor: opciones y estructura, nunca fórmulas o importes finales. */
export function validarPreparacion(datos) {
  campos(datos, ['cliente_id', 'plan_id', 'modalidad', 'familia', 'aportes', 'condiciones', 'revision']);
  const cliente_id = validarId(datos.cliente_id);
  const plan_id = validarId(datos.plan_id);
  if (!['Voluntario', 'Obligatorio', 'Monotributo'].includes(datos.modalidad)) invalidar('Modalidad inválida.');
  const familia = validarFamilia(datos.familia);
  campos(datos.aportes, datos.modalidad === 'Voluntario' ? [] : datos.modalidad === 'Obligatorio'
    ? ['sueldo_bruto', 'aporte_obra_social', 'aporte_personal', 'opcion_aporte'] : ['categoria', 'adherentes']);
  if (datos.modalidad === 'Obligatorio') {
    const campoAporte = datos.aportes.opcion_aporte === 'PERSONAL_RECIBO' ? 'aporte_personal' : datos.aportes.opcion_aporte === 'DECLARADO' ? 'aporte_obra_social' : 'sueldo_bruto';
    if (typeof datos.aportes[campoAporte] !== 'string' || !/^\d{1,12}(\.\d{1,2})?$/.test(datos.aportes[campoAporte])) invalidar('Declara el sueldo bruto o el aporte según la opción elegida.');
    if (['sueldo_bruto', 'aporte_obra_social', 'aporte_personal'].filter(c => datos.aportes[c] != null).length > 1) invalidar('Selecciona una única fuente declarada de aporte.');
  }
  if (datos.aportes.opcion_aporte != null && !['SUELDO', 'PERSONAL_RECIBO', 'DECLARADO'].includes(datos.aportes.opcion_aporte)) invalidar();
  if (datos.modalidad === 'Monotributo') {
    if (!/^[A-K]$/.test(datos.aportes.categoria ?? '')) invalidar('Declara la categoría de Monotributo.');
    if (!Number.isSafeInteger(datos.aportes.adherentes) || datos.aportes.adherentes < 0) throw createAppError('ASESOR_VALIDACION', 'La cantidad de adherentes registrados en Monotributo debe ser un entero no negativo.', 400,
      [{ field: 'aportes.adherentes', message: 'Ingrese una cantidad entera mayor o igual que cero.' }]);
  }
  campos(datos.condiciones, ['tramos', 'tdc', 'beneficios', 'esquema']);
  if (datos.condiciones.esquema != null && !['FIJO', 'TRAMOS'].includes(datos.condiciones.esquema)) invalidar('Esquema comercial inválido.');
  if (typeof datos.condiciones.tdc !== 'boolean' || !Array.isArray(datos.condiciones.tramos)) invalidar('Condiciones inválidas.');
  for (const tramo of datos.condiciones.tramos) {
    campos(tramo, ['porcentaje_id', 'meses']); validarId(tramo.porcentaje_id);
    // La duración y su acumulación se validan con la política vigente, no con un máximo fijo.
  }
  campos(datos.condiciones.beneficios, ['solicita_afinidad']);
  if (typeof datos.condiciones.beneficios.solicita_afinidad !== 'boolean') invalidar();
  return { cliente_id, plan_id, modalidad: datos.modalidad, familia, aportes: { ...datos.aportes },
    condiciones: structuredClone(datos.condiciones) };
}

/**
 * ============================================================
 * MATISTA | SERVICIOS DE CLIENTES
 * ============================================================
 *
 * Archivo: clientes.service.js
 * Módulo: Asesor
 *
 * Responsabilidad:
 * Consultar y guardar clientes propios con revisión optimista,
 * auditoría y una proyección limitada para búsquedas de DNI ajeno.
 *
 * ============================================================
 */
import { withConnection } from '../auth/auth.repository.js';
import { createAppError } from '../../shared/errors/app-error.js';
import * as repo from './asesor.repository.js';
import { invalidar, validarCliente, validarId } from './asesor.validation.js';

/** Devuelve 404 uniforme ante identificador ajeno o inexistente; no expone su existencia. */
export function exigirPropio(fila) {
  if (!fila)
    throw createAppError('ASESOR_NO_ENCONTRADO', 'El recurso no existe o no está autorizado.', 404);
  return fila;
}

/** Verifica revisión optimista para evitar sobrescribir una modificación concurrente. */
export function exigirRevision(fila, revision) {
  if (!Number.isInteger(revision) || revision !== fila.revision) {
    throw createAppError(
      'ASESOR_CONCURRENCIA',
      'La información cambió. Actualiza antes de continuar.',
      409
    );
  }
}

/** Valida paginación y filtros de DNI para lecturas acotadas. */
export function filtroClientes(query) {
  const dni = query.dni ?? '';
  const pagina = Number(query.pagina ?? 1);
  if (
    typeof dni !== 'string' ||
    !/^\d{0,10}$/.test(dni) ||
    !Number.isInteger(pagina) ||
    pagina < 1 ||
    pagina > 10000
  )
    invalidar();
  return {
    dni,
    offset: (pagina - 1) * 50
  };
}

/** Busca por DNI; ajenos revelan solo nombre de asesor y fecha según RN-03. */
export async function buscarPorDni(pool, actor, dni) {
  if (!/^\d{7,10}$/.test(dni)) invalidar('DNI inválido.');
  return withConnection(pool, async c => {
    const fila = await repo.buscarDni(c, dni);
    if (!fila)
      return {
        encontrado: false
      };
    if (fila.asesor_legajo !== actor)
      return {
        encontrado: true,
        autorizado: false,
        asesor: `${fila.asesor_nombre} ${fila.asesor_apellido}`,
        registrado_at: fila.created_at
      };
    const { asesor_nombre, asesor_apellido, ...cliente } = fila;
    return {
      encontrado: true,
      autorizado: true,
      cliente
    };
  });
}

/** Consulta detalle propio, sin permitir bypass por rol ADMIN. */
export async function obtenerCliente(pool, actor, id) {
  validarId(id);
  return withConnection(pool, async c => exigirPropio(await repo.buscarCliente(c, id, actor)));
}

/** Persiste identidad/contacto sin exigir nacimiento; la edad declarada pertenece a cada cotización. ID requiere revisión. */
export async function guardarCliente(pool, actor, datos, id = null) {
  const validado = validarCliente(datos);
  if (!id && !validado.email) invalidar('Completa el correo electrónico del cliente.');
  if (id) validarId(id);
  return withConnection(
    pool,
    async c => {
      const anterior = id ? exigirPropio(await repo.buscarCliente(c, id, actor, true)) : null;
      if (anterior) {
        exigirRevision(anterior, datos.revision);
        if (anterior.dni !== validado.dni) invalidar('El DNI del cliente no se modifica.');
        // Un consumidor anterior que omita las columnas nuevas no debe borrarlas accidentalmente.
        // null explícito sí permite corregir un dato no confirmado sin inventar reemplazos.
        for (const campo of ['fecha_nacimiento', 'provincia', 'localidad']) {
          if (!Object.hasOwn(datos, campo)) validado[campo] = anterior[campo] ?? null;
        }
        await repo.actualizarCliente(c, id, actor, validado);
      } else id = await repo.insertarCliente(c, validado, actor);
      await repo.auditar(
        c,
        actor,
        id,
        null,
        anterior ? 'CLIENTE_EDITADO' : 'CLIENTE_CREADO',
        anterior,
        validado
      );
      return repo.buscarCliente(c, id, actor);
    },
    {
      transaction: true
    }
  );
}

/** Lista la página solicitada de clientes propios. */
export async function consultarClientes(pool, actor, query) {
  const filtro = filtroClientes(query);
  return withConnection(pool, async c => ({
    clientes: await repo.listarClientes(c, actor, filtro.dni, filtro.offset)
  }));
}

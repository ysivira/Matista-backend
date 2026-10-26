/** Convierte JSON de mysql2 o de dobles de prueba a su representación nativa. */
export function leerJson(valor) {
  return typeof valor === 'string' ? JSON.parse(valor) : valor;
}

/** Lee prestaciones/condiciones oficiales y datos públicos del asesor para el documento, sin credenciales. */
export async function contextoDocumento(c, planId, actor) {
  const [planes] = await c.execute('SELECT id,nombre,detalles,condiciones_generales FROM planes WHERE id=?', [planId]);
  const [asesores] = await c.execute('SELECT legajo,nombre,apellido FROM empleados WHERE legajo=?', [actor]);
  return { plan: planes[0] ?? null, asesor: asesores[0] ?? null };
}

/** Busca cliente propio por ID y opcionalmente bloquea su fila en la transacción. */
export async function buscarCliente(c, id, actor, lock = false) {
  const [rows] = await c.execute(`SELECT clientes.*, DATE_FORMAT(fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento FROM clientes WHERE id = ? AND asesor_legajo = ?${lock ? ' FOR UPDATE' : ''}`, [id, actor]);
  return rows[0] ? { ...rows[0], familia: leerJson(rows[0].familia) } : null;
}

/** Busca DNI sin divulgar datos comerciales; el servicio decide la proyección por propiedad. */
export async function buscarDni(c, dni) {
  const [rows] = await c.execute(`SELECT c.*, DATE_FORMAT(c.fecha_nacimiento, '%Y-%m-%d') AS fecha_nacimiento, e.nombre AS asesor_nombre, e.apellido AS asesor_apellido
    FROM clientes c JOIN empleados e ON e.legajo = c.asesor_legajo WHERE c.dni = ?`, [dni]);
  return rows[0] ? { ...rows[0], familia: leerJson(rows[0].familia) } : null;
}

/** Lista exclusivamente los clientes del actor, con búsqueda por DNI y límite de página. */
export async function listarClientes(c, actor, dni, offset) {
  const [rows] = await c.execute(`SELECT id, dni, nombres, apellidos, revision, created_at
    FROM clientes WHERE asesor_legajo = ? AND dni LIKE ? ORDER BY id DESC LIMIT 50 OFFSET ${offset}`, [actor, `${dni}%`]);
  return rows;
}

/** Inserta un cliente de identidad/contacto validado con propietario del servidor; la familia no persiste aquí. */
export async function insertarCliente(c, datos, actor) {
  const [result] = await c.execute(`INSERT INTO clientes
    (dni,nombres,apellidos,email,telefono,direccion,fecha_nacimiento,provincia,localidad,asesor_legajo) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [datos.dni, datos.nombres, datos.apellidos, datos.email, datos.telefono, datos.direccion, datos.fecha_nacimiento, datos.provincia, datos.localidad, actor]);
  return String(result.insertId);
}

/** Actualiza un cliente bloqueado sin cambiar propietario, DNI ni la familia histórica persistida. */
export async function actualizarCliente(c, id, actor, datos) {
  await c.execute(`UPDATE clientes SET nombres=?,apellidos=?,email=?,telefono=?,direccion=?,fecha_nacimiento=?,provincia=?,localidad=?,revision=revision+1,updated_at=UTC_TIMESTAMP(6)
    WHERE id=? AND asesor_legajo=?`, [datos.nombres, datos.apellidos, datos.email, datos.telefono, datos.direccion, datos.fecha_nacimiento, datos.provincia, datos.localidad, id, actor]);
}

/** Inserta un evento en la misma transacción que cliente o cotización. */
export async function auditar(c, actor, cliente, cotizacion, evento, anterior, nuevo) {
  await c.execute(`INSERT INTO asesor_auditoria (actor_legajo,cliente_id,cotizacion_id,evento,anterior,nuevo) VALUES (?,?,?,?,?,?)`,
    [actor, cliente, cotizacion, evento, anterior == null ? null : JSON.stringify(anterior), JSON.stringify(nuevo)]);
}

/** Busca una cotización propia y devuelve únicamente sus snapshots persistidos. */
export async function buscarCotizacion(c, id, actor, lock = false) {
  const [rows] = await c.execute(`SELECT * FROM cotizaciones WHERE id=? AND asesor_legajo=?${lock ? ' FOR UPDATE' : ''}`, [id, actor]);
  if (!rows[0]) return null;
  const q = rows[0];
  return { ...q, solicitud: leerJson(q.solicitud), contacto: leerJson(q.contacto), resultado: leerJson(q.resultado) };
}

/** Persiste un borrador; jamás escribe número de emisión, resultado ni vigencia económica. */
export async function guardarBorrador(c, id, actor, entrada, solicitud, contacto, origenId = null) {
  const valores = [entrada.plan_id, entrada.modalidad, solicitud.referencias.tarifa_version_id,
    solicitud.referencias.politica_id, JSON.stringify(solicitud)];
  if (id) {
    await c.execute(`UPDATE cotizaciones SET plan_id=?,modalidad=?,tarifa_version_id=?,politica_id=?,solicitud=?,
      revision=revision+1,updated_at=UTC_TIMESTAMP(6) WHERE id=? AND asesor_legajo=?`, [...valores, id, actor]);
    await c.execute('DELETE FROM miembros_cotizacion WHERE cotizacion_id=?', [id]);
  } else {
    const [result] = await c.execute(`INSERT INTO cotizaciones
      (plan_id,modalidad,tarifa_version_id,politica_id,solicitud,cliente_id,asesor_legajo,contacto,origen_id)
      VALUES (?,?,?,?,?,?,?,?,?)`, [...valores, entrada.cliente_id, actor, JSON.stringify(contacto), origenId]);
    id = String(result.insertId);
  }
  const miembros = [{ parentesco: 'TITULAR', edad: entrada.familia.titular.edad }, ...entrada.familia.miembros];
  for (const [i, m] of miembros.entries()) {
    await c.execute('INSERT INTO miembros_cotizacion (cotizacion_id,orden,parentesco,edad) VALUES (?,?,?,?)', [id, i, m.parentesco, m.edad]);
  }
  return id;
}

/** Actualiza solo contacto o estado, sobre una cotización previamente bloqueada. */
export async function modificarCotizacion(c, id, actor, contacto, estado) {
  await c.execute(`UPDATE cotizaciones SET contacto=?,estado=?,revision=revision+1,updated_at=UTC_TIMESTAMP(6)
    WHERE id=? AND asesor_legajo=?`, [JSON.stringify(contacto), estado, id, actor]);
}

/** Persiste el snapshot completo del motor y las fechas MySQL UTC; no modifica números ya emitidos. */
export async function emitirCotizacion(c, fila, solicitud, resultado) {
  await c.execute(`UPDATE cotizaciones SET estado='EMITIDA',numero=CONCAT('MAT-',id),
    tarifa_version_id=?,politica_id=?,solicitud=?,resultado=?,emitida_at=UTC_TIMESTAMP(6),
    vence_at=DATE_ADD(UTC_TIMESTAMP(6),INTERVAL 15 DAY),revision=revision+1,updated_at=UTC_TIMESTAMP(6)
    WHERE id=? AND asesor_legajo=? AND estado='BORRADOR'`,
  [solicitud.referencias.tarifa_version_id, solicitud.referencias.politica_id, JSON.stringify(solicitud), JSON.stringify(resultado), fila.id, fila.asesor_legajo]);
  // Solo la emisión nueva sincroniza la edad declarada del snapshot; los reintentos no llegan aquí.
  await c.execute("UPDATE miembros_cotizacion SET edad=? WHERE cotizacion_id=? AND parentesco='TITULAR'",
    [solicitud.entrada.familia.titular.edad, fila.id]);
}

/**
 * Lista historial propio y aportes capturados sin recalcular snapshots.
 * @param {object} c Conexión mysql2 de la lectura autorizada.
 * @param {string} actor Propietario del historial.
 * @param {object} filtro Filtros validados, incluido texto Unicode y offset entero acotado.
 * @returns {Promise<object[]>} Filas históricas con aportes JSON decodificados.
 */
export async function listarCotizaciones(c, actor, filtro) {
  // DNI y número son ASCII: convertir solo su comparación libre admite tildes/Ñ y conserva el cotejo binario.
  const [rows] = await c.execute(`SELECT q.id,q.numero,q.origen_id,q.estado,q.modalidad,q.revision,q.created_at,q.emitida_at,q.vence_at,
    q.plan_id,c.dni,JSON_UNQUOTE(JSON_EXTRACT(q.resultado,'$.total')) AS total,JSON_UNQUOTE(JSON_EXTRACT(q.solicitud,'$.cliente.nombres')) AS nombres,
    JSON_UNQUOTE(JSON_EXTRACT(q.solicitud,'$.cliente.apellidos')) AS apellidos,
    JSON_UNQUOTE(JSON_EXTRACT(q.solicitud,'$.plan.nombre')) AS plan_nombre,
    JSON_EXTRACT(q.resultado,'$.aportes') AS aportes
    FROM cotizaciones q JOIN clientes c ON c.id=q.cliente_id
    WHERE q.asesor_legajo=? AND (?='' OR q.estado=?) AND c.dni LIKE ?
      AND (?='' OR CONCAT(c.nombres,' ',c.apellidos) LIKE ? OR CONVERT(c.dni USING utf8mb4) COLLATE utf8mb4_bin LIKE ? OR CONVERT(q.numero USING utf8mb4) COLLATE utf8mb4_bin LIKE ?)
      AND (?='' OR q.plan_id=?)
      AND (?='' OR DATE(q.created_at)>=?) AND (?='' OR DATE(q.created_at)<=?)
    ORDER BY q.id DESC LIMIT 50 OFFSET ${filtro.offset}`, [actor, filtro.estado, filtro.estado, `${filtro.dni}%`,
    filtro.cliente, `%${filtro.cliente}%`, `%${filtro.cliente}%`, `%${filtro.cliente}%`, filtro.plan, filtro.plan, filtro.desde, filtro.desde, filtro.hasta, filtro.hasta]);
  return rows.map(q => ({ ...q, aportes: leerJson(q.aportes) ?? [] }));
}

/** Consulta trazabilidad y recotizaciones exclusivamente dentro del mismo propietario. */
export async function detalleRelacionado(c, id, actor) {
  const [eventos] = await c.execute(`SELECT evento,anterior,nuevo,created_at,actor_legajo FROM asesor_auditoria
    WHERE cotizacion_id=? AND actor_legajo=? ORDER BY id`, [id, actor]);
  const [recotizaciones] = await c.execute('SELECT id,estado,created_at FROM cotizaciones WHERE origen_id=? AND asesor_legajo=? ORDER BY id', [id, actor]);
  return { eventos, recotizaciones };
}

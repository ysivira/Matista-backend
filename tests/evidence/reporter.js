/** Eventos auditables del runner; no conserva cabeceras, argumentos ni objetos Error arbitrarios. */
export default async function* report(source) {
  for await (const { type, data } of source) {
    if (!['test:pass', 'test:fail', 'test:summary'].includes(type)) continue;
    const { name, file, line, column, nesting, skip, todo, details, counts, success } = data;
    const error = details?.error;
    yield JSON.stringify({ type, name, file, line, column, nesting, skip, todo, counts, success,
      details: details && { type: details.type, duration_ms: details.duration_ms,
        ...(error ? { error: { message: error.message, code: error.code, failureType: error.failureType, cause: error.cause?.message } } : {}) } }) + '\n';
  }
}

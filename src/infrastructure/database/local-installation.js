/** Guardas y transacción serializada exclusivas de la instalación local. */
export function assertLocalInstallationTarget(config) {
  if (config?.nodeEnv !== 'development' || config.database !== 'matista_local' ||
    !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    throw new Error(
      'Instalación de demostración: solo development/matista_local en MySQL ' +
      'loopback local; prohibido en producción y en bases existentes.'
    );
  }
}

/** Verifica el destino efectivo, serializa inicializadores y revierte todo ante error. */
export async function withLocalInstallation(pool, config, operation) {
  assertLocalInstallationTarget(config);
  const connection = await pool.getConnection();
  let locked = false;
  let transaction = false;
  try {
    const [[identity]] = await connection.query('SELECT DATABASE() AS databaseName');
    if (identity.databaseName !== config.database) {
      throw new Error('La conexión no seleccionó matista_local; instalación cancelada.');
    }
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK('matista_local_installation', 10) AS acquired"
    );
    if (Number(lock.acquired) !== 1) {
      throw new Error('Hay otra instalación en curso; reintentar al finalizar.');
    }
    locked = true;
    await connection.beginTransaction();
    transaction = true;
    const result = await operation(connection);
    await connection.commit();
    transaction = false;
    return result;
  } catch (error) {
    if (transaction) await connection.rollback();
    throw error;
  } finally {
    try {
      if (locked) await connection.query("SELECT RELEASE_LOCK('matista_local_installation')");
    } finally {
      connection.release();
    }
  }
}

/**
 * ============================================================
 * MATISTA | AISLAMIENTO DE INTEGRACIONES
 * ============================================================
 *
 * Archivo: integracion-aislada.test.js
 * Módulo: Pruebas administrativas
 *
 * Responsabilidad:
 * Inspeccionar las suites MySQL para asegurar limpieza por
 * propiedad y protección de tablas y registros preexistentes.
 *
 * ============================================================
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Verificacion estatica de las garantias de aislamiento de las integraciones
// ADMIN: las limpiezas nunca vuelven a ser globales (patrones de legajo,
// tablas ajenas o restauraciones de versiones preexistentes). Cada prueba
// analiza el codigo fuente de la suite objetivo y falla si se reintroduce
// un patron destructivo, sin conectar a MySQL.
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

/** Lee y devuelve el codigo fuente de una suite de integracion. */
async function leerSuite(nombreArchivo) {
  return readFile(path.join(currentDirectory, nombreArchivo), 'utf8');
}

test('la limpieza de la integracion de empleados es exclusiva por legajos propios', async () => {
  const fuente = await leerSuite('employees.integration.test.js');

  // Cada cuenta queda registrada y las eliminaciones usan listas exactas.
  assert.match(fuente, /legajosCreados/u);
  assert.match(fuente, /legajo IN \(\$\{marcadores\}\)/u);
  assert.match(fuente, /verificarAusenciaDeResiduos/u);

  // La limpieza es atomica: toda eliminacion dentro de una transaccion con rollback.
  assert.match(fuente, /beginTransaction/u);
  assert.match(fuente, /rollback/u);

  // Prohibido reintroducir limpiezas globales por patron de legajo.
  assert.doesNotMatch(fuente, /legajo LIKE/u);
  assert.doesNotMatch(fuente, /'99%'/u);
});

test('la suite de mecanismos no destruye tablas ni etiquetas ajenas', async () => {
  const fuente = await leerSuite('admin.mecanismos.integration.test.js');

  // Identidad de corrida aleatoria: colisiones imposibles por UUID.
  assert.match(fuente, /randomUUID/u);
  assert.match(fuente, /const TABLA_RASCADO = `tmp_mecanismo_elm_\$\{ID_CORRIDA\}`/u);

  // CREATE sin IF NOT EXISTS: una tabla preexistente aborta antes de DROP.
  assert.doesNotMatch(fuente, /CREATE TABLE IF NOT EXISTS/u);
  assert.doesNotMatch(fuente, /DROP TABLE IF EXISTS/u);

  // El DROP solo corre si la propia suite creo la tabla y la propiedad se
  // acredita antes de crearla.
  assert.match(fuente, /information_schema\.tables/u);
  assert.match(fuente, /tablaRascadoCreada/u);

  // El after comprueba residuos de auditoria y de tabla antes de cerrar.
  assert.match(fuente, /residuosAuditoria\[0\]\.total/u);
  assert.match(fuente, /tablasResiduales\[0\]\.total/u);
});

test('el ciclo de versiones corre sobre fixtures propios sin tocar versiones preexistentes', async () => {
  const fuente = await leerSuite('tarifario.ciclo.integration.test.js');

  // Sombra temporal por sesion clonada desde SHOW CREATE TABLE (MySQL 8.4
  // rechaza CREATE TEMPORARY ... LIKE con el nombre real): las tablas
  // permanentes no reciben escrituras.
  assert.match(fuente, /SHOW CREATE TABLE/u);
  assert.match(fuente, /CREATE TEMPORARY TABLE /u);
  assert.match(fuente, /DROP TEMPORARY TABLE IF EXISTS/u);

  // Todos los borradores nacen via dependencias aisladas (INSERT-SELECT
  // adaptado; una tabla TEMPORARY no admite self-join en MySQL).
  assert.match(fuente, /copiarTarifasAislada/u);
  assert.match(fuente, /dependenciasAisladas/u);

  // El after acredita propiedad de los datos y compara el snapshot
  // permanente anterior y posterior.
  assert.match(fuente, /verificarPropiedadDeFixtures/u);
  assert.match(
    fuente,
    /assert\.equal\(snapshotFinal, snapshotPermanenteInicial\)/u,
  );

  // Prohibido restaurar o modificar la version ACTIVA preexistente.
  assert.doesNotMatch(fuente, /versionInicialModificada/u);
  assert.doesNotMatch(fuente, /estadoActivaInicial/u);
});

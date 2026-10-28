-- ============================================================
-- MATISTA | COMPROBACIONES PREVIAS DEL CICLO TARIFARIO
-- ============================================================
--
-- Archivo: 013_015_pre.sql
-- Módulo: Verificación de migraciones
--
-- Responsabilidad:
-- Consultar compatibilidad de estados, fechas y dependencias
-- antes de migrar el ciclo tarifario, sin modificar datos.
--
-- ============================================================

-- Verificaciones PREVIAS a 013/014/015 (solo lectura, sin DDL ni DML).
-- Ejecutar contra la base objetivo antes de correr las migraciones:
--   mysql -h<host> -P<puerto> -u<usuario> -p <base> < migrations/verificaciones/013_015_pre.sql
-- Si alguna consulta de compatibilidad devuelve un valor distinto de 0, detener
-- la ejecucion y resolver los datos (o coordinar con el responsable) antes de
-- aplicar 013. Ningun statement de este archivo modifica datos.

-- 1 · Compatibilidad de datos con las nuevas restricciones (debe dar 0).
SELECT
  SUM(tipo NOT IN ('CARGA_INICIAL', 'EDICION_LISTA'))  AS tipos_incompatibles,
  SUM(estado NOT IN ('PREPARACION', 'LISTA_PARA_ACTIVAR', 'ACTIVA', 'HISTORICA', 'CANCELADA'))
    AS estados_incompatibles
  FROM tarifario_versiones;

-- 2 · Compatibilidad con la anulacion de la fecha de activacion: toda version
--     ACTIVA o con cancelacion abierta debe conservar la fecha informada (debe dar 0).
SELECT COUNT(*) AS efectivas_sin_fecha
  FROM tarifario_versiones
 WHERE estado = 'ACTIVA'
   AND fecha_activacion IS NULL;

-- 3 · Restricciones declarativas presentes hoy (ninguna depende del modelo nuevo;
--     las que 013 retira se listan para replicar el ALTER con su reverso si falla).
SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
 WHERE tc.TABLE_SCHEMA = DATABASE()
   AND tc.TABLE_NAME = 'tarifario_versiones'
   AND tc.CONSTRAINT_TYPE = 'CHECK'
 ORDER BY tc.CONSTRAINT_NAME;

-- 4 · Indice unico de fechas vigente (uq_tarifario_versiones_fecha) debe seguir
--     existente para que 013 no tenga que recrearlo.
SELECT s.INDEX_NAME
  FROM information_schema.STATISTICS s
 WHERE s.TABLE_SCHEMA = DATABASE()
   AND s.TABLE_NAME = 'tarifario_versiones'
   AND s.INDEX_NAME = 'uq_tarifario_versiones_fecha'
 GROUP BY s.INDEX_NAME;

-- 5 · Dependencias para las claves foraneas de 014: tabla de empleados y de planes.
SELECT COUNT(*) AS empleados_registrados FROM empleados;
SELECT COUNT(*) AS planes_registrados FROM planes;

-- 6 · Estado de referencia previo (para comparar el conteo en el post-archivo):
--     versiones y tarifas no deben cambiar y el historial de eventos debe nacer vacio.
SELECT COUNT(*) AS versiones_previas FROM tarifario_versiones;
SELECT COUNT(*) AS tarifas_previas FROM tarifas;

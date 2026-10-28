-- ============================================================
-- MATISTA | COMPROBACIONES DEL CICLO TARIFARIO
-- ============================================================
--
-- Archivo: 013_015_post.sql
-- Módulo: Verificación de migraciones
--
-- Responsabilidad:
-- Consultar historial, columnas, índices y restricciones del
-- ciclo tarifario tras sus migraciones, sin realizar escrituras.
--
-- ============================================================

-- Verificaciones POSTERIORES a 013/014/015 (solo lectura).
-- Ejecutar contra la base objetivo despues de correr `npm run db:migrate`:
--   mysql -h<host> -P<puerto> -u<usuario> -p <base> < migrations/verificaciones/013_015_post.sql
-- Cada bloque valida un hito concreto de las migraciones. Cualquier divergencia
-- (nombres ausentes, flags de generacion, indices o conteos distintos) detiene el
-- circuito antes de habilitar Puerta 3.

-- 1 · El registro del corredor confirma las tres migraciones aplicadas.
SELECT version
  FROM schema_migrations
 WHERE version IN ('013_ciclo_vida_versiones',
                   '014_auditoria_eventos_versiones',
                   '015_garantias_exclusividad_versiones')
 ORDER BY version;

-- 2 · Direccion de columnas: fecha anulable, revision con defecto 0 y ambas
--     columnas generadas (PRIMARY guard*) deben listarse con EXTRA GENERATED.
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tarifario_versiones'
   AND COLUMN_NAME IN ('estado', 'fecha_activacion', 'revision', 'guard_activa', 'guard_borrador')
 ORDER BY COLUMN_NAME;

-- 3 · Nuevas restricciones declarativas presentes en tarifario_versiones.
SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
 WHERE tc.TABLE_SCHEMA = DATABASE()
   AND tc.TABLE_NAME = 'tarifario_versiones'
   AND tc.CONSTRAINT_TYPE = 'CHECK'
   AND tc.CONSTRAINT_NAME IN ('chk_tarifario_versiones_estado',
                              'chk_tarifario_versiones_tipo',
                              'chk_tarifario_versiones_estado_fecha')
 ORDER BY tc.CONSTRAINT_NAME;

-- 4 · Indices unicos de las garantias de exclusividad.
SELECT s.INDEX_NAME, s.COLUMN_NAME
  FROM information_schema.STATISTICS s
 WHERE s.TABLE_SCHEMA = DATABASE()
   AND s.TABLE_NAME = 'tarifario_versiones'
   AND s.INDEX_NAME IN ('uq_guard_activa_version', 'uq_guard_borrador_version')
 ORDER BY s.INDEX_NAME;

-- 5 · Estado del catalogo: versiones y tarifas sin cambios, eventos vacios.
SELECT COUNT(*) AS versiones_posteriores FROM tarifario_versiones;
SELECT COUNT(*) AS tarifas_posteriores FROM tarifas;
SELECT COUNT(*) AS eventos_registrados FROM tarifario_versiones_eventos;

-- 6 · Verificacion de foraneas declaradas en la tabla de auditoria.
SELECT tc.CONSTRAINT_NAME, kcu.REFERENCED_TABLE_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
  JOIN information_schema.KEY_COLUMN_USAGE kcu
    ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
   AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
   AND kcu.TABLE_NAME = tc.TABLE_NAME
 WHERE tc.TABLE_SCHEMA = DATABASE()
   AND tc.TABLE_NAME = 'tarifario_versiones_eventos'
   AND tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
 ORDER BY tc.CONSTRAINT_NAME;

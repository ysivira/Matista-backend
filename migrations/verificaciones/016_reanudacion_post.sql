-- ============================================================
-- MATISTA | COMPROBACIONES DE REANUDACIÓN
-- ============================================================
--
-- Archivo: 016_reanudacion_post.sql
-- Módulo: Verificación de migraciones
--
-- Responsabilidad:
-- Consultar el registro de migración, tipo de evento y
-- restricciones conservadas tras incorporar REANUDACION.
--
-- ============================================================

-- Verificaciones de la 016 (solo lectura, sin DDL ni DML).
-- Ejecutar contra la base objetivo DESPUES de renombrar y aplicar
-- migrations/016_reanudacion_evento.sql (procedimiento en el resumen de la
-- ronda). Cualquier divergencia detiene el circuito antes de usar el
-- servicio reanudarEdicionVersion en produccion.

-- 1 · El registro del corredor confirma la 016 aplicada.
SELECT version
  FROM schema_migrations
 WHERE version = '016_reanudacion_evento';

-- 2 · El ENUM ya contiene REANUDACION (COLUMN_TYPE debe listar los cuatro
--     valores previos en el mismo orden y el nuevo al final).
SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tarifario_versiones_eventos'
   AND COLUMN_NAME = 'tipo_evento';

-- 3 · Las restricciones declarativas de la 014 siguen presentes (ninguna
--     fue retirada por la ampliacion).
SELECT tc.CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS tc
 WHERE tc.TABLE_SCHEMA = DATABASE()
   AND tc.TABLE_NAME = 'tarifario_versiones_eventos'
   AND tc.CONSTRAINT_TYPE = 'CHECK'
 ORDER BY tc.CONSTRAINT_NAME;

-- 4 · Los eventos existentes quedaron intactos (solo conteo informativo).
SELECT tipo_evento, COUNT(*) AS eventos
  FROM tarifario_versiones_eventos
 GROUP BY tipo_evento
 ORDER BY tipo_evento;

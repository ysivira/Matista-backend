-- ============================================================
-- MATISTA | COMPROBACIONES DE DESCARTE
-- ============================================================
--
-- Archivo: 017_descarte_post.sql
-- Módulo: Verificación de migraciones
--
-- Responsabilidad:
-- Consultar evento DESCARTE, estado CANCELADA y guardas de
-- exclusividad posteriores a la migración, sin modificar datos.
--
-- ============================================================

-- Verificaciones de la 017 (solo lectura, sin DDL ni DML).
-- Ejecutar contra la base objetivo DESPUES de aplicar
-- migrations/017_descarte_versiones.sql (procedimiento en el informe de
-- la ronda). Cualquier divergencia detiene el circuito antes de usar el
-- servicio descartarVersionTarifario en produccion.

-- 1 · El registro del corredor confirma la 017 aplicada.
SELECT version
  FROM schema_migrations
 WHERE version = '017_descarte_versiones';

-- 2 · El ENUM ya contiene DESCARTE (COLUMN_TYPE debe listar los valores
--     previos en el mismo orden y el nuevo al final).
SELECT COLUMN_TYPE
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tarifario_versiones_eventos'
   AND COLUMN_NAME = 'tipo_evento';

-- 3 · El CHECK del estado sigue intacto (incluye CANCELADA de la 013;
--     la reutilizacion del estado evita cualquier cambio aqui).
SELECT CONSTRAINT_NAME
  FROM information_schema.TABLE_CONSTRAINTS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tarifario_versiones'
   AND CONSTRAINT_TYPE = 'CHECK'
 ORDER BY CONSTRAINT_NAME;

-- 4 · Las columnas generadas de la 015 siguen presentes: el descarte
--     libera la exclusividad sin cambios de esquema.
SELECT COLUMN_NAME, GENERATION_EXPRESSION
  FROM information_schema.COLUMNS
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_NAME = 'tarifario_versiones'
   AND COLUMN_NAME IN ('guard_activa', 'guard_borrador');

-- 5 · Los eventos existentes quedaron intactos (solo conteo informativo).
SELECT tipo_evento, COUNT(*) AS eventos
  FROM tarifario_versiones_eventos
 GROUP BY tipo_evento
 ORDER BY tipo_evento;

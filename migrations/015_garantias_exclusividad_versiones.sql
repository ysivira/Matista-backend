-- matista:target-table tarifario_versiones
-- matista:kind: alter
-- 015 · Garantias de persistencia del ciclo de vida (decisiones 4 y 3 del cierre
-- funcional). Columnas generadas con indice unico: MySQL evalua la expresion por
-- fila y el indice unico rechaza el segundo valor 1, de modo que la exclusividad
-- no depende de validaciones de servicio ni del frontend:
--   guard_activa   = 1 solo para la version ACTIVA  -> como maximo una ACTIVA.
--   guard_borrador = 1 para PREPARACION o LISTA_PARA_ACTIVAR -> como maximo un
--   borrador, con edicion cerrada incluida en la exclusividad.
-- La expresion usa funciones deterministas (IF/IN), requisito de las STORED.

-- Creacion de las columnas generadas (reconstruye la tabla, hoy minima).
ALTER TABLE tarifario_versiones
  ADD COLUMN guard_activa INT
    GENERATED ALWAYS AS (IF(estado = 'ACTIVA', 1, NULL)) STORED,
  ADD COLUMN guard_borrador INT
    GENERATED ALWAYS AS (IF(estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR'), 1, NULL)) STORED;

-- Indices unicos evaluados contra las filas existentes (hoy 1 version ACTIVA,
-- valor 1 de guard_activa: el indice valida sin conflicto).
ALTER TABLE tarifario_versiones
  ADD UNIQUE KEY uq_guard_activa_version (guard_activa),
  ADD UNIQUE KEY uq_guard_borrador_version (guard_borrador);

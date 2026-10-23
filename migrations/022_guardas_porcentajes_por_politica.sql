-- matista:target-table porcentajes_comerciales
-- matista:kind: alter
-- Rearma la guarda de fila abierta por sobre el ciclo de versiones: la columna
-- generada ahora toma la clave (politica_comercial_id) mientras la fila este
-- abierta, de modo que la VIGENTE y la PROGRAMADA puedan tener catalogos
-- propios sin duplicados internos ni eliminacion de indices (el runner los prohibe).
-- Nota: una programada cancelada conserva su catalogo abierto marcado por su
-- politica; una nueva programada usa otra politica, por lo que el indice
-- compuesto (politica_comercial_id, porcentaje) no colisiona entre versiones.
ALTER TABLE porcentajes_comerciales
  MODIFY COLUMN vigente_abierta BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN vigente_hasta IS NULL AND politica_comercial_id IS NOT NULL
         THEN politica_comercial_id
    END
  ) STORED;

-- Los catalogos cerrados dejan de ser abiertos automaticamente al reevaluar
-- la columna; el backfill activo no requiere UPDATE (vigente_hasta ya existia).

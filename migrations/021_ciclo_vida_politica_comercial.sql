-- matista:target-table politica_comercial
-- matista:kind: alter
-- Homologa la politica comercial con el ciclo de versiones sin alterar snapshots previos.
-- Incorpora el aporte de monotributo como campo versionado de cada snapshot
-- (no reemplaza monotributo_aportes, que conserva los importes por categoria).
-- La columna generada vigente_abierta se rearma sobre el nuevo estado: deja de
-- mirar vigente_hasta e impone la unicidad de la unica version VIGENTE (no se
-- elimina ningun indice, el runner lo prohibe); su indice unico
-- uq_politica_comercial_abierta se reutiliza como guarda de vigencia.
-- Orden delicado: primero existir el estado (NULL), luego redefinir la columna
-- generada (evalua NULL sin conflicto de indice), rellenar estado y por ultimo
-- endurecer NOT NULL y las demas guardas.
ALTER TABLE politica_comercial
  ADD COLUMN aporte_monotributo DECIMAL(12,2) NULL AFTER afinidad_pct,
  ADD COLUMN estado VARCHAR(12)
    CHARACTER SET ascii COLLATE ascii_bin NULL AFTER id,
  ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 0 AFTER estado,
  ADD COLUMN version_base_id BIGINT UNSIGNED NULL AFTER revision,
  ADD COLUMN cancelada_en DATETIME(6) NULL AFTER vigente_hasta,
  ADD COLUMN cancelada_por VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NULL AFTER cancelada_en,
  ADD COLUMN motivo_cancelacion VARCHAR(200) NULL AFTER cancelada_por;

ALTER TABLE politica_comercial
  MODIFY COLUMN vigente_abierta SMALLINT GENERATED ALWAYS AS (
    CASE WHEN estado = 'VIGENTE' THEN 1 END
  ) STORED;

-- Backfill de vigencia historica y del aporte de monotributo inicial.
UPDATE politica_comercial
   SET estado = CASE
     WHEN vigente_hasta IS NULL THEN 'VIGENTE'
     ELSE 'HISTORICA'
   END,
   aporte_monotributo = 23892.00
 WHERE estado IS NULL;

ALTER TABLE politica_comercial
  MODIFY estado VARCHAR(12)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ADD COLUMN guard_programada INT
    GENERATED ALWAYS AS (IF(estado = 'PROGRAMADA', 1, NULL)) STORED,
  ADD UNIQUE KEY uq_politica_comercial_programada (guard_programada),
  ADD KEY ix_politica_comercial_estado_fecha (estado, fecha_vigencia),
  ADD KEY ix_politica_comercial_base (version_base_id),
  ADD CONSTRAINT fk_politica_comercial_base
    FOREIGN KEY (version_base_id)
    REFERENCES politica_comercial (id),
  ADD CONSTRAINT fk_politica_comercial_cancelada_por
    FOREIGN KEY (cancelada_por)
    REFERENCES empleados (legajo),
  ADD CONSTRAINT chk_politica_comercial_estado
    CHECK (estado IN ('VIGENTE', 'PROGRAMADA', 'HISTORICA', 'CANCELADA')),
  ADD CONSTRAINT chk_politica_aporte_monotributo
    CHECK (aporte_monotributo IS NOT NULL AND aporte_monotributo > 0),
  ADD CONSTRAINT chk_politica_comercial_estado_vigencia
    CHECK (
      (estado = 'HISTORICA' AND vigente_hasta IS NOT NULL)
      OR (estado <> 'HISTORICA' AND vigente_hasta IS NULL)
    ),
  ADD CONSTRAINT chk_politica_comercial_cancelacion
    CHECK (
      (estado = 'CANCELADA'
        AND cancelada_en IS NOT NULL
        AND cancelada_por IS NOT NULL
        AND CHAR_LENGTH(TRIM(motivo_cancelacion)) BETWEEN 1 AND 200)
      OR (estado <> 'CANCELADA'
        AND cancelada_en IS NULL
        AND cancelada_por IS NULL
        AND motivo_cancelacion IS NULL)
    );

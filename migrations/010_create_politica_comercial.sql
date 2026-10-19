-- matista:target-table politica_comercial
-- E1 SPEC-03 ADMIN: política versionada por fila abierta (patrón aprobado en SPECT 02 §d / SPECT 03 §4).
CREATE TABLE politica_comercial (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  porcentaje_aporte_reconocido DECIMAL(5,2) NOT NULL,
  tope_sueldo_bruto DECIMAL(12,2) NOT NULL,
  joven_porcentaje DECIMAL(5,2) NOT NULL,
  comercial_fijo_max_pct DECIMAL(5,2) NOT NULL,
  comercial_fijo_meses_max TINYINT UNSIGNED NOT NULL,
  comercial_escalonado_max_pct DECIMAL(5,2) NOT NULL,
  comercial_escalonado_tramos_max TINYINT UNSIGNED NOT NULL,
  comercial_escalonado_total_meses_max TINYINT UNSIGNED NOT NULL,
  primer_tramo_50_meses_max TINYINT UNSIGNED NOT NULL,
  tdc_pct DECIMAL(5,2) NOT NULL,
  tdc_habilitado TINYINT NOT NULL,
  tope_comercial_tdc_pct DECIMAL(5,2) NOT NULL,
  afinidad_pct DECIMAL(5,2) NULL,
  fecha_vigencia DATETIME(6) NOT NULL,
  vigente_hasta DATETIME(6) NULL,
  -- Patrón fila abierta (probado en empleados_correos): una única fila vigente garantizada por índice único con columna generada.
  vigente_abierta SMALLINT GENERATED ALWAYS AS (
    CASE WHEN vigente_hasta IS NULL THEN 1 END
  ) STORED,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_politica_comercial_abierta (vigente_abierta),

  CONSTRAINT fk_politica_comercial_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_politica_aporte_reconocido
    CHECK (porcentaje_aporte_reconocido > 0 AND porcentaje_aporte_reconocido < 100),
  CONSTRAINT chk_politica_tope_bruto
    CHECK (tope_sueldo_bruto > 0),
  CONSTRAINT chk_politica_joven
    CHECK (joven_porcentaje >= 0 AND joven_porcentaje <= 100),
  -- Regla de elegibilidad joven NO va en la tabla: es fija en Reglas Comerciales (4.2 del documento rector).
  CONSTRAINT chk_politica_comercial_fijo_max_pct
    CHECK (comercial_fijo_max_pct > 0 AND comercial_fijo_max_pct <= 100),
  CONSTRAINT chk_politica_comercial_fijo_meses
    CHECK (comercial_fijo_meses_max > 0 AND comercial_fijo_meses_max <= 12),
  CONSTRAINT chk_politica_escalonado_max_pct
    CHECK (comercial_escalonado_max_pct > 0 AND comercial_escalonado_max_pct <= 100),
  CONSTRAINT chk_politica_escalonado_tramos
    CHECK (comercial_escalonado_tramos_max >= 1 AND comercial_escalonado_tramos_max <= 4),
  CONSTRAINT chk_politica_escalonado_total_meses
    CHECK (comercial_escalonado_total_meses_max > 0 AND comercial_escalonado_total_meses_max <= 12),
  CONSTRAINT chk_politica_primer_tramo_meses
    CHECK (primer_tramo_50_meses_max > 0 AND primer_tramo_50_meses_max <= 12),
  CONSTRAINT chk_politica_tdc_pct
    CHECK (tdc_pct >= 0 AND tdc_pct <= 100),
  CONSTRAINT chk_politica_tdc_habilitado
    CHECK (tdc_habilitado IN (0, 1)),
  CONSTRAINT chk_politica_tope_comercial_tdc
    CHECK (tope_comercial_tdc_pct > 0 AND tope_comercial_tdc_pct <= 100),
  CONSTRAINT chk_politica_afinidad
    CHECK (afinidad_pct IS NULL OR (afinidad_pct >= 0 AND afinidad_pct <= 100)),
  CONSTRAINT chk_politica_vigencia
    CHECK (vigente_hasta IS NULL OR vigente_hasta > fecha_vigencia)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

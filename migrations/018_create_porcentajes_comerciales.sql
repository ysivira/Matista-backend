-- matista:target-table porcentajes_comerciales
-- E1 SPEC-03 ADMIN: catálogo de porcentajes comerciales autorizados con vigencia por fila abierta.
CREATE TABLE porcentajes_comerciales (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  porcentaje DECIMAL(5,2) NOT NULL,
  descripcion VARCHAR(100) NULL,
  fecha_vigencia DATETIME(6) NOT NULL,
  vigente_hasta DATETIME(6) NULL,
  -- Patrón fila abierta: una única fila vigente por porcentaje garantizada por índice único con columna generada.
  vigente_abierta SMALLINT GENERATED ALWAYS AS (
    CASE WHEN vigente_hasta IS NULL THEN 1 END
  ) STORED,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_porcentajes_comerciales_abierta (vigente_abierta, porcentaje),

  CONSTRAINT fk_porcentajes_comerciales_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_porcentajes_comerciales_pct
    CHECK (porcentaje > 0 AND porcentaje <= 100),
  CONSTRAINT chk_porcentajes_comerciales_vigencia
    CHECK (vigente_hasta IS NULL OR vigente_hasta > fecha_vigencia)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
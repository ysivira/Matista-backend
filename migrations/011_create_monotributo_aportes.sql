-- matista:target-table monotributo_aportes
-- E1 SPEC-03 ADMIN: aportes por categoría (A–K + Adherente) con vigencia por fila abierta (RF-D23/D24, RN-14).
CREATE TABLE monotributo_aportes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  categoria VARCHAR(20) NOT NULL,
  aporte DECIMAL(12,2) NOT NULL,
  vigente_desde DATETIME(6) NOT NULL,
  vigente_hasta DATETIME(6) NULL,
  -- Una única fila abierta por categoría: la clave generada toma el valor de categoria solo mientras la fila esté abierta.
  categoria_abierta VARCHAR(20) GENERATED ALWAYS AS (
    CASE WHEN vigente_hasta IS NULL THEN categoria END
  ) STORED,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_monotributo_abierta (categoria_abierta),
  UNIQUE KEY uq_monotributo_categoria_desde (categoria, vigente_desde),

  CONSTRAINT fk_monotributo_aportes_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_monotributo_categoria
    CHECK (CHAR_LENGTH(categoria) > 0),
  CONSTRAINT chk_monotributo_aporte
    CHECK (aporte > 0),
  CONSTRAINT chk_monotributo_vigencia
    CHECK (vigente_hasta IS NULL OR vigente_hasta > vigente_desde)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- matista:target-table empleados_correos
CREATE TABLE empleados_correos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  email VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci NOT NULL,
  estado VARCHAR(12)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  verificado_at DATETIME(6) NULL,
  cerrado_at DATETIME(6) NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),

  actual_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN estado = 'ACTUAL' THEN legajo ELSE NULL END
    ) STORED,

  pendiente_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN estado = 'PENDIENTE' THEN legajo ELSE NULL END
    ) STORED,

  email_reservado VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_as_ci
    GENERATED ALWAYS AS (
      CASE
        WHEN estado IN ('ACTUAL', 'PENDIENTE') THEN email
        ELSE NULL
      END
    ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_empleados_correos_actual (actual_legajo),
  UNIQUE KEY uq_empleados_correos_pendiente (pendiente_legajo),
  UNIQUE KEY uq_empleados_correos_reservado (email_reservado),
  KEY idx_empleados_correos_login (email, estado),
  KEY idx_empleados_correos_legajo_estado (legajo, estado),

  CONSTRAINT fk_empleados_correos_empleado
    FOREIGN KEY (legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_empleados_correos_estado
    CHECK (
      estado IN ('PENDIENTE', 'ACTUAL', 'ANTERIOR', 'CANCELADO')
    ),

  CONSTRAINT chk_empleados_correos_fechas
    CHECK (
      (
        estado = 'PENDIENTE'
        AND verificado_at IS NULL
        AND cerrado_at IS NULL
      )
      OR
      (
        estado = 'ACTUAL'
        AND verificado_at IS NOT NULL
        AND cerrado_at IS NULL
      )
      OR
      (
        estado = 'ANTERIOR'
        AND verificado_at IS NOT NULL
        AND cerrado_at IS NOT NULL
      )
      OR
      (
        estado = 'CANCELADO'
        AND verificado_at IS NULL
        AND cerrado_at IS NOT NULL
      )
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

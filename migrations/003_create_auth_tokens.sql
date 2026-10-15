-- matista:target-table auth_tokens
CREATE TABLE auth_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  correo_id BIGINT UNSIGNED NULL,
  tipo VARCHAR(24)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  token_hash BINARY(32) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  consumed_at DATETIME(6) NULL,
  revoked_at DATETIME(6) NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  token_abierto_clave VARCHAR(48)
    CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE
        WHEN consumed_at IS NULL AND revoked_at IS NULL
        THEN CONCAT(tipo, ':', legajo)
        ELSE NULL
      END
    ) STORED,

  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_tokens_hash (token_hash),
  UNIQUE KEY uq_auth_tokens_abierto (token_abierto_clave),
  KEY idx_auth_tokens_expiracion (expires_at),
  KEY idx_auth_tokens_empleado (
    legajo, tipo, consumed_at, revoked_at
  ),

  CONSTRAINT fk_auth_tokens_empleado
    FOREIGN KEY (legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT fk_auth_tokens_correo
    FOREIGN KEY (correo_id)
    REFERENCES empleados_correos (id),

  CONSTRAINT chk_auth_tokens_tipo
    CHECK (tipo IN ('VERIFICAR_EMAIL', 'RESET_PASSWORD')),

  CONSTRAINT chk_auth_tokens_correo
    CHECK (
      (tipo = 'VERIFICAR_EMAIL' AND correo_id IS NOT NULL)
      OR
      (tipo = 'RESET_PASSWORD' AND correo_id IS NULL)
    ),

  CONSTRAINT chk_auth_tokens_expiracion
    CHECK (expires_at > created_at),

  CONSTRAINT chk_auth_tokens_consumo_revocacion
    CHECK (
      NOT (consumed_at IS NOT NULL AND revoked_at IS NOT NULL)
    ),

  CONSTRAINT chk_auth_tokens_fecha_consumo
    CHECK (
      consumed_at IS NULL OR consumed_at >= created_at
    ),

  CONSTRAINT chk_auth_tokens_fecha_revocacion
    CHECK (
      revoked_at IS NULL OR revoked_at >= created_at
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

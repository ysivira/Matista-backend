-- matista:target-table auth_sesiones
CREATE TABLE auth_sesiones (
  jti CHAR(36)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  issued_at DATETIME(6) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  revoked_at DATETIME(6) NULL,
  revocation_reason VARCHAR(40)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (jti),
  KEY idx_auth_sesiones_empleado (
    legajo, revoked_at, expires_at
  ),
  KEY idx_auth_sesiones_expiracion (expires_at),

  CONSTRAINT fk_auth_sesiones_empleado
    FOREIGN KEY (legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_auth_sesiones_expiracion
    CHECK (expires_at > issued_at),

  CONSTRAINT chk_auth_sesiones_fecha_revocacion
    CHECK (
      revoked_at IS NULL OR revoked_at >= issued_at
    ),

  CONSTRAINT chk_auth_sesiones_revocacion
    CHECK (
      (revoked_at IS NULL AND revocation_reason IS NULL)
      OR
      (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- matista:target-table empleados_auditoria
CREATE TABLE empleados_auditoria (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  evento VARCHAR(32)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  campo VARCHAR(16)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  valor_anterior VARCHAR(255) NULL,
  valor_nuevo VARCHAR(255) NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  KEY idx_empleados_auditoria_objetivo (legajo, created_at),
  KEY idx_empleados_auditoria_actor (actor_legajo, created_at),
  KEY idx_empleados_auditoria_evento (evento, created_at),

  CONSTRAINT fk_empleados_auditoria_objetivo
    FOREIGN KEY (legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT fk_empleados_auditoria_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_empleados_auditoria_evento_campo
    CHECK (
      (evento = 'REGISTRO' AND campo = 'CUENTA')
      OR
      (evento = 'EMAIL_VERIFICADO' AND campo = 'EMAIL')
      OR
      (evento = 'EMAIL_CAMBIADO' AND campo = 'EMAIL')
      OR
      (evento = 'ESTADO_CAMBIADO' AND campo = 'ESTADO')
      OR
      (evento = 'ROL_CAMBIADO' AND campo = 'ROL')
      OR
      (evento = 'PASSWORD_CAMBIADA' AND campo = 'PASSWORD')
    ),

  CONSTRAINT chk_empleados_auditoria_password
    CHECK (
      evento <> 'PASSWORD_CAMBIADA'
      OR (valor_anterior IS NULL AND valor_nuevo IS NULL)
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

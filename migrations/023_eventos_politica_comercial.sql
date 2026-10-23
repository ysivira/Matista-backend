-- matista:target-table politica_comercial_eventos
-- matista:kind: create
-- Auditoria por version con snapshot de identidad, equivalente al tarifario.
CREATE TABLE politica_comercial_eventos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  politica_comercial_id BIGINT UNSIGNED NOT NULL,
  tipo_evento ENUM(
    'CREACION',
    'PROGRAMACION',
    'MODIFICACION',
    'ACTIVACION',
    'CANCELACION',
    'RECUPERACION'
  ) NOT NULL,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_nombre VARCHAR(100) NOT NULL,
  actor_apellido VARCHAR(100) NOT NULL,
  detalle VARCHAR(500) NOT NULL,
  evento_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  KEY ix_politica_eventos_version (politica_comercial_id, evento_en),
  CONSTRAINT fk_politica_eventos_version
    FOREIGN KEY (politica_comercial_id)
    REFERENCES politica_comercial (id),
  CONSTRAINT fk_politica_eventos_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),
  CONSTRAINT chk_politica_eventos_actor_nombre
    CHECK (CHAR_LENGTH(TRIM(actor_nombre)) > 0),
  CONSTRAINT chk_politica_eventos_actor_apellido
    CHECK (CHAR_LENGTH(TRIM(actor_apellido)) > 0),
  CONSTRAINT chk_politica_eventos_detalle
    CHECK (CHAR_LENGTH(TRIM(detalle)) > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

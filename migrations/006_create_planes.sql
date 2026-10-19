-- matista:target-table planes
-- E1 SPEC-03 ADMIN: catálogo de planes heredado de SIGEC (solo lectura para ADMIN, RF-D06).
CREATE TABLE planes (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  nombre VARCHAR(100) NOT NULL,
  detalles TEXT NULL,
  condiciones_generales TEXT NULL,
  activa TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_planes_nombre (nombre),

  CONSTRAINT chk_planes_activa
    CHECK (activa IN (0, 1)),
  CONSTRAINT chk_planes_nombre
    CHECK (CHAR_LENGTH(nombre) > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

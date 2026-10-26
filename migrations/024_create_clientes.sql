-- matista:target-table clientes
-- SPEC-04: titular y composición familiar declarada; propiedad estable del asesor.
CREATE TABLE clientes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  dni VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nombres VARCHAR(100) NOT NULL,
  apellidos VARCHAR(100) NOT NULL,
  email VARCHAR(254) NULL,
  telefono VARCHAR(40) NULL,
  direccion VARCHAR(255) NULL,
  familia JSON NOT NULL,
  asesor_legajo VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_clientes_dni (dni),
  UNIQUE KEY uq_clientes_propietario (id, asesor_legajo),
  CONSTRAINT fk_clientes_asesor FOREIGN KEY (asesor_legajo) REFERENCES empleados (legajo),
  CONSTRAINT chk_clientes_revision CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

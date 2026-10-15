-- matista:target-table empleados
CREATE TABLE empleados (
  legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  nombre VARCHAR(100) NOT NULL,
  segundo_nombre VARCHAR(100) NULL,
  apellido VARCHAR(100) NOT NULL,
  segundo_apellido VARCHAR(100) NULL,
  telefono VARCHAR(20) NULL,
  direccion VARCHAR(255) NULL,
  password_hash VARCHAR(255)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  rol VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ASESOR',
  estado VARCHAR(12)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'PENDIENTE',
  password_changed_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
    ON UPDATE CURRENT_TIMESTAMP(6),

  PRIMARY KEY (legajo),
  KEY idx_empleados_estado_rol (estado, rol),
  KEY idx_empleados_apellido_nombre (apellido, nombre),

  CONSTRAINT chk_empleados_legajo
    CHECK (REGEXP_LIKE(legajo, '^[0-9]{7,10}$', 'c')),
  CONSTRAINT chk_empleados_nombre
    CHECK (CHAR_LENGTH(TRIM(nombre)) > 0),
  CONSTRAINT chk_empleados_apellido
    CHECK (CHAR_LENGTH(TRIM(apellido)) > 0),
  CONSTRAINT chk_empleados_password
    CHECK (CHAR_LENGTH(password_hash) > 0),
  CONSTRAINT chk_empleados_rol
    CHECK (rol IN ('ADMIN', 'ASESOR')),
  CONSTRAINT chk_empleados_estado
    CHECK (estado IN ('PENDIENTE', 'ACTIVO', 'INACTIVO', 'BAJA'))
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

-- matista:target-table tarifario_versiones
-- E1 SPEC-03 ADMIN: cabeceras de versión tarifaria (snapshot completo por versión, insert-only).
CREATE TABLE tarifario_versiones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tipo VARCHAR(16)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_base_id BIGINT UNSIGNED NULL,
  version_revertida_id BIGINT UNSIGNED NULL,
  plan_id SMALLINT UNSIGNED NULL,
  filtro_modalidad VARCHAR(12) NULL,
  porcentaje DECIMAL(5,2) NULL,
  fecha_activacion DATETIME(6) NOT NULL,
  estado VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVA',
  observacion VARCHAR(255) NOT NULL,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_tarifario_versiones_fecha (fecha_activacion),
  KEY ix_tarifario_versiones_estado (estado, fecha_activacion),
  KEY ix_tarifario_versiones_base (version_base_id),

  CONSTRAINT fk_tarifario_versiones_base
    FOREIGN KEY (version_base_id)
    REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_tarifario_versiones_revertida
    FOREIGN KEY (version_revertida_id)
    REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_tarifario_versiones_plan
    FOREIGN KEY (plan_id)
    REFERENCES planes (id),
  CONSTRAINT fk_tarifario_versiones_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_tarifario_versiones_tipo
    CHECK (tipo IN ('CARGA_INICIAL', 'AUMENTO_MASIVO', 'EDICION_PLAN', 'REVERSION')),
  CONSTRAINT chk_tarifario_versiones_modalidad
    CHECK (filtro_modalidad IS NULL OR filtro_modalidad IN ('OBLIGATORIO', 'VOLUNTARIO', 'AMBAS')),
  CONSTRAINT chk_tarifario_versiones_porcentaje
    CHECK (porcentaje IS NULL OR porcentaje > 0),
  CONSTRAINT chk_tarifario_versiones_estado
    CHECK (estado IN ('ACTIVA', 'CANCELADA')),
  -- CARGA_INICIAL no lleva actor (la migración no inventa legajos) ni alcance; el resto de tipos los exige.
  CONSTRAINT chk_tarifario_versiones_actor
    CHECK (
      (tipo = 'CARGA_INICIAL' AND actor_legajo IS NULL)
      OR
      (tipo <> 'CARGA_INICIAL' AND actor_legajo IS NOT NULL)
    ),
  -- Coherencia de alcance por tipo aprobada en el diseño consolidado v1.1.
  CONSTRAINT chk_tarifario_versiones_carga_inicial
    CHECK (
      tipo <> 'CARGA_INICIAL'
      OR (
        version_base_id IS NULL
        AND version_revertida_id IS NULL
        AND plan_id IS NULL
        AND filtro_modalidad IS NULL
        AND porcentaje IS NULL
      )
    ),
  CONSTRAINT chk_tarifario_versiones_aumento_masivo
    CHECK (
      tipo <> 'AUMENTO_MASIVO'
      OR (
        version_base_id IS NOT NULL
        AND filtro_modalidad IS NOT NULL
        AND porcentaje IS NOT NULL
        AND plan_id IS NULL
        AND version_revertida_id IS NULL
      )
    ),
  CONSTRAINT chk_tarifario_versiones_edicion_plan
    CHECK (
      tipo <> 'EDICION_PLAN'
      OR (
        version_base_id IS NOT NULL
        AND plan_id IS NOT NULL
        AND filtro_modalidad IS NOT NULL
        AND porcentaje IS NULL
        AND version_revertida_id IS NULL
      )
    ),
  CONSTRAINT chk_tarifario_versiones_reversion
    CHECK (
      tipo <> 'REVERSION'
      OR (
        version_base_id IS NOT NULL
        AND version_revertida_id IS NOT NULL
        AND plan_id IS NULL
        AND filtro_modalidad IS NULL
        AND porcentaje IS NULL
      )
    )
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

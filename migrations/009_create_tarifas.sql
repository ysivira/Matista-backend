-- matista:target-table tarifas
-- E1 SPEC-03 ADMIN: snapshot completo por versión, insert-only puro (sin UPDATE, Estrategia A).
CREATE TABLE tarifas (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  plan_id SMALLINT UNSIGNED NOT NULL,
  tipo_ingreso VARCHAR(12) NOT NULL,
  rango_etario VARCHAR(50) NOT NULL,
  rango_clave VARCHAR(50) NOT NULL,
  rango_nota VARCHAR(20) NULL,
  precio DECIMAL(12,2) NOT NULL,
  activa TINYINT NOT NULL DEFAULT 1,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tarifas_version_clave (version_id, plan_id, tipo_ingreso, rango_clave),
  KEY ix_tarifas_busqueda (plan_id, tipo_ingreso, rango_clave, version_id),

  CONSTRAINT fk_tarifas_version
    FOREIGN KEY (version_id)
    REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_tarifas_plan
    FOREIGN KEY (plan_id)
    REFERENCES planes (id),

  CONSTRAINT chk_tarifas_tipo_ingreso
    CHECK (tipo_ingreso IN ('Obligatorio', 'Voluntario')),
  -- activa=0 permite baja lógica (RF-D09) conservando la fila y su historial completo.
  CONSTRAINT chk_tarifas_activa
    CHECK (activa IN (0, 1)),
  CONSTRAINT chk_tarifas_precio
    CHECK (precio > 0),
  CONSTRAINT chk_tarifas_rango_clave
    CHECK (CHAR_LENGTH(rango_clave) > 0),
  CONSTRAINT chk_tarifas_rango_etario
    CHECK (CHAR_LENGTH(rango_etario) > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

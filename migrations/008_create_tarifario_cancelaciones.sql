-- matista:target-table tarifario_cancelaciones
-- E1 SPEC-03 ADMIN: historial de cancelaciones/reactivaciones; el registro nunca se borra (R3/R4).
CREATE TABLE tarifario_cancelaciones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  cancelada_por VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cancelada_en DATETIME(6) NOT NULL,
  motivo VARCHAR(255) NOT NULL,
  reactivada_por VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NULL,
  reactivada_en DATETIME(6) NULL,
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  UNIQUE KEY uq_tarifario_cancelaciones (version_id, cancelada_en),

  CONSTRAINT fk_tarifario_cancelaciones_version
    FOREIGN KEY (version_id)
    REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_tarifario_cancelaciones_cancelada_por
    FOREIGN KEY (cancelada_por)
    REFERENCES empleados (legajo),
  CONSTRAINT fk_tarifario_cancelaciones_reactivada_por
    FOREIGN KEY (reactivada_por)
    REFERENCES empleados (legajo),

  CONSTRAINT chk_tarifario_cancelaciones_reactivacion
    CHECK (
      (reactivada_por IS NULL AND reactivada_en IS NULL)
      OR
      (reactivada_por IS NOT NULL AND reactivada_en IS NOT NULL)
    ),
  CONSTRAINT chk_tarifario_cancelaciones_motivo
    CHECK (CHAR_LENGTH(motivo) > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

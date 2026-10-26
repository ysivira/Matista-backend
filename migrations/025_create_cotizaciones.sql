-- matista:target-table cotizaciones
-- El borrador carece de número de emisión e importes oficiales. La economía es snapshot.
CREATE TABLE cotizaciones (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cliente_id BIGINT UNSIGNED NOT NULL,
  asesor_legajo VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  origen_id BIGINT UNSIGNED NULL,
  estado VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'BORRADOR',
  numero VARCHAR(40) NULL,
  plan_id SMALLINT UNSIGNED NOT NULL,
  modalidad VARCHAR(12) NOT NULL,
  tarifa_version_id BIGINT UNSIGNED NOT NULL,
  politica_id BIGINT UNSIGNED NOT NULL,
  solicitud JSON NOT NULL,
  contacto JSON NOT NULL,
  resultado JSON NULL,
  emitida_at DATETIME(6) NULL,
  vence_at DATETIME(6) NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_cotizaciones_numero (numero),
  UNIQUE KEY uq_cotizaciones_propietario (id, asesor_legajo),
  KEY ix_cotizaciones_historial (asesor_legajo, created_at),
  CONSTRAINT fk_cotizaciones_cliente FOREIGN KEY (cliente_id, asesor_legajo) REFERENCES clientes (id, asesor_legajo),
  CONSTRAINT fk_cotizaciones_origen FOREIGN KEY (origen_id, asesor_legajo) REFERENCES cotizaciones (id, asesor_legajo),
  CONSTRAINT fk_cotizaciones_plan FOREIGN KEY (plan_id) REFERENCES planes (id),
  CONSTRAINT fk_cotizaciones_tarifa FOREIGN KEY (tarifa_version_id) REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_cotizaciones_politica FOREIGN KEY (politica_id) REFERENCES politica_comercial (id),
  CONSTRAINT chk_cotizaciones_estado CHECK (estado IN ('BORRADOR','EMITIDA','ANULADA')),
  CONSTRAINT chk_cotizaciones_modalidad CHECK (modalidad IN ('Voluntario','Obligatorio','Monotributo')),
  CONSTRAINT chk_cotizaciones_emision CHECK (
    (numero IS NULL AND resultado IS NULL AND emitida_at IS NULL AND vence_at IS NULL AND estado <> 'EMITIDA')
    OR (numero IS NOT NULL AND resultado IS NOT NULL AND emitida_at IS NOT NULL
        AND vence_at = DATE_ADD(emitida_at, INTERVAL 15 DAY) AND estado <> 'BORRADOR')
  ),
  CONSTRAINT chk_cotizaciones_revision CHECK (revision > 0)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

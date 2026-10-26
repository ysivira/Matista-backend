-- matista:target-table asesor_auditoria
-- Cambios de clientes y cotizaciones con identidad y valores históricos.
CREATE TABLE asesor_auditoria (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_legajo VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  cliente_id BIGINT UNSIGNED NOT NULL,
  cotizacion_id BIGINT UNSIGNED NULL,
  evento VARCHAR(40) NOT NULL,
  anterior JSON NULL,
  nuevo JSON NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  CONSTRAINT fk_asesor_auditoria_actor FOREIGN KEY (actor_legajo) REFERENCES empleados (legajo),
  CONSTRAINT fk_asesor_auditoria_cliente FOREIGN KEY (cliente_id) REFERENCES clientes (id),
  CONSTRAINT fk_asesor_auditoria_cotizacion FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones (id)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

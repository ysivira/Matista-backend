-- matista:target-table miembros_cotizacion
-- Snapshot de integrantes; no contiene valores económicos calculados en SPEC-04.
CREATE TABLE miembros_cotizacion (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  cotizacion_id BIGINT UNSIGNED NOT NULL,
  orden SMALLINT UNSIGNED NOT NULL,
  parentesco VARCHAR(16) NOT NULL,
  edad SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_miembros_orden (cotizacion_id, orden),
  CONSTRAINT fk_miembros_cotizacion FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones (id),
  CONSTRAINT chk_miembros_parentesco CHECK (parentesco IN ('TITULAR','CONYUGE','HIJO','ADHERENTE')),
  CONSTRAINT chk_miembros_edad CHECK (edad <= 120)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

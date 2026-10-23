-- matista:target-table porcentajes_comerciales
-- matista:kind: alter
-- Vincula cada catálogo con la versión de política que lo contiene sin destruir historial.
ALTER TABLE porcentajes_comerciales
  ADD COLUMN politica_comercial_id BIGINT UNSIGNED NULL AFTER id;

-- Las filas actualmente abiertas pertenecen a la única política actualmente abierta.
UPDATE porcentajes_comerciales AS pc
JOIN politica_comercial AS p
  ON p.vigente_hasta IS NULL
SET pc.politica_comercial_id = p.id
WHERE pc.vigente_hasta IS NULL
  AND pc.politica_comercial_id IS NULL;

-- Una fila histórica se vincula solo cuando su inicio coincide con un único intervalo de política.
UPDATE porcentajes_comerciales AS pc
JOIN politica_comercial AS p
  ON pc.fecha_vigencia >= p.fecha_vigencia
 AND (p.vigente_hasta IS NULL OR pc.vigente_hasta <= p.vigente_hasta)
LEFT JOIN politica_comercial AS otra
  ON pc.fecha_vigencia >= otra.fecha_vigencia
 AND (otra.vigente_hasta IS NULL OR pc.vigente_hasta <= otra.vigente_hasta)
 AND otra.id <> p.id
SET pc.politica_comercial_id = p.id
WHERE pc.vigente_hasta IS NOT NULL
  AND pc.politica_comercial_id IS NULL
  AND otra.id IS NULL;

ALTER TABLE porcentajes_comerciales
  ADD KEY ix_porcentajes_comerciales_politica (politica_comercial_id),
  ADD CONSTRAINT fk_porcentajes_comerciales_politica
    FOREIGN KEY (politica_comercial_id)
    REFERENCES politica_comercial (id);

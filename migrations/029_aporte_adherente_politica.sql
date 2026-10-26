-- matista:target-table politica_comercial
-- matista:kind: alter
-- Las políticas históricas no reciben valores comerciales que no tenían al emitirse.
ALTER TABLE politica_comercial
  ADD COLUMN aporte_adherente DECIMAL(12,2) NULL AFTER aporte_monotributo,
  ADD COLUMN iva_voluntario_pct DECIMAL(5,2) NULL AFTER aporte_adherente,
  ADD CONSTRAINT chk_politica_aporte_adherente CHECK (aporte_adherente IS NULL OR aporte_adherente >= 0),
  ADD CONSTRAINT chk_politica_iva_voluntario CHECK (iva_voluntario_pct IS NULL OR iva_voluntario_pct BETWEEN 0 AND 100);

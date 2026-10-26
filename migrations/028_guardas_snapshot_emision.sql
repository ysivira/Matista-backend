-- matista:target-table cotizaciones
-- matista:kind: alter
-- CHECK considera UNKNOWN aceptable: se exigen explícitamente vencimiento y JSON objeto.
ALTER TABLE cotizaciones
  ADD CONSTRAINT chk_cotizaciones_snapshot_emitido CHECK (
    numero IS NULL OR (
      resultado IS NOT NULL
      AND JSON_TYPE(resultado) = 'OBJECT'
      AND emitida_at IS NOT NULL
      AND vence_at IS NOT NULL
    )
  );

-- matista:target-table tarifario_versiones
-- matista:kind: alter
-- 013 · Ciclo de vida de versiones (modelo "copia completa", decisiones O-1..O-7).
-- Cambios: estados PREPARACION/LISTA_PARA_ACTIVAR/ACTIVA/HISTORICA (se conserva
-- CANCELADA por compatibilidad, sin productor), tipo reducido a CARGA_INICIAL +
-- EDICION_LISTA (los motivos finos van a la auditoria de 014), fecha de activacion
-- anulable para borradores y contador de revision para concurrencia optimista.
-- Retiramos los CHECK del modelo antiguo por operacion (AUMENTO_MASIVO,
-- EDICION_PLAN, REVERSION); son ajustes de metadatos declarativos, no tocan datos.

-- Retiro de las restricciones declarativas asociadas al modelo antiguo.
ALTER TABLE tarifario_versiones
  DROP CHECK chk_tarifario_versiones_estado,
  DROP CHECK chk_tarifario_versiones_tipo,
  DROP CHECK chk_tarifario_versiones_aumento_masivo,
  DROP CHECK chk_tarifario_versiones_edicion_plan,
  DROP CHECK chk_tarifario_versiones_reversion;

-- El ancho actual (10) no admite 'PREPARACION' ni 'LISTA_PARA_ACTIVAR';
-- se conserva el juego de caracteres y el valor por defecto vigentes.
ALTER TABLE tarifario_versiones
  MODIFY estado VARCHAR(20)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'ACTIVA';

-- Una version en preparacion todavia no tiene fecha de activacion; el
-- unico indice uq_tarifario_versiones_fecha se mantiene (los NULL quedan
-- exentos de la unicidad en MySQL).
ALTER TABLE tarifario_versiones
  MODIFY fecha_activacion DATETIME(6) NULL;

-- Contador de revision para bloqueo optimistico de edicion (SL-4).
ALTER TABLE tarifario_versiones
  ADD revision INT UNSIGNED NOT NULL DEFAULT 0 AFTER porcentaje;

-- Nuevas restricciones del ciclo de vida. chk_tarifario_versiones_estado_fecha
-- obliga a que todo borrador (PREPARACION o LISTA_PARA_ACTIVAR) tenga la fecha
-- de activacion pendiente; las versiones efectivas la informan siempre.
ALTER TABLE tarifario_versiones
  ADD CONSTRAINT chk_tarifario_versiones_estado
    CHECK (estado IN ('PREPARACION', 'LISTA_PARA_ACTIVAR', 'ACTIVA', 'HISTORICA', 'CANCELADA')),
  ADD CONSTRAINT chk_tarifario_versiones_tipo
    CHECK (tipo IN ('CARGA_INICIAL', 'EDICION_LISTA')),
  ADD CONSTRAINT chk_tarifario_versiones_estado_fecha
    CHECK (
      estado NOT IN ('PREPARACION', 'LISTA_PARA_ACTIVAR')
      OR fecha_activacion IS NULL
    );

-- matista:target-table tarifario_versiones_eventos
-- matista:kind: create
-- 014 · Auditoria de versiones (mandato de trazabilidad separada).
-- Un evento por operacion, con snapshot de nombre/apellido/legajo del responsable
-- (se preservan en el tiempo aunque cambien los datos del empleado). Los legajos
-- se guardan como texto exacto, sin conversion numerica ni perdida de ceros.
-- Aumento masivo: una fila agrupadora (tipo_operacion = 'AUMENTO_MASIVO') mas
-- N filas hijas ('PRECIO') que apuntan a ella por agrupador_id y traen el
-- detalle individual por tarifa con valor anterior y nuevo.

CREATE TABLE tarifario_versiones_eventos (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  agrupador_id BIGINT UNSIGNED NULL,
  tipo_evento ENUM('CREACION', 'MODIFICACION', 'FINALIZACION', 'ACTIVACION') NOT NULL,
  -- Tipo de operacion: se cataloga solo en eventos de MODIFICACION; los
  -- eventos CREACION, FINALIZACION y ACTIVACION no llevan operacion ni
  -- entidad (registran el hecho del ciclo de vida y su responsable).
  tipo_operacion VARCHAR(24) NULL,
  actor_legajo VARCHAR(10)
    CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_nombre VARCHAR(100) NOT NULL,
  actor_apellido VARCHAR(100) NOT NULL,
  evento_en DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  plan_id SMALLINT UNSIGNED NULL,
  tipo_ingreso VARCHAR(12) NULL,
  rango_clave VARCHAR(50) NULL,
  valor_anterior DECIMAL(12,2) NULL,
  valor_nuevo DECIMAL(12,2) NULL,
  detalle VARCHAR(500) NOT NULL DEFAULT '',
  created_at DATETIME(6)
    NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

  PRIMARY KEY (id),
  KEY ix_eventos_version (version_id, evento_en),
  KEY ix_eventos_agrupador (agrupador_id),

  CONSTRAINT fk_eventos_version
    FOREIGN KEY (version_id)
    REFERENCES tarifario_versiones (id),
  CONSTRAINT fk_eventos_agrupador
    FOREIGN KEY (agrupador_id)
    REFERENCES tarifario_versiones_eventos (id),
  CONSTRAINT fk_eventos_actor
    FOREIGN KEY (actor_legajo)
    REFERENCES empleados (legajo),
  CONSTRAINT fk_eventos_plan
    FOREIGN KEY (plan_id)
    REFERENCES planes (id),

  -- Catalogo cerrado de operaciones de modificacion (solo hay tipo de
  -- operacion en eventos de cambio de contenido; los eventos del ciclo de
  -- vida lo dejan pendiente).
  CONSTRAINT chk_eventos_operacion
    CHECK (
      tipo_operacion IS NULL
      OR tipo_operacion IN ('PRECIO', 'ALTA_FILA', 'BAJA_FILA', 'AUMENTO_MASIVO', 'ALTA_PLAN', 'DESACTIVACION_PLAN')
    ),
  CONSTRAINT chk_eventos_operacion_modificacion
    CHECK (tipo_evento <> 'MODIFICACION' OR tipo_operacion IS NOT NULL),

  -- Operaciones sobre una tarifa: entidad completa de la fila.
  CONSTRAINT chk_eventos_entidad_fila
    CHECK (
      tipo_operacion NOT IN ('PRECIO', 'ALTA_FILA', 'BAJA_FILA')
      OR (
        plan_id IS NOT NULL
        AND tipo_ingreso IS NOT NULL
        AND tipo_ingreso IN ('Obligatorio', 'Voluntario')
        AND rango_clave IS NOT NULL
        AND CHAR_LENGTH(rango_clave) > 0
      )
    ),

  -- Operaciones sobre un plan: entidad a nivel plan, sin alcance de fila
  -- ni valores de precio (los precios de altas van por filas hijas).
  CONSTRAINT chk_eventos_entidad_plan
    CHECK (
      tipo_operacion NOT IN ('ALTA_PLAN', 'DESACTIVACION_PLAN')
      OR (
        plan_id IS NOT NULL
        AND tipo_ingreso IS NULL
        AND rango_clave IS NULL
        AND valor_anterior IS NULL
        AND valor_nuevo IS NULL
      )
    ),

  -- El evento agrupador de aumento masivo es MODIFICACION y no lleva
  -- entidad ni valores: el detalle individual vive en las filas hijas.
  CONSTRAINT chk_eventos_agrupador_cero
    CHECK (
      tipo_operacion <> 'AUMENTO_MASIVO'
      OR (
        tipo_evento = 'MODIFICACION'
        AND agrupador_id IS NULL
        AND plan_id IS NULL
        AND tipo_ingreso IS NULL
        AND rango_clave IS NULL
        AND valor_anterior IS NULL
        AND valor_nuevo IS NULL
      )
    ),

  -- Solo los ajustes de precio individuales se agrupan bajo un evento
  -- agrupador; el agrupador nunca es hijo de otro evento.
  CONSTRAINT chk_eventos_agrupador_fila
    CHECK (
      (agrupador_id IS NULL OR (tipo_evento = 'MODIFICACION' AND tipo_operacion = 'PRECIO'))
      AND (tipo_operacion <> 'AUMENTO_MASIVO' OR agrupador_id IS NULL)
    ),

  -- Los eventos del ciclo de vida (operacion pendiente) no llevan entidad,
  -- valores ni agrupador: solo registran el hecho, la fecha y el responsable.
  CONSTRAINT chk_eventos_entidad_ciclo
    CHECK (
      tipo_operacion IS NOT NULL
      OR (
        agrupador_id IS NULL
        AND plan_id IS NULL
        AND tipo_ingreso IS NULL
        AND rango_clave IS NULL
        AND valor_anterior IS NULL
        AND valor_nuevo IS NULL
      )
    ),

  -- Valores anterior/nuevo segun corresponden a cada operacion.
  CONSTRAINT chk_eventos_valores
    CHECK (
      (tipo_operacion <> 'PRECIO' OR (
        valor_anterior IS NOT NULL
        AND valor_nuevo IS NOT NULL
        AND valor_anterior <> valor_nuevo
      ))
      AND (tipo_operacion <> 'ALTA_FILA' OR (
        valor_anterior IS NULL
        AND valor_nuevo IS NOT NULL
      ))
      AND (tipo_operacion <> 'BAJA_FILA' OR (
        valor_anterior IS NOT NULL
        AND valor_nuevo IS NULL
      ))
    ),

  -- El snapshot de identidad del responsable es obligatorio en cada evento.
  CONSTRAINT chk_eventos_actor_nombre
    CHECK (CHAR_LENGTH(TRIM(actor_nombre)) > 0),
  CONSTRAINT chk_eventos_actor_apellido
    CHECK (CHAR_LENGTH(TRIM(actor_apellido)) > 0),
  CONSTRAINT chk_eventos_detalle
    CHECK (CHAR_LENGTH(detalle) > 0)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;

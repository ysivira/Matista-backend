-- 016 · Evento de reapertura de edicion (correccion integral Versiones).
-- La accion "Volver a edicion" (LISTA_PARA_ACTIVAR -> PREPARACION) debe
-- quedar auditada con su propio tipo, al mismo nivel que los eventos del
-- ciclo de vida existentes. La 014 cerro el catalogo con
--   tipo_evento ENUM('CREACION','MODIFICACION','FINALIZACION','ACTIVACION')
-- por lo que reaperturas previas no tienen un tipo legible en auditoria.
-- Este alter AMPLIA el ENUM agregando el valor al final (MySQL no toca
-- datos con la ampliacion) y conserva todas las restricciones CHECK
-- vigentes: REANUDACION es un evento del ciclo de vida (tipo_operacion
-- NULL, sin entidad ni valores), que ya cumple chk_eventos_operacion,
-- chk_eventos_operacion_modificacion y chk_eventos_entidad_ciclo tal
-- como estan definidos en 014.
-- Estado: APROBADA Y APLICADA (matista_test y matista_dev). Era .pending; el
-- runner solo toma archivos '*.sql'. Renombrada desde
-- 016_reanudacion_evento.sql.pending al aprobarse la ejecucion.

-- matista:target-table tarifario_versiones_eventos
-- matista:kind: alter

ALTER TABLE tarifario_versiones_eventos
  MODIFY COLUMN tipo_evento
    ENUM('CREACION', 'MODIFICACION', 'FINALIZACION', 'ACTIVACION', 'REANUDACION')
    NOT NULL COMMENT 'REANUDACION: la version vuelve de LISTA_PARA_ACTIVAR a PREPARACION';

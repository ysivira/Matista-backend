-- 017 · Evento de descarte de versiones no activadas (correccion del
-- ciclo de vida). El negocio decide REUTILIZAR el estado 'CANCELADA'
-- heredado (migracion 013: valor conservado por compatibilidad y sin
-- productor; no existe ninguna fila con ese estado en las bases) y
-- presentarlo como 'Descartada' en la pantalla: no hay estados
-- redundantes y el CHECK chk_tarifario_versiones_estado no se toca.
-- El estado ya libera la exclusividad de borradores: guard_borrador
-- (015) vale 1 solo para PREPARACION/LISTA_PARA_ACTIVAR y NULL para
-- CANCELADA, de modo que el indice uq_guard_borrador_version vuelve a
-- aceptar un borrador nuevo inmediatamente despues del descarte.
-- Lo unico que el catalogo vigente no admite es el EVENTO de
-- trazabilidad: la 014 cerro tipo_evento en
-- ENUM('CREACION','MODIFICACION','FINALIZACION','ACTIVACION') y la 016
-- agrego 'REANUDACION'; este alter AMPLIA el ENUM con 'DESCARTE' al
-- final (MySQL no toca datos con la ampliacion). El evento DESCARTE es
-- del ciclo de vida (tipo_operacion NULL, sin entidad ni valores) y ya
-- cumple chk_eventos_operacion, chk_eventos_operacion_modificacion,
-- chk_eventos_agrupador_* y chk_eventos_entidad_ciclo tal como estan.
-- Estado: APROBADA PARA EJECUCION EN matista_test Y matista_dev. Antes
-- de aplicarla se verifico la 016 en ambas bases y se respaldo
-- matista_dev; despues se ejecutan las verificaciones 017_post.

-- matista:target-table tarifario_versiones_eventos
-- matista:kind: alter

ALTER TABLE tarifario_versiones_eventos
  MODIFY COLUMN tipo_evento
    ENUM('CREACION', 'MODIFICACION', 'FINALIZACION', 'ACTIVACION',
         'REANUDACION', 'DESCARTE')
    NOT NULL COMMENT 'DESCARTE: version no activada retirada del ciclo con motivo y responsable';

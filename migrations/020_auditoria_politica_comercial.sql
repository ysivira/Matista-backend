-- matista:target-table empleados_auditoria
-- matista:kind: alter
-- Amplía el catálogo cerrado sin retirar ninguna pareja AUTH o TARIFARIO existente.
ALTER TABLE empleados_auditoria
  DROP CHECK chk_empleados_auditoria_evento_campo;

ALTER TABLE empleados_auditoria
  ADD CONSTRAINT chk_empleados_auditoria_evento_campo
  CHECK (
    (evento = 'REGISTRO' AND campo = 'CUENTA')
    OR
    (evento = 'EMAIL_VERIFICADO' AND campo = 'EMAIL')
    OR
    (evento = 'EMAIL_CAMBIADO' AND campo = 'EMAIL')
    OR
    (evento = 'ESTADO_CAMBIADO' AND campo = 'ESTADO')
    OR
    (evento = 'ROL_CAMBIADO' AND campo = 'ROL')
    OR
    (evento = 'PASSWORD_CAMBIADA' AND campo = 'PASSWORD')
    OR
    (evento IN (
      'VERSION_CREADA',
      'VERSION_PROGRAMADA',
      'VERSION_CANCELADA',
      'VERSION_REACTIVADA',
      'VERSION_REVERTIDA'
    ) AND campo = 'TARIFARIO')
    OR
    (evento IN (
      'POLITICA_COMERCIAL_ACTUALIZADA',
      'POLITICA_COMERCIAL_RECUPERADA'
    ) AND campo = 'TODOS')
    OR
    (evento IN (
      'PORCENTAJE_COMERCIAL_CREADO',
      'PORCENTAJE_COMERCIAL_ELIMINADO'
    ) AND campo = 'PORCENTAJE')
    OR
    (evento = 'PORCENTAJE_COMERCIAL_ACTUALIZADO' AND campo = 'DESCRIPCION')
  );

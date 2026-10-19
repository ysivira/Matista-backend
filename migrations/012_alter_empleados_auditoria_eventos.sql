-- matista:target-table empleados_auditoria
-- matista:kind: alter
-- E1 SPEC-03 ADMIN: el CHECK de eventos se amplía con los eventos TARIFARIO (tabla AUTH existente).
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
  );

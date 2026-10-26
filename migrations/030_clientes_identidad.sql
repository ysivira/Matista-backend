-- matista:target-table clientes
-- matista:kind: alter
-- SPEC-UI-02: la composición familiar deja de ser obligatoria en el registro de cliente y
-- la identidad gana fecha de nacimiento, provincia y localidad. Sin UPDATE de datos: los
-- registros históricos conservan su familia persistida y quedan editables sin fecha, y los
-- nuevos pueden darse de alta sin familia (composición pertenece a cada cotización).
ALTER TABLE clientes
  ADD COLUMN fecha_nacimiento DATE NULL AFTER direccion,
  ADD COLUMN provincia VARCHAR(80) NULL AFTER fecha_nacimiento,
  ADD COLUMN localidad VARCHAR(80) NULL AFTER provincia,
  MODIFY familia JSON NULL;

# Catálogo inicial autónomo E2

`carga_inicial_autonoma.json` es un recorte comercial verificado, no un dump de una base.

- Fuente principal: planes activos de `matista_dev`, tarifas **solo** de la versión `CARGA_INICIAL` id 1 (histórica, sin aplicar aumentos posteriores) y 12 aportes abiertos.
- Verificación realizada el 2026-11-03: nombres, IDs, prestaciones (`detalles`), condiciones, claves/notas e importes coinciden fila por fila con los mismos catálogos iniciales de `matista_test` (4/160/12). Ambas bases se consultaron solo en lectura. No se copió la base de pruebas como plantilla.
- Matriz: RUBÍ, ESMERALDA, ZAFIRO y DIAMANTE; Obligatorio/Voluntario; 20 rangos por combinación. Se conservan importes DECIMAL como texto, sin cálculos ni redondeo.
- `rango_etario` se reconstruye al adaptar la fuente al escritor E2: `66+` → `66-00`, y la nota `(*)` se añade al rótulo `HIJO 0-1`. Después se valida con el normalizador existente; no se cambia ninguna clave ni precio.
- Política: `POLITICA_INICIAL` compartida con la importación E2 (`src/modules/admin/carga-inicial.service.js`). Se cotejó con la política original id 1 de `matista_dev`. Los nueve porcentajes (`50,45,40,35,30,25,20,15,10`) se reutilizan de `PORCENTAJES_COMERCIALES_INICIALES` en su repositorio.
- No hay clientes, cotizaciones, empleados, hashes, sesiones, tokens, correos de personas ni configuraciones privadas en este archivo. El ADMIN demo se aprovisiona por separado con bcrypt.

SHA-256 de los bytes del archivo verificado:

```text
c4091816077059241b7f735aa066b2d1c649735ccdf785ebc4f66aab0653c1cd
```

El lector y la prueba unitaria exigen esta huella; además se valida la matriz mediante las reglas E2. No editar tarifas para satisfacer pruebas: una nueva versión de datos requiere una fuente autorizada, documentar su cotejo y actualizar las huellas del lector y de la prueba. Conservar el archivo JSON byte por byte (UTF-8, finales LF). La procedencia histórica SIGEC no implica dependencia de ejecución: ningún comando autónomo solicita sus credenciales ni abre su conexión.

## Datos no disponibles en E2

`afinidad_pct`, `aporte_adherente` e `iva_voluntario_pct` permanecen NULL: no se rellenan con fixtures o supuestos. El IVA es imprescindible para cotizar Voluntario y debe publicarse por ADMIN con un valor aprobado antes de usar esa modalidad. Obligatorio y Monotributo se prueban con los datos originales. Ver el procedimiento completo en el [README del backend](../../README.md).

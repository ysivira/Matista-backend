# ASESOR y motor comercial centralizado

La consolidación SPEC-04 incorpora cálculo comercial y emisión transaccional en el backend. React solo captura entradas y presenta resultados. AUTH autentica cookie y consulta cuenta/sesión actuales. Todas las rutas `/api/asesor` requieren exclusivamente ASESOR activo. ADMIN no puede ingresar al módulo ni operar clientes/cotizaciones. Las mutaciones requieren Origin exacto.

Las lecturas compartidas se exponen en `/api/catalogo` para ADMIN y ASESOR: planes, tarifario, condiciones y PDF de planes/listas. Ese router no monta operaciones de escritura. `/api/admin` conserva la autorización exclusiva ADMIN. Compartir componentes visuales no intercambia roles.

El cliente se busca o registra dentro de `/asesor/nueva`. `/asesor/clientes` no está registrada como pantalla independiente. Se conservan los servicios, endpoints, tablas y auditoría de clientes para el flujo integrado.

## Operaciones

| Ruta relativa | Método | Operación |
|---|---|---|
| `/planes` | GET | Mismo catálogo de ADMIN |
| `/tarifario/planes/:planId/:tipoIngreso` | GET | Misma lista vigente; Monotributo consulta Obligatorio |
| `/listas/:planId/:tipoIngreso/exportacion` | GET | CSV de precios reales |
| `/condiciones` | GET | Política y porcentajes vigentes, aportes configurados |
| `/condiciones/validacion` | POST | Valida `{condiciones, familia?}` parcialmente editadas; devuelve `{politica_id, errores: [{field, message}]}` sin persistencia. Familia permite incluir Joven automático. |
| `/clientes` | GET/POST | Listar propios / registrar |
| `/clientes/busqueda/:dni` | GET | Buscar; ajenos solo nombre de asesor y fecha |
| `/clientes/:id` | GET/PUT | Detalle / actualización propia con revisión |
| `/cotizaciones` | GET/POST | Historial / crear BORRADOR |
| `/cotizaciones/:id` | GET/PUT | Detalle / sustituir preparación de borrador |
| `/cotizaciones/:id/contacto` | PATCH | Contacto no económico con revisión |
| `/cotizaciones/:id/recotizaciones` | POST | Nueva preparación vinculada; anuladas no admitidas |
| `/cotizaciones/:id/anulacion` | POST | Estado ANULADA, revisión y motivo obligatorios |
| `/cotizaciones/:id/calculo` | POST | Calcula con vigencias actuales; devuelve resultado, revisión y huella |
| `/cotizaciones/:id/emision` | POST | Recalcula y confirma revisión/huella; emite snapshot y auditoría |
| `/cotizaciones/:id/pdf` | GET | PDF institucional desde snapshot; borrador/anulada produce 409 |

Listados: 50 filas por página, `pagina` desde 1, `dni` como prefijo. Historial añade `estado`, `desde`, `hasta` (fecha de creación). Las fechas de emisión y vencimiento permanecen nulas en borradores.

## Entrada del formulario

Objeto cerrado: `cliente_id`, `plan_id`, `modalidad`, `familia`, `aportes`, `condiciones`; `revision` obligatoria al actualizar. IDs se tratan como cadenas decimales. No se aceptan estado, asesor, número, resultados ni totales del navegador.

- `familia`: `titular: {edad, estado_civil: SOLTERO|CASADO|OTRO}` y `miembros: [{parentesco: CONYUGE|HIJO, edad}]`. Nuevas preparaciones no admiten ADHERENTE como vínculo. Un registro histórico con ese vínculo se conserva al consultar; al reutilizarlo desde el formulario se exige declarar el vínculo real, sin inferirlo ni sobrescribir el original.

SPEC-UI-05: todas esas edades se declaran en años cumplidos y se guardan en el snapshot/miembros de la cotización. El alta de cliente no exige nacimiento; el contrato de identidad aún lo acepta opcionalmente y conserva el dato anterior al omitirse en una edición. La edad no se persiste como una fecha ficticia ni se añade una columna al maestro: el paso 1 la transporta en memoria al asistente y el contrato de cotización existente la valida. Una fecha real anterior puede sugerir la edad al comenzar una cotización nueva, pero nunca sustituye la edad guardada/declarada al calcular, emitir o recotizar.
- Voluntario: `aportes: {}`.
- Obligatorio: `aportes: {opcion_aporte: SUELDO, sueldo_bruto: stringDecimal}` o `{opcion_aporte: PERSONAL_RECIBO, aporte_personal: stringDecimal}`. El motor reconstruye bruto desde el aporte personal del 3 % y aplica el porcentaje total y tope vigentes. El antiguo DECLARADO requiere volver a identificar el dato antes de calcular.
- Monotributo: `aportes: {categoria: A..K, adherentes: entero no negativo}`. La categoría se conserva como registro, sin efecto económico. SPEC-MONOTRIBUTO-CORRECCION: el aporte unitario es `aporte_monotributo` de la política vigente tanto para titular como para cada adherente registrado; la cantidad es independiente de los familiares cotizados. Se conserva el parámetro administrativo antiguo `aporte_adherente` y los snapshots históricos, pero el cálculo nuevo no lo utiliza. Motor de Monotributo: `matista-3-monotributo`; Obligatorio y Voluntario conservan `matista-2` y sus resultados.
- `condiciones: {esquema?: FIJO|TRAMOS, tramos: [{porcentaje_id, meses}], tdc: boolean, beneficios: {solicita_afinidad: boolean}}`. El wizard nuevo declara TRAMOS; si falta el esquema en una entrada anterior, más de un período implica TRAMOS y cero/uno implica FIJO.

La posición del array establece el orden consecutivo de los tramos. El servidor comparte la validación de campaña entre edición inmediata, preparación y motor: opciones publicadas, duración individual/acumulada, exclusividad y tope contractual. Los importes se aplican secuencialmente sobre saldos. Un borrador no certifica elegibilidad ni condiciones aceptables para emitir.

SPEC-FIX-07: el campo opcional `familia` de validación inmediata reutiliza la composición del contrato existente, admitiendo edición parcial; sin ese contexto no es posible conocer la elegibilidad joven. Se conserva la respuesta y compatibilidad para consumidores anteriores. Preparación, recotización, preview, cálculo y emisión siempre validan la familia completa y suman Joven + Comercial + TDC + Afinidad contra `tope_comercial_tdc_pct` de la política vigente. Se evalúa cada tramo, o comercial cero si no hay campaña; el mensaje incluye acumulado, máximo y exceso. La omisión de familia en la validación parcial no elude el control de emisión.

La composición nueva admite un solo cónyuge y requiere CASADO cuando lo haya. El editor selecciona CASADO al elegir Cónyuge, impide otro y no deduce SOLTERO al eliminarlo. OTRO sigue siendo válido sin cónyuge y no activa Joven; no se convierte en CASADO ni SOLTERO por suposición. Para matrimonio la banda usa `Math.max(edadTitular, edadConyuge)`: se cobra una única tarifa MAT, se preservan las edades declaradas y se agregan los hijos según sus bandas. Un titular CASADO sin cónyuge informado conserva la selección MAT con su propia edad, como antes.

SPEC-UI-04: `matista-2` conserva BigInt y HALF-UP; desde recibo reconstruye el bruto como racional sin redondearlo antes del aporte final. Un recibo redondeado a centavos no necesariamente equivale al bruto original. Los resultados históricos no se recalculan al consultar.

## Solicitud servidor → motor, versión 1

`solicitarCalculo(solicitud)` recibe:

```text
version_contrato: 1
entrada: formulario validado
cliente: {id, dni, nombres, apellidos} leído bajo autorización
plan: {id, nombre, detalles, condiciones_generales} leído de ADMIN
asesor: {legajo, nombre, apellido} público, leído por servidor
referencias: {tarifa_version_id, politica_id}
catalogo: {tarifas, politica, porcentajes}
validacion_economica: PENDIENTE_CALCULO
```

El borrador captura las entradas y referencias. Calcular y emitir vuelven a resolver las vigencias y verifican propiedad dentro de la transacción. La emisión exige revisión y huella canónica del cálculo mostrado; el servidor vuelve a calcular y rechaza condiciones desactualizadas. Los reintentos idénticos no duplican la emisión.

SPEC-UI-05: el PDF incorpora la tabla íntegra de `planes.detalles` y `condiciones_generales`, con paginación adicional y sin recalcular importes. Los metadatos que no fueron capturados en snapshots anteriores se consultan como respaldo documental actual, sin modificar la cotización. No se infieren cláusulas contractuales que no estén en el catálogo.

Respuesta del motor, versión 1:

```text
version_contrato: 1
motor_version: identificador de implementación
referencias: {tarifa_version_id, politica_id}
precio_base: stringDecimal
aportes: [{concepto, importe: stringDecimal}]
beneficios: [{concepto, porcentaje, importe: stringDecimal}]
tramos: [{desde_mes, hasta_mes, total: stringDecimal, desglose}]
total: stringDecimal
advertencias: [string]
```

No existe endpoint que acepte resultados económicos desde React. La emisión fija número único, resultado, fecha de emisión y vencimiento a 15 días, con auditoría y commit conjunto. Los centavos y porcentajes se calculan con BigInt y HALF-UP, reutilizando las utilidades monetarias de ADMIN.

Orden confirmado: joven → comercial → TDC → afinidad. SPEC-FIX-07 sustituye la exclusión anterior de Joven del límite: los cuatro porcentajes consumen el mismo tope configurable. La suma es contractual, no una suma de importes ni el descuento efectivo secuencial. IVA configurable solo para Voluntario. Monotributo utiliza la lista Obligatorio, aporte base y el mismo aporte unitario por adherente registrado; la categoría no define el aporte. El campo de cantidad admite ingreso manual de enteros no negativos y validación al salir/continuar; no se deduce de la familia. Se cotiza el valor inicial: facturación y tratamiento de aportes posteriores al tercer mes están fuera del alcance. Los tramos posteriores se presentan con valores iniciales y advertencia, sin prometer tarifas futuras.

## Persistencia e historia

029 añade aporte_adherente e iva_voluntario_pct nullable a política comercial, sin backfill histórico. Los valores confirmados se activan mediante una nueva versión ADMIN auditada, no sobrescribiendo políticas anteriores.

024–027 agregan clientes (familia declarada JSON), cotizaciones (solicitud y resultado JSON separados), miembros_cotizacion y asesor_auditoria. 028 refuerza la guardia de emisión frente a NULL y resultados JSON que no sean objetos, conservando los checksums de las migraciones ya aplicadas. La FK compuesta cliente/asesor impide persistir una cotización de cliente ajeno. Origen/asesor preserva la propiedad al recotizar. El borrador tiene referencia técnica, pero no número de oferta ni importes oficiales.

Contacto administrativo se guarda aparte y audita anterior/nuevo, sin modificar solicitud/resultado. Edición económica solo sustituye entradas de BORRADOR; para una emisión se requiere nueva preparación vinculada. La anulación conserva toda la historia. El PDF utiliza exclusivamente datos persistidos; no reutiliza consultas a maestros actuales del generador SIGEC. Se adaptó el flujo, evitando introducir sus dependencias PDF en este stack.

La configuración de test fue autorizada expresamente y versionada (aporte adherente 23892, IVA Voluntario 10,50 % y tope 55 %). Las pruebas crean y limpian únicamente sus identidades/clientes/cotizaciones; requieren este catálogo de test configurado. Si la política de test no tiene porcentajes, la interfaz lo informa y permite preparar sin descuento comercial.

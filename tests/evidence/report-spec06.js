/** Genera el anexo desde registros existentes. --sync-txt sincroniza solo la exportación backend autorizada. */
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [directory] = process.argv.slice(2);
assert.ok(directory && path.isAbsolute(directory), 'Indicar el directorio de la ejecución SPEC06');
const out = directory;
const base = path.dirname(out);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const lines = async p => {
  try { return (await readFile(p,'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, value) => writeFile(path.join(out,name), JSON.stringify(value,null,2)+'\n', { mode: 0o600 });
const inventory = await json(path.join(out,'inventario-fuentes.json'));
for(const entry of inventory) {
  const currentSource=await readFile(path.join(root,entry.file),'utf8');
  entry.definitions=[...currentSource.matchAll(/(?:^|\n)\s*(?:await\s+)?(?:(t|st)\.)?test\(\s*(['"`])([^\n]*?)\2/g)].map(m=>({
    name:m[3],line:currentSource.slice(0,m.index+m[0].indexOf('test(')).split('\n').length,
    nested:Boolean(m[1]),parameterized:m[2]==='`'&&m[3].includes('${'),
  }));
  for(const definition of entry.definitions) {
    const line=currentSource.split('\n')[definition.line-1];
    definition.depth=/\bst\.test\(/.test(line)?2:/\bt\.test\(/.test(line)?1:0;
  }
  const mysql=entry.group.startsWith('mysql-')||entry.file.includes('admin.mecanismos.integration')||entry.file.includes('carga-inicial.integration');
  const install=entry.file.includes('instalacion.integration');
  entry.environmentRequired=install?['RUN_INSTALL_DB_TESTS=1','NODE_ENV=development','DB_NAME=matista_local','DB_HOST=loopback']:mysql?
    [entry.group==='mysql-auth.repository'?'RUN_AUTH_DB_TESTS=1':'RUN_DB_TESTS=1','NODE_ENV=test','DB_NAME=matista_test','DB_HOST=127.0.0.1','DB_USER','DB_PASSWORD']:
    entry.group==='pdf'?['RUN_PDF_TESTS=1','Node 24','--experimental-test-module-mocks']:['Node 24'];
  entry.databaseOrService=install?'MySQL matista_local (no autorizado)':mysql?'MySQL local matista_test':entry.group==='pdf'?'Chrome / Poppler (o dobles en infraestructura PDF)':'Sin base ni servicios externos; HTTP local cuando corresponde';
  if(entry.file.includes('carga-inicial.integration')) {
    entry.environmentRequired.push('SIGEC_DB_HOST','SIGEC_DB_USER','SIGEC_DB_PASSWORD','SIGEC_DB_DATABASE=sigec_db');
    entry.databaseOrService+=' + lectura SIGEC sigec_db (no autorizada)';
  }
  if(entry.group==='mysql-asesor')entry.databaseOrService+=' + Chrome';
  entry.commandNeeded=install?'NODE_ENV=development DB_HOST=127.0.0.1 DB_NAME=matista_local npm run test:install':
    `${mysql?'NODE_ENV=test DB_HOST=127.0.0.1 DB_NAME=matista_test '+(entry.group==='mysql-auth.repository'?'RUN_AUTH_DB_TESTS=1':'RUN_DB_TESTS=1')+' ':entry.group==='pdf'?'RUN_PDF_TESTS=1 ':''}node --experimental-test-module-mocks --test --test-concurrency=1 ${entry.file}`;
  entry.safety=entry.blocked??'Ejecutada en batería explícita; consultar preflight y resultado';
  entry.currentSha256=hash(await readFile(path.join(root,entry.file)));
}
await save('inventario-completo.json',inventory);
await save('bloqueos-actuales.json',inventory.filter(entry=>entry.blocked));
const initial = await json(path.join(out,'00-estado-inicial.json'));
const dependencies = await json(path.join(out,'dependencias.json'));
const results = [];
const evidenceRecords = [];
async function collect(dir) {
  evidenceRecords.push(...await lines(path.join(dir,'escenarios.jsonl')));
  for (const entry of await readdir(dir,{withFileTypes:true})) {
    const full = path.join(dir,entry.name);
    if (entry.isDirectory()) await collect(full);
    else if (entry.name.endsWith('-resultado.json')) {
      const result = await json(full);
      const events = await lines(path.join(dir,result.batch+'-eventos.jsonl'));
      let command = null;
      try { command = await json(path.join(dir,result.batch+'-comando.json')); } catch(e) { if(e.code!=='ENOENT') throw e; }
      results.push({ ...result, directory: dir, events, command });
    }
  }
}
await collect(out);
results.sort((a,b) => a.ended.localeCompare(b.ended));
const latest = new Map(results.map(r => [r.batch,r]));
const firstMysql=results.find(r=>r.integrity);
const identityPreflight=firstMysql?await json(path.join(firstMysql.directory,firstMysql.batch+'-antes-preflight.json')):null;
const events = [...latest.values()].flatMap(r => r.events.filter(e => ['test:pass','test:fail'].includes(e.type)).map(e => ({ ...e,batch:r.batch })));
for(const e of events) {
  if(e.file) e.file=path.relative(root,e.file);
}
const tests = events.filter(e => e.details?.type !== 'suite');
// Un contenedor test con subpruebas se informa aparte, no como otro caso funcional.
function isContainer(event) {
  if (!event.line || !event.file) return false;
  const next = Math.min(...events.filter(e => e.file===event.file && e.line>event.line && e.nesting<=event.nesting).map(e=>e.line),Infinity);
  return events.some(e => e.file===event.file && e.line>event.line && e.line<next && e.nesting>event.nesting);
}
const cases=tests.filter(e=>!isContainer(e));
const status=e=>e.skip?'OMITIDA':e.todo?'TODO':e.type==='test:pass'?'APROBADA':'FALLIDA';
const counts=list=>({ discovered:list.length, passed:list.filter(e=>status(e)==='APROBADA').length, failed:list.filter(e=>status(e)==='FALLIDA').length,
  skipped:list.filter(e=>status(e)==='OMITIDA').length, todo:list.filter(e=>status(e)==='TODO').length });
const blocked=inventory.filter(f=>f.blocked).flatMap(f=>f.definitions.map(d=>({file:f.file,...d,reason:f.blocked})));
function isDefinitionContainer(definition) {
  const definitions=inventory.find(f=>f.file===definition.file).definitions;
  const next=Math.min(...definitions.filter(d=>d.line>definition.line&&d.depth<=definition.depth).map(d=>d.line),Infinity);
  return definitions.some(d=>d.line>definition.line&&d.line<next&&d.depth>definition.depth);
}
const oldLog=await readFile(path.join(base,'04-instalacion-independiente-corregida-20261106T144151188934Z.txt'),'utf8');
const original=oldLog.split('\n').filter(l=>l.includes('# SKIP')&&!l.includes('ADMIN empleados: rutas HTTP')).map(l=>l.trim().replace(/^﹣ /,'').replace(/ \([\d.]+ms\) # SKIP.*$/,''));
assert.equal(original.length,49);
const originalStatus=original.map((name,i)=>{
  const source=inventory.find(f=>f.definitions.some(d=>d.name===name));
  assert.ok(source,`Prueba original sin correspondencia: ${name}`);
  const current=tests.find(e=>e.name===name && e.file===source.file);
  return {id:i+1,name,file:source.file,line:source.definitions.find(d=>d.name===name).line,
    originalReason:source.group==='pdf'?'RUN_PDF_TESTS=0':source.file.includes('instalacion.integration')?'RUN_INSTALL_DB_TESTS=0':'RUN_DB_TESTS=0',
    status:current?status(current):source.blocked?'BLOQUEADA':'NO REGISTRADA',reason:source.blocked??current?.skip??null,
    environmentRequired:source.environmentRequired,databaseOrService:source.databaseOrService,commandNeeded:source.commandNeeded,safety:source.safety};
});
const summary={ at:new Date().toISOString(), files:inventory.length, executedFiles:new Set(tests.map(e=>e.file)).size,
  nodeTests:counts(tests), cases:counts(cases), containers:tests.filter(isContainer).length, blockedNodes:blocked.length,
  blockedLeafDefinitions:blocked.filter(d=>!isDefinitionContainer(d)).length,
  original49:originalStatus, executions:results.map(({events,...r})=>({...r,counts:counts(events.filter(e=>e.details?.type!=='suite'&&e.type!=='test:summary'))})),
  limitations:['SIGEC y borrado C:324 no autorizados','DDL permanente de mecanismos no autorizado','Instalación matista_local no autorizada','SMTP externo no validado','Las tablas temporales del ciclo no incluyen FK; copiado adaptado en esa suite'] };
await save('resultados-consolidados.json',summary);
await save('inventario-instancias.json',events.map(e=>({...e,status:status(e),container:isContainer(e)})));
await save('omisiones-originales-49.json',originalStatus);

const escape=v=>String(v??'—').replaceAll('|','\\|').replaceAll('\n',' ');
const table=(header,rows)=>['| '+header.join(' | ')+' |','| '+header.map(()=> '---').join(' | ')+' |',...rows.map(r=>'| '+r.map(escape).join(' | ')+' |')].join('\n');
const code=value=>'```json\n'+JSON.stringify(value,null,2)+'\n```';
const compactCode=value=>'```json\n'+JSON.stringify(value)+'\n```';
const sections=[];
sections.push('# ANEXO — Evidencias reales MySQL de MATISTA\n\nValidación SPEC-06. Fecha de entrega: 06/11/2026.');
sections.push('## 1. Proyecto, entorno y versión\n\n'+table(['Propiedad','Identificación'],[
  ['Repositorio',root],['HEAD backend',initial['Matista-backend'].head.trim()],['Estado del código','HEAD base + cambios locales de pruebas; sin commit nuevo'],
  ['Entorno MySQL autorizado','test / matista_test / 127.0.0.1:3306'],['Registros de esta ejecución',out],['Generación del anexo',summary.at],
  ['Node',dependencies.node?.output.trim()],['Chrome',dependencies['/usr/bin/google-chrome']?.output.trim()],
  ['Frontend','Sin modificaciones; estado inicial y comprobación final conservados'],
])+'\n\nLas credenciales no se incluyen. El preflight registra identidad efectiva, versión MySQL y los 30 checksums de migraciones antes de cada batería SQL.\n\nConsulta inicial efectivamente ejecutada:\n\n```sql\nSELECT DATABASE() AS databaseName, VERSION() AS version, @@hostname AS hostname, @@port AS port\n```\n\n'+code(identityPreflight?.queries[0].rows??[]));
sections.push('## 2. Metodología\n\nSe ejecutaron baterías separadas con archivos explícitos, preflight y códigos de salida. Las tres suites bloqueadas no se importaron: sus hooks tampoco se ejecutaron. No se accedió a SIGEC, Aiven, Vercel ni matista_local. No se autorizaron migraciones pendientes ni tablas permanentes nuevas.\n\nLos escenarios reutilizan pruebas existentes. Las consultas de evidencia son SELECT y devuelven filas reales antes de limpiar los fixtures propios. Los registros JSONL conservan solicitudes/respuestas y consultas/resultados con secretos ocultos y datos personales sustituidos por huellas. Las comparaciones del test se realizan con las filas originales, no con sus versiones redactadas. Los IDs/legajos mostrados corresponden exclusivamente a fixtures sintéticos creados en esta ejecución.\n\nLos errores de rollback se inyectan en el adaptador de conexión de prueba; no se altera la aplicación. MySQL ejecuta la transacción real. No se exige recuperar valores AUTO_INCREMENT consumidos. Los resultados anteriores (526/0/49 y 29 aprobaciones) son antecedentes y no se suman a los resultados actuales.\n\nPara evitar duplicados se toma la última ejecución de cada batería. Se distinguen casos hoja, contenedores test y suites describe. Todos los intentos anteriores permanecen conservados.');
sections.push('## 3. Inventario completo de suites y pruebas\n\n'+table(['Archivo','Batería','Nodos actuales: aprobados/fallidos/omitidos','Estado'],inventory.map(f=>{
  const c=counts(tests.filter(e=>e.file===f.file));
  return [f.file,f.group,`${c.passed}/${c.failed}/${c.skipped}`,f.blocked??(c.discovered?'Ejecutado':'NO REGISTRADO')];
}))+'\n\nEl detalle individual de nombres, archivos, líneas, parametrizaciones y estados está en `inventario-fuentes.json` e `inventario-instancias.json`. `inventario-completo.json` añade variables, dependencias, destino, comando y evaluación de seguridad por archivo; `omisiones-originales-49.json` registra también esos datos individualmente para cada omisión. La inspección inicial encontró 57 archivos; SPEC-06 añade un archivo de pruebas del auxiliar de evidencia.\n\n`npm test` originalmente incluía 40 archivos y excluía 17: los cinco AUTH, diez de seguridad/correo/shared/salud y los dos de infraestructura PDF. La unión de scripts alcanzaba los 57, pero `test:db` solo ejecutaba esquema y `test:pdf` no habilitaba RUN_PDF_TESTS ni incluía clientes.normalizacion/fix07/monotributo. El nuevo test auxiliar tampoco entra en npm test: el ejecutor SPEC-06 sí lo descubre y lo ejecutó explícitamente.\n\nLa suite ADMIN empleados omitida ocultaba seis casos; el contenedor ASESOR ocultaba 14 subpruebas y el de instalación nueve. No se considera validada una prueba solo por existir.');
sections.push('## 4. Estado individual de las 49 omisiones originales\n\nFuente: `04-instalacion-independiente-corregida-20261106T144151188934Z.txt`, sección de npm test. Hay 49 nodos test omitidos y una marca adicional de suite describe omitida.\n\n'+table(['ID','Nombre exacto','Archivo:línea actual','Motivo original','Estado actual / bloqueo'],originalStatus.map(e=>[e.id,e.name,`${e.file}:${e.line}`,e.originalReason,e.status+(e.reason?' — '+e.reason:'')])));
const titles={
  'ESC-01':'Revocación por desactivación: HTTP y persistencia', 'ESC-02':'Logout: cookie anterior y sesión MySQL',
  'ESC-03':'Protección de cotizaciones ajenas', 'ESC-04':'Concurrencia: revisión y contenido persistido',
  'ESC-05':'Emisión idempotente y auditoría única', 'ESC-06':'Rollback: comparación completa antes/después',
};
function compactRow(row) {
  if(!row||typeof row!=='object')return row;
  if(row.solicitud!==undefined) {
    const result=typeof row.resultado==='string'?JSON.parse(row.resultado):row.resultado;
    return Object.fromEntries(Object.entries({...row,resultado:result&&{total:result.total},solicitud:{huella_del_registro_redactado:hash(JSON.stringify(row.solicitud))}})
      .filter(([k])=>!['created_at','updated_at','emitida_at','vence_at'].includes(k)));
  }
  if(row.nuevo!==undefined) return {...row,anterior:row.anterior==null?null:{huella_del_registro_redactado:hash(JSON.stringify(row.anterior))},nuevo:{huella_del_registro_redactado:hash(JSON.stringify(row.nuevo))}};
  return row;
}
function compactResponse(body) {
  if(body===null||body===undefined)return null;
  if(body.error)return body;
  const fields=['id','cliente_id','asesor_legajo','estado','rol','numero','revision','huella','emitida_at','vence_at','contacto','code'];
  const selected=Object.fromEntries(fields.filter(k=>Object.hasOwn(body,k)).map(k=>[k,body[k]]));
  if(body.resultado)selected.resultado={total:body.resultado.total};
  if(body.empleado)selected.empleado=Object.fromEntries(['legajo','rol','estado'].map(k=>[k,body.empleado[k]]));
  if(body.user)selected.user={legajo:body.user.legajo,rol:body.user.rol,estado:body.user.estado};
  return Object.keys(selected).length?selected:body;
}
let chapter=5;
const scenarioStates={};
for(const [scenario,title] of Object.entries(titles)) {
  const records=evidenceRecords.filter(e=>e.scenario===scenario);
  const scenarioResult=latest.get(scenario==='ESC-02'?'mysql-auth.repository':'mysql-asesor');
  const selectedRecords=records.filter(e=>scenarioResult&&e.at>=scenarioResult.started&&e.at<=scenarioResult.ended);
  const acceptance=scenarioResult?.exit===0?selectedRecords.filter(e=>e.type==='acceptance').at(-1):null;
  scenarioStates[scenario]={passed:Boolean(acceptance),criterion:acceptance?.criterion??null,batch:scenarioResult?.batch};
  let text=`## ${chapter++}. ${scenario}: ${title}\n\n**Estado:** ${acceptance?'Criterio verificado por las aserciones del escenario.':'NO ACREDITADO: falta aceptación registrada.'}\n\n`;
  text+=`**Fuente:** \`${scenarioResult?path.relative(base,path.join(scenarioResult.directory,'escenarios.jsonl')):'sin ejecución'}\`, batería \`${scenarioResult?.batch??'ausente'}\`.\n\n`;
  text+='Las respuestas y filas siguientes son una vista compacta de los registros efectivos, no respuestas fabricadas. Las huellas indicadas son cálculos de presentación sobre los registros redactados; no se atribuyen a MySQL. Los resultados completos depurados permanecen en `escenarios.jsonl` de la ejecución correspondiente.\n\n';
  const sqls=[...new Set(selectedRecords.filter(e=>e.type==='sql').map(e=>e.sql))];
  for(let i=0;i<sqls.length;i++)text+=`**SQL-${i+1}, efectivamente ejecutado:**\n\n\`\`\`sql\n${sqls[i]}\n\`\`\`\n\n`;
  text+='### Secuencia de preparación, ejecución y verificación\n\n';
  const quotations=selectedRecords.filter(e=>e.type==='sql'&&e.sql.includes('SELECT q.*'));
  if(quotations.length)text+=table(['Momento','Cotización','Estado','Número','Revisión','Huella de fila redactada'],quotations.map(e=>{
    const row=e.rows[0];return [e.phase,row.id,row.estado,row.numero,row.revision,hash(JSON.stringify(row))];
  }))+'\n\n';
  for(const entry of selectedRecords) {
    if(entry.type==='sql')text+=`**${entry.phase} — SQL-${sqls.indexOf(entry.sql)+1}**\n\n`+compactCode({parameters:entry.parameters,rows:entry.rows.map(compactRow)})+'\n\n';
    if(entry.type==='http')text+=`**HTTP ${entry.method} ${entry.path} → ${entry.status}**\n\n`+compactCode({request:entry.request,response_campos_seleccionados:compactResponse(entry.response),...(entry.sessionHeader?{sessionHeader:entry.sessionHeader}:{})})+'\n\n';
    if(entry.type==='fault')text+='**Fallo controlado observado:**\n\n'+code(entry)+'\n\nEn este paso se llama directamente al servicio con una fachada de conexión; no se afirma una respuesta HTTP 500 que no fue generada.\n\n';
  }
  text+='### Conclusión verificable\n\n'+(acceptance?.criterion??'No hay evidencia suficiente de aceptación en esta ejecución.')+'\n';
  sections.push(text);
}
sections.push('## 11. Resultados consolidados\n\n'+table(['Medida','Resultado'],[
  ['Archivos inventariados',summary.files],['Archivos con pruebas registradas en ejecución',summary.executedFiles],
  ['Casos hoja descubiertos por ejecución',summary.cases.discovered],['Casos hoja aprobados',summary.cases.passed],['Casos hoja fallidos',summary.cases.failed],['Casos hoja omitidos',summary.cases.skipped],
  ['Contenedores test, informados aparte',summary.containers],['Nodos test según Node (sin describe)',summary.nodeTests.discovered],
  ['Casos hoja inventariados: ejecutados + bloqueados',summary.cases.discovered+summary.blockedLeafDefinitions],
  ['Definiciones de casos bloqueados, sin ejecutar',summary.blockedLeafDefinitions],['Nodos bloqueados incluyendo contenedor de instalación',summary.blockedNodes],
])+'\n\n'+table(['Batería (último intento)','Salida','Aprobados/fallidos/omitidos (nodos Node)','Integridad de filas existentes'],[...latest.values()].map(r=>{
  const c=counts(r.events.filter(e=>e.details?.type!=='suite'&&e.type!=='test:summary'));
  return [r.batch,r.blocked?r.error:r.exit,`${c.passed}/${c.failed}/${c.skipped}`,r.integrity?.equal??'No utiliza MySQL'];
}))+'\n\nEl primer intento de ASESOR tuvo una aserción nueva incorrecta: esperaba un contacto sin los campos opcionales email/direccion que el contrato normaliza a null. Node informó dos fallos: esa subprueba y su contenedor. Se corrigió exclusivamente la expectativa del test y se repitió la batería completa con éxito. El TAP, eventos y comprobación de integridad del intento fallido se conservan; no se atribuye ese fallo a producción.\n\n### Casos bloqueados individualmente\n\n'+table(['Archivo:línea','Prueba','Tipo','Motivo'],blocked.map(d=>[`${d.file}:${d.line}`,d.name,isDefinitionContainer(d)?'Contenedor':'Caso',d.reason]))+'\n\n### Comandos reproducibles\n\nLos archivos `*-comando.json` conservan argumentos y entorno no secreto. Deben mantenerse las credenciales privadas fuera de los logs.\n\n'+[...latest.values()].filter(r=>r.command).map(r=>`**${r.batch}:**\n\n\`\`\`bash\n`+Object.entries(r.command.environment).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join(' ')+' '+[r.command.executable,...r.command.args].map(v=>JSON.stringify(v)).join(' ')+'\n```').join('\n\n'));
sections.push('## 12. Conclusión, limitaciones y entrega\n\n'+
  (Object.values(scenarioStates).every(s=>s.passed)?'Los seis escenarios cuentan con registros de aceptación en la última batería aprobada; el estado de las baterías y sus intentos se informa por separado.':'No están acreditados todos los escenarios.')+
  '\n\n**No se declara ejecución total del backend.** Permanecen bloqueadas individualmente las pruebas de mecanismos con DDL permanente, importación SIGEC y aceptación de instalación. El caso de rollback sobre catálogo vacío de instalación tampoco se reemplaza por una prueba similar.\n\nLas suites HTTP con dobles no acreditan persistencia MySQL; el correo simulado no acredita entrega SMTP. El ciclo sobre tablas temporales no acredita las FK, verificadas separadamente por las suites de esquema. No hubo modificaciones de lógica productiva, frontend, commits, push ni despliegues.\n\nEl estado inicial de Git se conserva en `00-estado-inicial.json`. La corrección previa de instalación se preserva mediante su SHA-256. La sincronización del TXT oficial y su verificación byte a byte se registran por separado en `verificacion-txt.json`; los archivos exactos propuestos para commit figuran en `propuesta-commit.md`.');
const annex=path.join(base,'ANEXO_EVIDENCIAS_REALES_MYSQL_MATISTA.md');
await writeFile(annex,sections.join('\n\n')+'\n',{mode:0o600});
await save('estado-escenarios.json',scenarioStates);
if(process.argv.includes('--sync-txt')) {
  const official='/home/yurlian/Documentos/exportacion_verificada_SPEC05_3192d84_8696aeb/Sivira_codigo_backend_01.txt';
  const frontend=path.join(path.dirname(official),'sivira_codigo_frontend_02.txt');
  const frontendBefore=hash(await readFile(frontend));
  let priorVerification=null;
  try { priorVerification=await json(path.join(out,'verificacion-txt.json')); } catch(e) { if(e.code!=='ENOENT')throw e; }
  const previous=await readFile(official);
  const blocks=new Map();
  const delimiter=/^===== INICIO ARCHIVO: (.+?) =====\n/gm;
  const text=previous.toString('utf8');
  for(const m of text.matchAll(delimiter)) {
    const start=m.index+m[0].length;
    const end=text.indexOf(`\n===== FIN ARCHIVO: ${m[1]} =====`,start);
    assert.ok(end>=start,`Delimitación incompleta: ${m[1]}`);
    assert.ok(!blocks.has(m[1]),`Bloque duplicado: ${m[1]}`);
    blocks.set(m[1],Buffer.from(text.slice(start,end)));
  }
  assert.ok(blocks.size>=196,'Exportación oficial incompleta: detener sincronización');
  const additions=['tests/helpers/evidence.js',...await readdir(path.join(root,'tests/evidence')).then(names=>names.filter(n=>n.endsWith('.js')).map(n=>'tests/evidence/'+n))];
  const names=[...new Set([...blocks.keys(),...additions])].sort();
  const changed=[];
  let header=text.slice(0,text.indexOf('===== INICIO ARCHIVO:'))
    .replace(/^COMMIT(?: BASE)?:.*$/m,`COMMIT BASE: ${initial['Matista-backend'].head.trim()}`)
    .replace(/^ARCHIVOS TEXTUALES:.*$/m,`ARCHIVOS TEXTUALES: ${names.length}`)
    .replace(/^CONTENIDO:.*$/m,'CONTENIDO: bytes literales del árbol de trabajo seleccionado; UTF-8 sin normalización.');
  if(!header.includes('ESTADO:'))header+='ESTADO: cambios locales de pruebas/auxiliares SPEC-06 sin commit; corrección previa de instalación conservada.\n\n';
  const parts=[Buffer.from(header)];
  for(const name of names) {
    assert.ok(!name.includes('..')&&!path.isAbsolute(name));
    const bytes=await readFile(path.join(root,name));
    assert.equal(Buffer.from(bytes.toString('utf8')).compare(bytes),0,`Archivo no UTF-8: ${name}`);
    if(!blocks.has(name)||!blocks.get(name).equals(bytes))changed.push(name);
    parts.push(Buffer.from(`===== INICIO ARCHIVO: ${name} =====\n`),bytes,Buffer.from(`\n===== FIN ARCHIVO: ${name} =====\n\n`));
  }
  const generated=Buffer.concat(parts);
  await writeFile(official,generated);
  // Segunda lectura independiente: extraer desde bytes y comparar cada archivo completo.
  const actual=await readFile(official);let identical=0;
  for(const name of names) {
    const begin=Buffer.from(`===== INICIO ARCHIVO: ${name} =====\n`);
    const start=actual.indexOf(begin)+begin.length;
    const end=actual.indexOf(Buffer.from(`\n===== FIN ARCHIVO: ${name} =====`),start);
    assert.ok(end>=start);assert.ok(actual.subarray(start,end).equals(await readFile(path.join(root,name))),`Diferencia de exportación: ${name}`); identical++;
  }
  assert.equal(hash(await readFile(frontend)),frontendBefore,'Frontend TXT debe permanecer intacto');
  await save('verificacion-txt.json',{official,included:names.length,identical,missing:0,different:0,extra:0,changed,
    previousSha256:hash(previous),sha256:hash(actual),frontendSha256:frontendBefore,frontendUnchanged:true,
    originalSha256:priorVerification?.originalSha256??priorVerification?.previousSha256??hash(previous),
    history:[...(priorVerification?.history??(priorVerification?[{previousSha256:priorVerification.previousSha256,sha256:priorVerification.sha256}]:[])),
      {at:new Date().toISOString(),previousSha256:hash(previous),sha256:hash(actual)}],
    scope:'Bloques anteriores + auxiliares SPEC06; excluye docs no rastreados, .env, node_modules y connection.js.save. No se crearon TXT alternativos.'});
}
const artifacts=[];
async function hashes(dir) {
  for(const e of await readdir(dir,{withFileTypes:true})) {
    const p=path.join(dir,e.name);
    if(e.isDirectory())await hashes(p);
    else if(e.name!=='huellas-artefactos.json')artifacts.push({file:path.relative(base,p),sha256:hash(await readFile(p))});
  }
}
await hashes(out); artifacts.push({file:path.basename(annex),sha256:hash(await readFile(annex))});
await save('huellas-artefactos.json',artifacts);
console.log(JSON.stringify({annex,files:summary.files,nodeTests:summary.nodeTests,cases:summary.cases,blockedLeafDefinitions:summary.blockedLeafDefinitions},null,2));

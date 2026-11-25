import { Chart, BarController, BarElement, CategoryScale, LinearScale, Tooltip } from 'chart.js';
import { money, todayISO, escapeHTML as esc } from './domain.js';
import { icon } from './icons.js';
import { enhanceControls } from './controls.js';
import { defaultPlanning, normalizePlanning, planningProjection } from './planning.js';
import { scenarioOperations, newDistributionOperation, aggregateDistributionPeople, simulateDistribution, operationMaximum } from './distribution.js';
import { validatePlanningExtensions } from './distribution-state.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip);
const KINDS={salary:'Nómina',administrator:'Retribución de administradora',professional:'Factura profesional',dividend:'Dividendo',expense:'Gasto de empresa','legacy-work':'Retribución por clasificar'};
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const amount=n=>finite(n)?money(n):'Por confirmar';
const shortMoney=n=>new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR',minimumFractionDigits:0,maximumFractionDigits:0,useGrouping:'always'}).format(n);
const percent=n=>finite(n)?new Intl.NumberFormat('es-ES',{maximumFractionDigits:1}).format(n)+' %':'Por confirmar';
const numeric=value=>{const n=Number(String(value??'').replace(',','.'));if(!Number.isFinite(n))throw new Error('Introduce un importe numérico válido.');return Math.round(n*100)/100;};
const clone=value=>structuredClone(value);
const dateLabel=date=>/^\d{4}-\d{2}-\d{2}$/.test(date||'')?date.split('-').reverse().join('/'):'Sin fecha';
const field=(label,name,value='',type='text',extra='',labelClass='')=>`<label class="field${labelClass?' '+esc(labelClass):''}"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(String(value??''))}" ${extra}></label>`;
const select=(label,name,options,value,extra='')=>`<label class="field"><span>${esc(label)}</span><select name="${esc(name)}" ${extra}>${options.map(([key,label])=>`<option value="${esc(String(key))}" ${String(key)===String(value)?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
const plainLegacy=draft=>({id:draft.id,name:draft.name,people:clone(draft.people||[]),dividendDate:draft.dividendDate||null,notes:draft.notes||''});
const readPlanning=(state,today)=>normalizePlanning(state.planning??defaultPlanning({today}),{today});
const extensions=state=>clone(state.planningExtensions||{version:1,people:[],scenarios:[]});
const emptyScenario=p=>({id:crypto.randomUUID(),name:'Escenario nuevo',people:p.settings.people.map(person=>({personId:person.id,workGross:0,dividendGross:0})),dividendDate:null,notes:'',operations:[]});
function ensureDraft(state,p,session){
  if(!session.draft)session.draft=emptyScenario(p);
  if(!Array.isArray(session.draft.operations))session.draft.operations=scenarioOperations(state,session.draft,p.settings);
  return session.draft;
}
function zeroScenario(p){return {id:'distribution-baseline',name:'No hacer nada',people:p.settings.people.map(person=>({personId:person.id,workGross:0,dividendGross:0})),dividendDate:null,notes:'',operations:[]};}
const simulation=(projection,scenario,p,ext)=>simulateDistribution(projection,scenario,p.settings,ext.people||[]);
const allIssues=result=>[...new Set([...(result.issues||[]),...(result.warnings||[])])];
const netTotal=result=>finite(result.personalNetTotal??result.totalPersonalNet)?result.companyRetained+(result.personalNetTotal??result.totalPersonalNet):null;
const personRows=result=>result.people||result.simulation?.people||[];
const totalSocial=result=>result.socialCostsTotal??result.simulation?.employerCosts??0;

export function distributionAccessibleTable(bars=[],id='distribution-data'){
  return `<details class="dist-accessible"><summary>Ver cifras del gráfico</summary><div class="table-scroll"><table id="${esc(id)}"><caption class="sr-only">Importes de la distribución: bruto, neto, impuestos y cotizaciones</caption><thead><tr><th>Concepto</th><th>Bruto / base</th><th>Neto / uso</th><th>Impuestos</th><th>Cotizaciones</th><th>Tipo efectivo</th></tr></thead><tbody>${bars.map(bar=>`<tr><th scope="row">${esc(bar.label)}</th><td>${esc(amount(bar.gross))}</td><td>${bar.known===false?'Por confirmar':esc(amount(bar.net))}${bar.kind==='expense'?' · uso de empresa':''}</td><td>${esc(amount(bar.tax))}</td><td>${esc(amount(bar.socialCosts))}</td><td>${esc(percent(bar.effectiveRate))}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function legend(result={}){return '<div class="dist-chart-legend"><span><i></i>Neto / usos de empresa</span><span><i class="is-tax"></i>Impuestos</span>'+((result.bars||[]).some(bar=>bar.socialCosts>0)?'<span><i class="is-social"></i>Cotizaciones</span>':'')+((result.bars||[]).some(bar=>bar.known===false)?'<span><i class="is-pending"></i>Por confirmar</span>':'')+((result.bars||[]).some(bar=>bar.loss>0)?'<span><i class="is-loss"></i>Pérdida</span>':'')+'</div>';}
function graphPanel(result,{base=false,title,subtitle,id}){
  return `<article class="dist-panel ${base?'is-base':'is-editable'}"><div class="dist-panel-heading"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div></div>${base?`<div class="dist-graph-column"><div class="dist-chart-scroll"><div class="dist-chart-box is-base"><canvas id="${id}" role="img" aria-label="${esc(title)}: netos por encima de cero e impuestos por debajo">Consulta las cifras accesibles del gráfico.</canvas></div></div>${legend(result)}<div data-dist-reference-table>${distributionAccessibleTable(result.bars,`${id}-data`)}</div></div>`:`<div class="dist-editor-layout"><div class="dist-graph-column"><div class="dist-chart-scroll"><div class="dist-chart-box" data-dist-chart-width><canvas id="${id}" role="img" aria-label="Distribución editable por empresa y operación: netos positivos e impuestos negativos">Consulta las cifras accesibles del gráfico.</canvas></div></div>${legend(result)}<p class="dist-chart-hint">Misma escala que el escenario de referencia. Los importes sin tratamiento fiscal confirmado se muestran como brutos pendientes.</p><div data-dist-editable-table>${distributionAccessibleTable(result.bars,`${id}-data`)}</div></div><aside class="dist-controls" aria-label="Operaciones del escenario"><div data-dist-operations></div><button class="dist-add-button" type="button" data-dist-action="toggle-add">${icon('plus')}Agregar dato</button><form class="dist-add-form" id="distribution-add-form" hidden>${select('Qué quieres añadir','kind',Object.entries(KINDS).filter(([kind])=>kind!=='legacy-work'),'administrator')}${select('Persona','personId',[],'')}<p class="field-hint" data-dist-add-help></p><button class="button primary" type="submit">Añadir operación</button></form></aside></div>`}</article>`;
}

function summaryColumn(label,result,current=false){
  return `<div class="dist-summary-column"><span class="dist-summary-label ${current?'is-current':''}">${esc(label)}</span><div class="dist-summary-row is-main"><span>Impuestos totales</span><strong>${esc(amount(result.taxTotal))}</strong></div><div class="dist-summary-row is-main"><span>Neto conjunto<small>Empresa y personas</small></span><strong>${esc(amount(netTotal(result)))}</strong></div><div class="dist-summary-row"><span>Tipo efectivo global</span><strong>${esc(percent(finite(result.taxTotal)&&result.baseProfit>0?result.taxTotal/result.baseProfit*100:null))}</strong></div>${totalSocial(result)>0?`<div class="dist-summary-row"><span>Cotizaciones aparte</span><strong>${esc(amount(totalSocial(result)))}</strong></div>`:''}</div>`;
}
function summaryHTML(reference,current,p,referenceName){
  const delta=finite(reference.taxTotal)&&finite(current.taxTotal)?current.taxTotal-reference.taxTotal:null;
  return `<section class="dist-summary"><div class="dist-summary-heading">${icon('report')}<div><h2>Resumen de la simulación</h2><p>Compara dónde queda el dinero y el coste fiscal de cada decisión.</p></div></div>${summaryColumn(referenceName,reference)}${summaryColumn('Con distribución',current,true)}<div class="dist-summary-save"><button class="button primary" data-dist-action="save">${icon('check')}Guardar escenario</button><div class="dist-delta">${delta===null?'<span>Completa los datos fiscales para comparar.</span>':`<strong>${esc(money(Math.abs(delta)))}</strong><span>${delta>0?'más de impuestos':delta<0?'menos de impuestos':'de diferencia fiscal'}</span>`}</div></div></section><section class="dist-summary-extra" aria-label="Dinero por destino"><div><span>Permanece en la empresa</span><strong>${esc(amount(current.companyRetained))}</strong><p>Incluye la reserva legal que corresponda.</p></div>${p.settings.people.map(person=>{const row=personRows(current).find(row=>row.id===person.id);return `<div><span>Neto para ${esc(person.name)}</span><strong>${esc(amount(row?.personalNet))}</strong><p>Después del IRPF estimado.</p></div>`;}).join('')}<div><span>Caja tras pagos y reservas</span><strong>${esc(amount(current.cashAfterDistributions))}</strong><p>Antes del colchón adicional indicado.</p></div>${current.otherCosts>0?`<div><span>Otros usos de la empresa</span><strong>${esc(amount(current.otherCosts))}</strong><p>Gastos simulados; no son neto personal.</p></div>`:''}</section>`;
}

function operationsHTML(draft,p,projection,ext,result){
  if(!draft.operations.length)return '<div class="dist-controls-empty">Empiezas igual que el escenario base. Añade una retribución, un dividendo o un gasto para ver cómo cambia la distribución.</div>';
  return draft.operations.map(op=>{
    const person=p.settings.people.find(row=>row.id===op.personId),bar=(result.bars||[]).find(row=>row.id===op.id);
    let max=0;try{max=operationMaximum(projection,draft,p.settings,ext.people||[],op.id);}catch{max=0;}
    max=Math.max(0,finite(max)?max:0);
    const baseAmount=['professional','expense'].includes(op.kind);
    return `<section class="dist-operation" data-dist-operation="${esc(op.id)}"><div class="dist-operation-top"><input class="dist-operation-label" type="text" maxlength="200" value="${esc(op.label)}" aria-label="Nombre de la operación" data-dist-op="${esc(op.id)}" data-field="label"><button class="icon-btn" data-dist-action="remove-operation" data-id="${esc(op.id)}" aria-label="Eliminar ${esc(op.label)}">${icon('close')}</button></div><p class="dist-operation-kind">${esc(KINDS[op.kind])}${person?' · '+esc(person.name):''}</p><div class="dist-operation-amount"><label for="dist-amount-${esc(op.id)}">${baseAmount?'Importe sin IVA':'Importe bruto'}</label><span><input id="dist-amount-${esc(op.id)}" type="number" min="0" max="${max}" step="0.01" value="${op.amount}" data-dist-op="${esc(op.id)}" data-field="amount" aria-label="${baseAmount?'Base':'Bruto'} de ${esc(op.label)}">€</span></div><input class="dist-range" type="range" min="0" max="${max}" step="1" value="${Math.min(max,op.amount)}" data-dist-range="${esc(op.id)}" aria-label="Ajustar ${esc(op.label)}"><p class="dist-limit" data-dist-limit="${esc(op.id)}">Hasta ${esc(money(max))} dentro de este presupuesto.</p><div class="dist-net-value"><span>${op.kind==='expense'?'Uso de empresa':'Neto estimado'}</span><strong data-dist-net="${esc(op.id)}">${bar?.known===false?'Por confirmar':esc(amount(bar?.net))}</strong></div><details class="dist-operation-settings"><summary>Opciones fiscales</summary>${select('Tipo de pago',`kind-${op.id}`,Object.entries(KINDS),op.kind,`data-dist-op="${esc(op.id)}" data-field="kind"`)}${op.kind!=='expense'?select('Persona',`person-${op.id}`,p.settings.people.map(row=>[row.id,row.name]),op.personId,`data-dist-op="${esc(op.id)}" data-field="personId"`):''}<label class="dist-checkbox"><input type="checkbox" ${op.deductible?'checked':''} data-dist-op="${esc(op.id)}" data-field="deductible" ${op.kind==='dividend'?'disabled':''}>Deducible para la empresa</label>${['salary','administrator','professional','legacy-work'].includes(op.kind)?`<label class="dist-checkbox"><input type="checkbox" ${op.taxTreatmentConfirmed?'checked':''} data-dist-op="${esc(op.id)}" data-field="taxTreatmentConfirmed">Tratamiento del pago revisado para esta simulación</label>`:''}${['salary','administrator','professional','legacy-work'].includes(op.kind)?`${field('Cotización personal (%)',`employee-${op.id}`,op.employeeSSRate,'number',`min="0" max="100" step="0.01" data-dist-op="${esc(op.id)}" data-field="employeeSSRate"`)}${field('Cotización empresarial (%)',`employer-${op.id}`,op.employerSSRate,'number',`min="0" max="100" step="0.01" data-dist-op="${esc(op.id)}" data-field="employerSSRate"`)}`:''}${op.kind!=='expense'?field('Retención al pagar (%, opcional)',`withhold-${op.id}`,op.withholdingRate??'','number',`min="0" max="100" step="0.01" data-dist-op="${esc(op.id)}" data-field="withholdingRate"`):''}${baseAmount?field('IVA de la operación (%, opcional)',`vat-${op.id}`,op.vatRate??'','number',`min="0" max="100" step="0.01" data-dist-op="${esc(op.id)}" data-field="vatRate"`):''}<p class="dist-operation-note">${baseAmount?'El IVA afecta a caja y se muestra separado del beneficio y del neto personal. ':''}La retención es un adelanto del impuesto, no otro impuesto añadido.</p></details></section>`;
  }).join('');
}

function peopleSettings(settings,peopleExtensions,usedPeople){
  return settings.people.map((person,index)=>{
    const region=peopleExtensions.find(row=>row.personId===person.id)?.taxRegion||'catalonia',used=usedPeople.has(person.id);
    return `<section class="dist-person-settings" data-dist-person-index="${index}"><div class="dist-person-heading"><h3>${esc(person.name)}</h3><button class="icon-btn" type="button" data-dist-action="remove-person" data-index="${index}" aria-label="Eliminar persona ${esc(person.name)}" ${used||settings.people.length<=1?'disabled title="Esta persona está utilizada en una operación"':''}>${icon('close')}</button></div>${field('Nombre',`person.${index}.name`,person.name,'text','required maxlength="120"')}${select('Residencia fiscal',`person.${index}.taxRegion`,[['catalonia','Cataluña'],['other','Otra · requiere cálculo específico']],region)}<div class="form-grid">${field('Participación simulada (%)',`person.${index}.sharePercent`,person.sharePercent,'number','min="0" max="100" step="0.01" required')}${select('Cuota RETA',`person.${index}.retaPeriod`,[['initial','Primer período reducido'],['extension','Prórroga'],['ordinary','Ordinaria']],person.retaPeriod)}</div><label class="dist-checkbox"><input type="checkbox" name="person.${index}.isShareholder" ${person.isShareholder?'checked':''}>Tiene derecho a dividendos como socia</label><details class="dist-profile-fiscal"><summary>Perfil fiscal personal</summary><label class="dist-checkbox"><input type="checkbox" name="person.${index}.taxProfileKnown" ${person.taxProfileKnown?'checked':''}>Datos personales revisados para este ejercicio</label><div class="form-grid">${field('Sueldo bruto de otros empleos (€)',`person.${index}.externalSalary`,person.externalSalary,'number','min="0" step="0.01" required')}${field('Cotizaciones personales ya previstas (€)',`person.${index}.employeeSS`,person.employeeSS,'number','min="0" step="0.01" required')}${field('RETA personal anual deducible (€)',`person.${index}.retaAnnual`,person.retaAnnual,'number','min="0" step="0.01" required')}${field('Otras rentas generales netas (€)',`person.${index}.otherGeneralIncome`,person.otherGeneralIncome,'number','min="0" step="0.01" required')}${field('Gasto general del trabajo (€)',`person.${index}.employmentExpense`,person.employmentExpense,'number','min="0" step="0.01" required')}${field('Otras rentas del ahorro (€)',`person.${index}.otherSavings`,person.otherSavings,'number','min="0" step="0.01" required')}${field('Tipo empresarial habitual (%)',`person.${index}.employerContributionRate`,person.employerContributionRate,'number','min="0" max="100" step="0.01" required')}${field('Año de revisión RETA',`person.${index}.retaYear`,person.retaYear,'number','min="1900" max="2200" step="1" required')}</div></details></section>`;
  }).join('');
}

function usedPersonIds(state,draft){
  return new Set([...[...(draft.operations||[]),...(state.planningExtensions?.scenarios||[]).flatMap(row=>row.operations||[])].filter(op=>op.personId).map(op=>op.personId),...(state.planning?.scenarios||[]).flatMap(row=>(row.people||[]).filter(person=>person.workGross>0||person.dividendGross>0).map(person=>person.personId))]);
}

function settingsHTML(state,p,ext,draft){
  return `<details class="dist-settings" id="distribution-settings"><summary>Datos de la empresa y perfiles personales</summary><p class="dist-settings-copy">Cada persona tiene sus propios ingresos y circunstancias. Los datos de esta simulación se comparten con las personas autorizadas de la empresa.</p><form id="distribution-settings-form"><div class="form-grid">${field('Beneficio de partida aportado (opcional)','profitOverride',p.settings.profitOverride??'','number','step="0.01" placeholder="Usar cierre y registros de la aplicación"')}${field('Saldo de caja aportado (opcional)','cashBalanceOverride',p.settings.cashBalanceOverride??'','number','step="0.01" placeholder="Usar los registros de caja"')}${field('Tipo de Sociedades a simular (%)','corporateTaxRate',p.settings.corporateTaxRate,'number','min="0" max="35" step="0.01" required')}${field('Reserva legal pendiente (€)','legalReservePending',p.settings.legalReservePending,'number','min="0" step="0.01" required')}${field('Colchón mínimo de caja (€)','minimumCash',p.settings.minimumCash,'number','min="0" step="0.01" required')}${field('Fecha de corte de los datos','asOf',p.settings.asOf,'date','required')}${field('Previsión hasta','horizon',p.settings.horizon,'date','required')}</div><label class="dist-checkbox"><input type="checkbox" name="corporateTaxConfirmed" ${p.settings.corporateTaxConfirmed?'checked':''}>Tipo de Sociedades confirmado con el gestor</label><p class="dist-advanced-shared">Las participaciones se indican para simular un reparto. No formalizan una entrada en el capital. Las regiones y perfiles todavía no soportados mantienen el IRPF pendiente.</p><div class="dist-settings-people" data-dist-profiles>${peopleSettings(p.settings,ext.people,usedPersonIds(state,draft))}</div><div class="dist-settings-actions"><button class="button secondary" type="button" data-dist-action="add-person" ${p.settings.people.length>=8?'disabled':''}>${icon('plus')}Agregar persona</button><button class="button primary" type="submit">Guardar datos del cálculo</button></div></form></details>`;
}

function issuesHTML(result){
  const list=allIssues(result);if(!list.length)return '';
  const exceeds=(result.issues||[]).some(text=>/superan el beneficio|supera la caja|dividendos superan|superan el beneficio repartible/i.test(text));
  return `<details class="dist-info ${exceeds?'is-error':''}" ${exceeds?'open':''}><summary>${exceeds?'El reparto supera el presupuesto disponible':'Datos y condiciones por confirmar'} · ${list.length}</summary><ul>${list.map(value=>`<li>${esc(value)}</li>`).join('')}</ul></details>`;
}

export function distributionPage(state,{today=todayISO(),session={draft:null,selectedId:''}}={}){
  try{
    const p=readPlanning(state,today),ext=extensions(state),draft=ensureDraft(state,p,session),projection=planningProjection(state,p,{today});
    const editorPlan={...p,settings:clone(session.settingsDraft||p.settings)},editorExtensions={...ext,people:clone(session.settingsRegions||ext.people)};
    const referenceScenario=p.scenarios.find(row=>row.id===session.compareId),reference=simulation(projection,referenceScenario?{...referenceScenario,operations:scenarioOperations(state,referenceScenario,p.settings)}:zeroScenario(p),p,ext),current=simulation(projection,draft,p,ext),referenceName=referenceScenario?.name||'No hacer nada';
    return `<div class="distribution-page" data-distribution-page><header class="dist-heading"><div class="dist-heading-copy"><div class="dist-heading-icon">${icon('euro')}</div><div><h1>Distribución del beneficio</h1><p>Prueba cómo repartir el beneficio y compara el dinero que queda y los impuestos asociados.</p></div></div><form class="dist-year" id="distribution-year-form">${select('Año fiscal','taxYear',[...new Set([p.settings.taxYear,Number(today.slice(0,4)),Number(today.slice(0,4))+1])].sort().map(year=>[year,String(year)]),p.settings.taxYear)}</form></header><div class="dist-actions">${field('Nombre del escenario','distributionName',draft.name,'text','maxlength="120" required','dist-draft-name')}${select('Recuperar escenario','distributionSaved',[['','Escenario nuevo'],...p.scenarios.map(row=>[row.id,row.name])],session.selectedId||'')}${select('Comparar con','distributionCompare',[['','No hacer nada'],...p.scenarios.map(row=>[row.id,row.name])],session.compareId||'')}<div class="dist-action-buttons"><button class="button secondary" data-dist-action="new">${icon('plus')}Nuevo</button><button class="button secondary" data-dist-action="duplicate">${icon('copy')}Duplicar</button><button class="button secondary" data-dist-action="reset">Restablecer</button><button class="icon-btn" data-dist-action="delete" aria-label="Eliminar escenario guardado" ${session.selectedId?'':'disabled'}>${icon('trash')}</button></div></div><p class="dist-status ${session.dirty?'is-dirty':''}" data-dist-status>${icon('shield')}${session.dirty?'Cambios sin guardar.':'Simulación: no genera nóminas, facturas ni pagos reales.'}</p><section class="dist-layout">${graphPanel(reference,{base:true,title:referenceScenario?'Referencia: '+referenceScenario.name:'Escenario: No hacer nada',subtitle:referenceScenario?'Comparas con este escenario guardado.':'Mantienes el beneficio en la empresa.',id:'distribution-base-chart'})}${graphPanel(current,{title:'Escenario editable',subtitle:'Añade operaciones y ajusta sus importes.',id:'distribution-editable-chart'})}</section><div data-dist-summary>${summaryHTML(reference,current,p,referenceName)}</div><div class="dist-scenario-notes"><div>${field('Fecha prevista del dividendo (opcional)','distributionDividendDate',draft.dividendDate||'','date')}</div><details><summary>Notas del escenario</summary><label class="field"><span>Notas</span><textarea name="distributionNotes" maxlength="2000" rows="2">${esc(draft.notes||'')}</textarea></label></details></div><p class="dist-notes">El neto personal es la estimación final después del impuesto, no necesariamente la transferencia inicial. Los dividendos ordinarios se simulan tras cerrar el ejercicio; su IRPF corresponde al año en que resulten exigibles. Las cotizaciones y el IVA se separan de los impuestos.</p><div data-dist-issues>${issuesHTML(current)}</div>${settingsHTML(state,editorPlan,editorExtensions,draft)}<details class="dist-info"><summary>Fuentes y alcance de la simulación</summary><ul>${(projection.warnings||[]).map(text=>`<li>${esc(text)}</li>`).join('')}<li>La reserva de Sociedades se calcula con el tipo indicado. Para un ejercicio que cierra en diciembre, su presentación es normalmente en julio del año siguiente.</li><li>El total de impuestos puede combinar Sociedades y retribuciones del ejercicio con dividendos exigibles el año siguiente.</li><li>Las retribuciones deben corresponder a servicios reales y tener un tratamiento fiscal revisado; la simulación no sustituye su formalización.</li></ul><p class="field-hint">${(projection.sources||[]).map(source=>`<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.label)}</a>`).join(' · ')}</p></details></div>`;
  }catch(error){return `<div class="distribution-page"><h1>Distribución del beneficio</h1><div class="dist-info is-error">${esc(error.message)}</div></div>`;}
}

export function distributionChartBounds(bars){
  const positive=Math.max(1,...bars.map(bar=>bar.known===false?bar.positive??bar.unknownGross??bar.gross??0:bar.net||0));
  const negative=Math.max(1,...bars.map(bar=>(bar.tax||0)+(bar.socialCosts||0)+(bar.loss||0)));
  const raw=Math.max(positive,negative)/5,power=10**Math.floor(Math.log10(raw));
  const step=([1,2,2.5,5,10].find(value=>value>=raw/power)||10)*power;
  return {max:Math.ceil(positive*1.12/step)*step,min:-Math.ceil(Math.max(positive*.12,negative*1.15)/step)*step,step};
}

export function distributionAxisLabel(bar){
  let text=String(bar.label||'');
  const prefix=KINDS[bar.kind];
  if(prefix&&text.startsWith(prefix+' · '))return [({administrator:'Administradora',professional:'Profesional'}[bar.kind]||prefix),text.slice(prefix.length+3).slice(0,19)];
  const words=text.split(/\s+/),first=[];while(words.length&&(first.join(' ').length+words[0].length<19||!first.length))first.push(words.shift());
  const rest=words.join(' ');return [first.join(' ').slice(0,19),rest.length>19?rest.slice(0,18)+'…':rest];
}

const valuePlugin={id:'orquiviaDistributionValues',afterDatasetsDraw(chart){
  const {ctx,chartArea,scales}=chart,bars=chart.$distributionBars||[];if(!chartArea||!scales.y)return;
  ctx.save();ctx.textAlign='center';ctx.font='600 13px "DM Sans", system-ui, sans-serif';
  const positiveMeta=chart.getDatasetMeta(0),taxMeta=chart.getDatasetMeta(1),socialMeta=chart.getDatasetMeta(2),pendingMeta=chart.getDatasetMeta(3);
  bars.forEach((bar,index)=>{
    const point=positiveMeta.data[index]||pendingMeta.data[index];if(!point)return;
    const positive=bar.known===false?bar.positive??bar.unknownGross??bar.gross:Math.max(0,bar.net||0),top=scales.y.getPixelForValue(positive),zero=scales.y.getPixelForValue(0);
    if(bar.loss>0){const bottom=scales.y.getPixelForValue(-bar.loss);ctx.fillStyle='#a35e68';ctx.fillText('Pérdida '+shortMoney(bar.loss),point.x,Math.min(chartArea.bottom-6,bottom+15));return;}
    ctx.fillStyle='#29213d';ctx.fillText((bar.employerSS>0?'Coste SL ':'')+shortMoney(bar.employerSS>0?bar.companyCost:bar.gross||0),point.x,Math.max(chartArea.top+12,top-13));
    const positiveHeight=Math.abs(zero-top);
    if(positiveHeight>24){ctx.fillStyle=bar.known===false?'#756a89':'#4f416e';ctx.font='500 13px "DM Sans", system-ui, sans-serif';ctx.fillText(bar.known===false?'Por confirmar':shortMoney(bar.net||0),point.x,top+positiveHeight/2+4);}
    if(bar.known!==false&&bar.tax>0){const taxBottom=scales.y.getPixelForValue(-bar.tax),height=Math.abs(taxBottom-zero);if(height>22){ctx.fillStyle='#ffffff';ctx.fillText(shortMoney(bar.tax),point.x,zero+height/2+4);}else{ctx.fillStyle='#51449a';const bottom=scales.y.getPixelForValue(-bar.tax-(bar.socialCosts||0));ctx.fillText(shortMoney(bar.tax),point.x,Math.min(chartArea.bottom-5,bottom+14));}}
    ctx.font='600 13px "DM Sans", system-ui, sans-serif';
  });ctx.restore();
}};

export function distributionChartConfig(result,bounds){
  const bars=result.bars||[];
  return {type:'bar',data:{labels:bars.map(bar=>bar.label),datasets:[
    {label:'Neto / usos de empresa',data:bars.map(bar=>bar.known===false?0:Math.max(0,bar.net||0)),backgroundColor:bars.map(bar=>bar.kind==='expense'?'#b9ac96':'#aaa5df'),borderRadius:5,borderSkipped:false,stack:'distribution',maxBarThickness:115},
    {label:'Impuestos',data:bars.map(bar=>bar.known===false||!bar.tax?0:-bar.tax),backgroundColor:'#51449a',borderRadius:3,borderSkipped:false,stack:'distribution',maxBarThickness:115},
    {label:'Cotizaciones',data:bars.map(bar=>bar.socialCosts?-bar.socialCosts:0),backgroundColor:'#8884aa',borderRadius:3,borderSkipped:false,stack:'distribution',maxBarThickness:115},
    {label:'Bruto pendiente de IRPF',data:bars.map(bar=>bar.known===false?bar.positive??bar.unknownGross??bar.gross??0:0),backgroundColor:'#d9d6e5',borderRadius:5,borderSkipped:false,stack:'distribution',maxBarThickness:115},
    {label:'Pérdida de la empresa',data:bars.map(bar=>bar.loss?-bar.loss:0),backgroundColor:'#bb7d87',borderRadius:4,borderSkipped:false,stack:'distribution',maxBarThickness:115},
  ]},plugins:[valuePlugin],options:{responsive:true,maintainAspectRatio:false,animation:false,layout:{padding:{top:23,right:10,bottom:0,left:0}},interaction:{mode:'index',intersect:false},plugins:{legend:{display:false},tooltip:{filter:item=>item.raw!==0,callbacks:{title:items=>bars[items[0]?.dataIndex]?.label||'',label:item=>{const bar=bars[item.dataIndex];return `${item.dataset.label}: ${money(Math.abs(item.raw))}`;},afterBody:items=>{const bar=bars[items[0]?.dataIndex];return bar?[`Bruto / base: ${amount(bar.gross)}`,`Tipo efectivo: ${percent(bar.effectiveRate)}`,bar.kind==='company'?`Base de Sociedades: ${amount(bar.taxableBase)} · tipo ${percent(bar.statutoryRate)}`:'',bar.employerSS>0?`Cotización empresarial: ${amount(bar.employerSS)}`:'',bar.employeeSS>0?`Cotización personal: ${amount(bar.employeeSS)}`:'',bar.vat?`IVA separado de caja: ${amount(bar.vat)}`:'',bar.transferNet!==null&&bar.transferNet!==undefined?`Transferencia estimada: ${amount(bar.transferNet)}`:''].filter(Boolean):[];}}}},scales:{x:{stacked:true,afterFit:scale=>{scale.height=52;},grid:{display:false},border:{color:'#c5bfda'},ticks:{color:'#777086',font:{size:12},maxRotation:0,minRotation:0,callback(value){return distributionAxisLabel(bars[value]||{label:this.getLabelForValue(value)});}}},y:{stacked:true,min:bounds.min,max:bounds.max,border:{display:false},grid:{color:context=>context.tick.value===0?'#b8b0cf':'#efedf5',lineWidth:context=>context.tick.value===0?1.3:1},ticks:{color:'#858093',font:{size:12},maxTicksLimit:7,stepSize:bounds.step,callback:value=>shortMoney(value)}}}}};
}

export function bindDistribution(root,{getState,commit,toast,today=todayISO(),session={draft:null,selectedId:''}}){
  const scope=root.querySelector('[data-distribution-page]');if(!scope)return Object.assign(()=>{},{hasUnsaved:()=>false});
  const signals=new AbortController(),on=(node,event,fn)=>node?.addEventListener(event,fn,{signal:signals.signal});
  let p=readPlanning(getState(),today),ext=extensions(getState()),draft=ensureDraft(getState(),p,session),projection=planningProjection(getState(),p,{today}),charts=[],controlDisposers=[],frame=0,settingsDirty=Boolean(session.settingsDirty),muting=false;
  let settingsModel=clone(session.settingsDraft||p.settings),regionsModel=clone(session.settingsRegions||ext.people);
  const accessToken=session.distributionAccessToken||crypto.randomUUID();session.distributionAccessToken=accessToken;
  const isCurrentSession=()=>session.distributionAccessToken===accessToken;
  const captureSettings=()=>{settingsDirty=true;session.settingsDirty=true;session.settingsDraft=clone(settingsModel);session.settingsRegions=clone(regionsModel);session.settingsValues=Object.fromEntries(new FormData(scope.querySelector('#distribution-settings-form')));};
  if(session.settingsValues){const form=scope.querySelector('#distribution-settings-form');for(const input of form.elements){if(!input.name)continue;if(input.type==='checkbox')input.checked=Object.hasOwn(session.settingsValues,input.name);else if(Object.hasOwn(session.settingsValues,input.name))input.value=String(session.settingsValues[input.name]);}scope.querySelector('#distribution-settings').open=true;}
  const hasUnsaved=()=>Boolean(session.dirty||settingsDirty);
  const dirty=()=>{session.dirty=true;const status=scope.querySelector('[data-dist-status]');status.classList.add('is-dirty');status.textContent='Cambios sin guardar en este escenario.';};
  on(window,'beforeunload',event=>{if(hasUnsaved()){event.preventDefault();event.returnValue='';}});
  const fiscalPeople=()=>ext.people||[];
  const getCurrent=()=>simulation(projection,draft,p,ext);
  const getReference=()=>{const saved=p.scenarios.find(row=>row.id===session.compareId);return {name:saved?.name||'No hacer nada',result:simulation(projection,saved?{...saved,operations:scenarioOperations(getState(),saved,p.settings)}:zeroScenario(p),p,ext)};};
  const enhanceNew=node=>{controlDisposers.push(enhanceControls(node));};
  const refreshCharts=()=>{
    const reference=getReference(),current=getCurrent(),all=[...(reference.result.bars||[]),...(current.bars||[])];
    const bounds=distributionChartBounds(all);
    const data=[reference.result,current];
    if(!charts.length){for(const [index,id] of ['distribution-base-chart','distribution-editable-chart'].entries()){const canvas=scope.querySelector('#'+id);if(canvas){try{const chart=new Chart(canvas,distributionChartConfig(data[index],bounds));chart.$distributionBars=data[index].bars||[];charts[index]=chart;chart.update('none');}catch(error){canvas.parentElement.innerHTML='<div class="dist-chart-empty">Las cifras están disponibles en el detalle accesible del gráfico.</div>';}}}}
    else charts.forEach((chart,index)=>{if(!chart)return;const config=distributionChartConfig(data[index],bounds);chart.data=config.data;chart.options.scales.x.ticks=config.options.scales.x.ticks;chart.options.plugins.tooltip=config.options.plugins.tooltip;chart.options.scales.y.min=bounds.min;chart.options.scales.y.max=bounds.max;chart.options.scales.y.ticks.stepSize=bounds.step;chart.$distributionBars=data[index].bars||[];chart.update('none');});
    const referenceTitle=scope.querySelector('.dist-panel.is-base h2');if(referenceTitle)referenceTitle.textContent=session.compareId?'Referencia: '+reference.name:'Escenario: No hacer nada';
    const referenceCopy=scope.querySelector('.dist-panel.is-base .dist-panel-heading p');if(referenceCopy)referenceCopy.textContent=session.compareId?'Comparas con este escenario guardado.':'Mantienes el beneficio en la empresa.';
    scope.querySelector('[data-dist-reference-table]').innerHTML=distributionAccessibleTable(reference.result.bars,'distribution-base-chart-data');
    scope.querySelector('[data-dist-editable-table]').innerHTML=distributionAccessibleTable(current.bars,'distribution-editable-chart-data');
    scope.querySelectorAll('.dist-panel .dist-chart-legend').forEach((node,index)=>{node.outerHTML=legend(data[index]);});
    scope.querySelector('[data-dist-summary]').innerHTML=summaryHTML(reference.result,current,p,reference.name);
    scope.querySelector('[data-dist-issues]').innerHTML=issuesHTML(current);
    const chartWidth=scope.querySelector('[data-dist-chart-width]');chartWidth.style.minWidth=Math.max(240,(current.bars?.length||1)*105)+'px';
    for(const op of draft.operations){
      const row=[...scope.querySelectorAll('[data-dist-operation]')].find(node=>node.dataset.distOperation===op.id);if(!row)continue;
      let maximum=0;try{maximum=operationMaximum(projection,draft,p.settings,fiscalPeople(),op.id);}catch{}
      maximum=Math.max(0,finite(maximum)?maximum:0);
      const input=row.querySelector('[data-field="amount"]'),range=row.querySelector('[data-dist-range]');input.max=String(maximum);range.max=String(maximum);range.value=String(Math.min(maximum,op.amount));
      row.querySelector('[data-dist-limit]').textContent=`Hasta ${money(maximum)} dentro de este presupuesto.`;
      const bar=current.bars?.find(bar=>bar.id===op.id);row.querySelector('[data-dist-net]').textContent=bar?.known===false?'Por confirmar':amount(bar?.net);
    }
  };
  const schedule=()=>{if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{frame=0;try{refreshCharts();}catch(error){toast(error.message,true);}});};
  const renderOps=()=>{const current=getCurrent(),container=scope.querySelector('[data-dist-operations]');container.innerHTML=operationsHTML(draft,p,projection,ext,current);enhanceNew(container);refreshCharts();};
  const setDraft=next=>{session.draft=next;draft=next;session.dirty=false;muting=true;scope.querySelector('[name="distributionName"]').value=draft.name;const saved=scope.querySelector('[name="distributionSaved"]');saved.value=session.selectedId||'';saved.dispatchEvent(new Event('change',{bubbles:true}));const date=scope.querySelector('[name="distributionDividendDate"]');date.value=draft.dividendDate||'';date.dispatchEvent(new Event('change',{bubbles:true}));scope.querySelector('[name="distributionNotes"]').value=draft.notes||'';scope.querySelector('[data-dist-action="delete"]').disabled=!session.selectedId;muting=false;scope.querySelector('[data-dist-status]').textContent='Simulación: no genera nóminas, facturas ni pagos reales.';renderOps();};
  const allowDiscard=()=>!session.dirty||window.confirm('¿Descartar los cambios sin guardar de este escenario?');
  const persist=async(change,text)=>{try{return await commit(state=>{change(state);state.planning=normalizePlanning(state.planning,{today});if(state.planningExtensions)state.planningExtensions=validatePlanningExtensions(state.planningExtensions,state.planning);},text);}catch(error){toast(error.message,true);return false;}};
  const save=async()=>{
    if(settingsDirty){toast('Guarda primero los datos del cálculo y los perfiles que has modificado.',true);return;}
    const checked=getCurrent();
    if(!checked.budgetValid||(checked.issues||[]).length){toast(checked.issues?.[0]||'Completa la caja de partida para comprobar el presupuesto del escenario.',true);return;}
    draft.name=scope.querySelector('[name="distributionName"]').value.trim()||'Escenario sin nombre';draft.people=aggregateDistributionPeople(draft.operations,p.settings);
    const legacy=plainLegacy(draft),operations=clone(draft.operations),previousSelected=session.selectedId;session.selectedId=draft.id;session.dirty=false;
    const ok=await persist(state=>{const plan=readPlanning(state,today);plan.scenarios=[legacy,...plan.scenarios.filter(row=>row.id!==legacy.id)];state.planning=plan;const side=extensions(state);side.scenarios=[{scenarioId:legacy.id,operations},...side.scenarios.filter(row=>row.scenarioId!==legacy.id)];state.planningExtensions=side;},'Escenario guardado.');
    if(!ok&&isCurrentSession()){session.selectedId=previousSelected;session.dirty=true;dirty();}
  };
  const updateAddPeople=()=>{const form=scope.querySelector('#distribution-add-form'),kind=form.elements.kind.value,eligible=p.settings.people.filter(person=>kind!=='dividend'||person.isShareholder&&person.sharePercent>0),person=form.elements.personId;person.innerHTML=eligible.map(row=>`<option value="${esc(row.id)}">${esc(row.name)}</option>`).join('');person.closest('.field').hidden=kind==='expense';person.required=kind!=='expense';person.dispatchEvent(new Event('change',{bubbles:true}));const help=scope.querySelector('[data-dist-add-help]');help.textContent=kind==='dividend'&&!eligible.length?'Indica primero la participación de las socias en los datos del cálculo.':kind==='professional'||kind==='expense'?'El importe se introduce sin IVA. El IVA se indica en las opciones fiscales.':'';form.querySelector('button[type="submit"]').disabled=kind!=='expense'&&!eligible.length;};
  on(scope.querySelector('#distribution-add-form').elements.kind,'change',updateAddPeople);
  on(scope.querySelector('#distribution-add-form'),'submit',event=>{event.preventDefault();try{if(settingsDirty){toast('Guarda primero los perfiles y los datos del cálculo.',true);return;}const form=event.currentTarget,kind=form.elements.kind.value,person=p.settings.people.find(row=>row.id===form.elements.personId.value);if(kind!=='expense'&&!person)throw new Error('Guarda primero el perfil de la persona.');const op=newDistributionOperation(kind,kind==='expense'?null:person?.id,{label:kind==='expense'?'Gasto de empresa':`${KINDS[kind]} · ${person.name}`});if(['salary','administrator','professional','legacy-work'].includes(kind))op.employerSSRate=person?.employerContributionRate||0;draft.operations.push(op);dirty();form.hidden=true;renderOps();}catch(error){toast(error.message,true);}});
  on(scope.querySelector('[name="distributionName"]'),'input',event=>{draft.name=event.target.value;dirty();});
  on(scope.querySelector('[name="distributionNotes"]'),'input',event=>{draft.notes=event.target.value;dirty();});
  on(scope.querySelector('[name="distributionDividendDate"]'),'change',event=>{if(!muting){draft.dividendDate=event.target.value||null;dirty();schedule();}});
  on(scope.querySelector('[name="distributionSaved"]'),'change',event=>{if(muting)return;if(!allowDiscard()){muting=true;event.target.value=session.selectedId||'';event.target.dispatchEvent(new Event('change',{bubbles:true}));muting=false;return;}const saved=p.scenarios.find(row=>row.id===event.target.value);session.selectedId=saved?.id||'';setDraft(saved?{...clone(saved),operations:scenarioOperations(getState(),saved,p.settings)}:emptyScenario(p));});
  on(scope.querySelector('[name="distributionCompare"]'),'change',event=>{session.compareId=event.target.value;schedule();});
  on(scope,'input',event=>{
    const input=event.target;if(input.closest('#distribution-settings-form')){captureSettings();return;}
    const opId=input.dataset.distOp||input.dataset.distRange;if(!opId)return;
    const op=draft.operations.find(op=>op.id===opId);if(!op)return;
    const key=input.dataset.distRange?'amount':input.dataset.field;
    try{
      if(key==='amount'){let max=operationMaximum(projection,draft,p.settings,fiscalPeople(),op.id);max=Math.max(0,finite(max)?max:0);op.amount=Math.max(0,Math.min(max,numeric(input.value||0)));const row=input.closest('[data-dist-operation]'),num=row.querySelector('[data-field="amount"]'),range=row.querySelector('[data-dist-range]');if(input===range)num.value=String(op.amount);else if(numeric(input.value||0)>max)num.value=String(op.amount);range.value=String(op.amount);}
      else if(key==='label')op.label=input.value;
      else if(['employeeSSRate','employerSSRate','withholdingRate','vatRate'].includes(key))op[key]=input.value===''&&['withholdingRate','vatRate'].includes(key)?null:Math.max(0,Math.min(100,numeric(input.value||0)));
      else return;
      dirty();schedule();
    }catch(error){toast(error.message,true);}
  });
  on(scope,'change',event=>{
    const input=event.target;if(muting)return;if(input.closest('#distribution-settings-form')){captureSettings();return;}
    const op=draft.operations.find(op=>op.id===input.dataset.distOp);if(!op)return;
    const key=input.dataset.field;
    if(settingsDirty&&['kind','personId'].includes(key)){muting=true;input.value=String(op[key]);input.dispatchEvent(new Event('change',{bubbles:true}));muting=false;toast('Guarda primero los perfiles y los datos del cálculo.',true);return;}
    if(muting)return;
    if(key==='kind'){const replacement=newDistributionOperation(input.value,input.value==='expense'?null:op.personId||p.settings.people[0].id,{label:op.label});if(['salary','administrator','professional','legacy-work'].includes(input.value))replacement.employerSSRate=p.settings.people.find(person=>person.id===replacement.personId)?.employerContributionRate||0;Object.assign(op,replacement,{id:op.id,amount:op.amount});dirty();renderOps();}
    else if(key==='personId'){op.personId=input.value;dirty();schedule();}
    else if(['deductible','taxTreatmentConfirmed'].includes(key)){op[key]=input.checked;dirty();schedule();}
  });
  const readSettings=()=>{
    const form=scope.querySelector('#distribution-settings-form'),data=new FormData(form),settings=clone(settingsModel);
    for(const key of ['profitOverride','cashBalanceOverride'])settings[key]=String(data.get(key)||'').trim()===''?null:numeric(data.get(key));
    for(const key of ['corporateTaxRate','legalReservePending','minimumCash'])settings[key]=numeric(data.get(key));
    settings.asOf=String(data.get('asOf'));settings.horizon=String(data.get('horizon'));settings.corporateTaxConfirmed=data.get('corporateTaxConfirmed')==='on';
    const region=[];
    settings.people=settings.people.map((person,index)=>{const prefix=`person.${index}.`,updated={...person,name:String(data.get(prefix+'name')||'').trim(),isShareholder:data.get(prefix+'isShareholder')==='on',taxProfileKnown:data.get(prefix+'taxProfileKnown')==='on',retaPeriod:String(data.get(prefix+'retaPeriod'))};for(const key of ['externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings','sharePercent','employerContributionRate','retaYear'])updated[key]=numeric(data.get(prefix+key));region.push({personId:person.id,taxRegion:String(data.get(prefix+'taxRegion'))});return updated;});
    return {settings,region};
  };
  on(scope.querySelector('#distribution-settings-form'),'submit',async event=>{event.preventDefault();const previous={settingsDirty:session.settingsDirty,settingsDraft:clone(session.settingsDraft),settingsRegions:clone(session.settingsRegions),settingsValues:clone(session.settingsValues)};try{const {settings,region}=readSettings();settingsDirty=false;for(const key of ['settingsDirty','settingsDraft','settingsRegions','settingsValues'])delete session[key];const ok=await persist(state=>{const plan=readPlanning(state,today);plan.settings=settings;const ids=new Set(settings.people.map(person=>person.id));for(const row of plan.scenarios)row.people=row.people.filter(person=>ids.has(person.personId));state.planning=plan;const side=extensions(state);side.people=region;state.planningExtensions=side;},'Datos del cálculo guardados.');if(!ok&&isCurrentSession()){Object.assign(session,previous);settingsDirty=true;}}catch(error){if(isCurrentSession()){Object.assign(session,previous);settingsDirty=true;}toast(error.message,true);}});
  on(scope.querySelector('#distribution-year-form'),'change',async event=>{if(event.target.name!=='taxYear'||muting)return;if(settingsDirty){muting=true;event.target.value=String(p.settings.taxYear);event.target.dispatchEvent(new Event('change',{bubbles:true}));muting=false;toast('Guarda primero los perfiles y los datos del cálculo.',true);return;}const year=Number(event.target.value);await persist(state=>{const plan=readPlanning(state,today);plan.settings.taxYear=year;if(plan.settings.horizon<`${year}-12-31`)plan.settings.horizon=`${year}-12-31`;state.planning=plan;},'Ejercicio de la simulación actualizado.');});
  on(scope,'click',async event=>{
    const button=event.target.closest('[data-dist-action]');if(!button||!scope.contains(button))return;const action=button.dataset.distAction;
    try{
      if(action==='toggle-add'){const form=scope.querySelector('#distribution-add-form');form.hidden=!form.hidden;if(!form.hidden){updateAddPeople();form.elements.kind.focus();}}
      if(action==='remove-operation'){draft.operations=draft.operations.filter(op=>op.id!==button.dataset.id);dirty();renderOps();}
      if(action==='save')await save();
      if(action==='new'&&allowDiscard()){session.selectedId='';setDraft(emptyScenario(p));}
      if(action==='duplicate'){draft={...clone(draft),id:crypto.randomUUID(),name:(draft.name||'Escenario')+' · copia'};session.selectedId='';setDraft(draft);dirty();}
      if(action==='reset'&&(!draft.operations.length||window.confirm('¿Restablecer todas las operaciones a cero?'))){for(const op of draft.operations)op.amount=0;dirty();renderOps();}
      if(action==='delete'&&session.selectedId&&window.confirm('¿Eliminar este escenario guardado?')){const id=session.selectedId,previous={draft:clone(draft),selectedId:session.selectedId,dirty:session.dirty,compareId:session.compareId};session.selectedId='';session.draft=null;session.dirty=false;if(session.compareId===id)session.compareId='';const ok=await persist(state=>{const plan=readPlanning(state,today);plan.scenarios=plan.scenarios.filter(row=>row.id!==id);state.planning=plan;const side=extensions(state);side.scenarios=side.scenarios.filter(row=>row.scenarioId!==id);state.planningExtensions=side;},'Escenario eliminado.');if(!ok&&isCurrentSession()){Object.assign(session,previous);draft=session.draft;}}
      if(action==='add-person'){
        const {settings,region}=readSettings();if(settings.people.length>=8)return;settingsModel=settings;regionsModel=region;const prototype=defaultPlanning({today}).settings.people[0],person={...clone(prototype),id:crypto.randomUUID(),name:`Persona ${settings.people.length+1}`};settingsModel.people.push(person);regionsModel.push({personId:person.id,taxRegion:'catalonia'});const container=scope.querySelector('[data-dist-profiles]');container.innerHTML=peopleSettings(settingsModel,regionsModel,usedPersonIds(getState(),draft));enhanceNew(container);captureSettings();scope.querySelector('[data-dist-action="add-person"]').disabled=settingsModel.people.length>=8;
      }
      if(action==='remove-person'){
        const {settings,region}=readSettings(),person=settings.people[Number(button.dataset.index)];if(!person||usedPersonIds(getState(),draft).has(person.id)||settings.people.length<=1)return;settingsModel={...settings,people:settings.people.filter(row=>row.id!==person.id)};regionsModel=region.filter(row=>row.personId!==person.id);const container=scope.querySelector('[data-dist-profiles]');container.innerHTML=peopleSettings(settingsModel,regionsModel,usedPersonIds(getState(),draft));enhanceNew(container);captureSettings();scope.querySelector('[data-dist-action="add-person"]').disabled=false;
      }
    }catch(error){toast(error.message,true);}
  });
  updateAddPeople();renderOps();
  const cleanup=()=>{signals.abort();if(frame)cancelAnimationFrame(frame);charts.forEach(chart=>chart?.destroy());controlDisposers.forEach(dispose=>dispose());};cleanup.hasUnsaved=hasUnsaved;return cleanup;
}

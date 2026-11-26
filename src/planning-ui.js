import { money, todayISO, escapeHTML as esc } from './domain.js';
import { icon } from './icons.js';
import { defaultPlanning, normalizePlanning, planningProjection, simulatePlanningScenario, suggestForecastItems } from './planning.js';
import { forecastLedger } from './forecast-ledger.js';
import { forecastMatrix, forecastTreasuryChart, forecastVATPanel, forecastReviewPanel, forecastCellDialog } from './forecast-ui.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) ? money(value) : 'Por completar';
const number = value => { const n=Number(String(value??'').replace(',','.')); if(!Number.isFinite(n))throw new Error('Revisa los importes del formulario.');return Math.round(n*100)/100; };
const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? value.split('-').reverse().join('/') : 'Sin fecha';
const message = value => typeof value === 'string' ? value : value?.message||value?.label||value?.description||'';
const clone = value => structuredClone(value);
const nextForecastDate = value => { const date=new Date(value+'T00:00:00Z');date.setUTCDate(date.getUTCDate()+1);return date.toISOString().slice(0,10); };
const loadPlanning = (state,today) => normalizePlanning(state.planning??defaultPlanning({today}),{today});
const field = (label,name,value='',type='text',extra='') => `<label class="field"><span>${esc(label)}</span><input name="${esc(name)}" type="${type}" value="${esc(String(value??''))}" ${extra}></label>`;
const select = (label,name,options,value,extra='') => `<label class="field"><span>${esc(label)}</span><select name="${esc(name)}" ${extra}>${options.map(([key,label])=>`<option value="${esc(String(key))}" ${String(value)===String(key)?'selected':''}>${esc(label)}</option>`).join('')}</select></label>`;
const cadence = {once:'Una vez',monthly:'Cada mes',quarterly:'Cada trimestre',yearly:'Cada año'};
const treatment = {operating:'Gasto corriente',asset:'Compra de equipo / inversión',tax:'Impuesto',transfer:'Traspaso / financiación'};
const tabs = page => `<nav class="planning-tabs" aria-label="Planificación"><a href="#prevision" ${page==='forecast'?'aria-current="page"':''}>${icon('clock')}Previsión</a><a href="#escenarios" ${page==='scenarios'?'aria-current="page"':''}>${icon('report')}Escenarios</a></nav>`;
const notice = (title,copy,kind='') => `<div class="planning-banner ${kind}" role="note">${icon('info')}<div><strong>${esc(title)}</strong><p>${esc(copy)}</p></div></div>`;
const issues = (values,kind='') => (values||[]).filter(value=>message(value)).length ? `<ul class="planning-issues ${kind}">${values.filter(value=>message(value)).map(value=>`<li>${icon('info')}<span>${esc(message(value))}</span></li>`).join('')}</ul>` : '';
const metric = (label,value,copy) => `<article class="planning-metric"><span>${esc(label)}</span><strong>${esc(amount(value))}</strong><small>${esc(copy)}</small></article>`;
const dateValue = row => row.date||row.expectedDate||row.collectionDate||row.dueDate||'';
const amountValue = row => row.amount??row.remaining??row.grossRemaining??row.outstanding??row.amountGross??0;
const rowID = row => row.id||row.documentId||'';
const rowLabel = row => row.label||row.number||row.description||'Documento pendiente';

function horizonForm(p) {
  return `<form class="card planning-controls" id="planning-horizon-form">${field('Previsión a partir del','asOf',p.settings.asOf,'date','required')}${field('Hasta el','horizon',p.settings.horizon,'date','required')}<button class="button secondary" type="submit">Actualizar horizonte</button></form>`;
}

/** Native SVG charts preserve text sizes instead of scaling a screenshot. */
export function planningCashChart(monthly=[],{width=900}={}) {
  if(!monthly.length)return '<div class="planning-month-empty">Añade una previsión para ver cómo cambia tu dinero en los próximos meses.</div>';
  const rows=monthly.slice(0,121),W=Math.max(200,width),H=290,left=60,right=18,top=25,bottom=45,plotW=W-left-right,plotH=H-top-bottom;
  const max=Math.max(1,...rows.flatMap(row=>[row.closingCash||0,row.inflows||0]));
  const maxOut=Math.max(0,...rows.map(row=>row.outflows||0));
  const minCash=Math.min(0,...rows.map(row=>row.closingCash||0));
  const min=Math.min(-maxOut*1.15,minCash*1.15),upper=max*1.16,span=upper-min;
  const y=value=>top+(upper-value)/span*plotH,step=plotW/rows.length,bar=Math.min(27,step*.22),zero=y(0);
  const points=rows.map((row,index)=>finite(row.closingCash)?[left+step*(index+.5),y(row.closingCash),index]:null).filter(Boolean);
  const labels=Math.max(1,Math.ceil(rows.length/Math.max(1,Math.floor(plotW/75))));
  const currencyShort=n=>Math.abs(n)>=1000?`${new Intl.NumberFormat('es-ES',{maximumFractionDigits:1}).format(n/1000)} mil €`:`${new Intl.NumberFormat('es-ES',{maximumFractionDigits:Math.abs(n)<10?1:0}).format(n)} €`;
  const ticks=[0,max*.5,max];
  const bars=rows.map((row,index)=>{
    const x=left+step*(index+.5),incoming=Math.max(0,row.inflows||0),outgoing=Math.max(0,row.outflows||0),m=String(row.month||'').slice(0,7);
    const label=/^\d{4}-\d{2}$/.test(m)?new Intl.DateTimeFormat('es-ES',{month:'short',year:rows.length>12?'2-digit':undefined,timeZone:'UTC'}).format(new Date(m+'-01T12:00:00Z')):m;
    return `<g><title>${esc(m)}: entradas ${esc(money(incoming))}, salidas ${esc(money(outgoing))}, saldo ${esc(amount(row.closingCash))}</title><rect class="planning-chart-income" x="${x-bar-2}" y="${y(incoming)}" width="${bar}" height="${Math.max(0,zero-y(incoming))}" rx="3"/><rect class="planning-chart-cost" x="${x+2}" y="${zero}" width="${bar}" height="${Math.max(0,y(-outgoing)-zero)}" rx="3"/>${index%labels===0||index===rows.length-1&&rows.length===1?`<text class="planning-chart-label" x="${x}" y="${H-14}" text-anchor="middle">${esc(label)}</text>`:''}</g>`;
  }).join('');
  return `<div class="planning-chart-legend"><span><i></i>Cobros previstos</span><span><i class="is-cost"></i>Pagos previstos</span><span><i class="is-balance"></i>${points.length?'Dinero en cuenta':'Saldo por completar'}</span></div><svg class="planning-cash-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Previsión mensual de cobros, pagos y saldo"><title>El saldo de caja previsto por mes</title>${ticks.map(value=>`<line class="planning-chart-grid" x1="${left}" x2="${W-right}" y1="${y(value)}" y2="${y(value)}"/><text class="planning-chart-label" x="${left-8}" y="${y(value)+4}" text-anchor="end">${esc(currencyShort(value))}</text>`).join('')}<line class="planning-chart-zero" x1="${left}" x2="${W-right}" y1="${zero}" y2="${zero}"/>${bars}${points.length?`<polyline class="planning-chart-balance" points="${points.map(point=>point.slice(0,2).join(',')).join(' ')}"/>`:''}${points.map(([x,cy,index])=>`<circle class="planning-chart-point" cx="${x}" cy="${cy}" r="4"><title>${esc(money(rows[index].closingCash))}</title></circle>${rows.length<=6&&step>=105?`<text class="planning-chart-value" x="${x}" y="${Math.max(top+8,cy-12)}" text-anchor="middle">${esc(currencyShort(rows[index].closingCash))}</text>`:''}`).join('')}</svg>`;
}

function itemHTML(item) {
  const kind=item.kind==='income'?'Cobro':item.treatment==='asset'?'Inversión':'Pago';
  return `<article class="planning-item"><div><h3><span class="planning-item-kind ${item.kind==='income'?'is-income':item.treatment==='asset'?'is-asset':''}">${kind}</span>${esc(item.label)}</h3><p>${esc(cadence[item.recurrence]||'Una vez')} · desde ${dateLabel(item.startDate)}${item.endDate?' hasta '+dateLabel(item.endDate):''}${item.active===false?' · En pausa':''}</p><p>${esc(treatment[item.treatment]||'Gasto corriente')}${item.vatRate===null?' · IVA por concretar':` · IVA ${esc(String(item.vatRate))} %`}</p></div><div><div class="planning-item-amount">${esc(money(item.amountGross))}</div><div class="planning-item-actions"><button class="icon-btn" data-plan-action="edit-item" data-id="${esc(item.id)}" aria-label="Editar ${esc(item.label)}">${icon('edit')}</button><button class="icon-btn" data-plan-action="toggle-item" data-id="${esc(item.id)}" aria-label="${item.active===false?'Activar':'Pausar'} ${esc(item.label)}">${icon(item.active===false?'check':'clock')}</button><button class="icon-btn danger" data-plan-action="delete-item" data-id="${esc(item.id)}" aria-label="Eliminar previsión ${esc(item.label)}">${icon('trash')}</button></div></div></article>`;
}

/** Flat v1 IDs remain visible even when a linked record is no longer available. */
export function forecastLinkOptions(state, linkedIDs=[]) {
  const records=new Map(), add=(id,label)=>{
    if(typeof id!=='string'||!id)return;
    if(records.has(id)){const current=records.get(id);current.label+=` / ${label}`;current.ambiguous=true;}
    else records.set(id,{id,label,orphan:false,ambiguous:false});
  };
  for(const row of state.expenses||[])add(row.id,`Gasto · ${dateLabel(row.date)} · ${row.description||row.supplier||'Sin concepto'} · ${money(row.total||0)}`);
  for(const row of state.documents||[])if(row.kind==='invoice'&&['issued','partial','paid','overdue'].includes(row.status))add(row.id,`Factura · ${row.number||'Sin número'} · ${row.title||'Documento'} · ${dateLabel(row.date)}`);
  else if(row.kind==='quote'&&row.status==='accepted')add(row.id,`Presupuesto aceptado · ${row.number||'Sin número'} · ${row.title||'Documento'} · ${dateLabel(row.date)}`);
  for(const row of state.taxRecords||[])add(row.id,`Impuesto · Modelo ${row.model||'sin indicar'} · ${row.reference||dateLabel(row.date)} · ${money(row.amount||0)}`);
  for(const id of linkedIDs)if(!records.has(id))records.set(id,{id,label:`Registro no disponible · ${id} · enlace conservado`,orphan:true,ambiguous:false});
  return [...records.values()];
}

/** Only a deliberate deselection of a represented option removes an existing link. */
export function forecastLinkedIDs(submittedIDs, representedIDs, previousIDs=[]) {
  const represented=new Set(representedIDs);
  return [...new Set([...submittedIDs,...previousIDs.filter(id=>!represented.has(id))])];
}

function itemEditor(state,p) {
  const records=forecastLinkOptions(state);
  return `<section class="card planning-editor" id="planning-item-editor" hidden><div class="planning-editor-heading"><div><h2 data-editor-title>Nueva previsión</h2><p>Una previsión no crea un gasto ni un cobro real.</p></div><button class="icon-btn" type="button" data-plan-action="close-item" aria-label="Cerrar editor">${icon('close')}</button></div><form id="planning-item-form"><input name="id" type="hidden"><div class="form-grid">${field('Concepto','label','','text','required maxlength="200" placeholder="Asesoría, línea móvil, ordenador…"')}${select('Qué va a pasar','kind',[['expense','Voy a pagar'],['income','Voy a cobrar']],'expense')}${field('Importe total, con IVA si lo hay (€)','amountGross','','number','required min="0.01" max="100000000" step="0.01"')}${field('Primer pago o cobro previsto','startDate',p.settings.asOf,'date','required')}${select('Se repite','recurrence',Object.entries(cadence),'once')}${field('Hasta cuándo (opcional)','endDate','','date')}${select('Efecto en el beneficio','treatment',Object.entries(treatment),'operating')}${select('IVA incluido en el importe','vatRate',[['','Por concretar'],['0','Sin IVA · 0 %'],['4','4 %'],['10','10 %'],['21','21 %']],'')}</div><div class="planning-checkbox-row"><label class="planning-checkbox"><input name="vatDeductible" type="checkbox">El IVA es deducible y está confirmado</label><label class="planning-checkbox"><input name="active" type="checkbox" checked>Previsión activa</label></div><p class="field-hint" data-treatment-help>El gasto corriente reduce el beneficio previsto. Los impuestos y traspasos se separan del gasto.</p><details class="planning-detail"><summary>Este movimiento ya está registrado</summary><p class="planning-detail-copy">Vincula los registros correspondientes para que la previsión no los vuelva a contar. Para una cuota recurrente, la fecha identifica el período ya registrado.</p><label class="field"><span>Registros vinculados (opcional)</span><select class="planning-link-records" name="linkedRecordIds" multiple size="4">${records.map(row=>`<option value="${esc(row.id)}">${esc(row.label)}</option>`).join('')}</select></label></details><div class="planning-input-error" data-item-error role="alert" hidden></div><div class="planning-form-actions"><button class="button secondary" type="button" data-plan-action="close-item">Cancelar</button><button class="button primary" type="submit">Guardar previsión</button></div></form></section>`;
}

function collectionForm(projection,p) {
  const rows=projection.receivables||[];
  return `<details class="card planning-detail"><summary>Cobros de trabajos confirmados · ${rows.length}</summary><p class="planning-detail-copy">Las facturas pendientes se cuentan una sola vez. Revisa cuándo esperas recibirlas; cambiar esta fecha no las marca como cobradas.</p><form id="planning-collections-form"><div class="planning-collections">${rows.map(row=>`<div class="planning-collection-row"><div><strong>${esc(rowLabel(row))}</strong><span>${esc(money(amountValue(row)))}${row.kind==='accepted-quote'?' · presupuesto aceptado sin facturar':''}</span></div>${field('Cobro previsto (opcional)',rowID(row),p.settings.collectionDates?.[rowID(row)]||dateValue(row),'date')}</div>`).join('')||'<p class="planning-detail-copy">No hay facturas pendientes de cobro para este horizonte.</p>'}</div>${rows.length?'<div class="planning-form-actions"><button class="button secondary" type="submit">Guardar fechas de cobro</button></div>':''}</form></details>`;
}

function suggestedItems(state,p,today) {
  try{return suggestForecastItems(state,p,{today})||[];}catch{return [];}
}

function forecastQuickForm(p) {
  return `<section class="card forecast-quick"><form id="planning-quick-form"><h2>Nueva previsión</h2>${select('Movimiento','kind',[['expense','Gasto'],['income','Cobro']],'expense')}${field('Concepto','label','','text','required maxlength="200" placeholder="Gestor, móvil, nuevo servicio…"')}${field('Importe total (€)','amountGross','','number','required min="0.01" max="100000000" step="0.01" placeholder="Con IVA si lo hay"')}${select('Frecuencia','recurrence',[['monthly','Mensual'],['quarterly','Trimestral'],['yearly','Anual'],['once','Puntual']],'monthly')}${field('Inicio','startDate',nextForecastDate(p.settings.asOf),'date','required')}${field('Fin','endDate',p.settings.horizon,'date')}<button type="submit" class="button primary">${icon('plus')}Añadir a previsión</button><div class="forecast-quick-foot"><span>Los importes incluyen IVA cuando corresponda.</span><button type="button" class="text-button" data-plan-action="quick-options">IVA, inversión o vincular un registro</button></div><p class="planning-input-error" data-quick-error role="alert" hidden></p></form></section>`;
}

function forecastPage(state,p,projection,today) {
  const ledger=forecastLedger(state,p,{today}), suggestions=suggestedItems(state,p,today), closingDate=ledger.horizon<`${ledger.year}-12-31`?ledger.horizon:`${ledger.year}-12-31`;
  return `<header class="forecast-heading"><div><span class="forecast-section-kicker">PREVISIÓN Y TESORERÍA</span><h1>Lo real y lo previsto, juntos.</h1><p>Cada cobro y pago en su mes. Lo pendiente se convierte en real al vincular su registro.</p></div><div class="forecast-year-label">Año ${ledger.year}</div></header><div class="forecast-period"><form id="planning-horizon-form">${field('Real hasta','asOf',p.settings.asOf,'date','required')}${field('Previsión hasta','horizon',p.settings.horizon,'date','required')}<button class="button secondary" type="submit">Actualizar fechas</button><button class="text-button forecast-today" type="button" data-plan-action="refresh-cutoff">Actualizar a hoy</button><p class="forecast-cutoff-help">La fecha de corte indica hasta qué día se muestran como reales los pagos y cobros registrados.</p></form><div class="forecast-cash-now"><span>Dinero actual registrado</span><strong>${esc(amount(ledger.cashNow))}</strong></div></div>${forecastQuickForm(p)}${itemEditor(state,p)}${forecastMatrix(ledger)}${forecastCellDialog()}${forecastReviewPanel(ledger)}<section class="card forecast-treasury"><div class="forecast-treasury-copy"><span class="forecast-section-kicker">TU DINERO</span><h2>Tesorería real y prevista</h2><p>Evolución del saldo acumulado durante ${ledger.year}.</p><div class="forecast-legend"><span><i class="is-line"></i>Real</span><span><i class="is-line is-dashed"></i>Previsto</span></div></div><div class="forecast-chart-scroll"><div data-forecast-treasury-chart>${forecastTreasuryChart(ledger)}</div></div><div class="forecast-closing"><span>Saldo final previsto</span><strong>${esc(amount(ledger.closingBalance))}</strong><small>A ${dateLabel(closingDate)}</small></div></section><div class="forecast-profit-note"><div>${icon('report')}<span>Beneficio previsto antes de Sociedades <strong>${esc(amount(projection.baseProfit))}</strong></span></div><p>El saldo es dinero en cuenta. El beneficio utiliza ingresos y gastos del ejercicio, aunque todavía no se hayan cobrado o pagado.</p></div>${forecastVATPanel(state,p,projection)}<details class="card planning-detail forecast-management"><summary>Gestionar previsiones · ${p.items.length}</summary><div class="planning-list">${p.items.map(itemHTML).join('')||'<p class="planning-detail-copy">Todavía no has añadido previsiones.</p>'}</div></details>${suggestions.length?`<details class="card planning-detail forecast-suggestions"><summary>Cuotas del histórico que puedes prever · ${suggestions.length}</summary><p class="planning-detail-copy">Revisa el importe y la fecha antes de añadirlas. Las sugerencias no crean gastos reales.</p>${suggestions.map((item,index)=>`<div class="planning-suggestion"><strong>${esc(item.label||'Cuota recurrente')}</strong><p>${esc(money(item.amountGross||0))} · ${esc(cadence[item.recurrence]||'Cada mes')}</p><button class="text-button" data-plan-action="accept-suggestion" data-index="${index}">${icon('plus')}Añadir a la previsión</button></div>`).join('')}</details>`:''}${collectionForm(projection,p)}${settingsSection(p)}${projectionNotes(projection)}`;
}

function blankScenario(p) {
  return {id:crypto.randomUUID(),name:'Escenario nuevo',people:p.settings.people.map(person=>({personId:person.id,workGross:0,dividendGross:0})),dividendDate:null,notes:''};
}
function baseScenario(p) {
  return {id:'baseline',name:'Dejarlo en Orquivia',people:p.settings.people.map(person=>({personId:person.id,workGross:0,dividendGross:0})),dividendDate:null,notes:''};
}
const chartClass=(key,index)=>key==='company-retained'||/retain|company.*left|empresa|companyRetained/i.test(key)?'company':/corporate|company.tax|sociedad/i.test(key)?'corporate-tax':/personal.tax|irpf|employer|cotiza/i.test(key)?'personal-tax':/unknown|pending/i.test(key)?'unknown':`person-${index%2+1}`;

export function planningAllocation(result,scale) {
  let segments=(result.segments||[]).filter(segment=>finite(segment.amount)&&segment.amount>0);
  if(!segments.length){
    segments=[{key:'company-retained',label:'Se queda en Orquivia',amount:Math.max(0,result.companyRetained||0)},{key:'company-tax',label:'Sociedades',amount:result.companyTax||0}];
    for(const person of result.people||[]){
      const gross=(person.workGross||0)+(person.dividendGross||0);
      if(gross<=0)continue;
      segments.push({key:`person-${person.id}`,label:finite(person.personalNet)?`${person.name} · neto`:`${person.name} · IRPF pendiente`,amount:finite(person.personalNet)?person.personalNet:gross});
      if(finite(person.personalTax)&&person.personalTax>0)segments.push({key:'personal-tax',label:`IRPF ${person.name}`,amount:person.personalTax});
      if(person.employerCosts>0)segments.push({key:'employer-costs',label:'Cotización de la empresa',amount:person.employerCosts});
    }
    segments=segments.filter(segment=>finite(segment.amount)&&segment.amount>0);
  }
  const total=segments.reduce((sum,row)=>sum+row.amount,0),height=Math.max(1,scale,total);
  const rows=segments.map((row,index)=>{
    const isPerson=/^person[-:]/.test(row.key||'')&&!/tax/.test(row.key||'');
    const personIndex=(result.people||[]).findIndex(person=>person.id===row.personId);
    const cls=row.pending?'unknown':isPerson?`person-${Math.max(0,personIndex)%2+1}`:chartClass(String(row.key||''),index);
    return {...row,cls};
  });
  return `<div class="planning-allocation"><div class="planning-allocation-bar" role="img" aria-label="${esc(rows.map(row=>`${row.label}: ${money(row.amount)}`).join('; '))}">${rows.map(row=>`<div class="planning-allocation-segment planning-swatch-${row.cls}" style="height:${Math.max(0,row.amount/height*100).toFixed(4)}%" title="${esc(row.label)}: ${esc(money(row.amount))}"></div>`).join('')}</div><div class="planning-allocation-legend">${rows.map(row=>`<div><i class="planning-swatch-${row.cls}"></i><span>${esc(row.label)}</span><strong>${esc(money(row.amount))}</strong></div>`).join('')||'<p class="planning-detail-copy">No hay beneficio positivo para distribuir en esta previsión.</p>'}</div></div>`;
}

function comparisonCard(title,subtitle,result,projection,scale) {
  return `<article class="card planning-comparison-card"><div class="planning-comparison-heading"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${icon('report')}</div><div class="planning-comparison-total ${result.companyRetained<0?'planning-net-negative':''}">${esc(amount(result.companyRetained))}<small>Beneficio estimado que conserva Orquivia</small></div>${planningAllocation(result,scale??Math.max(0,projection.baseProfit||0))}<div class="planning-comparison-foot"><div><span>Impuestos totales · SL y personas</span><strong>${esc(amount(result.taxTotal))}</strong></div><div><span>En vuestro bolsillo, después de IRPF</span><strong>${esc(amount(result.totalPersonalNet))}</strong></div></div><div class="planning-cash-position"><span>Margen de caja tras retiros, impuestos y colchón</span><strong class="${result.cashAfterMinimum<0?'planning-net-negative':''}">${esc(amount(result.cashAfterMinimum))}</strong></div><p class="planning-live-note">Caja a ${dateLabel(projection.horizon||projection.to||'')}, antes de reservas fiscales: ${esc(amount(result.cashAtHorizon))}. ${result.dividendTotal>0?`El dividendo se simula para ${dateLabel(result.dividendDate)}; su IRPF corresponde al año ${esc(String(result.dividendYear))}.`:'Los dividendos posteriores se separan de este saldo.'}</p></article>`;
}

function comparisonMarkup(p,projection,baseline,current,title){
  const sumSegments=result=>(result.segments||[]).reduce((sum,row)=>sum+Math.max(0,row.amount||0),0);
  const scale=Math.max(0,projection.baseProfit||0,sumSegments(baseline),sumSegments(current));
  return comparisonCard('Dejarlo en Orquivia','Sin nuevas retribuciones ni dividendos',baseline,projection,scale)+comparisonCard(title,'Escenario que estás probando',current,projection,scale);
}

function scenarioMessages(result){
  const warnings=[...new Set([...(result.warnings||[]),...(result.people||[]).flatMap(person=>(person.retaWarnings||[]).map(value=>`${person.name}: ${message(value)}`))])];
  return issues(result.issues,'is-error')+(warnings.length?`<details class="card planning-detail"><summary>Qué falta confirmar en este escenario · ${warnings.length}</summary>${issues(warnings)}</details>`:'');
}

function peopleSliders(p,scenario,projection) {
  const max=Math.max(1000,Math.ceil(Math.max(0,projection.baseProfit||0)/1000)*1000);
  return p.settings.people.map((person,index)=>{
    const row=scenario.people.find(row=>row.personId===person.id)||{workGross:0,dividendGross:0};
    return `<section class="card planning-person" data-person-id="${esc(person.id)}"><div class="planning-person-heading"><div class="planning-person-avatar">${esc((person.name||'?').slice(0,1).toUpperCase())}</div><div><h3>${esc(person.name)}</h3><p>${person.taxProfileKnown?'Datos personales configurados':'IRPF pendiente de completar'} · ${person.isShareholder?esc(String(person.sharePercent))+' % de participación simulada':'Sin participación simulada'}</p></div></div>${[['workGross','Retribución por trabajo','Reduce el beneficio de la SL si corresponde a trabajo real y es deducible.'],['dividendGross','Dividendo bruto','Sale del beneficio después de Sociedades; respeta la participación simulada.']].map(([key,label,copy])=>`<div class="planning-slider-group"><div class="planning-slider-header"><label for="planning-number-${index}-${key}">${label}</label><span class="planning-slider-number"><input id="planning-number-${index}-${key}" name="${index}.${key}" type="number" min="0" max="100000000" step="0.01" value="${row[key]||0}" data-plan-person="${index}" data-plan-field="${key}" aria-label="${esc(label+' para '+person.name)}">€</span></div><input type="range" min="0" max="${max}" step="100" value="${Math.min(max,row[key]||0)}" data-plan-range="${index}" data-plan-field="${key}" aria-label="Ajustar ${esc(label.toLowerCase()+' de '+person.name)}"><p>${copy}</p></div>`).join('')}<div class="planning-person-summary"><span>Neto final estimado</span><strong data-person-net="${index}">Por completar</strong></div></section>`;
  }).join('');
}

function scenariosPage(state,p,projection) {
  const selected=p.scenarios[0]||blankScenario(p),baseline=simulatePlanningScenario(projection,baseScenario(p),p.settings),current=simulatePlanningScenario(projection,selected,p.settings);
  return `<div class="page-heading"><div><div class="eyebrow">ESCENARIOS</div><h1>Prueba distintas formas de repartir.</h1><p>Compara dejar el beneficio en la empresa con una combinación de retribuciones y dividendos.</p></div></div>${tabs('scenarios')}${notice('Aquí puedes probar sin mover dinero','Los cambios de estos gráficos no generan nóminas, dividendos ni transferencias. Guarda los escenarios que quieras revisar juntas.')}${horizonForm(p)}<section class="card"><div class="planning-scenario-toolbar">${select('Escenario guardado','planningScenario',[['','Nuevo escenario'],...p.scenarios.map(row=>[row.id,row.name])],p.scenarios.length?selected.id:'')}${field('Nombre del escenario','planningScenarioName',selected.name,'text','maxlength="120" required')}<div class="planning-heading-actions"><button class="button secondary" data-plan-action="new-scenario">${icon('plus')}Nuevo</button><button class="button secondary" data-plan-action="duplicate-scenario">${icon('copy')}Duplicar</button><button class="button primary" data-plan-action="save-scenario">${icon('check')}Guardar escenario</button><button class="icon-btn danger" data-plan-action="delete-scenario" aria-label="Eliminar escenario guardado" ${p.scenarios.length?'':'disabled'}>${icon('trash')}</button></div></div><p class="planning-scenario-status" data-scenario-status>${icon('shield')}${p.scenarios.length?'Escenario guardado. Los cambios se guardan al pulsar el botón.':'Escenario nuevo. Ajusta los importes y guárdalo para retomarlo después.'}</p></section><div class="planning-comparison" data-planning-comparison>${comparisonMarkup(p,projection,baseline,current,selected.name)}</div><div class="planning-scenario-effect" data-planning-effect></div><div class="planning-people" data-planning-people>${peopleSliders(p,selected,projection)}</div><section class="card planning-scenario-extras">${field('Fecha prevista del dividendo (opcional)','planningDividendDate',selected.dividendDate||'','date')}<label class="field"><span>Notas del escenario</span><textarea name="planningScenarioNotes" maxlength="2000" rows="2" placeholder="Qué queréis comparar o dejar pendiente">${esc(selected.notes||'')}</textarea></label><p class="field-hint">El dividendo ordinario del beneficio de un ejercicio suele acordarse en el siguiente. Su fecha determina si sale de la caja del horizonte actual.</p></section><div data-planning-scenario-issues>${scenarioMessages(current)}</div>${settingsSection(p)}${projectionNotes(projection)}`;
}

function settingsSection(p) {
  const s=p.settings;
  return `<details class="card planning-detail" id="planning-settings"><summary>Datos del cálculo y de cada persona</summary><p class="planning-detail-copy">Completa estos datos una vez y revisa los cambios cuando cambie el año o vuestra situación. No se adivina el IRPF de una persona a partir del de la otra.</p><form id="planning-settings-form" class="planning-settings"><div class="form-grid">${field('Año de los tipos fiscales','taxYear',s.taxYear,'number','required min="2026" max="2100" step="1"')}${select('Sociedades a simular','corporateTaxRate',[[15,'15 % · nueva entidad, si corresponde'],[19,'19 % · tramo microempresa, si corresponde'],[21,'21 %'],[23,'23 %'],[25,'25 % · general']],s.corporateTaxRate)}${field('Reserva legal pendiente (€)','legalReservePending',s.legalReservePending,'number','min="0" step="0.01" max="100000000" required')}${field('Colchón de caja que queréis conservar (€)','minimumCash',s.minimumCash,'number','min="0" step="0.01" max="100000000" required')}${field('Saldo de partida aportado (opcional)','cashBalanceOverride',s.cashBalanceOverride??'','number','step="0.01" placeholder="Usar los registros de la aplicación"')}${field('Beneficio de partida aportado (opcional)','profitOverride',s.profitOverride??'','number','step="0.01" placeholder="Usar el cierre y los registros"')}</div><div class="planning-checkbox-row"><label class="planning-checkbox"><input type="checkbox" name="corporateTaxConfirmed" ${s.corporateTaxConfirmed?'checked':''}>El tipo de Sociedades está confirmado con el gestor</label></div>${select('Gastos registrados pendientes de clasificar','pendingCosts',[['gross','Restar su importe completo como estimación'],['exclude','Separarlos hasta que se revisen'] ],s.pendingCosts)}<p class="field-hint">La reserva legal permanece en la empresa. Se destina el 10 % del beneficio anual hasta alcanzar el 20 % del capital social. Indica aquí solo lo que el gestor confirme que falta por reservar.</p><p class="field-hint">Una estimación con importes completos no convierte esos gastos en deducibles. Los justificantes, el IVA y los ajustes pueden cambiar el resultado.</p><div class="planning-shared-note">Estos datos de planificación se comparten con las personas autorizadas de la empresa. Las participaciones que indiques son para simular; no formalizan un cambio de socias.</div><div class="planning-settings-people">${s.people.map((person,index)=>`<section class="planning-settings-person"><h3>${esc(person.name)}</h3>${field('Nombre',`person.${index}.name`,person.name,'text','required maxlength="80"')}<label class="planning-checkbox"><input type="checkbox" name="person.${index}.taxProfileKnown" ${person.taxProfileKnown?'checked':''}>He revisado los datos fiscales de esta persona</label><div class="form-grid">${field('Sueldo bruto anual de otros empleos (€)',`person.${index}.externalSalary`,person.externalSalary,'number','min="0" step="0.01" required')}${field('Seguridad Social anual de esos empleos (€)',`person.${index}.employeeSS`,person.employeeSS,'number','min="0" step="0.01" required')}${field('Cuota RETA personal anual deducible (€)',`person.${index}.retaAnnual`,person.retaAnnual,'number','min="0" step="0.01" required')}${field('Otras rentas generales netas (€)',`person.${index}.otherGeneralIncome`,person.otherGeneralIncome,'number','min="0" step="0.01" required')}${field('Gasto general de rendimientos del trabajo (€)',`person.${index}.employmentExpense`,person.employmentExpense,'number','min="0" step="0.01" required')}${field('Otras rentas del ahorro anuales (€)',`person.${index}.otherSavings`,person.otherSavings,'number','min="0" step="0.01" required')}${field('Participación a simular (%)',`person.${index}.sharePercent`,person.sharePercent,'number','min="0" max="100" step="0.01" required')}${field('Cotización adicional de la empresa (%)',`person.${index}.employerContributionRate`,person.employerContributionRate,'number','min="0" max="100" step="0.01" required')}${select('Cuota de autónomos',`person.${index}.retaPeriod`,[['initial','Primer período reducido'],['extension','Prórroga de la cuota reducida'],['ordinary','Cotización ordinaria']],person.retaPeriod)}${field('Año que se revisa para RETA',`person.${index}.retaYear`,person.retaYear,'number','min="2026" max="2100" step="1" required')}</div><label class="planning-checkbox"><input type="checkbox" name="person.${index}.isShareholder" ${person.isShareholder?'checked':''}>Es socia en este escenario</label><p class="field-hint">Si la empresa debe pagar cotizaciones por esta retribución, inclúyelas arriba. La cuota de autónomos pagada personalmente no se añade como coste de la SL.</p></section>`).join('')}</div><div class="planning-form-actions"><button class="button primary" type="submit">Guardar datos del cálculo</button></div></form></details>`;
}

function projectionNotes(projection) {
  return `<details class="card planning-detail"><summary>De dónde salen las cifras</summary><p class="planning-detail-copy">El cierre del gestor se utiliza una sola vez. Se añaden los registros posteriores y los movimientos futuros de esta previsión; las alternativas sin aceptar quedan fuera.</p>${issues(projection.issues,'is-error')}${issues(projection.warnings)}<ul class="planning-method-list"><li>El beneficio y la caja se calculan por separado. Cobrar una factura no vuelve a generar su venta.</li><li>Una compra de equipo afecta a la caja. Su amortización debe concretarse antes de restarla del beneficio.</li><li>Las remuneraciones por trabajo real pueden reducir el beneficio si son deducibles. Los dividendos se reparten después del impuesto de la sociedad.</li><li>El IRPF mostrado es una estimación del impuesto adicional final. La retención del pago puede ser distinta.</li><li>Sociedades de un ejercicio que cierra el 31 de diciembre se presenta normalmente en julio del año siguiente. Se reserva para ver la caja disponible, aunque todavía no se haya pagado.</li></ul><div class="planning-method-links"><a href="https://www.boe.es/buscar/act.php?id=BOE-A-2006-20764#a63" target="_blank" rel="noopener noreferrer">IRPF estatal</a><a href="https://www.boe.es/buscar/act.php?id=BOE-A-2024-6951" target="_blank" rel="noopener noreferrer">IRPF Cataluña</a><a href="https://sede.agenciatributaria.gob.es/Sede/impuesto-sobre-sociedades/que-base-imponible-se-determina-sociedades/tipo-impositivo.html" target="_blank" rel="noopener noreferrer">Sociedades</a><a href="https://www.boe.es/buscar/act.php?id=BOE-A-2007-13409#a3-5" target="_blank" rel="noopener noreferrer">Cuota reducida</a></div></details>`;
}

export function planningPage(state,{today=todayISO(),page='forecast'}={}) {
  try{
    const p=loadPlanning(state,today),projection=planningProjection(state,p,{today});
    return `<div class="planning-page" data-planning-page="${page}">${page==='scenarios'?scenariosPage(state,p,projection):forecastPage(state,p,projection,today)}</div>`;
  }catch(error){return `<div class="planning-page"><div class="page-heading"><div><div class="eyebrow">PLANIFICACIÓN</div><h1>Revisa los datos de la previsión.</h1><p>Los registros originales de la empresa siguen conservados.</p></div></div>${tabs(page)}${notice('No se pudo calcular la previsión',error.message,'is-error')}</div>`;}
}

export function bindPlanning(root,ctx) {
  const today=ctx.today||todayISO(),page=ctx.page||root.querySelector('[data-planning-page]')?.dataset.planningPage||'forecast';
  const scope=root.querySelector('.planning-page');if(!scope)return()=>{};
  const signals=new AbortController(),on=(node,type,fn)=>node?.addEventListener(type,fn,{signal:signals.signal});
  let p;try{p=loadPlanning(ctx.getState(),today);}catch{return()=>signals.abort();}
  let projection=planningProjection(ctx.getState(),p,{today}),scenario=clone(p.scenarios[0]||blankScenario(p)),dirty=false,muting=false;
  const dirtyForms=new Set();
  const hasUnsaved=()=>dirty||dirtyForms.size>0;
  const beforeUnload=event=>{if(hasUnsaved()){event.preventDefault();event.returnValue='';}};
  window.addEventListener('beforeunload',beforeUnload,{signal:signals.signal});
  const markForm=event=>{if(!muting&&event.target.form?.id)dirtyForms.add(event.target.form.id);};
  on(scope,'input',markForm);on(scope,'change',markForm);
  const persist=async(change,text)=>{
    try{return await ctx.commit(state=>{const next=loadPlanning(state,today);change(next);state.planning=normalizePlanning(next,{today});},text);}catch(error){ctx.toast(error.message,true);return false;}
  };
  const markDirty=()=>{dirty=true;const status=scope.querySelector('[data-scenario-status]');if(status){status.classList.add('is-dirty');status.textContent='Tienes cambios sin guardar en este escenario.';}};
  const showError=error=>ctx.toast(error.message||String(error),true);
  const readScenario=()=>{
    scenario.name=scope.querySelector('[name="planningScenarioName"]')?.value.trim()||'Escenario sin nombre';
    scenario.notes=scope.querySelector('[name="planningScenarioNotes"]')?.value||'';
    scenario.dividendDate=scope.querySelector('[name="planningDividendDate"]')?.value||null;
    return scenario;
  };
  const updateScenario=()=>{
    if(page!=='scenarios')return;
    try{
      readScenario();
      const baseline=simulatePlanningScenario(projection,baseScenario(p),p.settings),result=simulatePlanningScenario(projection,scenario,p.settings);
      const comparison=scope.querySelector('[data-planning-comparison]');if(comparison)comparison.innerHTML=comparisonMarkup(p,projection,baseline,result,scenario.name);
      const effect=scope.querySelector('[data-planning-effect]');if(effect){const delta=finite(result.taxTotal)&&finite(baseline.taxTotal)?result.taxTotal-baseline.taxTotal:null;effect.innerHTML=delta===null?'<span>Completa los datos fiscales para comparar los impuestos totales y el neto personal.</span>':`<span>Frente a dejarlo en la empresa:</span><strong>${esc(money(Math.abs(delta)))}</strong><span>${delta>0?'más de impuestos totales':delta<0?'menos de impuestos totales':'de diferencia en impuestos'}. Mira también cuánto llega a vuestro bolsillo.</span>`;}
      p.settings.people.forEach((person,index)=>{const row=(result.people||[]).find(row=>row.id===person.id)||{};const target=scope.querySelector(`[data-person-net="${index}"]`);if(target)target.textContent=amount(row.personalNet);});
      const messages=scope.querySelector('[data-planning-scenario-issues]');if(messages)messages.innerHTML=scenarioMessages(result);
    }catch(error){const messages=scope.querySelector('[data-planning-scenario-issues]');if(messages)messages.innerHTML=notice('Revisa el escenario',error.message,'is-error');}
  };
  const mountScenario=next=>{
    muting=true;scenario=clone(next);dirty=false;
    const chosen=scope.querySelector('[name="planningScenario"]');chosen.value=p.scenarios.some(row=>row.id===scenario.id)?scenario.id:'';chosen.dispatchEvent(new Event('change',{bubbles:true}));
    scope.querySelector('[name="planningScenarioName"]').value=scenario.name;
    const date=scope.querySelector('[name="planningDividendDate"]');date.value=scenario.dividendDate||'';date.dispatchEvent(new Event('change',{bubbles:true}));
    scope.querySelector('[name="planningScenarioNotes"]').value=scenario.notes||'';
    const people=scope.querySelector('[data-planning-people]');people.innerHTML=peopleSliders(p,scenario,projection);bindPersonInputs(people);
    const status=scope.querySelector('[data-scenario-status]');status.classList.remove('is-dirty');status.textContent=p.scenarios.some(row=>row.id===scenario.id)?'Escenario guardado. Los cambios se guardan al pulsar el botón.':'Escenario nuevo. Ajusta los importes y guárdalo para retomarlo después.';
    scope.querySelector('[data-plan-action="delete-scenario"]').disabled=!p.scenarios.some(row=>row.id===scenario.id);
    muting=false;
    updateScenario();
  };
  function bindPersonInputs(people) {
    people.querySelectorAll('[data-plan-person]').forEach(input=>on(input,'input',()=>{
      const index=Number(input.dataset.planPerson),key=input.dataset.planField,person=p.settings.people[index];
      if(!person)return;
      const row=scenario.people.find(row=>row.personId===person.id)||(()=>{const value={personId:person.id,workGross:0,dividendGross:0};scenario.people.push(value);return value;})();
      row[key]=Math.max(0,number(input.value||0));
      const range=people.querySelector(`[data-plan-range="${index}"][data-plan-field="${key}"]`);if(range)range.value=Math.min(Number(range.max),row[key]);markDirty();updateScenario();
    }));
    people.querySelectorAll('[data-plan-range]').forEach(input=>on(input,'input',()=>{
      const index=Number(input.dataset.planRange),key=input.dataset.planField,target=people.querySelector(`[data-plan-person="${index}"][data-plan-field="${key}"]`);if(target){target.value=input.value;target.dispatchEvent(new Event('input',{bubbles:true}));}
    }));
  }
  on(scope.querySelector('#planning-horizon-form'),'submit',async event=>{
    event.preventDefault();const data=new FormData(event.currentTarget);await persist(next=>{next.settings.asOf=String(data.get('asOf'));next.settings.horizon=String(data.get('horizon'));},'Horizonte de previsión guardado.');
  });
  const quickForm=scope.querySelector('#planning-quick-form');
  const quickItem=()=>{
    const data=new FormData(quickForm);
    return {id:'',label:String(data.get('label')||'').trim(),kind:String(data.get('kind')||'expense'),amountGross:String(data.get('amountGross')||''),vatRate:null,vatDeductible:false,treatment:'operating',recurrence:String(data.get('recurrence')||'monthly'),startDate:String(data.get('startDate')||''),endDate:String(data.get('endDate')||'')||null,active:true,linkedRecordIds:[]};
  };
  on(quickForm,'submit',async event=>{
    event.preventDefault();const target=quickForm.querySelector('[data-quick-error]');
    try{
      const values=quickItem(),item={...values,id:crypto.randomUUID(),amountGross:number(values.amountGross)};
      if(item.recurrence==='once'&&item.startDate<=p.settings.asOf)throw new Error('Para un movimiento ya realizado, registra el pago o cobro y vincúlalo desde las opciones de previsión.');
      target.hidden=true;
      await persist(next=>next.items.push(item),'Previsión añadida.');
    }catch(error){target.textContent=error.message;target.hidden=false;}
  });
  const editor=scope.querySelector('#planning-item-editor'),form=scope.querySelector('#planning-item-form');
  let editingLinkedIDs=[];
  const closeEditor=()=>{if(editor)editor.hidden=true;dirtyForms.delete('planning-item-form');};
  const openEditor=item=>{
    if(!editor||!form)return;muting=true;form.reset();dirtyForms.delete('planning-item-form');
    const values={id:item?.id||'',label:item?.label||'',kind:item?.kind||'expense',amountGross:item?.amountGross??'',startDate:item?.startDate||nextForecastDate(p.settings.asOf),endDate:item?.endDate||'',recurrence:item?.recurrence||'once',treatment:item?.treatment||'operating',vatRate:item?.vatRate??''};
    Object.entries(values).forEach(([name,value])=>{const input=form.elements.namedItem(name);if(input){input.value=String(value);input.dispatchEvent(new Event('change',{bubbles:true}));}});
    form.elements.vatDeductible.checked=item?.vatDeductible===true;form.elements.active.checked=item?.active!==false;
    editingLinkedIDs=[...(item?.linkedRecordIds||[])];
    form.elements.linkedRecordIds.innerHTML=forecastLinkOptions(ctx.getState(),editingLinkedIDs).map(option=>`<option value="${esc(option.id)}" ${editingLinkedIDs.includes(option.id)?'selected':''}>${esc(option.label)}</option>`).join('');
    const err=form.querySelector('[data-item-error]');err.hidden=true;err.textContent='';
    editor.querySelector('[data-editor-title]').textContent=item?.id?'Editar previsión':'Nueva previsión';editor.hidden=false;muting=false;editor.scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});form.elements.label.focus();
  };
  on(form?.elements.treatment,'change',()=>{
    form.querySelector('[data-treatment-help]').textContent=form.elements.treatment.value==='asset'?'La inversión se resta de la caja, pero no se deduce entera del beneficio. Su amortización queda pendiente de concretar.':'El gasto corriente reduce el beneficio previsto. Los impuestos y traspasos se separan del gasto.';
  });
  on(form,'submit',async event=>{
    event.preventDefault();const data=new FormData(form),id=String(data.get('id')||'')||crypto.randomUUID();
    try{
      const item={id,label:String(data.get('label')).trim(),kind:String(data.get('kind')),amountGross:number(data.get('amountGross')),vatRate:data.get('vatRate')===''?null:number(data.get('vatRate')),vatDeductible:data.get('vatDeductible')==='on',treatment:String(data.get('treatment')),recurrence:String(data.get('recurrence')),startDate:String(data.get('startDate')),endDate:String(data.get('endDate')||'')||null,active:data.get('active')==='on',linkedRecordIds:forecastLinkedIDs(data.getAll('linkedRecordIds').map(String),[...form.elements.linkedRecordIds.options].map(option=>option.value),editingLinkedIDs)};
      if(item.recurrence==='once'&&item.startDate<=p.settings.asOf&&!item.linkedRecordIds.length)throw new Error('Vincula el registro de este movimiento pasado o elige una fecha futura. La previsión no crea un pago real.');
      await persist(next=>{const index=next.items.findIndex(row=>row.id===id);if(index<0)next.items.push(item);else next.items[index]=item;},'Previsión guardada.');
    }catch(error){const target=form.querySelector('[data-item-error]');target.textContent=error.message;target.hidden=false;}
  });
  on(scope.querySelector('#planning-collections-form'),'submit',async event=>{
    event.preventDefault();const dates=Object.fromEntries(new FormData(event.currentTarget));await persist(next=>{for(const [key,value] of Object.entries(dates)){if(value)next.settings.collectionDates[key]=String(value);else delete next.settings.collectionDates[key];}},'Fechas previstas de cobro guardadas.');
  });
  on(scope.querySelector('#planning-settings-form'),'submit',async event=>{
    event.preventDefault();const data=new FormData(event.currentTarget);
    try{
      await persist(next=>{
        const settings=next.settings;
        ['taxYear','corporateTaxRate','legalReservePending','minimumCash'].forEach(key=>settings[key]=number(data.get(key)));
        ['cashBalanceOverride','profitOverride'].forEach(key=>settings[key]=String(data.get(key)||'').trim()===''?null:number(data.get(key)));
        settings.corporateTaxConfirmed=data.get('corporateTaxConfirmed')==='on';settings.pendingCosts=String(data.get('pendingCosts'));
        settings.people=settings.people.map((person,index)=>{
          const prefix=`person.${index}.`,updated={...person,name:String(data.get(prefix+'name')).trim(),taxProfileKnown:data.get(prefix+'taxProfileKnown')==='on',isShareholder:data.get(prefix+'isShareholder')==='on',retaPeriod:String(data.get(prefix+'retaPeriod'))};
          ['externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings','sharePercent','employerContributionRate','retaYear'].forEach(key=>updated[key]=number(data.get(prefix+key)));
          return updated;
        });
      },'Datos de planificación guardados.');
    }catch(error){showError(error);}
  });
  on(scope,'click',async event=>{
    const button=event.target.closest('[data-plan-action]');if(!button||!scope.contains(button))return;
    const action=button.dataset.planAction,id=button.dataset.id;
    try{
      if(action==='new-item')openEditor();
      if(action==='refresh-cutoff')await persist(next=>{next.settings.asOf=today;if(next.settings.horizon<today)next.settings.horizon=today;},'Corte de movimientos actualizado a hoy.');
      if(action==='quick-options')openEditor(quickItem());
      if(action==='inspect-cell'){
        const ledger=forecastLedger(ctx.getState(),p,{today}),row=ledger.rows.find(value=>value.id===button.dataset.row),cell=row?.months[button.dataset.month];if(!row||!cell)return;
        const dialog=scope.querySelector('#forecast-cell-dialog');dialog.querySelector('#forecast-cell-title').textContent=`${row.label} · ${button.dataset.month}`;
        dialog.querySelector('[data-forecast-cell-body]').innerHTML=`<div class="forecast-detail-summary"><div><span>Cobrado / pagado registrado</span><strong>${esc(money(cell.actual))}</strong></div><div><span>Previsto pendiente</span><strong>${esc(money(cell.expected))}</strong></div></div><ul class="forecast-detail-entries">${cell.entries.map(entry=>`<li><div><span class="forecast-detail-status ${entry.status==='actual'?'is-actual':'is-expected'}">${entry.status==='actual'?'Real registrado':'Pendiente'}</span><strong>${esc(entry.label)}</strong><small>${dateLabel(entry.date)} · ${entry.recordType==='forecast'?'Previsión':entry.recordType==='invoice'?'Factura emitida':entry.recordType==='quote'?'Presupuesto aceptado':entry.recordType==='tax'?'Registro de impuesto':'Gasto registrado'}</small></div><div><b>${esc(money(entry.amount))}</b>${entry.recordId&&typeof ctx.openForecastRecord==='function'?`<button type="button" class="text-button" data-plan-action="open-record" data-type="${esc(entry.recordType)}" data-id="${esc(entry.recordId)}">Ver registro</button>`:''}</div></li>`).join('')}</ul>${row.itemId?`<div class="planning-form-actions"><button class="button secondary" type="button" data-plan-action="edit-cell-item" data-id="${esc(row.itemId)}">Editar o vincular esta previsión</button></div>`:''}`;
        dialog.showModal();
      }
      if(action==='close-cell')scope.querySelector('#forecast-cell-dialog')?.close();
      if(action==='edit-cell-item'){scope.querySelector('#forecast-cell-dialog')?.close();openEditor(p.items.find(row=>row.id===id));}
      if(action==='open-record'){scope.querySelector('#forecast-cell-dialog')?.close();await ctx.openForecastRecord?.(button.dataset.type,id);}
      if(action==='close-item')closeEditor();
      if(action==='edit-item')openEditor(p.items.find(row=>row.id===id));
      if(action==='toggle-item')await persist(next=>{const item=next.items.find(row=>row.id===id);if(item)item.active=!item.active;},'Previsión actualizada.');
      if(action==='delete-item'&&window.confirm('¿Eliminar esta previsión? Los registros de gastos y cobros no cambian.'))await persist(next=>{next.items=next.items.filter(row=>row.id!==id);},'Previsión eliminada.');
      if(action==='accept-suggestion'){
        const suggested=suggestedItems(ctx.getState(),p,today)[Number(button.dataset.index)];if(!suggested)return;
        const candidate=suggested.item||suggested;
        const item={id:crypto.randomUUID(),label:candidate.label,kind:candidate.kind||'expense',amountGross:candidate.amountGross,vatRate:candidate.vatRate??null,vatDeductible:candidate.vatDeductible===true,treatment:candidate.treatment||'operating',recurrence:candidate.recurrence||'monthly',startDate:candidate.startDate,endDate:candidate.endDate??null,active:true,linkedRecordIds:candidate.linkedRecordIds||[]};
        await persist(next=>next.items.push(item),'Cuota añadida a la previsión.');
      }
      if(action==='new-scenario'&&(!dirty||window.confirm('¿Crear otro escenario y descartar los cambios sin guardar?'))){scope.querySelector('[name="planningScenario"]').value='';mountScenario(blankScenario(p));}
      if(action==='duplicate-scenario'){readScenario();const copy={...clone(scenario),id:crypto.randomUUID(),name:scenario.name+' · copia'};mountScenario(copy);markDirty();}
      if(action==='save-scenario'){
        readScenario();const saved=clone(scenario);await persist(next=>{next.scenarios=[saved,...next.scenarios.filter(row=>row.id!==saved.id)];},'Escenario guardado.');
      }
      if(action==='delete-scenario'&&p.scenarios.some(row=>row.id===scenario.id)&&window.confirm('¿Eliminar este escenario guardado? No cambia los documentos ni pagos de la empresa.'))await persist(next=>{next.scenarios=next.scenarios.filter(row=>row.id!==scenario.id);},'Escenario eliminado.');
    }catch(error){showError(error);}
  });
  if(page==='scenarios'){
    bindPersonInputs(scope.querySelector('[data-planning-people]'));
    on(scope.querySelector('[name="planningScenario"]'),'change',event=>{if(!muting){if(dirty&&!window.confirm('¿Cambiar de escenario y descartar los cambios sin guardar?')){muting=true;event.target.value=p.scenarios.some(row=>row.id===scenario.id)?scenario.id:'';event.target.dispatchEvent(new Event('change',{bubbles:true}));muting=false;return;}mountScenario(p.scenarios.find(row=>row.id===event.target.value)||blankScenario(p));}});
    ['planningScenarioName','planningScenarioNotes','planningDividendDate'].forEach(name=>on(scope.querySelector(`[name="${name}"]`),'input',()=>{if(!muting){markDirty();updateScenario();}}));
    on(scope.querySelector('[name="planningDividendDate"]'),'change',()=>{if(!muting){markDirty();updateScenario();}});
    updateScenario();
  }
  const chart=scope.querySelector('[data-planning-cash-chart]');
  let resizeObserver=null,chartWidth=0;
  if(chart&&typeof ResizeObserver!=='undefined'){
    resizeObserver=new ResizeObserver(entries=>{const width=Math.round(entries[0]?.contentRect.width||0);if(width>0&&width!==chartWidth){chartWidth=width;chart.innerHTML=planningCashChart(projection.monthly,{width});}});resizeObserver.observe(chart);
  }
  const treasuryChart=scope.querySelector('[data-forecast-treasury-chart]');
  let treasuryObserver=null,treasuryWidth=0;
  if(treasuryChart&&typeof ResizeObserver!=='undefined'){
    const ledger=forecastLedger(ctx.getState(),p,{today});
    treasuryObserver=new ResizeObserver(entries=>{const width=Math.max(600,Math.round(entries[0]?.contentRect.width||0));if(width!==treasuryWidth){treasuryWidth=width;treasuryChart.innerHTML=forecastTreasuryChart(ledger,{width});}});treasuryObserver.observe(treasuryChart);
  }
  const cleanup=()=>{signals.abort();resizeObserver?.disconnect();treasuryObserver?.disconnect();};
  cleanup.hasUnsaved=hasUnsaved;
  return cleanup;
}

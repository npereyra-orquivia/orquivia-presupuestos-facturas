import { alignStatements } from './accountant-close.js';
import { accountantPanel, bindAccountant } from './accountant-ui.js';
import { todayISO, money, escapeHTML as esc } from './domain.js';
import { profitLossReport } from './profit-loss.js';
import { balanceSheetReport } from './balance-sheet.js';
import { icon } from './icons.js';

const dateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value.split('-').reverse().join('/') : 'Pendiente';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const known = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => known(value) ? money(value) : 'Por completar';
let activePeriod;

export function statementPeriod(preferences = {}, today = todayISO()) {
  const to = validDate(preferences.to) ? preferences.to : today;
  const from = validDate(preferences.from) ? preferences.from : `${to.slice(0,4)}-01-01`;
  return from <= to ? { from, to } : { from: `${to.slice(0,4)}-01-01`, to };
}

export function buildStatements(state, preferences = {}, options = {}) {
  const period = statementPeriod(preferences);
  const stored=state.company?.statementInputs,adjustments=[...(options.adjustments || [])];
  const declared=stored===undefined?null:statementInputs(stored);
  if(declared?.asOf===period.to){
    if(known(declared.capitalSocial))adjustments.push({id:'declared-capital',section:'equity',label:'Capital social declarado',amount:declared.capitalSocial,source:declared.source});
    if(known(declared.financialDebt))adjustments.push({id:'declared-financing',section:'liability',label:'Préstamos y financiación declarados',amount:declared.financialDebt,source:declared.source});
  }
  const reportOptions={...options,adjustments};
  if(declared?.asOf===period.to){
    if(known(declared.bankBalance)){reportOptions.bankBalance=declared.bankBalance;reportOptions.bankSource=declared.source;}
    reportOptions.capitalFundingPending=declared.capitalFundingPending===true;
  }
  return { period, ...alignStatements(state,period,profitLossReport(state,period,reportOptions),balanceSheetReport(state,{asOf:period.to},reportOptions),reportOptions) };
}

export function statementInputs(values){
  if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('Los datos aportados para el balance no tienen un formato válido.');
  if(!validDate(values.asOf))throw new Error('Indica una fecha de corte válida.');
  const result={asOf:values.asOf,source:typeof values.source==='string'?values.source.trim():''};
  for(const key of ['capitalSocial','financialDebt','bankBalance']){
    const raw=values[key];if(raw===undefined||raw===null||String(raw).trim()==='')continue;
    const pattern=key==='bankBalance'?/^-?\d+(?:[.,]\d{1,2})?$/:/^\d+(?:[.,]\d{1,2})?$/;
    if(!pattern.test(String(raw).trim()))throw new Error('Introduce importes decimales válidos, con un máximo de dos decimales; capital y préstamos deben ser no negativos.');
    const number=Number(String(raw).replace(',','.'));
    if(!Number.isFinite(number)||(key!=='bankBalance'&&number<0)||Math.abs(number)>Number.MAX_SAFE_INTEGER/100)throw new Error('Los importes contables deben ser válidos; capital y préstamos deben ser no negativos.');
    if(Math.abs(number*100-Math.round(number*100))>0.00001)throw new Error('Introduce los importes contables con un máximo de dos decimales.');
    result[key]=number;
  }
  if(!['capitalSocial','financialDebt','bankBalance'].some(key=>Object.hasOwn(result,key)))throw new Error('Indica al menos un importe; deja en blanco lo que no esté confirmado.');
  if(values.capitalFundingPending===true)result.capitalFundingPending=true;
  if(!result.source||result.source.length>500)throw new Error('Indica la fuente de estos datos, con un máximo de 500 caracteres.');
  return result;
}

function accountingForm(state,period){
  const original=state.company?.statementInputs,inputs=original?.asOf===period.to?original:{};
  return `<section class="card statement-accounting"><div class="card-header"><div><h2>Datos aportados para el balance</h2><p>Importes a ${dateLabel(period.to)}. Deja en blanco lo que todavía no esté confirmado; cero significa que se ha confirmado ese importe.</p></div></div><form id="statement-accounting-form"><fieldset><div class="form-grid"><label class="field"><span>Capital social declarado (opcional)</span><input type="number" name="capitalSocial" min="0" step="0.01" value="${known(inputs.capitalSocial)?inputs.capitalSocial:''}" placeholder="Sin confirmar"></label><label class="field"><span>Préstamos y financiación pendientes (opcional)</span><input type="number" name="financialDebt" min="0" step="0.01" value="${known(inputs.financialDebt)?inputs.financialDebt:''}" placeholder="Sin confirmar"></label></div><label class="field"><span>Saldo del extracto a fecha de corte (opcional)</span><input type="number" name="bankBalance" step="0.01" value="${known(inputs.bankBalance)?inputs.bankBalance:''}" placeholder="Sin conciliar"></label><label class="statement-checkbox"><input type="checkbox" name="capitalFundingPending" ${inputs.capitalFundingPending===true?'checked':''}> Desembolso del capital pendiente de acreditar</label><label class="field"><span>Fuente de estos datos</span><textarea name="statementSource" maxlength="500" rows="2" placeholder="Documento o declaración que acredita los importes y su fecha" required>${esc(inputs.source || '')}</textarea></label><p class="field-hint">Estos datos se guardan para esta fecha de corte y se incorporan al informe con su fuente. No completan por sí solos los ajustes contables que faltan.</p><p class="field-hint" data-accounting-permission></p><div class="form-footer"><button type="submit" class="button secondary">Guardar datos del balance</button></div></fieldset></form>${original&&original.asOf!==period.to?`<p class="statement-footnote">Hay datos aportados para el ${dateLabel(original.asOf)}. Se utilizarán al seleccionar esa misma fecha de corte.</p>`:''}</section>`;
}

const rowHTML = row => `<tr class="${row.amount === null ? 'statement-row-pending' : ''}${/result|final|total/.test(row.id || '') ? ' statement-row-total' : ''}"><th scope="row">${esc(row.label)}${row.source ? `<small class="statement-source">${esc(row.source)}</small>` : ''}</th><td class="amount">${esc(amount(row.amount))}</td></tr>`;
const rowsTable = (label,rows,empty) => `<div class="table-scroll"><table class="statement-table" aria-label="${esc(label)}"><thead><tr><th>Partida</th><th class="amount">Importe</th></tr></thead><tbody>${rows.length ? rows.map(rowHTML).join('') : `<tr><td colspan="2">${esc(empty)}</td></tr>`}</tbody></table></div>`;
const issueHTML = row => `<li><span><strong>${esc(row.label || row.description || 'Por revisar')}</strong>${row.date ? `<small>${dateLabel(row.date)}</small>` : ''}</span>${known(row.amount) ? `<b>${esc(money(row.amount))}</b>` : '<span class="statement-pending-text">Por completar</span>'}</li>`;

/** This view displays recorded subtotals and missing information without inventing a closing entry. */
export function statementsPage(state, preferences = {}, options = {}) {
  const {period,profitLoss:p,balance:b,alignment} = buildStatements(state,preferences,options);
  activePeriod = period;
  const pending = p.pending || [], missing = [...(b.missing || []),...(b.pending || [])], exclusions = p.excluded || [];
  const limitations = [...new Set([...(p.limitations || []),...(b.limitations || [])])];
  return `<div class="page-heading"><div><div class="eyebrow">ESTADOS FINANCIEROS</div><h1>La situación de tu empresa, en un informe.</h1><p>Consulta pérdidas y ganancias y balance de situación con los registros disponibles.</p></div></div>
    <section class="card statement-toolbar"><form id="statement-period-form"><label class="field"><span>Desde · pérdidas y ganancias</span><input type="date" name="statementFrom" value="${period.from}" required></label><label class="field"><span>Fecha de corte</span><input type="date" name="statementTo" value="${period.to}" required></label><button type="submit" class="button secondary">Aplicar fechas</button></form><div class="statement-downloads"><button type="button" class="button secondary" id="statements-csv">${icon('download')}Descargar detalle CSV</button><button type="button" class="button primary" id="statements-pdf">${icon('download')}Descargar los dos en PDF</button></div></section>
    ${accountantPanel(alignment)}
    <div class="statement-notice" role="note">${icon('info')}<div><strong>${p.accountantClose?'Referencia del gestor y operaciones posteriores':'Informe provisional · elaborado con los registros de la aplicación'}</strong><p>${p.accountantClose?'El cierre se utiliza una sola vez. El balance solo corresponde al gestor cuando coincide la fecha de corte; los períodos posteriores permanecen provisionales.':'El resultado final y el balance completo requieren revisar las partidas pendientes y los datos contables que faltan.'} El PDF conserva estas indicaciones.</p></div></div>
    <section class="statement-metrics" aria-label="Importes registrados"><article class="card"><span>Ventas sin IVA</span><strong>${esc(money(p.summary.salesBase))}</strong><small>Facturas emitidas del período, cobradas o no</small></article><article class="card"><span>Gastos con coste identificado</span><strong>${esc(money(p.summary.knownExpenses))}</strong><small>${p.accountantClose?'Cierre del gestor más costes posteriores identificados':'Las partidas sin valoración figuran pendientes'}</small></article><article class="card statement-metric-pending"><span>${p.status==='accountant-reference'?'Resultado según informe del gestor':'Resultado contable completo'}</span><strong>${p.status==='accountant-reference'?esc(money(p.summary.netResult)):'Por completar'}</strong><small>${p.status==='accountant-reference'?'Resultado mostrado por el gestor; revisar impuestos y aplicación del beneficio':'El subtotal antes de pendientes se muestra en la cuenta'}</small></article><article class="card"><span>Información pendiente</span><strong>${p.status==='accountant-reference'?'Ver observaciones':pending.length + missing.length}</strong><small>${p.status==='accountant-reference'?'Composición de cuentas y conciliación de justificantes':'Revisiones de la cuenta y del balance'}</small></article></section>
    <div class="statement-grid"><section class="card statement-section"><div class="card-header"><div><h2>Cuenta de pérdidas y ganancias</h2><p>Del ${dateLabel(period.from)} al ${dateLabel(period.to)} · criterio de devengo</p></div></div>${rowsTable('Cuenta de pérdidas y ganancias',p.lines || [],'No hay partidas registradas.')}<p class="statement-footnote">${p.accountantClose?'El informe conserva el cierre del gestor como referencia. Las partidas posteriores sin valoración no se han descontado y los importes no acreditan un dividendo disponible.':'Los presupuestos, las aportaciones de socios y los cobros de facturas no se cuentan como ventas adicionales. El resultado final permanece pendiente mientras falte información.'}</p></section>
    <section class="card statement-section"><div class="card-header"><div><h2>Balance de situación</h2><p>Situación a ${dateLabel(period.to)}</p></div></div><h3 class="statement-subheading">Activos identificados</h3>${rowsTable('Activos identificados',b.assets || [],'No hay activos identificados.')}<div class="statement-subtotal"><span>Suma de activos identificados</span><strong>${esc(amount(b.summary.knownAssets))}</strong></div><h3 class="statement-subheading">Pasivos identificados</h3>${rowsTable('Pasivos identificados',b.liabilities || [],'No hay deudas identificadas en los registros disponibles.')}<div class="statement-subtotal"><span>Suma de pasivos identificados</span><strong>${esc(amount(b.summary.knownLiabilities))}</strong></div><h3 class="statement-subheading">Patrimonio neto</h3>${rowsTable('Patrimonio neto',b.equity || [],'Pendiente de completar con los datos contables de la empresa.')}<p class="statement-footnote">${b.summary.balanced ? 'La comprobación aritmética no sustituye la revisión contable de las partidas.' : 'La igualdad entre activo, patrimonio neto y pasivo no puede verificarse con los datos disponibles. No se añade una partida artificial para cuadrarla.'}</p></section></div>
    ${b.status==='accountant-reference'?'':accountingForm(state,period)}
    <section class="card statement-review"><div class="card-header"><div><h2>Información para completar el informe</h2><p>Estas partidas también se incluyen en el PDF y en el detalle descargable.</p></div></div><div class="statement-review-grid"><div><h3>Pérdidas y ganancias · ${pending.length} revisiones</h3><ul class="statement-issues">${pending.map(issueHTML).join('') || '<li>Sin revisiones específicas registradas para este período.</li>'}</ul></div><div><h3>Balance · ${missing.length} datos por completar</h3><ul class="statement-issues">${missing.map(issueHTML).join('') || '<li>Sin datos adicionales identificados.</li>'}</ul></div></div></section>
    ${exclusions.length ? `<details class="card statement-details"><summary>Movimientos separados del resultado · ${exclusions.length}</summary><ul class="statement-issues">${exclusions.map(issueHTML).join('')}</ul></details>` : ''}
    <details class="card statement-details"><summary>Criterios y alcance del informe</summary><ul class="statement-method">${limitations.map(value=>`<li>${esc(value)}</li>`).join('')}</ul><p class="statement-footnote">El saldo bancario refleja los registros disponibles a la fecha de corte. Un extracto y la contabilidad del gestor permiten comprobar la integridad y el tratamiento de las partidas.</p></details>`;
}

function csvCell(value) {
  let text = known(value) ? value.toFixed(2).replace('.',',') : String(value ?? '');
  if (!known(value) && /^[\s\u0000-\u001f\u007f\uFEFF]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g,'""')}"`;
}

/** A traceable support export: blank amounts remain missing, rather than becoming zero. */
export function statementsCSV({period,profitLoss:p,balance:b,alignment}) {
  const rows = [['Estado financiero','Tipo de registro','Fecha','Concepto','Importe EUR','Criterio / situación']];
  rows.push(['General','Período',period.to,`Desde ${period.from} hasta ${period.to}`,'','Estados financieros provisionales · registros de la aplicación']);
  if(p.accountantClose) rows.push(['General','Referencia gestor',p.accountantClose.asOf,p.accountantClose.source,'','Los registros anteriores al cierre no se vuelven a sumar']);
  for (const row of p.lines || []) rows.push(['Pérdidas y ganancias','Partida',period.to,row.label,known(row.amount)?row.amount:'',known(row.amount)?'Importe identificado':'Por completar']);
  for (const row of p.invoices || []) rows.push(['Pérdidas y ganancias','Factura emitida',row.date,[row.number,row.description].filter(Boolean).join(' · '),known(row.amount)?row.amount:'','Venta sin IVA; criterio de devengo']);
  for (const row of p.expenses || []) rows.push(['Pérdidas y ganancias','Gasto de soporte',row.date,[row.description,row.supplier].filter(Boolean).join(' · '),known(row.costKnown)?row.costKnown:'',`Total del documento: ${known(row.grossTotal)?row.grossTotal.toFixed(2):'pendiente'} EUR. ${known(row.costKnown)?'Coste identificado':'Coste pendiente de confirmar'}`]);
  for (const row of p.pending || []) rows.push(['Pérdidas y ganancias','Revisión pendiente',row.date || period.to,row.label,known(row.amount)?row.amount:'','Importe de referencia; no es un coste neto confirmado']);
  for (const row of p.excluded || []) rows.push(['Pérdidas y ganancias','Separado del resultado',row.date || period.to,row.label,known(row.amount)?row.amount:'',row.type || 'Revisar clasificación contable']);
  for (const [group,entries] of [['Activo',b.assets],['Pasivo',b.liabilities],['Patrimonio neto',b.equity]]) for (const row of entries || []) rows.push(['Balance de situación',group,b.asOf,row.label,known(row.amount)?row.amount:'',row.source || 'Partida identificada']);
  for (const row of b.missing || []) rows.push(['Balance de situación','Dato pendiente',b.asOf,row.label,'','Por completar; no equivale a cero']);
  for (const row of b.pending || []) rows.push(['Balance de situación','Revisión pendiente',b.asOf,row.label,known(row.amount)?row.amount:'','Importe de referencia por comprobar']);
  if(alignment){
    const a=alignment;rows.push(['Previsión','Referencia',a.close.asOf,a.close.source,a.close.profitLoss.resultBeforeTax,'Resultado antes de impuestos según gestor']);
    for(const row of a.comparison) rows.push(['Conciliación','Diferencia',a.close.asOf,row.label,row.difference,`Gestor: ${row.accountant.toFixed(2)} EUR; portal identificado: ${row.application.toFixed(2)} EUR`]);
    for(const [key,label] of [['futureSales','Ventas futuras sin IVA'],['futureCosts','Costes futuros'],['payrollCost','Coste adicional de nómina'],['taxProvision','Provisión estimada IS']]) rows.push(['Previsión','Hipótesis',a.through,label,a.forecast[key]??'','No es una operación real ni un impuesto presentado']);
    rows.push(['Previsión','Estimación',a.through,'Resultado antes de impuestos y partidas pendientes',a.beforeTax,'Provisional; no equivale al dividendo repartible']);
    rows.push(['Previsión','Pendientes',a.through,'Importes posteriores pendientes de valoración',a.pendingGross,'No descontados del subtotal']);
    rows.push(['Previsión','Estimación',a.through,'Después de provisión indicada',a.afterTax??'','Por completar si falta impuesto o hay revisiones pendientes']);
  }
  for (const text of [...new Set([...(p.limitations || []),...(b.limitations || [])])]) rows.push(['General','Criterio',period.to,text,'','Alcance del informe']);
  return '\ufeff' + rows.map(row=>row.map(csvCell).join(';')).join('\r\n');
}

const save = (blob,name) => { const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000); };

async function logoData(url) {
  if (!url) return undefined;
  const response = await fetch(url);
  if (!response.ok) throw new Error('No se ha podido cargar el logo del informe. Vuelve a intentarlo.');
  const blob = await response.blob();
  return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('No se ha podido preparar el logo.'));reader.readAsDataURL(blob);});
}

export function bindStatements(root,ctx) {
  const form=root.querySelector('#statement-period-form');if(!form)return;
  bindAccountant(root,ctx,activePeriod);
  form.onsubmit=event=>{
    event.preventDefault();
    const from=form.elements.statementFrom.value,to=form.elements.statementTo.value;
    if(!validDate(from)||!validDate(to)||from>to){ctx.toast('Revisa las fechas: el inicio debe ser anterior o igual a la fecha de corte.',true);return;}
    activePeriod={from,to};ctx.setViewState?.('statements',activePeriod);ctx.render();
  };
  const accounting=root.querySelector('#statement-accounting-form');
  if(accounting){
    const canEdit=ctx.getMode()!=='cloud'||ctx.getBackend()?.workspaceInfo?.()?.role==='admin';
    accounting.querySelector('fieldset').disabled=!canEdit;
    accounting.querySelector('[data-accounting-permission]').textContent=canEdit?'':'Solo administración puede guardar los datos contables compartidos.';
    accounting.onsubmit=async event=>{
      event.preventDefault();if(!canEdit||ctx.isBusy())return;
      try{
        const inputs=statementInputs({asOf:activePeriod.to,capitalSocial:accounting.elements.capitalSocial.value,financialDebt:accounting.elements.financialDebt.value,bankBalance:accounting.elements.bankBalance.value,capitalFundingPending:accounting.elements.capitalFundingPending.checked,source:accounting.elements.statementSource.value});
        await ctx.commit(state=>{state.company.statementInputs=inputs;},'Datos del balance guardados con su fuente.');
      }catch(error){ctx.toast(error.message,true);}
    };
  }
  const reports=()=>buildStatements(ctx.getState(),activePeriod || {},ctx.getStatementsOptions?.() || {});
  const name=()=>`Orquivia_Estados_financieros_${activePeriod.from}_${activePeriod.to}`;
  const csv=root.querySelector('#statements-csv');if(csv)csv.onclick=()=>save(new Blob([statementsCSV(reports())],{type:'text/csv;charset=utf-8'}),`${name()}.csv`);
  const button=root.querySelector('#statements-pdf');if(button)button.onclick=async()=>{
    if(ctx.isBusy())return;
    const mode=ctx.getMode(),backend=mode==='cloud'?ctx.getBackend():null,isCurrent=ctx.operationScope?.(),state=structuredClone(ctx.getState()),selected={...activePeriod},options=structuredClone(ctx.getStatementsOptions?.() || {});
    ctx.setBusy(true);root.querySelectorAll('#statement-period-form input,#statement-period-form button,#statements-pdf,#statements-csv').forEach(node=>node.disabled=true);button.textContent='Preparando informe…';
    try{
      const [{createStatementsPDF},logo]=await Promise.all([import('./statements-pdf.js'),logoData(ctx.logo)]);
      if((isCurrent&&!isCurrent())||ctx.getMode()!==mode||(backend&&ctx.getBackend()!==backend))throw new Error('La sesión ha cambiado. Vuelve a abrir el informe.');
      const {profitLoss,balance,alignment}=buildStatements(state,selected,options);
      const pdf=createStatementsPDF({company:state.company,profitLoss,balance,alignment,logoData:logo,demo:mode==='demo'});
      save(pdf.output('blob'),`Orquivia_Estados_financieros_${selected.from}_${selected.to}.pdf`);
      ctx.toast('PDF preparado con los dos estados y sus partidas pendientes de revisión.');
    }catch(error){ctx.toast(error.message,true)}finally{ctx.setBusy(false);ctx.render();}
  };
}

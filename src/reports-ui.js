import './reports.css';
import { money, todayISO, escapeHTML as esc, totals } from './domain.js';
import { periodReport, reportCSV, expenseCashMovements, taxCashMovements, expenseNeedsReview, expenseVATLabel } from './expenses.js';
import { buildPeriodBundle } from './quarter-export.js';
import { localReceipt } from './expense-ui.js';
import { icon } from './icons.js';
import { taxSection, bindTaxSection } from './tax-ui.js';
import { monthlyCashActivity } from './cash-activity.js';
import { renderCashActivityChart } from './cash-chart.js';
import { renderFinancialTotals } from './financial-summary.js';

let period={type:'quarter',year:Number(todayISO().slice(0,4)),quarter:Math.ceil(Number(todayISO().slice(5,7))/3)};
const select=(label,name,options,value)=>`<label class="field"><span>${label}</span><select name="${name}">${options.map(([v,l])=>`<option value="${v}" ${String(value)===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
const save=(blob,name)=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)};
const dateLabel=value=>value?new Intl.DateTimeFormat('es-ES',{dateStyle:'medium',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z')):'—';
const csvName=()=>`Orquivia_${period.type==='all'?'historico':period.year+(period.type==='quarter'?'_T'+period.quarter:'_anual')}.csv`;

export function reportsPage(state,preferences){
  if(preferences)period={...period,...preferences};
  const report=periodReport(state,period),s=report.summary;
  const years=[...new Set([Number(todayISO().slice(0,4)),period.year,...state.documents.map(d=>Number(d.date.slice(0,4))),...(state.expenses||[]).map(e=>Number(e.date.slice(0,4))),...state.payments.map(p=>Number(p.date.slice(0,4))),...(state.expenses||[]).flatMap(e=>expenseCashMovements(e).map(p=>Number(p.date.slice(0,4)))),...(state.taxRecords||[]).map(t=>t.year),...(state.taxRecords||[]).flatMap(t=>taxCashMovements(t).map(p=>Number(p.date.slice(0,4))))])].sort((a,b)=>b-a);
  const rows=[...report.invoices.map(d=>({id:d.id,kind:'invoice',date:d.date,name:d.number,detail:d.client?.name||d.clientSnapshot?.name||'',total:totals(d).total})),...report.expenses.map(e=>({id:e.id,kind:'expense',date:e.date,name:e.description,detail:[e.supplier,e.vatDocumentStatus?expenseVATLabel(e):''].filter(Boolean).join(' · '),total:e.total,review:expenseNeedsReview(e)}))].sort((a,b)=>b.date.localeCompare(a.date));
  const activity=monthlyCashActivity(state,period);
  return `<div class="page-heading"><div><div class="eyebrow">INFORMACIÓN PARA TU GESTOR</div><h1>Tus cuentas, con perspectiva.</h1><p>Reúne las facturas emitidas, los gastos y sus justificantes en un solo expediente.</p></div><button class="button secondary" data-action="expense-import">${icon('upload')}Importar gastos revisados</button></div>
    <section class="card quarter-card"><div class="card-header"><div><h2>${esc(report.label)}</h2><p>${report.from?dateLabel(report.from)+' – '+dateLabel(report.to):'Sin documentos registrados'}</p></div><div class="report-selects">${select('Ver','reportType',[['quarter','Un trimestre'],['year','Un año completo'],['all','Todo el histórico']],period.type)}${period.type!=='all'?select('Año','reportYear',years.map(y=>[String(y),String(y)]),period.year):''}${period.type==='quarter'?select('Trimestre','reportQuarter',[['1','T1 · enero–marzo'],['2','T2 · abril–junio'],['3','T3 · julio–septiembre'],['4','T4 · octubre–diciembre']],period.quarter):''}</div></div>
    ${renderFinancialTotals(report,activity)}
    <div class="quarter-actions"><p>${s.reviewCount?`${s.reviewCount} registros por revisar. `:''}El expediente incluye un listado CSV, las facturas PDF, los justificantes originales y un resumen para el gestor.</p><button class="button secondary" id="report-csv">${icon('download')}Descargar listado CSV</button><button class="button primary" id="report-bundle">${icon('download')}Descargar expediente</button></div></section>
    ${renderCashActivityChart(activity)}
    <section class="card report-evaluation"><div class="card-header"><div><h2>El desglose de IVA y bases</h2><p>Importes registrados para preparar la revisión con el gestor.</p></div>${icon('grid')}</div><div class="report-vat-metrics"><div><span>IVA repercutido</span><strong>${money(s.outputVAT)}</strong><small>De las facturas emitidas</small></div><div><span>IVA soportado registrado</span><strong>${money(s.inputVATRecorded)}</strong><small>${s.vatReviewCount||0} gastos con IVA sin confirmar</small></div></div><div class="report-evaluation-grid"><div><span>Ventas sin IVA</span><strong>${money(s.salesBase)}</strong></div><div><span>Base de gastos desglosados</span><strong>${money(s.expenseBase)}</strong></div><div><span>Diferencia de bases</span><strong>${s.activityDifference===null?'Por revisar':money(s.activityDifference)}</strong></div><div><span>Gastos con IVA sin desglosar</span><strong>${money(s.vatReviewTotal)}</strong></div></div><p class="report-hint">La diferencia compara las bases registradas. Suplidos e importes adicionales: ${money(s.additionalTotal)}. Los importes cuyo IVA está sin confirmar cuentan en gastos y pagos; su base y cuota de IVA quedan pendientes de revisión por el gestor.</p></section>
    <section class="card"><div class="card-header"><div><h2>Facturas y gastos del período</h2><p>Abre un documento para revisar sus datos.</p></div><span class="count-chip">${rows.length}</span></div><div class="table-scroll"><table><thead><tr><th>Documento / concepto</th><th>Tipo</th><th>Fecha</th><th>Total</th></tr></thead><tbody>${rows.map(row=>`<tr><td><button class="doc-link" ${row.kind==='invoice'?`data-action="view" data-id="${esc(row.id)}"`:`data-expense="${esc(row.id)}"`}><span class="doc-icon ${row.kind==='invoice'?'invoice':'quote'}">${icon(row.kind==='invoice'?'invoice':'euro')}</span><span><strong>${esc(row.name)}</strong><small>${esc(row.detail||'')}${row.review?' · Por revisar':''}</small></span></button></td><td>${row.kind==='invoice'?'Factura':'Gasto'}</td><td class="date-cell">${dateLabel(row.date)}</td><td class="amount">${money(row.total)}</td></tr>`).join('')||'<tr><td colspan="4"><div class="empty-state">No hay documentos en este período.</div></td></tr>'}</tbody></table></div></section>${taxSection(state,report.taxRecords)}`;
}

export function bindReports(root,ctx){
  bindTaxSection(root,ctx);
  for(const [name,key] of [['reportType','type'],['reportYear','year'],['reportQuarter','quarter']]){
    const control=root.querySelector(`[name="${name}"]`);if(control)control.onchange=()=>{period[key]=key==='type'?control.value:Number(control.value);ctx.setViewState?.('reports',period);ctx.render()};
  }
  const csv=root.querySelector('#report-csv');if(csv)csv.onclick=()=>save(new Blob([reportCSV(ctx.getState(),period)],{type:'text/csv;charset=utf-8'}),csvName());
  const button=root.querySelector('#report-bundle');if(button)button.onclick=async()=>{
    if(ctx.isBusy())return;
    ctx.setBusy(true);root.querySelectorAll('.report-selects select,#report-csv,#report-bundle').forEach(node=>node.disabled=true);
    try{
      const bundle=await buildPeriodBundle(ctx.getState(),{...period},{backend:ctx.getMode()==='cloud'?ctx.getBackend():null,downloadLocalReceipt:localReceipt,logoUrl:ctx.logo,demo:ctx.getMode()==='demo',onProgress:({completed,total})=>{button.textContent=`Preparando ${completed} / ${total}…`}});
      save(bundle.blob,bundle.name);ctx.toast(`Expediente preparado: ${bundle.invoiceCount} facturas y ${bundle.receiptCount} justificantes.`);
    }catch(error){ctx.toast(error.message,true)}finally{ctx.setBusy(false);ctx.render()}
  };
}

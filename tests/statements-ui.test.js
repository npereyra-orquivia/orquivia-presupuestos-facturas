import test from 'node:test';
import assert from 'node:assert/strict';
import { statementPeriod, statementInputs, buildStatements, statementsPage, statementsCSV, bindStatements } from '../src/statements-ui.js';

const period={from:'2026-01-01',to:'2026-10-22'};
const invoice=overrides=>({id:'invoice',kind:'invoice',status:'issued',number:'F-2026-001',date:'2026-09-01',items:[{description:'Servicio',quantity:1,price:1000}],vat:21,withholding:0,discount:0,...overrides});
const expense=overrides=>({id:'expense',description:'Material',supplier:'Proveedor',category:'Material',date:'2026-10-02',base:100,vatAmount:21,total:121,vatDeductibleAmount:21,paymentStatus:'paid',paidDate:'2026-10-02',attachments:[{id:'receipt'}],...overrides});
const state=overrides=>({company:{name:'Empresa',openingBalance:1000,openingBalanceDate:'2026-01-01'},documents:[invoice()],payments:[],expenses:[],taxRecords:[],...overrides});

test('statement period defaults to the selected closing year and validates calendar boundaries',()=>{
  assert.deepEqual(statementPeriod({},'2026-10-22'),period);
  assert.deepEqual(statementPeriod({to:'2025-12-31'},'2026-10-22'),{from:'2025-01-01',to:'2025-12-31'});
  assert.deepEqual(statementPeriod({from:'2026-03-01',to:'2026-02-30'},'2026-10-22'),{from:'2026-03-01',to:'2026-10-22'});
  assert.deepEqual(statementPeriod({from:'2026-11-01',to:'2026-10-22'},'2026-10-22'),period);
});

test('the primary view keeps the complete result unavailable while exposing partial figures, bank sources and missing equity',()=>{
  const html=statementsPage(state({expenses:[expense({base:529,vatAmount:0,total:529,vatReviewNeeded:true,vatDeductibleAmount:0,attachments:[]})]}),period);
  assert.match(html,/Informe provisional/);
  assert.match(html,/Resultado contable completo<\/span><strong>Por completar/);
  assert.match(html,/Resultado parcial antes de partidas pendientes/);
  assert.match(html,/igualdad entre activo, patrimonio neto y pasivo no puede verificarse/);
  assert.match(html,/Conciliar el saldo calculado/);
  assert.match(html,/Pendiente de completar con los datos contables/);
  assert.match(html,/Guardar datos del balance/);
  assert.match(html,/Descargar los dos en PDF/);
  assert.ok(!html.includes('Resultado contable completo</span><strong>1.000'));
});

test('record descriptions and declared accounting sources cannot inject HTML into the review or form',()=>{
  const unsafe='<img src=x onerror=bad()>',s=state({expenses:[expense({description:unsafe,vatReviewNeeded:true,attachments:[]})]});
  s.company.statementInputs={asOf:period.to,capitalSocial:3000,source:'</textarea><script>bad()</script>'};
  const html=statementsPage(s,period);
  assert.ok(!html.includes(unsafe));assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;img'));assert.ok(html.includes('&lt;/textarea&gt;'));
});

test('accounting declarations preserve explicit zero, omit blanks, require provenance and never prefill capital',()=>{
  assert.deepEqual(statementInputs({asOf:period.to,capitalSocial:'',financialDebt:'0',source:' Titular, a fecha de corte '}),{asOf:period.to,source:'Titular, a fecha de corte',financialDebt:0});
  assert.equal(statementInputs({asOf:period.to,capitalSocial:'3000,00',financialDebt:'',source:'Escritura aportada'}).capitalSocial,3000);
  for(const input of [{asOf:period.to,capitalSocial:'1',source:''},{asOf:period.to,capitalSocial:'',financialDebt:'',source:'Sin datos'},
    {asOf:'2026-02-30',capitalSocial:'1',source:'Fuente'},{asOf:period.to,capitalSocial:'0x10',source:'Fuente'},
    {asOf:period.to,capitalSocial:'-1',source:'Fuente'},{asOf:period.to,capitalSocial:'1.001',source:'Fuente'}])assert.throws(()=>statementInputs(input));
  const html=statementsPage(state(),period);
  assert.match(html,/name="capitalSocial"[^>]*value=""/);
  assert.match(html,/name="financialDebt"[^>]*value=""/);
});

test('declared balances apply only to their exact closing date without altering workspace data',()=>{
  const s=state();s.company.statementInputs={asOf:period.to,capitalSocial:3000,financialDebt:0,source:'Declaración contrastada'};
  const before=JSON.stringify(s),result=buildStatements(s,period);
  assert.equal(result.balance.equity.find(row=>row.id==='manual:declared-capital').amount,3000);
  assert.equal(result.balance.liabilities.find(row=>row.id==='manual:declared-financing').amount,0);
  assert.equal(result.balance.summary.balanced,false);
  const previous=buildStatements(s,{from:period.from,to:'2026-10-21'});
  assert.equal(previous.balance.equity.length,0);
  assert.equal(JSON.stringify(s),before);
  s.company.statementInputs.capitalSocial=-1;assert.throws(()=>buildStatements(s,period),/no negativos/);
});

test('support CSV keeps missing values blank and protects spreadsheet formulas in external text',()=>{
  const report=buildStatements(state({documents:[invoice({number:'=HYPERLINK("https://example.test")'})],expenses:[expense({description:'Un gasto sin desglose',vatReviewNeeded:true})]}),period);
  const csv=statementsCSV(report);
  assert.ok(csv.startsWith('\ufeff'));
  assert.match(csv,/'=HYPERLINK/);
  assert.match(csv,/'=HYPERLINK\(""https:\/\/example\.test""\)/);
  const finalLine=csv.split('\r\n').find(row=>row.includes('Resultado contable completo'));
  assert.match(finalLine,/;"";"Por completar"$/);
  assert.ok(csv.includes('Total del documento: 121.00 EUR. Coste pendiente de confirmar'));
  assert.ok(csv.includes('Conciliar el saldo calculado'));
  const hiddenPrefix=statementsCSV(buildStatements(state({documents:[invoice({number:'\u0000=SUM(1)'})]}),period));
  assert.ok(hiddenPrefix.includes("'\u0000=SUM(1)"));
});

test('a logout while the PDF module is loading aborts the private export before creating a document',async()=>{
  statementsPage(state(),period);
  let mode='cloud',busy=false,rendered=0;const messages=[],backend={};
  const form={elements:{},onsubmit:null},button={textContent:'',disabled:false},csv={};
  const root={querySelector:selector=>({'#statement-period-form':form,'#statements-pdf':button,'#statements-csv':csv}[selector] || null),querySelectorAll:()=>[button]};
  const ctx={getState:()=>state(),getMode:()=>mode,getBackend:()=>backend,isBusy:()=>busy,setBusy:value=>{busy=value},render:()=>{rendered++},toast:(...values)=>messages.push(values)};
  bindStatements(root,ctx);
  const work=button.onclick();mode='locked';await work;
  assert.equal(busy,false);assert.equal(rendered,1);
  assert.ok(messages.some(([message,error])=>error&&message.includes('sesión ha cambiado')));
});

test('bank and declared capital retain reconciliation and funding warnings without creating cash or a balancing entry',()=>{
  const s=state();s.company.statementInputs=statementInputs({asOf:period.to,capitalSocial:'3000',financialDebt:'0',bankBalance:'1724,47',capitalFundingPending:true,source:'Escritura transcrita; desembolso pendiente y extracto aportado'});
  const result=buildStatements(s,period);
  assert.equal(result.balance.summary.bankBalance,1724.47);
  assert.equal(result.balance.pending.find(row=>row.id==='bank-difference').amount,724.47);
  assert.ok(result.balance.pending.some(row=>row.id==='capital-funding'));
  assert.equal(s.company.openingBalance,1000);
  const old=buildStatements(s,{from:period.from,to:'2026-10-21'});
  assert.equal(old.balance.summary.bankBalance,1000);
  assert.ok(!old.balance.pending.some(row=>row.id==='capital-funding'));
  assert.equal(statementInputs({asOf:period.to,bankBalance:'-20.50',source:'Descubierto del extracto'}).bankBalance,-20.5);
  assert.match(statementsPage(s,period),/Desembolso del capital pendiente de acreditar/);
});

test('a change of identity with the same backend aborts a pending private PDF export',async()=>{
  statementsPage(state(),period);
  let current=true,busy=false;const messages=[],backend={},button={},csv={},form={};
  const root={querySelector:key=>({'#statement-period-form':form,'#statements-pdf':button,'#statements-csv':csv}[key]||null),querySelectorAll:()=>[button]};
  bindStatements(root,{getState:()=>state(),getMode:()=> 'cloud',getBackend:()=>backend,operationScope:()=>()=>current,isBusy:()=>busy,setBusy:value=>{busy=value},render:()=>{},toast:(...args)=>messages.push(args)});
  const work=button.onclick();current=false;await work;
  assert.ok(messages.some(([message,error])=>error&&message.includes('sesión ha cambiado')));
});

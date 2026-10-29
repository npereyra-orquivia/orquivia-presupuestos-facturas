import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccountantClose, accountantAlignment, alignStatements, forecastInputs } from '../src/accountant-close.js';
import { buildStatements, statementsCSV, statementsPage } from '../src/statements-ui.js';
import { createStatementsPDF } from '../src/statements-pdf.js';

// Synthetic amounts and identities only. Real company reports stay outside Git.
const close = () => ({ format:'orquivia-accountant-close',version:1,from:'2026-01-01',asOf:'2026-09-30',issuedAt:'2026-10-20',taxId:'B00000000',source:'Informe sintético',sources:[{name:'example.pdf',sha256:'a'.repeat(64)}],notes:['Revisar la composición de la cuenta de socia.'],profitLoss:{sales:10000,expenses:[{account:'623',label:'Servicios de ejemplo',amount:1000}],resultBeforeTax:9000,result:9000,corporateTax:null},balance:{assets:[{account:'572',label:'Banco de ejemplo',amount:12000}],liabilities:[],equity:[{account:'100',label:'Capital de ejemplo',amount:3000},{account:'129',label:'Resultado',amount:9000}]},taxFilings:[{model:'303',year:2026,quarter:3,result:-50}] });
const invoice = (id,date,price) => ({id,kind:'invoice',number:id,clientId:'client',status:'issued',date,dueDate:date,items:[{description:'Ejemplo',quantity:1,price}],vat:21,withholding:0,discount:0});
const expense = (id,date,total,unknown=false) => ({id,description:'Gasto sintético',date,paidDate:date,total,base:unknown?total:total/1.21,vatAmount:unknown?0:total-total/1.21,vatDeductibleAmount:unknown?0:total-total/1.21,vatReviewNeeded:unknown,paymentStatus:'paid',attachments:[{id:'receipt'}]});
const state = () => ({company:{name:'Ejemplo',taxId:'B00000000',openingBalance:0,openingBalanceDate:'2026-01-01',accountantClose:close()},clients:[],documents:[invoice('old','2026-09-01',10000),invoice('new','2026-10-02',200)],payments:[],expenses:[expense('old-expense','2026-09-02',1210),expense('new-expense','2026-10-03',121)],taxRecords:[]});
const period = {from:'2026-01-01',to:'2026-10-22'};

test('a sourced close must balance, match its result and belong to the active company',()=>{
  assert.equal(validateAccountantClose(close(),{taxId:'B-00000000'}).profitLoss.result,9000);
  for(const change of [c=>c.balance.assets[0].amount++,c=>c.profitLoss.result++,c=>c.profitLoss.expenses[0].amount++,c=>c.sources[0].sha256='bad',c=>c.taxFilings[0].quarter=4]){
    const c=close();change(c);assert.throws(()=>validateAccountantClose(c));
  }
  assert.throws(()=>validateAccountantClose(close(),{taxId:'B11111111'}),/NIF/);
  const c=close();c.profitLoss.sales='10000';assert.throws(()=>validateAccountantClose(c),/importe/);
});

test('the historical close replaces report calculations without changing any operational record',()=>{
  const s=state(),original=structuredClone(s),r=buildStatements(s,{from:'2026-01-01',to:'2026-09-30'});
  assert.equal(r.profitLoss.summary.salesBase,10000);assert.equal(r.profitLoss.summary.knownExpenses,1000);
  assert.equal(r.profitLoss.summary.netResult,9000);assert.equal(r.profitLoss.pending.length,0);
  assert.equal(r.balance.summary.knownAssets,12000);assert.equal(r.balance.summary.equity,12000);assert.equal(r.balance.summary.balanced,true);
  assert.deepEqual(s,original);
});

test('post-close accrual adds only subsequent invoices and costs and leaves the later balance provisional',()=>{
  const r=buildStatements(state(),period);
  assert.equal(r.profitLoss.summary.salesBase,10200);assert.equal(r.profitLoss.summary.knownExpenses,1100);
  assert.equal(r.profitLoss.summary.resultBeforePending,9100);assert.equal(r.profitLoss.invoices.length,1);
  assert.equal(r.profitLoss.summary.netResult,null);assert.equal(r.balance.summary.complete,false);
  assert.equal(r.alignment.comparison[1].difference,0);
  const unrelated=buildStatements(state(),{from:'2026-10-01',to:period.to});assert.equal(unrelated.profitLoss.summary.salesBase,200);
});

test('unvalued later bank charges prevent a net forecast and never silently become zero-cost profit',()=>{
  const s=state();s.expenses.push(expense('unvalued','2026-10-04',300,true));
  s.company.accountantForecast={futureSales:500,futureCosts:100,payrollCost:200,taxProvision:30};
  const a=accountantAlignment(s,period,{actualThrough:'2026-10-22'});
  assert.equal(a.pendingGross,300);assert.equal(a.beforeTax,9300);assert.equal(a.afterTax,null);assert.ok(a.later.pending.length);
  s.expenses.pop();assert.equal(accountantAlignment(s,period).afterTax,9270);
  const none=state();assert.equal(accountantAlignment(none,period).afterTax,null);
  assert.deepEqual(forecastInputs({futureSales:'250,25',taxProvision:''}),{futureSales:250.25,futureCosts:0,payrollCost:0,taxProvision:null});
  for(const raw of ['-1','Infinity','1e3','5.555'])assert.throws(()=>forecastInputs({futureCosts:raw}));
});

test('future-year documents never enter a forecast for the closing year',()=>{
  const s=state();s.documents.push(invoice('future-year','2027-01-02',50000));
  const a=accountantAlignment(s,{from:'2026-01-01',to:'2027-01-31'},{actualThrough:'2027-01-31'});
  assert.equal(a.through,'2026-12-31');assert.equal(a.beforeTax,9100);
});

test('HTML, CSV and PDF retain source, cutoff, comparison and explicit forecast limitations',()=>{
  const s=state();s.company.accountantClose.source='<script>alert(1)</script>';
  const r=buildStatements(s,period),html=statementsPage(s,period),csv=statementsCSV(r);
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.match(html,/Previsión a 31\/12\/2026/);
  assert.match(csv,/Referencia gestor/);assert.match(csv,/2026-09-30/);assert.match(csv,/Hipótesis/);assert.match(csv,/dividendo repartible/);
  const pdf=createStatementsPDF({company:s.company,profitLoss:r.profitLoss,balance:r.balance,alignment:r.alignment});
  assert.ok(pdf.getNumberOfPages()>=4);
});

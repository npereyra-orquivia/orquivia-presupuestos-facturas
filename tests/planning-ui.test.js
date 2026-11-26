import test from 'node:test';
import assert from 'node:assert/strict';
import { planningPage, planningCashChart, forecastLinkOptions, forecastLinkedIDs } from '../src/planning-ui.js';
import { defaultPlanning } from '../src/planning.js';
import { forecastLedger } from '../src/forecast-ledger.js';
import { forecastTreasuryChart, forecastMatrix } from '../src/forecast-ui.js';

const today='2026-11-25';
function fixture(){
  const planning=defaultPlanning({today});
  planning.settings.profitOverride=24000;
  planning.settings.cashBalanceOverride=26000;
  planning.settings.people[0].name='Alicia <img src=x onerror=alert(1)>';
  planning.settings.people[0].externalSalary=35000;
  planning.settings.people[0].employeeSS=2200;
  planning.settings.people[0].taxProfileKnown=true;
  planning.scenarios=[{id:'safe-scenario',name:'Escenario <script>alert(1)</script>',dividendDate:null,notes:'',people:[{personId:planning.settings.people[0].id,workGross:8000,dividendGross:0}]}];
  return {company:{name:'Empresa de prueba'},clients:[],documents:[],payments:[],expenses:[],taxRecords:[],planning};
}
test('scenario comparison renders the same baseline and independent people without executable user markup',()=>{
  const html=planningPage(fixture(),{today,page:'scenarios'});
  assert.match(html,/Dejarlo en Orquivia/);
  assert.match(html,/data-planning-comparison/);
  assert.match(html,/data-plan-range/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.match(html,/IRPF pendiente de completar/);
});
test('forecast render keeps operational records separate and identifies monthly and equipment plans',()=>{
  const s=fixture(),original=structuredClone(s);
  s.planning.items=[{id:'monthly',label:'Cuota periódica',kind:'expense',amountGross:180,vatRate:null,vatDeductible:false,treatment:'operating',recurrence:'monthly',startDate:'2026-12-10',endDate:null,active:true,linkedRecordIds:[]},
    {id:'asset',label:'Equipo de trabajo',kind:'expense',amountGross:1200,vatRate:null,vatDeductible:false,treatment:'asset',recurrence:'once',startDate:'2026-12-15',endDate:null,active:true,linkedRecordIds:[]}];
  const html=planningPage(s,{today,page:'forecast'});
  assert.match(html,/Cada mes/);assert.match(html,/Compra de equipo/);assert.match(html,/1\.380,00/);
  assert.match(html,/no crea un gasto ni un cobro real/);
  assert.deepEqual(s.documents,original.documents);assert.deepEqual(s.expenses,original.expenses);
});
test('forecast chart handles zero, missing cash and negative cash without invalid geometry',()=>{
  for(const width of [230,736,1200]){
    const html=planningCashChart([{month:'2026-11',inflows:0,outflows:0,closingCash:null},{month:'2026-12',inflows:100,outflows:600,closingCash:-500}],{width});
    assert.match(html,/role="img"/);assert.match(html,/Saldo por completar|Dinero en cuenta/);
    assert.ok(!/NaN|Infinity|undefined/.test(html));
    assert.match(html,/planning-chart-cost/);
  }
});

test('monthly cash view distinguishes linked real movements and the remaining forecast with traceability',()=>{
  const s=fixture();
  s.expenses=[{id:'advisor-nov',date:'2026-11-10',description:'Asesoría <img src=x>',supplier:'Proveedor',base:150,vatAmount:30,vatDeductibleAmount:30,total:180,paymentStatus:'paid',paidDate:'2026-11-10'}];
  s.planning.items=[{id:'advisor',label:'Asesoría <script>alert(1)</script>',kind:'expense',amountGross:180,vatRate:20,vatDeductible:true,treatment:'operating',recurrence:'monthly',startDate:'2026-11-10',endDate:'2026-12-10',active:true,linkedRecordIds:['advisor-nov']}];
  const original=structuredClone(s),html=planningPage(s,{today,page:'forecast'});
  assert.match(html,/Tu año, mes a mes/);
  assert.match(html,/Total 2026/);
  assert.match(html,/forecast-actual/);assert.match(html,/forecast-expected/);
  assert.match(html,/data-plan-action="inspect-cell"/);
  assert.match(html,/data-month="2026-11"/);assert.match(html,/data-month="2026-12"/);
  assert.match(html,/forecast-cell-dialog/);
  assert.match(html,/1 vinculado/);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('<img src=x>'));
  assert.deepEqual(s,original);
});

test('forecast exposes undecided VAT and past unlinked plans without treating them as settled cash',()=>{
  const s=fixture();
  s.expenses=[{id:'unknown',date:'2026-11-11',description:'Justificante sin desglose',base:12,vatAmount:0,vatDeductibleAmount:0,total:12,vatReviewNeeded:true,paymentStatus:'paid',paidDate:'2026-11-11'}];
  s.planning.items=[{id:'past',label:'Por comprobar',kind:'expense',amountGross:100,vatRate:null,vatDeductible:false,treatment:'operating',recurrence:'once',startDate:'2026-11-10',endDate:null,active:true,linkedRecordIds:[]}];
  const html=planningPage(s,{today,page:'forecast'});
  assert.match(html,/Previsiones por revisar/);
  assert.match(html,/Quedan fuera de la caja/);
  assert.match(html,/1 gasto registrado y 0 previsiones con IVA pendiente/);
  assert.match(html,/IVA de facturas registradas/);
  assert.match(html,/IVA deducible confirmado en gastos/);
  assert.match(html,/enero del año siguiente/);
});

test('new treasury chart separates known history and future and handles a partial-year balance anchor',()=>{
  const s=fixture(),ledger=forecastLedger(s,s.planning,{today});
  for(const width of [260,800,1200]){
    const html=forecastTreasuryChart(ledger,{width});
    assert.match(html,/role="img"/);
    assert.match(html,/línea discontinua: previsto/i);
    assert.ok(!/NaN|Infinity|undefined/.test(html));
  }
});

test('offsetting movements retain a zero-value cell and its drilldown',()=>{
  const cell={actual:0,expected:0,entries:[{status:'actual',amount:100},{status:'actual',amount:-100}]};
  const ledger={year:2026,asOf:today,horizon:'2026-12-31',months:[{key:'2026-11',label:'Nov'}],rows:[{id:'refund',label:'Pago y devolución',kind:'expense',source:'expense',months:{'2026-11':cell},actual:0,expected:0}],series:[],totals:{},openingBalance:null,closingBalance:null};
  const html=forecastMatrix(ledger);
  assert.match(html,/data-plan-action="inspect-cell"/);
  assert.match(html,/data-row="refund"/);
  assert.match(html,/title="Real: 0,00/);
});

test('editing a forecast roundtrips accepted quotes, tax records and unavailable linked IDs',()=>{
  const s=fixture();
  s.documents=[{id:'quote-link',kind:'quote',status:'accepted',number:'PR-2026-001',date:'2026-11-01'},
    {id:'old-draft',kind:'invoice',status:'draft',date:'2026-11-01'}];
  s.taxRecords=[{id:'tax-link',model:'303',reference:'T4',amount:150,date:'2026-12-31'}];
  const original=['quote-link','tax-link','old-draft','missing-link'];
  const options=forecastLinkOptions(s,original),represented=options.map(option=>option.id);
  assert.match(options.find(option=>option.id==='quote-link').label,/Presupuesto aceptado/);
  assert.match(options.find(option=>option.id==='tax-link').label,/Impuesto · Modelo 303/);
  assert.equal(options.find(option=>option.id==='old-draft').orphan,true);
  assert.equal(options.find(option=>option.id==='missing-link').orphan,true);
  const selected=options.filter(option=>original.includes(option.id)).map(option=>option.id);
  assert.deepEqual(forecastLinkedIDs(selected,represented,original),original);
  assert.deepEqual(forecastLinkedIDs(selected.filter(id=>id!=='quote-link'),represented,original),original.filter(id=>id!=='quote-link'));
  assert.deepEqual(forecastLinkedIDs(['quote-link','tax-link'],['quote-link','tax-link'],original),original);
});

test('forecast year-end label and VAT uncertainty stay inside the displayed exercise and horizon',()=>{
  const s=fixture();s.planning.settings.horizon='2027-01-11';
  s.planning.items=[{id:'next-year',label:'Servicio futuro',kind:'expense',amountGross:100,vatRate:null,vatDeductible:false,treatment:'operating',recurrence:'once',startDate:'2027-01-10',endDate:null,active:true,linkedRecordIds:[]}];
  const html=planningPage(s,{today,page:'forecast'});
  assert.match(html,/<small>A 31\/12\/2026<\/small>/);
  assert.ok(!html.includes('1 previsión con IVA pendiente'));
  assert.match(html,/Cómo se obtiene la reserva/);
  assert.match(html,/Menos IVA ya liquidado/);
});

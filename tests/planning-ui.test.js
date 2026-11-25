import test from 'node:test';
import assert from 'node:assert/strict';
import { planningPage, planningCashChart } from '../src/planning-ui.js';
import { defaultPlanning } from '../src/planning.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { distributionPage, distributionAccessibleTable, distributionChartConfig } from '../src/distribution-ui.js';
import { defaultPlanning, planningProjection } from '../src/planning.js';
import { newDistributionOperation, aggregateDistributionPeople, simulateDistribution } from '../src/distribution.js';

const today='2026-11-25';
const state=()=>{
  const planning=defaultPlanning({today});
  planning.settings.cashBalanceOverride=16000;
  planning.settings.profitOverride=10000;
  planning.settings.corporateTaxConfirmed=true;
  return {company:{name:'Empresa de ejemplo',openingBalance:0,openingBalanceDate:'2026-01-01'},clients:[],documents:[],payments:[],expenses:[],taxRecords:[],planning};
};
const legacy=(id,people)=>({id,name:'Ejemplo guardado',people,dividendDate:null,notes:''});

test('a fresh distribution session starts empty even when older simulations exist',()=>{
  const s=state(),op=newDistributionOperation('administrator',s.planning.settings.people[0].id,{label:'Operación guardada'});op.amount=2500;
  const saved=legacy('saved',aggregateDistributionPeople([op],s.planning.settings));
  s.planning.scenarios.push(saved);
  s.planningExtensions={version:1,people:[],scenarios:[{scenarioId:saved.id,operations:[op]}]};
  const session={draft:null,selectedId:''},html=distributionPage(s,{today,session});
  assert.equal(session.draft.operations.length,0);
  assert.equal(session.selectedId,'');
  assert.match(html,/Escenario: No hacer nada/);
  assert.match(html,/Escenario editable/);
  assert.match(html,/<canvas id="distribution-base-chart"/);
  assert.match(html,/<canvas id="distribution-editable-chart"/);
  assert(!html.includes('Operación guardada'));
  assert.match(html,/<label class="field dist-draft-name">/);
  assert(!html.includes('class="dist-draft-name" type="text"'));
});

test('the in-memory draft survives another page render without becoming a real document',()=>{
  const s=state(),session={draft:null,selectedId:''};
  distributionPage(s,{today,session});
  const op=newDistributionOperation('expense',null,{label:'Compra prevista'});op.amount=1200;
  session.draft.operations.push(op);session.dirty=true;
  const before=structuredClone(s),id=session.draft.id;
  const html=distributionPage(s,{today,session});
  assert.equal(session.draft.id,id);
  assert.equal(session.draft.operations[0].amount,1200);
  assert.match(html,/Compra prevista/);
  assert.deepEqual(s,before);
});

test('accessible figures escape names and preserve unknown tax as unknown',()=>{
  const html=distributionAccessibleTable([{label:'<img src=x onerror=alert(1)>',kind:'administrator',gross:100,net:null,tax:null,socialCosts:0,effectiveRate:null,known:false}], 'figures');
  assert(!html.includes('<img'));
  assert.match(html,/&lt;img/);
  assert.match(html,/Por confirmar/);
  assert(!html.includes('undefined'));
  assert.match(html,/id="figures"/);
});

test('known and unknown social costs remain separate below zero without duplicating gross',()=>{
  const bar={id:'work',label:'Trabajo',kind:'salary',gross:100,companyCost:110,net:null,tax:null,socialCosts:20,employeeSS:10,employerSS:10,positive:90,unknownGross:90,known:false};
  const config=distributionChartConfig({bars:[bar]},{min:-30,max:120});
  assert.equal(config.data.datasets[0].data[0],0);
  assert.equal(config.data.datasets[1].data[0],0);
  assert.equal(config.data.datasets[2].data[0],-20);
  assert.equal(config.data.datasets[3].data[0],90);
  assert.equal(config.data.datasets.reduce((sum,row)=>sum+Math.abs(row.data[0]),0),110);
  const known=distributionChartConfig({bars:[{...bar,net:65,tax:25,known:true}]},{min:-60,max:120});
  assert.equal(known.data.datasets[0].data[0],65);
  assert.equal(known.data.datasets[1].data[0],-25);
  assert.equal(known.data.datasets[2].data[0],-20);
  assert.equal(known.data.datasets[3].data[0],0);
});

test('loss is a separate negative series rather than tax or a positive net',()=>{
  const config=distributionChartConfig({bars:[{id:'company',label:'Empresa',kind:'company',gross:-500,net:-500,tax:0,socialCosts:0,loss:500,known:true}]},{min:-700,max:100});
  assert.equal(config.data.datasets[0].data[0],0);
  assert.equal(config.data.datasets[1].data[0],0);
  assert.equal(config.data.datasets[4].data[0],-500);
});

test('an expense is an enterprise use and never added to personal net',()=>{
  const s=state(),op=newDistributionOperation('expense',null,{label:'Material previsto'});op.amount=1000;
  const projection=planningProjection(s,s.planning,{today});
  const result=simulateDistribution(projection,{...legacy('draft',[]),operations:[op]},s.planning.settings,[]);
  assert.equal(result.totalPersonalNet,0);
  assert.equal(result.otherCosts,1000);
  const chart=distributionChartConfig(result,{min:-2000,max:10000});
  assert.equal(chart.data.datasets[0].data[1],1000);
  assert.equal(chart.data.datasets[0].backgroundColor[1],'#b9ac96');
  assert.match(distributionAccessibleTable(result.bars),/uso de empresa/);
});

test('the default page does not claim an over-budget distribution when cash is simply unknown',()=>{
  const s=state();s.planning.settings.cashBalanceOverride=null;delete s.company.openingBalance;
  const html=distributionPage(s,{today,session:{draft:null,selectedId:''}});
  assert.match(html,/Datos y condiciones por confirmar/);
  assert(!html.includes('El reparto supera el presupuesto disponible'));
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length);
});

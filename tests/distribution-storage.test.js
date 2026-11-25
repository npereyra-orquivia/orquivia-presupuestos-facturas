import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanningState } from '../src/planning-state.js';
import { validatePlanningExtensions } from '../src/distribution-state.js';
import { validateCloudState, createBackend } from '../src/backend.js';
import { prepareRestore } from '../src/security.js';
import { compareWorkspaceEdits, renderConflictComparison } from '../src/history-ui.js';
import { planningFixture } from '../supabase/tests/planning-fixture.mjs';
import { distributionFixture } from '../supabase/tests/distribution-fixture.mjs';
import JSZip from 'jszip';
import { prepareExpenseImport,executeExpenseImport } from '../src/expense-import.js';

const state=()=>({company:{name:'Synthetic company'},clients:[],documents:[],payments:[],planning:planningFixture(),planningExtensions:distributionFixture()});

test('distribution sidecar round-trips without adding incompatible keys to planning v1',()=>{
  const original=state();
  assert.deepEqual(validatePlanningState(original.planning),original.planning);
  assert.deepEqual(Object.keys(original.planning.scenarios[0]).sort(),['dividendDate','id','name','notes','people']);
  assert.deepEqual(validateCloudState(original),original);
  assert.deepEqual(prepareRestore(JSON.stringify({state:original}),{today:'2026-01-01'}),original);
  const copy=validatePlanningExtensions(original.planningExtensions,original.planning);copy.scenarios[0].operations[0].amount=900;
  assert.equal(original.planningExtensions.scenarios[0].operations[0].amount,2200);
  const legacy=state();delete legacy.planningExtensions;
  assert.deepEqual(validateCloudState(legacy),legacy);assert.deepEqual(prepareRestore(legacy,{today:'2026-01-01'}),legacy);
});

test('operation references, exact shapes, enum types and monetary precision are validated before transport',()=>{
  const mutations=[e=>e.password='not-a-secret',e=>e.people[0].taxRegion=null,e=>e.people[0].taxRegion='unknown',e=>e.people[0].personId='missing',
    e=>e.people.push(structuredClone(e.people[0])),e=>e.scenarios.push(structuredClone(e.scenarios[0])),e=>e.scenarios[0].scenarioId='missing',
    e=>e.scenarios[0].operations.push(structuredClone(e.scenarios[0].operations[0])),e=>e.scenarios[0].operations[0].credential='fictional',
    e=>e.scenarios[0].operations[0].kind=null,e=>e.scenarios[0].operations[0].kind='transfer',e=>e.scenarios[0].operations[0].personId=null,
    e=>e.scenarios[0].operations[5].personId='person-a',e=>e.scenarios[0].operations[0].amount=-1,e=>e.scenarios[0].operations[0].amount=1.001,
    e=>e.scenarios[0].operations[0].withholdingRate=101,e=>e.scenarios[0].operations[0].vatRate='21',e=>e.scenarios[0].operations[0].employeeSSRate=Infinity,
    e=>e.scenarios[0].operations[0].taxTreatmentConfirmed=null,e=>e.scenarios[0].operations[0].deductible='false',
    e=>e.scenarios[0].operations[0].label='\u00a0',e=>e.scenarios[0].operations[0].label='broken\ud800',e=>e.scenarios[0].operations[0].id='x'.repeat(141)];
  for(const change of mutations){const s=state();change(s.planningExtensions);assert.throws(()=>validatePlanningExtensions(s.planningExtensions,s.planning));assert.throws(()=>validateCloudState(s),{code:'INVALID_STATE'});}
  const missing=state();delete missing.planning;assert.throws(()=>validateCloudState(missing));
  for(const key of ['__proto__','constructor','prototype']){const s=state();Object.defineProperty(s.planningExtensions.scenarios[0].operations[0],key,{value:'fixture',enumerable:true});assert.throws(()=>validatePlanningExtensions(s.planningExtensions,s.planning));}
});

test('operation totals must match the legacy per-person gross values exactly without deducting employee SS',()=>{
  const s=state();
  assert.deepEqual(validatePlanningExtensions(s.planningExtensions,s.planning),s.planningExtensions);
  s.planning.scenarios[0].people[0].workGross=3600;
  assert.throws(()=>validatePlanningExtensions(s.planningExtensions,s.planning),{code:'PLANNING_CLIENT_UPDATE_REQUIRED'});
  s.planningExtensions.scenarios[0].operations[0].amount+=100;
  assert.deepEqual(validatePlanningExtensions(s.planningExtensions,s.planning),s.planningExtensions);
  s.planningExtensions.scenarios[0].operations[5].amount=99999;
  assert.deepEqual(validatePlanningExtensions(s.planningExtensions,s.planning),s.planningExtensions,'Scenario expense does not enter personal aggregates');
});

test('a large but structurally valid operation set is rejected at the sidecar byte budget',()=>{
  const s=state(),template=s.planningExtensions.scenarios[0].operations[0];
  s.planning.scenarios=Array.from({length:50},(_,n)=>({id:`s${n}`,name:'Scenario',people:[{personId:'person-a',workGross:1000,dividendGross:0}],dividendDate:null,notes:''}));
  s.planningExtensions.scenarios=s.planning.scenarios.map((scenario,n)=>({scenarioId:scenario.id,operations:Array.from({length:50},(_,i)=>({...template,id:`operation-${n}-${i}`.padEnd(140,'x'),label:'x'.repeat(200),amount:20}))}));
  assert.throws(()=>validatePlanningExtensions(s.planningExtensions,s.planning),/1 MB/);
});

test('operation conflicts compare old and saved values while escaping labels and redacting unknown keys',()=>{
  const base=state(),draft=structuredClone(base),current=structuredClone(base);
  draft.planningExtensions.scenarios[0].operations[0].label='<img src=x onerror=alert(1)>';
  draft.planningExtensions.scenarios[0].operations[0].amount=2300;
  current.planningExtensions.scenarios[0].operations[0].amount=2400;
  const before=JSON.stringify({base,draft,current}),rows=compareWorkspaceEdits(base,draft,current);
  const row=rows.find(r=>r.entityId==='distribution:scenario-a');
  assert(row);assert.deepEqual(row.overlappingFields,['operations']);
  const markup=renderConflictComparison(rows);assert(!markup.includes('<img'));assert(markup.includes('&lt;img'));assert(markup.includes('2.300')||markup.includes('2300'));assert(markup.includes('2.400')||markup.includes('2400'));
  assert.equal(JSON.stringify({base,draft,current}),before);
});

test('older setup imports cannot orphan existing operation sidecars and ordinary imports preserve them',async()=>{
  const org='00000000-0000-4000-8000-000000000001';
  const pack=async(planning)=>{
    const manifest={format:'orquivia-expenses-v1',expenses:[{expense:{id:'00000000-0000-4000-8000-000000000003',supplier:'Fixture supplier',description:'Fixture bank charge',date:'2025-03-01',base:100,vatAmount:0,total:100,paymentStatus:'paid',paidDate:'2025-03-01',vatReviewNeeded:true,vatDeductibleAmount:0,reviewNeeded:true,missingReceiptReason:'Fixture awaiting receipt'},receipts:[]}]};
    if(planning)manifest.planning=planning;
    const zip=new JSZip();zip.file('manifest.json',JSON.stringify(manifest));return new File([await zip.generateAsync({type:'uint8array'})],'Fixture.zip');
  };
  let current=state();const original=JSON.stringify(current),oldPlan=structuredClone(current.planning);oldPlan.scenarios=[];
  await assert.rejects(prepareExpenseImport(await pack(oldPlan),current,org),/operaciones|escenario/i);
  assert.equal(JSON.stringify(current),original);
  const prepared=await prepareExpenseImport(await pack(),current,org),sidecar=structuredClone(current.planningExtensions);
  await executeExpenseImport(prepared,{backend:{},getState:()=>current,commit:async change=>{const next=structuredClone(current);change(next);current=validateCloudState(next);return true;}});
  assert.equal(current.expenses.length,1);assert.deepEqual(current.planningExtensions,sidecar);
});

test('server requests to refresh an older operations editor are surfaced without consuming the workspace version',async()=>{
  const originalFetch=globalThis.fetch,member={id:'e3100000-0000-4000-8000-000000000001',aud:'authenticated',email:'editor@example.test'};
  const access={organization_id:'e3200000-0000-4000-8000-000000000001',organization_name:'Synthetic',role:'editor',require_mfa:true};
  const token=[{alg:'HS256',typ:'JWT'},{role:'authenticated',sub:member.id,aal:'aal2',exp:Math.floor(Date.now()/1000)+3600}].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).concat('fixture-signature').join('.');
  const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
  let backend,requests=0;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.includes('/auth/v1/token'))return json({access_token:token,refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,user:member});
    if(url.includes('/auth/v1/user'))return json(member);
    if(url.includes('/rest/v1/rpc/refresh_orquivia_access'))return json(access);
    if(url.includes('/rest/v1/rpc/load_orquivia_workspace'))return json({...access,state:state(),version:7});
    if(url.includes('/rest/v1/rpc/save_orquivia_team_state')){requests++;assert.equal(JSON.parse(init.body).p_expected_version,7);return json({code:'22023',message:'PLANNING_CLIENT_UPDATE_REQUIRED'},400);}
    throw new Error('Unexpected fixture request');
  };
  try{backend=createBackend({url:'https://example.supabase.co',anonKey:'sb_publishable_test'});await backend.signIn(member.email,'fictional-password');await backend.loadState();
    for(let i=0;i<2;i++)await assert.rejects(backend.saveState(state()),error=>error.code==='PLANNING_CLIENT_UPDATE_REQUIRED'&&error.message.includes('Actualiza la página'));
    assert.equal(requests,2);
  }finally{backend?.dispose();globalThis.fetch=originalFetch;}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlanningState } from '../src/planning-state.js';
import { validateWorkspace } from '../src/domain.js';
import { createBackend, validateCloudState } from '../src/backend.js';
import { defaultPlanning, normalizePlanning } from '../src/planning.js';
import { prepareRestore } from '../src/security.js';
import { compareWorkspaceEdits, renderConflictComparison, historyFieldLabel } from '../src/history-ui.js';
import { planningFixture } from '../supabase/tests/planning-fixture.mjs';

const state = () => ({company:{name:'Synthetic company'},clients:[],documents:[],payments:[],planning:planningFixture()});

test('plans survive cloud snapshots and encrypted-backup restore without changing operational records',()=>{
  const original=state(),copy=validateCloudState(original),restored=prepareRestore(JSON.stringify({state:original}),{today:'2026-01-01'});
  assert.deepEqual(copy,original);assert.deepEqual(restored,original);
  copy.planning.items[0].amountGross=500;
  assert.equal(original.planning.items[0].amountGross,120);
  assert.deepEqual(validateWorkspace(original,'2026-01-01'),[]);
  const legacy=state();delete legacy.planning;
  assert.deepEqual(prepareRestore(legacy,{today:'2026-01-01'}),legacy);
});

test('engine defaults and completed form inputs match the strict cloud and restore schemas',()=>{
  for(const planning of [defaultPlanning({today:'2026-11-01'}),normalizePlanning({settings:{people:[{id:'worker',name:'Perfil sintético'}]},
    items:[{id:'future-item',label:'Compra prevista',amountGross:'99.95',startDate:'2026-11-30'}],
    scenarios:[{id:'future-scenario',name:'Simulación',people:[{personId:'worker',workGross:'1200',dividendGross:'0'}]}]}, {today:'2026-11-01'})]) {
    assert.deepEqual(validatePlanningState(planning),planning);
    const original={...state(),planning};
    assert.deepEqual(validateCloudState(original).planning,planning);
    assert.deepEqual(prepareRestore(original,{today:'2026-11-01'}).planning,planning);
  }
});

test('strict planning schema rejects unknown secret-like fields, invalid dates, enums and decimal amounts',()=>{
  const changes=[
    p=>p.settings.password='not-a-real-secret',p=>p.items[0].extra=true,p=>p.scenarios[0].people[0].credential='fixture',
    p=>p.settings.pendingCosts=null,p=>p.items[0].kind=null,p=>p.items[0].recurrence=null,p=>p.items[0].treatment=null,
    p=>p.settings.people[0].retaPeriod=null,p=>p.settings.corporateTaxConfirmed='false',p=>p.settings.taxYear=2026.5,
    p=>p.settings.horizon='2025-02-29',p=>p.settings.horizon='2039-01-01',p=>p.items[0].amountGross=10.001,
    p=>p.settings.people[0].externalSalary=Infinity,p=>p.settings.people[0].sharePercent=101,p=>p.items[0].id='x'.repeat(141),
    p=>p.items[0].endDate='2025-01-01',p=>p.scenarios[0].notes='x'.repeat(2001),p=>p.settings.collectionDates['bad\nkey']='2025-12-01',
    p=>p.settings.collectionDates['invoice-fixture']='2025-02-30',p=>p.settings.people[0].externalSalary=-1,
  ];
  for(const change of changes){const planning=planningFixture();change(planning);assert.throws(()=>validatePlanningState(planning));assert.throws(()=>validateCloudState({...state(),planning}),{code:'INVALID_STATE'});}
  assert.throws(()=>validatePlanningState(null));
});

test('identities and allocation references cannot be duplicated or silently detached',()=>{
  const changes=[p=>p.items.push(structuredClone(p.items[0])),p=>p.scenarios.push(structuredClone(p.scenarios[0])),p=>p.settings.people.push(structuredClone(p.settings.people[0])),
    p=>p.items[0].linkedRecordIds=['same','same'],p=>p.scenarios[0].people[0].personId='missing',p=>p.scenarios[0].people.push(structuredClone(p.scenarios[0].people[0]))];
  for(const change of changes){const p=planningFixture();change(p);assert.throws(()=>validatePlanningState(p));}
  const p=planningFixture();p.settings.cashBalanceOverride=-500;p.settings.profitOverride=-1000;
  assert.equal(validatePlanningState(p).settings.cashBalanceOverride,-500);
});

test('planning accepts normal Unicode while rejecting hidden control, broken Unicode and prototype keys',()=>{
  const p=planningFixture();p.items[0].label='📆'.repeat(200);
  assert.equal(validatePlanningState(p).items[0].label,p.items[0].label);
  for(const label of ['\u00a0','\ufeff','broken\ud800','control\u0085']){const value=planningFixture();value.items[0].label=label;assert.throws(()=>validatePlanningState(value));}
  for(const key of ['__proto__','constructor','prototype']){
    const value=planningFixture();Object.defineProperty(value.settings.collectionDates,key,{value:'2026-11-30',enumerable:true});
    assert.throws(()=>validatePlanningState(value));assert.throws(()=>prepareRestore({...state(),planning:value},{today:'2026-01-01'}));
  }
});

test('planning conflicts show each local record against its saved version and never merge away another edit',()=>{
  const base=state(),draft=structuredClone(base),current=structuredClone(base);
  draft.planning.items[0].amountGross=130;current.planning.items[0].amountGross=160;
  draft.planning.scenarios[0].people[0].workGross=4000;current.planning.scenarios[0].people[0].workGross=4500;
  draft.planning.settings.minimumCash=2000;current.planning.settings.minimumCash=3000;
  const before=JSON.stringify({base,draft,current});
  const rows=compareWorkspaceEdits(base,draft,current);
  assert.equal(rows.length,3);
  assert.deepEqual(rows.map(r=>r.entityId).sort(),['forecast:forecast-a','scenario:scenario-a','settings']);
  assert.deepEqual(rows.find(r=>r.entityId==='forecast:forecast-a').overlappingFields,['amountGross']);
  const markup=renderConflictComparison(rows);
  assert.match(markup,/Servicio mensual/);assert.match(markup,/4(?:[.,])?000/);assert.match(markup,/4500/);assert.match(markup,/Colchón de caja/);
  assert.equal(JSON.stringify({base,draft,current}),before);
  assert.equal(historyFieldLabel('corporateTaxRate'),'Tipo de Sociedades');
});

test('planning history RPC binds organization, captured member, MFA and late-response isolation',async()=>{
  const originalFetch=globalThis.fetch;
  const member={id:'f3100000-0000-4000-8000-000000000001',aud:'authenticated',email:'editor@example.test'};
  const other={id:'f3100000-0000-4000-8000-000000000002',aud:'authenticated',email:'other@example.test'};
  const org='f3200000-0000-4000-8000-000000000001';
  const access={organization_id:org,organization_name:'Synthetic company',role:'editor',require_mfa:true};
  const rows=[{id:11,entityType:'planning',entityId:'scenario:scenario-a',actorId:member.id,changedFields:['people']}];
  const token=(id)=>[{alg:'HS256',typ:'JWT'},{role:'authenticated',sub:id,aal:'aal2',exp:Math.floor(Date.now()/1000)+3600}].map(p=>Buffer.from(JSON.stringify(p)).toString('base64url')).concat('fixture-signature').join('.');
  const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  let signedIn=member,denied=false,count=0,expectedId='planning',delayed=null,release,backend;
  globalThis.fetch=async(input,init={})=>{
    const url=String(input);
    if(url.includes('/auth/v1/token')){signedIn=JSON.parse(init.body).email===other.email?other:member;return json({access_token:token(signedIn.id),refresh_token:'fixture-refresh',token_type:'bearer',expires_in:3600,user:signedIn});}
    if(url.includes('/auth/v1/user'))return json(signedIn);
    if(url.includes('/rest/v1/rpc/refresh_orquivia_access'))return denied?json({code:'42501',message:'MFA_REQUIRED'},403):json(access);
    if(url.includes('/rest/v1/rpc/load_orquivia_workspace'))return json({...access,state:state(),version:1});
    if(url.includes('/rest/v1/rpc/load_orquivia_record_history')){
      count++;
      assert.deepEqual(JSON.parse(init.body),{p_organization_id:org,p_entity_type:'planning',p_entity_id:expectedId,p_limit:100,p_expected_user_id:member.id});
      if(delayed){delayed();await new Promise(done=>{release=done;});}
      return json(rows);
    }
    throw new Error('Unexpected fixture request');
  };
  try {
    backend=createBackend({url:'https://example.supabase.co',anonKey:'sb_publishable_test'});
    await backend.signIn(member.email,'fictional-password');await backend.loadState();
    assert.deepEqual(await backend.recordHistory('planning','planning',999),rows);
    expectedId='scenario:scenario-a';assert.deepEqual(await backend.recordHistory('planning',expectedId,999),rows);
    await assert.rejects(backend.recordHistory('planning','bad\nrecord'),{code:'INVALID_HISTORY_RECORD'});
    denied=true;await assert.rejects(backend.recordHistory('planning','planning'),{code:'MFA_REQUIRED'});assert.equal(count,2);
    denied=false;await backend.loadState();
    const started=new Promise(done=>{delayed=done;});const pending=backend.recordHistory('planning',expectedId,999);await started;
    await backend.signIn(other.email,'fictional-password');release();
    await assert.rejects(pending,{code:'AUTH_CHANGED'});
  } finally {backend?.dispose();globalThis.fetch=originalFetch;}
});

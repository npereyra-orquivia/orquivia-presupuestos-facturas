import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const db=await PGlite.create();
const admin='f7100000-0000-4000-8000-000000000001',editor='f7100000-0000-4000-8000-000000000002';
const otherAdmin='f7100000-0000-4000-8000-000000000003',outsider='f7100000-0000-4000-8000-000000000004';
const org='f7200000-0000-4000-8000-000000000001',otherOrg='f7200000-0000-4000-8000-000000000002';
const attempt='f7300000-0000-4000-8000-000000000001',nextAttempt='f7300000-0000-4000-8000-000000000002';
const commit='a'.repeat(40),hash='b'.repeat(64);
const successful={sourceCommit:commit,encryptedBytes:16000,storageObjects:42,storageBytes:10633068,checksumVerified:true,permissionsChecked:true,archiveSha256:hash};
let checks=0;
const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
const equal=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);checks++;};
const deny=async(sql,params=[],code='42501',message)=>{await assert.rejects(db.query(sql,params),e=>e.code===code&&(!message||e.message===message));checks++;};
const as=async(role,user=admin,aal='aal2',claimRole=role)=>{
  await db.exec(`reset role; set role ${role}`);
  await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,role:claimRole,aal})]);
};
const loadSQL='select public.load_orquivia_backup_health($1,$2) result';
const recordSQL='select public.record_orquivia_backup_attempt($1,$2,$3,$4) result';
const restoreSQL='select public.record_orquivia_restore_evidence($1,$2) result';
const load=async(organization=org,user=admin)=>(await query(loadSQL,[organization,user]))[0].result;
const record=async(phase,report={},id=attempt,organization=org)=>(await query(recordSQL,[organization,id,phase,report]))[0].result;
const sourceData=async()=>{
  const tables=['orquivia_organizations','orquivia_memberships','orquivia_team_workspaces','orquivia_number_counters','orquivia_document_numbers','orquivia_audit_log'];
  return Promise.all(tables.map(name=>query(`select to_jsonb(t) value from public.${name} t order by to_jsonb(t)::text`)));
};
try{
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text);
    create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.jwt() to anon,authenticated,service_role;
    grant select on auth.users to service_role;
    insert into auth.users values('${admin}','admin@example.test'),('${editor}','editor@example.test'),('${otherAdmin}','other-admin@example.test'),('${outsider}','outsider@example.test');`);
  for(const name of ['202610130001_orquivia.sql','202610140002_team_production.sql'])
    await db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  await as('service_role');
  await query('select public.bootstrap_orquivia_team($1,$2,$3,$4)',[admin,editor,'Synthetic organization',org]);
  await query('insert into public.orquivia_organizations(id,name,require_mfa) values($1,$2,true)',[otherOrg,'Other organization']);
  await query('insert into public.orquivia_memberships(organization_id,user_id,role) values($1,$2,$3)',[otherOrg,otherAdmin,'admin']);
  await query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  await db.exec('reset role');
  const before=await sourceData();
  const migration=await readFile(new URL('../migrations/202610280017_operations_evidence.sql',import.meta.url),'utf8');
  await db.exec(migration);
  equal(await sourceData(),before,'Migration never rewrites financial state, members, numbering or history');
  await as('authenticated');
  let state=await load();
  equal(Object.keys(state).sort(),['lastAttempt','lastRestore','lastSuccess','serverTime']);
  equal(state.lastAttempt,null);equal(state.lastSuccess,null);equal(state.lastRestore,null);
  assert.match(state.serverTime,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);checks++;
  await deny(loadSQL,[org,null],'42501','AUTH_CHANGED');
  await deny(loadSQL,[org,editor],'42501','AUTH_CHANGED');
  await deny(loadSQL,[otherOrg,admin],'42501','MEMBERSHIP_REQUIRED');
  await as('authenticated',editor);await deny(loadSQL,[org,editor],'42501','ADMIN_REQUIRED');
  await as('authenticated',otherAdmin);await deny(loadSQL,[org,otherAdmin],'42501','MEMBERSHIP_REQUIRED');
  await as('authenticated',outsider);await deny(loadSQL,[org,outsider],'42501','MEMBERSHIP_REQUIRED');
  await as('authenticated',admin,'aal1');await deny(loadSQL,[org,admin],'42501','MFA_REQUIRED');
  await as('service_role');await query('update public.orquivia_organizations set require_mfa=false where id=$1',[org]);
  await as('authenticated',admin,'aal1');await deny(loadSQL,[org,admin],'42501','MFA_REQUIRED');
  await as('service_role');await query('update public.orquivia_organizations set require_mfa=true where id=$1',[org]);
  for(const role of ['anon','authenticated','service_role']){
    await as(role);
    for(const sql of ['select * from orquivia_private.backup_health','insert into orquivia_private.backup_health(organization_id) values($1)',
      'update orquivia_private.backup_health set last_success_at=now() where organization_id=$1','delete from orquivia_private.backup_health where organization_id=$1'])
      await deny(sql,sql.includes('$1')?[org]:[]);
    if(role!=='service_role'){
      await deny(recordSQL,[org,attempt,'started',{}]);await deny(restoreSQL,[org,{}]);
    }else await deny(loadSQL,[org,admin]);
  }
  await as('service_role',admin,'aal2','authenticated');
  await deny(recordSQL,[org,attempt,'started',{}],'42501','SERVICE_ROLE_REQUIRED');
  await as('service_role');
  for(const patch of [[null,attempt,'started',{}],[org,null,'started',{}],[org,attempt,null,{}],[org,attempt,'other',{}],
    [org,attempt,'started',null],[org,attempt,'started',{secret:'not allowed'}],[org,attempt,'failed',{errorCode:'PRIVATE_UNKNOWN'}],
    [org,attempt,'failed',{errorCode:null}],[org,attempt,'succeeded',{...successful,privatePath:'not allowed'}],
    [org,attempt,'succeeded',{...successful,checksumVerified:false}],[org,attempt,'succeeded',{...successful,permissionsChecked:null}],
    [org,attempt,'succeeded',{...successful,encryptedBytes:0}],[org,attempt,'succeeded',{...successful,storageBytes:-1}],
    [org,attempt,'succeeded',{...successful,storageObjects:1.5}],[org,attempt,'succeeded',{...successful,sourceCommit:null}],
    [org,attempt,'succeeded',Object.fromEntries(Object.entries(successful).filter(([key])=>key!=='archiveSha256'))],
    [org,attempt,'succeeded',{...successful,archiveSha256:null}]])
    await deny(recordSQL,patch,'22023','INVALID_BACKUP_EVIDENCE');
  await deny(recordSQL,['f7200000-0000-4000-8000-000000000099',attempt,'started',{}],'22023','INVALID_BACKUP_ORGANIZATION');
  equal(await record('started'),{recorded:true,phase:'started'});
  await as('authenticated');state=await load();const startedAt=state.lastAttempt.startedAt;
  equal(state.lastAttempt.status,'started');equal(state.lastSuccess,null);equal(state.lastRestore,null);
  await as('service_role');equal(await record('started'),{recorded:true,phase:'started'});
  await deny(recordSQL,[org,nextAttempt,'started',{}],'PT409','BACKUP_ATTEMPT_CONFLICT');
  await deny(recordSQL,[org,nextAttempt,'succeeded',successful],'PT409','BACKUP_ATTEMPT_CONFLICT');
  equal(await record('succeeded',successful),{recorded:true,phase:'succeeded'});
  await as('authenticated');state=await load();
  equal(state.lastAttempt.startedAt,startedAt);equal(state.lastAttempt.status,'succeeded');equal(state.lastAttempt.errorCode,null);
  equal(state.lastSuccess,{finishedAt:state.lastAttempt.finishedAt,sourceCommit:commit,encryptedBytes:16000,storageObjects:42,storageBytes:10633068,checksumVerified:true,permissionsChecked:true});
  equal(state.lastRestore,null,'Success and readiness flags do not record a restoration');
  assert.ok(!JSON.stringify(state).includes(org)&&!JSON.stringify(state).includes(attempt));checks++;
  await as('service_role');equal(await record('succeeded',successful),{recorded:true,phase:'succeeded'});
  await deny(recordSQL,[org,attempt,'succeeded',{...successful,storageBytes:1}],'PT409','BACKUP_ATTEMPT_CONFLICT');
  const lastSuccess=state.lastSuccess;
  await record('started',{},nextAttempt);
  await record('failed',{errorCode:'SCHEDULED_BACKUP_UPLOAD_FAILED'},nextAttempt);
  await as('authenticated');state=await load();equal(state.lastAttempt.status,'failed');equal(state.lastSuccess,lastSuccess);
  equal(state.lastAttempt.errorCode,'SCHEDULED_BACKUP_UPLOAD_FAILED');equal(state.lastRestore,null);
  await as('service_role');
  await deny(recordSQL,[org,nextAttempt,'succeeded',successful],'PT409','BACKUP_ATTEMPT_CONFLICT');
  const report={sourceCommit:commit,reportSha256:hash,scope:'business-data-and-originals',verifiedAt:new Date().toISOString()};
  for(const value of [null,{}, {...report,scope:'automatic'},{...report,reportSha256:null},{...report,verifiedAt:'2099-01-01T00:00:00Z'},
    {...report,verifiedAt:'2026-99-01T00:00:00Z'},{...report,readiness:true}]) await deny(restoreSQL,[org,value],'22023','INVALID_RESTORE_EVIDENCE');
  await query(restoreSQL,[org,report]);
  await as('authenticated');state=await load();equal(state.lastRestore,report);
  await as('service_role');
  await deny(restoreSQL,[org,{...report,scope:'full-system'}],'PT409','RESTORE_EVIDENCE_CONFLICT');
  await deny(restoreSQL,[org,{...report,verifiedAt:new Date(Date.now()-1000*60).toISOString()}],'PT409','RESTORE_EVIDENCE_CONFLICT');
  await db.exec('reset role');
  const healthBefore=(await query('select to_jsonb(t) value from orquivia_private.backup_health t'));
  await db.exec(migration);
  equal(await query('select to_jsonb(t) value from orquivia_private.backup_health t'),healthBefore,'Reapplying migration preserves evidence');
  equal(await sourceData(),before,'Evidence never mutates company records or numbering');
  console.log(`Operations evidence PostgreSQL: ${checks} checks passed`);
}finally{await db.close();}

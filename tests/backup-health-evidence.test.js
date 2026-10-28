import test from 'node:test';
import assert from 'node:assert/strict';
import { backupEvidenceConfiguration, createBackupHealthReporter } from '../scripts/backup/health-evidence.mjs';

const env={ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED:'true',ORQUIVIA_BACKUP_SUPABASE_URL:'https://tfaglecwycbamibnhqmq.supabase.co',
  ORQUIVIA_BACKUP_ORGANIZATION_ID:'f7200000-0000-4000-8000-000000000001',ORQUIVIA_BACKUP_SERVICE_ROLE_KEY:'fixture-only-service-credential-not-real'};
const commit='a'.repeat(40),hash='b'.repeat(64);
const captured={sourceCommit:commit};
const uploaded={encryptedBytes:200,checksumVerified:true,permissionsChecked:true,
  operationalEvidence:{sourceCommit:commit,storageObjects:42,storageBytes:1000,archiveSha256:hash}};
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});

test('health reporting remains optional and rejects ambiguous or cross-project enabled configuration',()=>{
  for(const value of [undefined,'','false'])assert.equal(backupEvidenceConfiguration({...env,ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED:value}),null);
  for(const patch of [{ORQUIVIA_BACKUP_HEALTH_REPORT_ENABLED:'TRUE'},{ORQUIVIA_BACKUP_ORGANIZATION_ID:''},
    {ORQUIVIA_BACKUP_ORGANIZATION_ID:'https://example.test/org'}, {ORQUIVIA_BACKUP_SERVICE_ROLE_KEY:'short'},
    {ORQUIVIA_BACKUP_SERVICE_ROLE_KEY:'secret\nnot-allowed-with-long-enough-value'},
    {ORQUIVIA_BACKUP_SUPABASE_URL:'https://abcdefghijklmnopqrst.supabase.co'}])
    assert.throws(()=>backupEvidenceConfiguration({...env,...patch}));
});

test('server-only evidence uses one attempt, fixed origin, closed metadata and never records restoration',async()=>{
  const calls=[];
  const reporter=createBackupHealthReporter(env,{fetchFn:async(url,options)=>{
    calls.push({url,options});const body=JSON.parse(options.body);return json({recorded:true,phase:body.p_phase});
  }});
  await reporter.started();await reporter.succeeded(captured,uploaded);await reporter.failed('UNRECOGNIZED_PRIVATE_VALUE');
  assert.equal(new Set(calls.map(call=>JSON.parse(call.options.body).p_attempt_id)).size,1);
  assert.ok(calls.every(call=>call.url==='https://tfaglecwycbamibnhqmq.supabase.co/rest/v1/rpc/record_orquivia_backup_attempt'));
  assert.ok(calls.every(call=>call.options.redirect==='error'&&call.options.cache==='no-store'));
  assert.ok(calls.every(call=>call.options.headers.apikey===env.ORQUIVIA_BACKUP_SERVICE_ROLE_KEY));
  assert.deepEqual(calls.map(call=>JSON.parse(call.options.body).p_phase),['started','succeeded','failed']);
  assert.deepEqual(JSON.parse(calls[0].options.body).p_report,{});
  assert.deepEqual(JSON.parse(calls[1].options.body).p_report,{sourceCommit:commit,encryptedBytes:200,storageObjects:42,
    storageBytes:1000,checksumVerified:true,permissionsChecked:true,archiveSha256:hash});
  assert.deepEqual(JSON.parse(calls[2].options.body).p_report,{errorCode:'SCHEDULED_BACKUP_FAILED'});
  assert.ok(!JSON.stringify(calls.map(call=>JSON.parse(call.options.body))).includes('recoveryTested'));
  assert.ok(!JSON.stringify(calls).includes('UNRECOGNIZED_PRIVATE_VALUE'));
});

test('unverified or inconsistent upload metadata cannot reach the evidence RPC',async()=>{
  let calls=0;const reporter=createBackupHealthReporter(env,{fetchFn:async()=>{calls++;return json({recorded:true});}});
  for(const patch of [{permissionsChecked:false},{checksumVerified:false},{encryptedBytes:0},
    {operationalEvidence:{...uploaded.operationalEvidence,sourceCommit:'c'.repeat(40)}},
    {operationalEvidence:{...uploaded.operationalEvidence,storageObjects:-1}},
    {operationalEvidence:{...uploaded.operationalEvidence,storageBytes:null}},
    {operationalEvidence:{...uploaded.operationalEvidence,archiveSha256:'not-a-hash'}}])
    await assert.rejects(reporter.succeeded(captured,{...uploaded,...patch}),{code:'SCHEDULED_BACKUP_EVIDENCE_INVALID'});
  assert.equal(calls,0);
});

test('network and malformed evidence responses fail with closed codes instead of exposing server bodies',async()=>{
  for(const makeResponse of [()=>{throw new Error('PRIVATE_TOKEN_BODY')},()=>json({recorded:false}),
    ()=>new Response('PRIVATE_TOKEN_BODY',{status:403}),()=>new Response('x'.repeat(4097),{headers:{'Content-Type':'application/json'}})]){
    const reporter=createBackupHealthReporter(env,{fetchFn:async()=>makeResponse()});
    await assert.rejects(reporter.started(),error=>error.code==='SCHEDULED_BACKUP_EVIDENCE_FAILED'&&!error.message.includes('PRIVATE_TOKEN_BODY'));
  }
});

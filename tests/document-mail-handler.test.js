import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailHandler } from '../supabase/functions/_shared/document-mail-handler.js';
const user = '10000000-0000-4000-8000-000000000001', org = '20000000-0000-4000-8000-000000000001', id = '30000000-0000-4000-8000-000000000001';
const signature = {name:'Persona de prueba',role:'Dirección',phone:''};
const token = (aal='aal2') => `header.${Buffer.from(JSON.stringify({sub:user,exp:Math.floor(Date.now()/1000)+3600,aal})).toString('base64url')}.signature`;
const request = (action,fields={},aal='aal2') => new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${token(aal)}`,origin:'https://npereyra-orquivia.github.io'},body:JSON.stringify({action,organizationId:org,expectedUserId:user,...fields})});
const fields = {documentId:'quote',expectedWorkspaceVersion:7,idempotencyKey:id,to:['client@example.test'],subject:'Presupuesto',message:'Un mensaje'};

function fixture({smtpError,archiveError,existing=false}={}) {
  const calls=[];let smtp=0,append=0,status='sending';
  const db={rpc:async(name,p)=>{calls.push({name,p});let data;
    if(name.endsWith('_profile'))data={email:'sender@example.test',connected:true,signature,version:1,provider:'serviciodecorreo',...(p.p_secrets?{password:'test-password',sentFolder:'Sent'}:{})};
    if(name.endsWith('_claim')&&!name.endsWith('archive_claim'))data={existing,job:{id,status,createdAt:'2026-10-15T09:00:00Z'},document:{id:'quote',kind:'quote',status:'ready',number:'PR-001'},company:{},client:{}};
    if(name.endsWith('_complete')){status=p.p_status;data={job:{id,status},...(status==='archive_pending'?{workspace:{state:{},version:8}}:{})};}
    if(name.endsWith('_archive_claim'))data={raw:btoa('exact-mime'),messageId:'<fixture@example.test>'};
    return {data,error:null};}};
  const mail={buildMessage:async()=>({raw:new TextEncoder().encode('exact-mime'),messageId:'<fixture@example.test>',envelope:{from:'sender@example.test',to:fields.to}}),
    sendRaw:async()=>{++smtp;if(smtpError)throw Object.assign(new Error('raw secret detail'),{code:smtpError});},
    appendSent:async(_c,folder,raw)=>{++append;assert.equal(folder,'Sent');assert.equal(new TextDecoder().decode(raw),'exact-mime');if(archiveError)throw Error('private detail');}};
  const handler=createDocumentMailHandler({db,auth:{getUser:async()=>({data:{user:{id:user,email:'sender@example.test'}}})},mail,renderDocumentPdf:async()=>new Uint8Array([1,2]),logoBytes:new Uint8Array([3])});
  return {handler,calls,count:()=>({smtp,append})};
}
test('AAL1 and a switched identity cannot access profile, credentials or jobs',async()=>{
  for(const req of [request('profile',{},'aal1'),request('profile',{expectedUserId:org})]){
    const f=fixture(),r=await f.handler(req);assert.equal(r.status,403);assert.equal(f.calls.length,0);
  }
});
test('confirmed SMTP acceptance precedes archival and carries the canonical workspace result',async()=>{
  const f=fixture(),r=await(await f.handler(request('send',fields))).json();
  assert.equal(r.job.status,'sent');assert.equal(r.workspace.version,8);assert.deepEqual(f.count(),{smtp:1,append:1});
  const saved=f.calls.findIndex(c=>c.name.endsWith('_store_message')),accepted=f.calls.findIndex(c=>c.p.p_status==='archive_pending'),archived=f.calls.findIndex(c=>c.name.endsWith('_archive_claim'));
  assert.ok(saved<accepted&&accepted<archived);
});
test('archive failure preserves sent status and retryArchive never submits SMTP',async()=>{
  const f=fixture({archiveError:true}),r=await(await f.handler(request('send',fields))).json();assert.equal(r.job.status,'archive_pending');
  const retry=fixture(),result=await(await retry.handler(request('retryArchive',{jobId:id}))).json();assert.equal(result.job.status,'sent');assert.deepEqual(retry.count(),{smtp:0,append:1});
});
test('an ambiguous SMTP failure is never archived or retried, and idempotent requests never send again',async()=>{
  const f=fixture({smtpError:'SMTP_UNCERTAIN'}),r=await(await f.handler(request('send',fields))).json();assert.equal(r.job.status,'uncertain');assert.deepEqual(f.count(),{smtp:1,append:0});
  const replay=fixture({existing:true});await replay.handler(request('send',fields));assert.deepEqual(replay.count(),{smtp:0,append:0});
});

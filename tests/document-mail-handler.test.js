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
    if(name.endsWith('_complete')){status=p.p_status;data={job:{id,status,...(p.p_delivery?{errorCode:p.p_delivery.errorCode,accepted:p.p_delivery.accepted,rejected:p.p_delivery.rejected}:{})},...(status==='archive_pending'?{workspace:{state:{},version:8}}:{})};}
    if(name.endsWith('_archive_claim'))data={raw:btoa('exact-mime'),messageId:'<fixture@example.test>'};
    return {data,error:null};}};
  const mail={buildMessage:async()=>({raw:new TextEncoder().encode('exact-mime'),messageId:'<fixture@example.test>',envelope:{from:'sender@example.test',to:fields.to}}),
    sendRaw:async()=>{++smtp;if(smtpError)throw Object.assign(new Error('raw secret detail'),typeof smtpError==='string'?{code:smtpError}:smtpError);},
    appendSent:async(_c,folder,raw)=>{++append;assert.equal(folder,'Sent');assert.equal(new TextDecoder().decode(raw),'exact-mime');if(archiveError)throw Error('private detail');}};
  const handler=createDocumentMailHandler({db,auth:{getUser:async()=>({data:{user:{id:user,email:'sender@example.test'}}})},mail,renderDocumentPdf:async()=>new Uint8Array([1,2]),logoBytes:new Uint8Array([3])});
  return {handler,calls,count:()=>({smtp,append})};
}
test('AAL1 and a switched identity cannot access profile, credentials or jobs',async()=>{
  for(const req of [request('profile',{},'aal1'),request('profile',{expectedUserId:org}),request('composer',{documentId:'quote'},'aal1'),request('composer',{documentId:'quote',expectedUserId:org})]){
    const f=fixture(),r=await f.handler(req);assert.equal(r.status,403);assert.equal(f.calls.length,0);
  }
});

test('composer starts the independent public profile and history reads in parallel without credentials',async()=>{
  const calls=[];let release;
  const gate=new Promise(resolve=>release=resolve);
  const publicProfile={email:'sender@example.test',signature,connected:true,version:1,provider:'serviciodecorreo'};
  const history=[{id,status:'sent',to:['client@example.test'],cc:[]}];
  const handler=createDocumentMailHandler({db:{rpc:async(name,p)=>{
    calls.push({name,p});await gate;
    return {data:name.endsWith('_profile')?publicProfile:{history},error:null};
  }},auth:{getUser:async()=>({data:{user:{id:user,email:publicProfile.email}}})},mail:{},renderDocumentPdf:()=>{throw Error('read cannot render or send');}});
  const pending=handler(request('composer',{documentId:'quote'}));await new Promise(resolve=>setImmediate(resolve));
  const started=calls.map(call=>call.name);release();
  const response=await pending,result=await response.json();
  assert.equal(response.status,200);assert.deepEqual(started,['orquivia_mail_profile','orquivia_mail_history']);
  assert.deepEqual(calls,[{name:'orquivia_mail_profile',p:{p_user:user,p_org:org,p_secrets:false}},
    {name:'orquivia_mail_history',p:{p_user:user,p_org:org,p_document:'quote'}}]);
  assert.deepEqual(result,{profile:publicProfile,history});assert.equal(result.profile.password,undefined);assert.equal(result.profile.sentFolder,undefined);
});

test('history performs only its membership-checked history RPC and malformed composer documents perform no RPC',async()=>{
  const calls=[];
  const handler=createDocumentMailHandler({db:{rpc:async(name,p)=>{calls.push({name,p});return {data:{history:[]},error:null};}},
    auth:{getUser:async()=>({data:{user:{id:user,email:'sender@example.test'}}})},mail:{}});
  const historyResponse=await handler(request('history',{documentId:'quote'}));
  assert.equal(historyResponse.status,200);assert.deepEqual(await historyResponse.json(),{history:[]});
  assert.deepEqual(calls,[{name:'orquivia_mail_history',p:{p_user:user,p_org:org,p_document:'quote'}}]);
  calls.length=0;
  const invalid=await handler(request('composer',{documentId:{forged:'quote'}}));assert.equal(invalid.status,400);assert.deepEqual(calls,[]);
});

test('composer fails closed if either independent membership or MFA check denies access',async()=>{
  for(const [denied,errorCode] of [['orquivia_mail_profile','MEMBERSHIP_REQUIRED'],['orquivia_mail_history','MFA_REQUIRED']]) {
    const handler=createDocumentMailHandler({db:{rpc:async name=>name===denied?{data:null,error:{message:errorCode}}:
      {data:name.endsWith('_profile')?{email:'sender@example.test',signature}:{history:[{id:'private-job'}]},error:null}},
      auth:{getUser:async()=>({data:{user:{id:user,email:'sender@example.test'}}})},mail:{}});
    const response=await handler(request('composer',{documentId:'quote'}));
    assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:errorCode});
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

test('To/Cc are normalized into the claim and the request hash changes when Cc changes',async()=>{
  const first=fixture(),second=fixture();
  await first.handler(request('send',{...fields,to:['client@example.test','other@example.test'],cc:['copy@example.test','CLIENT@example.test']}));
  await second.handler(request('send',{...fields,to:['client@example.test','other@example.test'],cc:['different@example.test']}));
  const claim=f=>f.calls.find(call=>call.name==='orquivia_mail_claim').p;
  assert.deepEqual(claim(first).p_to,['client@example.test','other@example.test']);assert.deepEqual(claim(first).p_cc,['copy@example.test']);
  assert.notEqual(claim(first).p_hash,claim(second).p_hash);
});

test('a partially accepted message records recipients without archiving, marking sent or returning a workspace change',async()=>{
  const f=fixture({smtpError:{code:'SMTP_PARTIAL',accepted:fields.to,rejected:['copy@example.test']}});
  const result=await(await f.handler(request('send',{...fields,cc:['copy@example.test']}))).json();
  assert.equal(result.job.status,'uncertain');assert.equal(result.job.errorCode,'SMTP_PARTIAL');assert.deepEqual(result.job.accepted,fields.to);assert.deepEqual(result.job.rejected,['copy@example.test']);
  assert.equal(result.workspace,undefined);assert.deepEqual(f.count(),{smtp:1,append:0});
  assert.ok(f.calls.some(call=>call.name==='orquivia_mail_store_message'));
  assert.ok(!f.calls.some(call=>call.p.p_status==='archive_pending'||call.name==='orquivia_mail_archive_claim'));
});

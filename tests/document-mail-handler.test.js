import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailHandler } from '../supabase/functions/_shared/document-mail-handler.js';
import { encodeMailAttachments, MAIL_ATTACHMENT_LIMITS } from '../src/mail-attachments.js';
const user = '10000000-0000-4000-8000-000000000001', org = '20000000-0000-4000-8000-000000000001', id = '30000000-0000-4000-8000-000000000001';
const signature = {name:'Persona de prueba',role:'Dirección',phone:''};
const token = (aal='aal2') => `header.${Buffer.from(JSON.stringify({sub:user,exp:Math.floor(Date.now()/1000)+3600,aal})).toString('base64url')}.signature`;
const request = (action,fields={},aal='aal2') => new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${token(aal)}`,origin:'https://npereyra-orquivia.github.io'},body:JSON.stringify({action,organizationId:org,expectedUserId:user,...fields})});
const fields = {documentId:'quote',expectedWorkspaceVersion:7,idempotencyKey:id,to:['client@example.test'],subject:'Presupuesto',message:'Un mensaje'};

function fixture({smtpError,archiveError,existing=false,invoice=false,storeError,buildError}={}) {
  const calls=[],built=[];let smtp=0,append=0,status='sending';
  const db={rpc:async(name,p)=>{calls.push({name,p});let data;
    if(name.endsWith('_profile'))data={email:'sender@example.test',connected:true,signature,version:1,provider:'serviciodecorreo',...(p.p_secrets?{password:'test-password',sentFolder:'Sent'}:{})};
    if(name.endsWith('_claim')&&!name.endsWith('archive_claim')){
      if(p.p_attachments?.length&&!invoice)return {data:null,error:{message:'DOCUMENT_NOT_SENDABLE'}};
      data={existing,job:{id,status,createdAt:'2026-10-15T09:00:00Z'},document:{id:invoice?'invoice':'quote',kind:invoice?'invoice':'quote',status:invoice?'issued':'ready',number:invoice?'F-001':'PR-001'},company:{},client:{}};
    }
    if(name.endsWith('_store_message')&&storeError)return {data:null,error:{message:storeError}};
    if(name.endsWith('_complete')){status=p.p_status;data={job:{id,status,...(p.p_delivery?{errorCode:p.p_delivery.errorCode,accepted:p.p_delivery.accepted,rejected:p.p_delivery.rejected}:{})},...(status==='archive_pending'?{workspace:{state:{},version:8}}:{})};}
    if(name.endsWith('_archive_claim'))data={...(p.p_include_raw===false?{}:{raw:btoa('exact-mime')}),messageId:'<fixture@example.test>'};
    return {data,error:null};}};
  const mail={buildMessage:async args=>{built.push(args);if(buildError)throw Object.assign(Error('private detail'),{code:buildError});return {raw:new TextEncoder().encode('exact-mime'),messageId:'<fixture@example.test>',envelope:{from:'sender@example.test',to:fields.to}};},
    sendRaw:async()=>{++smtp;if(smtpError)throw Object.assign(new Error('raw secret detail'),typeof smtpError==='string'?{code:smtpError}:smtpError);},
    appendSent:async(_c,folder,raw)=>{++append;assert.equal(folder,'Sent');assert.equal(new TextDecoder().decode(raw),'exact-mime');if(archiveError)throw Error('private detail');}};
  const handler=createDocumentMailHandler({db,auth:{getUser:async()=>({data:{user:{id:user,email:'sender@example.test'}}})},mail,renderDocumentPdf:async()=>new Uint8Array([1,2]),logoBytes:new Uint8Array([3])});
  return {handler,calls,built,count:()=>({smtp,append})};
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

const extra = (text='Synthetic document') => ({ name:'Justificante.pdf',contentType:'application/pdf',bytes:new TextEncoder().encode('%PDF-1.7\n'+text+'\n%%EOF') });

test('invoice extras are decoded once, hashed into the claim and archived as exactly the prepared MIME',async()=>{
  const f=fixture({invoice:true}), attachment=extra('a'.repeat(110_000));
  const r=await f.handler(request('send',{...fields,documentId:'invoice',attachments:encodeMailAttachments([attachment])}));
  const result=await r.json();assert.equal(r.status,200);assert.equal(result.job.status,'sent');
  assert.deepEqual(f.count(),{smtp:1,append:1});
  const claim=f.calls.find(call=>call.name==='orquivia_mail_claim').p;
  assert.equal(claim.p_attachments[0].name,attachment.name);assert.equal(claim.p_attachments[0].size,attachment.bytes.length);
  assert.match(claim.p_attachments[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(claim.p_attachments[0].bytes,undefined);assert.equal(claim.p_attachments[0].contentBase64,undefined);
  assert.deepEqual(f.built[0].attachments,[attachment]);assert.equal(f.built[0].documentKind,'invoice');
  assert.equal(f.calls.find(call=>call.name==='orquivia_mail_archive_claim').p.p_include_raw,false);
  assert.ok(!JSON.stringify(result).includes('Synthetic document'));
});

test('same file bytes preserve idempotency while changed bytes or filenames alter the request hash',async()=>{
  const attempts=[];
  for(const attachment of [extra('same'),extra('same'),extra('changed'),{...extra('same'),name:'Otra-referencia.pdf'}]){
    const f=fixture({invoice:true,existing:true});await f.handler(request('send',{...fields,documentId:'invoice',attachments:encodeMailAttachments([attachment])}));
    attempts.push(f.calls.find(call=>call.name==='orquivia_mail_claim').p.p_hash);assert.deepEqual(f.count(),{smtp:0,append:0});
  }
  assert.equal(attempts[0],attempts[1]);assert.notEqual(attempts[0],attempts[2]);assert.notEqual(attempts[0],attempts[3]);
  const a=fixture(),b=fixture();await a.handler(request('send',fields));await b.handler(request('send',{...fields,attachments:[]}));
  assert.equal(a.calls.find(call=>call.name==='orquivia_mail_claim').p.p_hash,b.calls.find(call=>call.name==='orquivia_mail_claim').p.p_hash);
});

test('quote extras and malformed or oversized payloads cannot reach SMTP or the PDF renderer',async()=>{
  const quote=fixture();const r=await quote.handler(request('send',{...fields,attachments:encodeMailAttachments([extra()])}));
  assert.equal(r.status,400);assert.deepEqual(quote.count(),{smtp:0,append:0});assert.equal(quote.built.length,0);
  for(const attachments of [[{name:'proof.pdf',contentType:'application/pdf',contentBase64:btoa('<html>not pdf</html>')}],
    [{name:'proof.pdf',contentType:'application/pdf',contentBase64:btoa('%PDF-1.7'),url:'https://private.invalid/file'}],
    Array.from({length:6},(_,index)=>({...encodeMailAttachments([extra()])[0],name:`proof-${index}.pdf`}))]){
    const f=fixture({invoice:true});const response=await f.handler(request('send',{...fields,documentId:'invoice',attachments}));
    assert.equal(response.status,400);assert.deepEqual(f.count(),{smtp:0,append:0});assert.equal(f.built.length,0);
    assert.ok(!f.calls.some(call=>call.name==='orquivia_mail_claim'));
  }
  const f=fixture();const oversized=request('send',fields);oversized.headers.set('content-length',String(MAIL_ATTACHMENT_LIMITS.bodyBytes+1));
  assert.equal((await f.handler(oversized)).status,400);assert.equal(f.calls.length,0);
});

test('quota and MIME preparation failures are definite unsent outcomes with a useful recorded error',async()=>{
  for(const options of [{storeError:'MAIL_STORAGE_LIMIT'}, {buildError:'MAIL_MESSAGE_TOO_LARGE'}, {buildError:'provider-private-error'}]){
    const f=fixture({invoice:true,...options});const result=await(await f.handler(request('send',{...fields,documentId:'invoice',attachments:encodeMailAttachments([extra()])}))).json();
    assert.equal(result.job.status,'failed');assert.equal(result.workspace,undefined);assert.deepEqual(f.count(),{smtp:0,append:0});
    assert.equal(result.job.errorCode,options.storeError||(['MAIL_MESSAGE_TOO_LARGE'].includes(options.buildError)?options.buildError:'MAIL_PREPARATION_FAILED'));
    assert.ok(!JSON.stringify(result).includes('private'));
  }
});

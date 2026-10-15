import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailBackend } from '../src/document-mail-backend.js';

test('a mailbox response from an old login cannot enter the new account',async()=>{
  let user={id:'owner'},release,adopted=0;
  const response=new Promise(resolve=>release=resolve);
  const mail=createDocumentMailBackend({client:{functions:{invoke:async()=>response}},requireUser:async()=>user,getWorkspace:()=>({organizationId:'org'}),getVersion:()=>1,enqueue:fn=>fn(),adoptWorkspace:()=>++adopted});
  const pending=mail.profile();await new Promise(resolve=>setImmediate(resolve));user={id:'other'};release({data:{email:'old@example.test'},error:null});
  await assert.rejects(pending,error=>error.code==='AUTH_CHANGED');assert.equal(adopted,0);
});
test('mail requests bind the authenticated account and serialize financial version adoption',async()=>{
  let version=1,queue=Promise.resolve(),calls=[];
  const mail=createDocumentMailBackend({client:{functions:{invoke:async(_name,args)=>{calls.push(args.body);return {data:{job:{status:'sent'},workspace:{state:{},version:2}},error:null};}}},
    requireUser:async()=>({id:'owner'}),getWorkspace:()=>({organizationId:'org'}),getVersion:()=>version,
    enqueue:fn=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;},adoptWorkspace:result=>version=result.version});
  const first=mail.send('quote',{idempotencyKey:'key',expectedUserId:'forged',organizationId:'forged'}),second=mail.send('quote',{idempotencyKey:'other'});
  await first;await assert.rejects(second,error=>error.code==='VERSION_CONFLICT');
  assert.equal(calls.length,1);assert.equal(calls[0].expectedUserId,'owner');assert.equal(calls[0].organizationId,'org');assert.equal(version,2);
});
test('server/provider errors cannot disclose credential details through frontend messages',async()=>{
  const mail=createDocumentMailBackend({client:{functions:{invoke:async()=>({data:{error:{code:'PRIVATE_PROVIDER_ERROR',message:'password=secret'}},error:null})}},requireUser:async()=>({id:'owner'}),getWorkspace:()=>({organizationId:'org'}),getVersion:()=>1,enqueue:fn=>fn(),adoptWorkspace:()=>{}});
  await assert.rejects(mail.profile(),error=>!error.message.includes('password')&&!error.message.includes('secret'));
});

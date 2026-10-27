import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailBackend } from '../src/document-mail-backend.js';
import { createDocumentMailHandler } from '../supabase/functions/_shared/document-mail-handler.js';

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

test('composer loads profile and history in one request with authenticated context guards',async()=>{
  const calls=[];let checks=0;
  const profile={email:'owner@example.test',connected:true,signature:{name:'Owner',role:'',phone:''},version:1};
  const history=[{id:'job',status:'sent',to:['client@example.test']}];
  const mail=createDocumentMailBackend({client:{functions:{invoke:async(name,args)=>{calls.push({name,...args});return {data:{profile,history},error:null};}}},
    requireUser:async()=>{++checks;return {id:'owner'};},getWorkspace:()=>({organizationId:'org'}),getVersion:()=>1,enqueue:fn=>fn(),adoptWorkspace:()=>{throw Error('read must not adopt a workspace');}});
  assert.deepEqual(await mail.composer('quote'),{profile,history});
  assert.equal(calls.length,1);assert.equal(checks,2);
  assert.deepEqual(calls[0],{name:'document-mail',body:{documentId:'quote',action:'composer',expectedUserId:'owner',organizationId:'org'}});
});

test('composer never returns an old identity or organization response after switching sessions',async()=>{
  for(const change of ['user','organization','mfa']) {
    let user={id:'owner'},organizationId='org',mfa=true,release;
    const response=new Promise(resolve=>release=resolve);
    const mail=createDocumentMailBackend({client:{functions:{invoke:async()=>response}},
      requireUser:async()=>{if(!mfa)throw Object.assign(Error('MFA required'),{code:'MFA_REQUIRED'});return user;},getWorkspace:()=>({organizationId}),getVersion:()=>1,enqueue:fn=>fn(),adoptWorkspace:()=>{throw Error('read must not adopt a workspace');}});
    const pending=mail.composer('quote');await new Promise(resolve=>setImmediate(resolve));
    if(change==='user')user={id:'other'};else if(change==='organization')organizationId='other-org';else mfa=false;
    release({data:{profile:{email:'old@example.test'},history:[{id:'private-job'}]},error:null});
    await assert.rejects(pending,error=>error.code===(change==='mfa'?'MFA_REQUIRED':'AUTH_CHANGED'));
  }
});

test('composer cannot invoke the function before MFA verification',async()=>{
  let calls=0;
  const mail=createDocumentMailBackend({client:{functions:{invoke:async()=>{++calls;return {data:{},error:null};}}},
    requireUser:async()=>{throw Object.assign(Error('MFA required'),{code:'MFA_REQUIRED'});},getWorkspace:()=>({organizationId:'org'}),getVersion:()=>1,enqueue:fn=>fn(),adoptWorkspace:()=>{}});
  await assert.rejects(mail.composer('quote'),error=>error.code==='MFA_REQUIRED');assert.equal(calls,0);
});

test('modern and legacy database profile conflicts keep a readable Edge error and preserve the edited signature',async()=>{
  const user={id:'10000000-0000-4000-8000-000000000001',email:'owner@example.test'},organizationId='20000000-0000-4000-8000-000000000001';
  const signature={name:'Owner edited locally',role:'Dirección',phone:'+34 600 000 000'};
  const jwt=`header.${Buffer.from(JSON.stringify({sub:user.id,aal:'aal2',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.signature`;
  for(const databaseCode of ['PT409','40001']){
    const calls=[];let adopted=0;
    const handler=createDocumentMailHandler({db:{rpc:async(name,parameters)=>{
      calls.push({name,parameters});
      if(name==='orquivia_mail_profile')return {data:{email:user.email,connected:true,signature:{name:'Server original',role:'',phone:''},version:2},error:null};
      assert.equal(name,'orquivia_mail_save_profile');assert.equal(parameters.p_expected_version,1);
      assert.deepEqual(parameters.p_signature,signature);
      return {data:null,error:{code:databaseCode,message:'PROFILE_CONFLICT',details:'private provider data'}};
    }},auth:{getUser:async()=>({data:{user},error:null})},mail:{},renderDocumentPdf:()=>{throw Error('A profile conflict cannot render or send a document');}});
    const mail=createDocumentMailBackend({client:{functions:{invoke:async(_name,args)=>{
      const response=await handler(new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${jwt}`,origin:'https://npereyra-orquivia.github.io'},body:JSON.stringify(args.body)}));
      assert.equal(response.status,409,'The Edge protocol exposes the same business conflict for either database SQLSTATE');
      assert.deepEqual(await response.clone().json(),{error:'PROFILE_CONFLICT'});
      return {data:null,error:{context:response}};
    }}},requireUser:async()=>user,getWorkspace:()=>({organizationId}),getVersion:()=>7,enqueue:fn=>fn(),adoptWorkspace:()=>++adopted});
    const draft={expectedVersion:1,signature:structuredClone(signature)},retained=structuredClone(draft);
    await assert.rejects(mail.signature(draft),error=>{
      assert.equal(error.code,'PROFILE_CONFLICT');assert.equal(error.message,'Tu configuración cambió en otra pestaña. Vuelve a cargarla.');
      assert.ok(!error.message.includes('private provider'));return true;
    });
    assert.deepEqual(draft,retained);assert.equal(adopted,0);
    assert.deepEqual(calls.map(call=>call.name),['orquivia_mail_profile','orquivia_mail_save_profile']);
  }
});

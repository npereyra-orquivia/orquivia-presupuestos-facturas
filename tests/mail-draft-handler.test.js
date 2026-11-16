import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentMailHandler } from '../supabase/functions/_shared/document-mail-handler.js';
const user='10000000-0000-4000-8000-000000000001',org='20000000-0000-4000-8000-000000000001';
const id='30000000-0000-4000-8000-000000000001';
const draft={to:'unfinished@',cc:'',subject:'',message:'Still writing\nwith a second line\tand a tab',relatedDocumentIds:['quote-z','quote-a'],idempotencyKey:id};
const request=(action,fields={},aal='aal2')=>{
 const token=`header.${Buffer.from(JSON.stringify({sub:user,exp:Math.floor(Date.now()/1000)+3600,aal})).toString('base64url')}.signature`;
 return new Request('https://example.test',{method:'POST',headers:{authorization:`Bearer ${token}`,origin:'https://npereyra-orquivia.github.io'},body:JSON.stringify({action,documentId:'quote-main',organizationId:org,expectedUserId:user,...fields})});
};
function fixture({error,result={draft:null,version:0,updatedAt:null}}={}){
 const calls=[];const forbidden=()=>{throw Error('Draft operations must never contact a mailbox or render a PDF');};
 const handler=createDocumentMailHandler({db:{rpc:async(name,params)=>{calls.push({name,params});return error?{data:null,error:{message:'Private provider detail: '+error}}:{data:result,error:null};}},
 auth:{getUser:async()=>({data:{user:{id:user,email:'owner@example.test'}}})},mail:{verifyMailbox:forbidden,sendRaw:forbidden,appendSent:forbidden,buildMessage:forbidden},renderDocumentPdf:forbidden});
 return{handler,calls};
}
test('an incomplete draft is saved independently from sending with exact text and normalized official quote IDs',async()=>{
 const result={draft:{...draft,relatedDocumentIds:['quote-a','quote-z']},version:4,updatedAt:'2026-01-01T00:00:00Z'};const f=fixture({result});
 const response=await f.handler(request('draft-save',{expectedDraftVersion:3,draft}));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),result);
 assert.deepEqual(f.calls,[{name:'orquivia_mail_draft_save',params:{p_user:user,p_org:org,p_document:'quote-main',p_expected_version:3,p_draft:result.draft}}]);
});
test('reading a personal draft needs only its membership-checked RPC and never reads mailbox credentials',async()=>{
 const f=fixture();const response=await f.handler(request('draft-read'));
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{draft:null,version:0,updatedAt:null});
 assert.deepEqual(f.calls,[{name:'orquivia_mail_draft_read',params:{p_user:user,p_org:org,p_document:'quote-main'}}]);
});
test('identity and second-factor guards reject every draft action before reaching any database RPC',async()=>{
 for(const action of ['draft-read','draft-save'])for(const [fields,aal]of [[{},'aal1'],[{expectedUserId:org},'aal2']]){
  const f=fixture();const response=await f.handler(request(action,{expectedDraftVersion:0,draft,...fields},aal));assert.equal(response.status,403);assert.equal(f.calls.length,0);
 }
});
test('binary extras, unknown fields, oversized text, control injection and invalid UUIDs cannot enter draft storage',async()=>{
 const invalid=[null,[],{...draft,attachments:[]},{...draft,password:'not-allowed'},{...draft,to:[]},{...draft,to:'x'.repeat(5201)},{...draft,cc:'x'.repeat(5201)},
 {...draft,subject:'x'.repeat(201)},{...draft,message:'x'.repeat(20001)},{...draft,subject:'bad\nheader'},{...draft,cc:'bad\rheader'},
 {...draft,message:'bad\u0001control'},{...draft,idempotencyKey:'not-a-uuid'}];
 const missing={...draft};delete missing.message;invalid.push(missing);
 for(const value of invalid){const f=fixture();const response=await f.handler(request('draft-save',{expectedDraftVersion:0,draft:value}));assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'INVALID_DRAFT'});assert.equal(f.calls.length,0);}
});
test('related quote selections stay bounded, unique and separate from the primary PDF',async()=>{
 for(const relatedDocumentIds of [null,['quote-main'],['a','a'],['a','b','c','d','e'],[5],[' trailing '],['bad\ncontrol']]){
  const f=fixture();const response=await f.handler(request('draft-save',{expectedDraftVersion:0,draft:{...draft,relatedDocumentIds}}));assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'INVALID_RELATED_DOCUMENTS'});assert.equal(f.calls.length,0);
 }
 const f=fixture();const value={...draft};delete value.relatedDocumentIds;await f.handler(request('draft-save',{expectedDraftVersion:0,draft:value}));assert.deepEqual(f.calls[0].params.p_draft.relatedDocumentIds,[]);
});
test('invalid draft version or document IDs never invoke database or mailbox operations',async()=>{
 for(const expectedDraftVersion of [undefined,null,-1,0.5,Number.MAX_SAFE_INTEGER+1]){
  const f=fixture();const response=await f.handler(request('draft-save',{expectedDraftVersion,draft}));assert.equal(response.status,400);assert.equal(f.calls.length,0);
 }
 for(const documentId of ['',null,{},'x'.repeat(101),'bad\ncontrol']){
  const f=fixture();const response=await f.handler(request('draft-read',{documentId}));assert.equal(response.status,400);assert.equal(f.calls.length,0);
 }
});
test('concurrent-tab conflicts and membership failures expose only stable codes without draft or provider text',async()=>{
 for(const [error,status]of [['DRAFT_CONFLICT',409],['MEMBERSHIP_REQUIRED',403],['MFA_REQUIRED',403],['INVALID_DRAFT',400],['unexpected-private-detail',400]]){
  const f=fixture({error});const response=await f.handler(request('draft-save',{expectedDraftVersion:3,draft}));assert.equal(response.status,status);
  assert.deepEqual(await response.json(),{error:error==='unexpected-private-detail'?'MAIL_DATABASE_ERROR':error});
 }
});

import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=await PGlite.create();
const owner='10000000-0000-4000-8000-000000000001',editor='10000000-0000-4000-8000-000000000002',outsider='10000000-0000-4000-8000-000000000003',unverified='10000000-0000-4000-8000-000000000004';
const org='20000000-0000-4000-8000-000000000001',otherOrg='20000000-0000-4000-8000-000000000002';
const draft={to:'unfinished@',cc:'',subject:'',message:'Line one\nLine two\tstill editing',relatedDocumentIds:['extra'],idempotencyKey:'30000000-0000-4000-8000-000000000001'};
let checks=0;const equal=(a,b)=>{assert.deepEqual(a,b);checks++;};
const query=async(sql,args=[])=>(await db.query(sql,args)).rows;
const denied=async(sql,args=[],code)=>{await assert.rejects(db.query(sql,args),code?error=>error.message.includes(code):undefined);checks++;};
const read='select public.orquivia_mail_draft_read($1,$2,$3) result';
const save='select public.orquivia_mail_draft_save($1,$2,$3,$4,$5) result';
try{
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text);create table auth.mfa_factors(user_id uuid,status text);
 create schema orquivia_private;create table public.orquivia_organizations(id uuid primary key);
 create table public.orquivia_memberships(organization_id uuid,user_id uuid,active boolean);
 create table public.orquivia_team_workspaces(organization_id uuid primary key,state jsonb,version bigint default 1,updated_at timestamptz default now());
 insert into auth.users values('${owner}','owner@example.test'),('${editor}','editor@example.test'),('${outsider}','outsider@example.test'),('${unverified}','unverified@example.test');
 insert into auth.mfa_factors values('${owner}','verified'),('${editor}','verified'),('${outsider}','verified'),('${unverified}','unverified');
 insert into public.orquivia_organizations values('${org}'),('${otherOrg}');
 insert into public.orquivia_memberships values('${org}','${owner}',true),('${org}','${editor}',true),('${otherOrg}','${outsider}',true),('${org}','${unverified}',true);`);
 const mail=await readFile(new URL('../migrations/202610150012_document_mail.sql',import.meta.url),'utf8');await db.exec(mail.replace('create extension if not exists supabase_vault with schema vault;',''));
 await db.exec(await readFile(new URL('../migrations/202611160019_mail_drafts.sql',import.meta.url),'utf8'));
 const q=(id,clientId='client',status='ready',kind='quote')=>({id,clientId,status,kind,number:'FIXTURE-'+id});
 const state={documents:[q('main'),q('extra'),q('third'),q('wrong-client','other'),q('unissued','client','draft'),q('rejected','client','rejected'),q('invoice','client','issued','invoice')]};
 await db.query('insert into public.orquivia_team_workspaces(organization_id,state) values($1,$2),($3,$2)',[org,state,otherOrg]);
 await db.exec('set role service_role');
 equal((await query(read,[owner,org,'main']))[0].result,{draft:null,version:0,updatedAt:null});
 let saved=(await query(save,[owner,org,'main',0,draft]))[0].result;equal(saved.draft,draft);equal(saved.version,1);equal(typeof saved.updatedAt,'string');
 equal((await query(read,[owner,org,'main']))[0].result,saved);
 // Each account, document and organization has an independent record.
 equal((await query(read,[editor,org,'main']))[0].result.draft,null);
 equal((await query(read,[owner,org,'extra']))[0].result.draft,null);
 equal((await query(read,[outsider,otherOrg,'main']))[0].result.draft,null);
 await denied(read,[owner,otherOrg,'main'],'MEMBERSHIP_REQUIRED');await denied(read,[outsider,org,'main'],'MEMBERSHIP_REQUIRED');
 await denied(read,[unverified,org,'main'],'MFA_REQUIRED');await denied(save,[unverified,org,'main',0,draft],'MFA_REQUIRED');
 let replacement={...draft,message:'Later edit',relatedDocumentIds:['third','extra']};saved=(await query(save,[owner,org,'main',1,replacement]))[0].result;
 equal(saved.version,2);equal(saved.draft.relatedDocumentIds,['extra','third']);
 await denied(save,[owner,org,'main',1,{...draft,message:'Stale tab would overwrite'}],'DRAFT_CONFLICT');equal((await query(read,[owner,org,'main']))[0].result,saved);
 await query(save,[editor,org,'main',0,{...draft,message:'Editor private draft'}]);equal((await query(read,[owner,org,'main']))[0].result.draft.message,'Later edit');
 for(const changes of [{attachments:[]},{credential:'forbidden'},{idempotencyKey:'invalid'},{to:[]},{to:'a'.repeat(5201)},{cc:'x'.repeat(5201)},{subject:'x'.repeat(201)},{message:'x'.repeat(20001)},{subject:'Header\r\ninjection'},{to:'Line\nBreak'},{message:'\u0001control'},{idempotencyKey:null}])await denied(save,[owner,org,'main',2,{...draft,...changes}],'INVALID_DRAFT');
 const missing={...draft};delete missing.message;await denied(save,[owner,org,'main',2,missing],'INVALID_DRAFT');
 for(const ids of [['main'],['extra','extra'],['extra','third','a','b','c'],[5],null,['extra ']])await denied(save,[owner,org,'main',2,{...draft,relatedDocumentIds:ids}],'INVALID_RELATED_DOCUMENTS');
 for(const ids of [['wrong-client'],['unissued'],['invoice'],['missing'],['rejected']])await denied(save,[owner,org,'main',2,{...draft,relatedDocumentIds:ids}],'DOCUMENT_NOT_SENDABLE');
 await denied(save,[owner,org,'invoice',0,draft],'INVALID_RELATED_DOCUMENTS');
 await denied(save,[owner,org,'unissued',0,{...draft,relatedDocumentIds:[]}],'DOCUMENT_NOT_SENDABLE');await denied(save,[owner,org,'missing',0,draft],'DOCUMENT_NOT_SENDABLE');
 const invoice={...draft,relatedDocumentIds:[]};equal((await query(save,[owner,org,'invoice',0,invoice]))[0].result.draft,invoice);
 await db.exec('reset role');equal((await query('select state,version from public.orquivia_team_workspaces where organization_id=$1',[org]))[0],{state,version:1});equal((await query('select count(*)::int n from orquivia_private.mail_jobs'))[0].n,0);
 // Prepared draft reads/writes never acquire a mailbox credential or send job.
 for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await denied(read,[owner,org,'main']);await denied(save,[owner,org,'main',2,draft]);await denied('select * from orquivia_private.mail_drafts');await db.exec('reset role');}
 console.log(`Mail draft PostgreSQL: ${checks} checks passed.`);
}finally{await db.close();}

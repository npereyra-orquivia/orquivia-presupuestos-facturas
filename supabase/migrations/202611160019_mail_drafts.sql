-- Personal email drafts contain only editable text and official document IDs.
-- No SMTP credentials, message MIME or uploaded attachment bytes are stored here.
begin;

create table orquivia_private.mail_drafts (
  organization_id uuid not null references public.orquivia_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  document_id text not null check(length(document_id) between 1 and 100 and document_id !~ '[[:cntrl:]]'),
  draft jsonb not null check(jsonb_typeof(draft)='object' and octet_length(draft::text)<=150000),
  version bigint not null check(version between 1 and 9007199254740991),
  updated_at timestamptz not null default now(),
  primary key(organization_id,user_id,document_id)
);
alter table orquivia_private.mail_drafts enable row level security;
revoke all on orquivia_private.mail_drafts from public,anon,authenticated;

create function public.orquivia_mail_draft_read(p_user uuid,p_org uuid,p_document text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved orquivia_private.mail_drafts;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  if p_document is null or length(p_document) not between 1 and 100 or p_document ~ '[[:cntrl:]]' then raise exception 'INVALID_DOCUMENT'; end if;
  select * into saved from orquivia_private.mail_drafts where organization_id=p_org and user_id=p_user and document_id=p_document;
  return jsonb_build_object('draft',saved.draft,'version',coalesce(saved.version,0),'updatedAt',saved.updated_at);
end; $$;

create function public.orquivia_mail_draft_save(p_user uuid,p_org uuid,p_document text,p_expected_version bigint,p_draft jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare saved orquivia_private.mail_drafts; s jsonb; d jsonb; rd jsonb; related jsonb; normalized_related jsonb; field text; ref jsonb; normalized jsonb;
begin
  perform orquivia_private.mail_member(p_user,p_org);
  if p_document is null or length(p_document) not between 1 and 100 or p_document ~ '[[:cntrl:]]' then raise exception 'INVALID_DOCUMENT'; end if;
  if p_expected_version is null or p_expected_version not between 0 and 9007199254740991 then raise exception 'INVALID_DRAFT'; end if;
  if jsonb_typeof(p_draft) is distinct from 'object' or octet_length(p_draft::text)>150000 then raise exception 'INVALID_DRAFT'; end if;
  if exists(select 1 from jsonb_object_keys(p_draft) k where k not in ('to','cc','subject','message','relatedDocumentIds','idempotencyKey')) then raise exception 'INVALID_DRAFT'; end if;
  foreach field in array array['to','cc','subject','message','idempotencyKey'] loop
    if jsonb_typeof(p_draft->field) is distinct from 'string' then raise exception 'INVALID_DRAFT'; end if;
  end loop;
  if length(p_draft->>'to')>5200 or length(p_draft->>'cc')>5200 or length(p_draft->>'subject')>200 or length(p_draft->>'message')>20000
    or (p_draft->>'to') ~ '[[:cntrl:]]' or (p_draft->>'cc') ~ '[[:cntrl:]]' or (p_draft->>'subject') ~ '[[:cntrl:]]'
    or translate(p_draft->>'message',chr(9)||chr(10)||chr(13),'') ~ '[[:cntrl:]]'
    or (p_draft->>'idempotencyKey') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_DRAFT'; end if;
  related:=coalesce(p_draft->'relatedDocumentIds','[]'::jsonb);
  if jsonb_typeof(related) is distinct from 'array' or jsonb_array_length(related)>4 then raise exception 'INVALID_RELATED_DOCUMENTS'; end if;
  if exists(select 1 from jsonb_array_elements(related) r where jsonb_typeof(r) is distinct from 'string' or length(r#>>'{}') not between 1 and 100
    or r#>>'{}'=p_document or (r#>>'{}') is distinct from btrim(r#>>'{}') or r#>>'{}' ~ '[[:cntrl:]]')
    or (select count(*) from jsonb_array_elements(related))<>(select count(distinct r) from jsonb_array_elements(related) r) then raise exception 'INVALID_RELATED_DOCUMENTS'; end if;
  select coalesce(jsonb_agg(r order by r#>>'{}'),'[]'::jsonb) into normalized_related from jsonb_array_elements(related) r;
  normalized:=p_draft||jsonb_build_object('relatedDocumentIds',normalized_related);
  perform pg_advisory_xact_lock(hashtextextended('mail-draft:'||p_org::text||':'||p_user::text||':'||p_document,0));
  select * into saved from orquivia_private.mail_drafts where organization_id=p_org and user_id=p_user and document_id=p_document for update;
  if coalesce(saved.version,0)<>p_expected_version then raise exception 'DRAFT_CONFLICT' using errcode='PT409'; end if;
  -- The shared lock makes all selected client/status checks one coherent view.
  select state into s from public.orquivia_team_workspaces where organization_id=p_org for share;
  select value into d from jsonb_array_elements(s->'documents') where value->>'id'=p_document;
  if d is null or coalesce(d->>'number','')='' or not coalesce(((d->>'kind'='quote' and d->>'status' in ('ready','sent'))
    or (d->>'kind'='invoice' and d->>'status' in ('issued','partial','paid','overdue'))),false) then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  if jsonb_array_length(normalized_related)>0 and d->>'kind'<>'quote' then raise exception 'INVALID_RELATED_DOCUMENTS'; end if;
  for ref in select value from jsonb_array_elements(normalized_related) loop
    select value into rd from jsonb_array_elements(s->'documents') where value->>'id'=ref#>>'{}';
    if rd is null or rd->>'kind' is distinct from 'quote' or not coalesce(rd->>'status' in ('ready','sent'),false) or coalesce(rd->>'number','')=''
      or rd->>'clientId' is distinct from d->>'clientId' then raise exception 'DOCUMENT_NOT_SENDABLE'; end if;
  end loop;
  insert into orquivia_private.mail_drafts(organization_id,user_id,document_id,draft,version)
    values(p_org,p_user,p_document,normalized,coalesce(saved.version,0)+1)
    on conflict(organization_id,user_id,document_id) do update set draft=excluded.draft,version=excluded.version,updated_at=now();
  return public.orquivia_mail_draft_read(p_user,p_org,p_document);
end; $$;

revoke all on function public.orquivia_mail_draft_read(uuid,uuid,text),public.orquivia_mail_draft_save(uuid,uuid,text,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.orquivia_mail_draft_read(uuid,uuid,text),public.orquivia_mail_draft_save(uuid,uuid,text,bigint,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;

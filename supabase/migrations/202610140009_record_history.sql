-- Record history is derived by the server from the old and new workspace in
-- the same transaction as a successful versioned save, issue or import.
-- Earlier aggregate audit entries remain unchanged; no history is invented.
begin;

create table public.orquivia_record_history (
  id bigint generated always as identity primary key,
  audit_id bigint not null references public.orquivia_audit_log(id),
  organization_id uuid not null references public.orquivia_organizations(id),
  actor_id uuid, actor_email text, event text not null, workspace_version bigint not null,
  entity_type text not null check(entity_type in ('document','expense','client','payment','company')),
  entity_id text not null check(length(entity_id) between 1 and 160),
  action text not null check(action in ('created','updated','deleted')),
  changed_fields text[] not null,
  related_entity_type text, related_entity_id text,
  created_at timestamptz not null default now()
);
create index on public.orquivia_record_history(organization_id,entity_type,entity_id,id desc);
create index on public.orquivia_record_history(organization_id,related_entity_type,related_entity_id,id desc)
  where related_entity_id is not null;
alter table public.orquivia_record_history enable row level security;
revoke all on public.orquivia_record_history from public,anon,authenticated;
grant select on public.orquivia_record_history to authenticated;
grant all on public.orquivia_record_history to service_role;
grant usage,select on sequence public.orquivia_record_history_id_seq to service_role;
create policy "Company members read record history" on public.orquivia_record_history for select to authenticated
  using(orquivia_private.is_member(organization_id));

create function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare allowed text[]; fields text[]; has_other boolean;
begin
  -- Only known business field names are exposed. Values, nested original
  -- metadata and personal-account/profile fields never enter this history.
  allowed:=case p_type
    when 'document' then array['kind','status','number','clientId','date','dueDate','title','items','vat','discount','withholding','total','notes','po','paymentMethod','contractExpectedDate','contractReceived','paymentReviewNeeded','quoteId','companySnapshot','clientSnapshot','sourceMetadata','importWarnings']
    when 'expense' then array['kind','date','supplier','supplierTaxId','description','category','reference','notes','base','vatAmount','vatRate','vatDeductibleAmount','additionalAmount','total','paymentStatus','paidDate','cashAmount','cashMovements','attachments','reviewNeeded','vatReviewNeeded','vatDocumentStatus','sourceMetadata','importWarnings']
    when 'client' then array['name','taxId','address','email','contact','phone']
    when 'payment' then array['documentId','amount','date','reference']
    when 'company' then array['name','legalName','taxId','address','email','phone','iban','bic','vat','withholding','paymentTerms','emailNotifications','notificationEmail','privacyText','openingBalance','openingBalanceDate']
    else array[]::text[] end;
  select coalesce(array_agg(k order by k),array[]::text[])
    into fields from (
      select k from jsonb_object_keys(coalesce(p_old,'{}'::jsonb)||coalesce(p_new,'{}'::jsonb)) k
      where k<>'id' and p_old->k is distinct from p_new->k
    ) differences where k=any(allowed);
  -- Compute the fallback separately because the known-field filter above
  -- intentionally excludes every unknown key, including credential names.
  select exists(select 1 from jsonb_object_keys(coalesce(p_old,'{}'::jsonb)||coalesce(p_new,'{}'::jsonb)) k
    where k<>'id' and not(k=any(allowed)) and p_old->k is distinct from p_new->k) into has_other;
  if has_other then fields:=array_append(fields,'other'); end if;
  return fields;
end; $$;

create function orquivia_private.record_changes(p_old jsonb,p_new jsonb)
returns table(entity_type text,entity_id text,action text,changed_fields text[],related_entity_type text,related_entity_id text)
language plpgsql immutable set search_path='' as $$
declare collection text; r record;
begin
  foreach collection in array array['documents','expenses','clients','payments'] loop
    entity_type:=case collection when 'documents' then 'document' when 'expenses' then 'expense' when 'clients' then 'client' else 'payment' end;
    for r in
      select old_row.v old_value,new_row.v new_value,coalesce(old_row.v->>'id',new_row.v->>'id') record_id
      from jsonb_array_elements(coalesce(p_old->collection,'[]'::jsonb)) old_row(v)
      full join jsonb_array_elements(coalesce(p_new->collection,'[]'::jsonb)) new_row(v)
        on old_row.v->>'id'=new_row.v->>'id'
      where old_row.v is distinct from new_row.v
    loop
      entity_id:=r.record_id;
      action:=case when r.old_value is null then 'created' when r.new_value is null then 'deleted' else 'updated' end;
      changed_fields:=orquivia_private.record_change_fields(entity_type,r.old_value,r.new_value);
      related_entity_type:=case when entity_type='payment' then 'document' else null end;
      related_entity_id:=case when entity_type='payment' then coalesce(r.new_value->>'documentId',r.old_value->>'documentId') else null end;
      return next;
    end loop;
  end loop;
  if p_old->'company' is distinct from p_new->'company' then
    entity_type:='company'; entity_id:='company';
    action:=case when p_old->'company' is null then 'created' else 'updated' end;
    changed_fields:=orquivia_private.record_change_fields(entity_type,p_old->'company',p_new->'company');
    related_entity_type:=null; related_entity_id:=null;
    return next;
  end if;
end; $$;

create or replace function orquivia_private.audit(p_org uuid,p_event text,p_version bigint,p_old jsonb,p_new jsonb,p_actor uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=coalesce(p_actor,auth.uid()); email text; summary jsonb; audit_id bigint;
begin
  select u.email into email from auth.users u where u.id=actor;
  summary:=jsonb_build_object('documentCount',jsonb_array_length(p_new->'documents'),'paymentCount',jsonb_array_length(p_new->'payments'),
    'expenseCount',jsonb_array_length(coalesce(p_new->'expenses','[]'::jsonb)),
    'expensesChanged',p_old->'expenses' is distinct from p_new->'expenses',
    'companyChanged',p_old->'company' is distinct from p_new->'company','previousDigest',case when p_old is null then null else md5(p_old::text) end);
  insert into public.orquivia_audit_log(organization_id,actor_id,actor_email,event,workspace_version,changes,state_digest)
    values(p_org,actor,email,p_event,p_version,summary,md5(p_new::text)) returning id into audit_id;
  insert into public.orquivia_record_history(audit_id,organization_id,actor_id,actor_email,event,workspace_version,
      entity_type,entity_id,action,changed_fields,related_entity_type,related_entity_id)
    select audit_id,p_org,actor,email,p_event,p_version,c.entity_type,c.entity_id,c.action,c.changed_fields,c.related_entity_type,c.related_entity_id
      from orquivia_private.record_changes(p_old,p_new) c;
end; $$;

create function public.load_orquivia_record_history(p_organization_id uuid,p_entity_type text,p_entity_id text,
    p_limit integer,p_expected_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  perform orquivia_private.require_member(p_organization_id);
  if p_entity_type is null or p_entity_type not in ('document','expense','client','payment','company')
    or p_entity_id is null or length(btrim(p_entity_id))=0 or length(p_entity_id)>160 or p_entity_id ~ '[[:cntrl:]]'
    or (p_entity_type='company' and p_entity_id<>'company') then
    raise exception 'INVALID_HISTORY_RECORD' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(v order by history_id desc),'[]'::jsonb) into result from (
    select h.id history_id,jsonb_build_object('id',h.id,'actorId',h.actor_id,'actorEmail',h.actor_email,'event',h.event,
      'action',h.action,'entityType',h.entity_type,'entityId',h.entity_id,'workspaceVersion',h.workspace_version,
      'changedFields',to_jsonb(h.changed_fields),'createdAt',h.created_at) v
    from public.orquivia_record_history h where h.organization_id=p_organization_id
      and ((h.entity_type=p_entity_type and h.entity_id=p_entity_id)
        or (h.related_entity_type=p_entity_type and h.related_entity_id=p_entity_id))
    order by h.id desc limit greatest(1,least(coalesce(p_limit,50),100))
  ) entries;
  return result;
end; $$;

revoke all on function orquivia_private.record_change_fields(text,jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb),
  orquivia_private.audit(uuid,text,bigint,jsonb,jsonb,uuid) from public,anon,authenticated;
grant execute on function orquivia_private.record_change_fields(text,jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb),
  orquivia_private.audit(uuid,text,bigint,jsonb,jsonb,uuid) to service_role;
revoke all on function public.load_orquivia_record_history(uuid,text,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.load_orquivia_record_history(uuid,text,text,integer,uuid) to authenticated;
commit;

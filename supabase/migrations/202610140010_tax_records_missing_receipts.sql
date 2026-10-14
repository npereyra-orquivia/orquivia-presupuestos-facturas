-- Tax declarations are distinct from supplier expenses and VAT deduction.
-- Their private originals use the same immutable, MFA/member-only bucket.
-- A missing expense receipt requires an explicit note, never invented VAT.
begin;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_vat_documents_v3;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare e jsonb; r jsonb; a jsonb; linked jsonb; field text; value numeric; amount numeric;
  today date:=(now() at time zone 'Europe/Madrid')::date;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  ids text[]:=array[]::text[]; paths text[]:=array[]::text[]; receipt_ids text[]:=array[]::text[];
begin
  -- Keep every existing document, invoice, expense, date and amount rule.
  if not orquivia_private.valid_state_vat_documents_v3(p_state) then return false; end if;
  for e in select v from jsonb_array_elements(coalesce(p_state->'expenses','[]'::jsonb)) v loop
    if e ? 'missingReceiptReason' then
      if jsonb_typeof(e->'missingReceiptReason') is distinct from 'string'
        or e->>'missingReceiptReason' ~ '^[[:space:]]*$' or length(e->>'missingReceiptReason')>2000 then return false; end if;
      if jsonb_array_length(coalesce(e->'attachments','[]'::jsonb))=0 and (
        e->'vatReviewNeeded' is distinct from 'true'::jsonb or (e->>'vatAmount')::numeric<>0
        or coalesce((e->>'vatDeductibleAmount')::numeric,0)<>0 or e ? 'vatRate') then return false; end if;
    end if;
    ids:=array_append(ids,e->>'id');
    for a in select v from jsonb_array_elements(coalesce(e->'attachments','[]'::jsonb)) v loop
      receipt_ids:=array_append(receipt_ids,a->>'id'); paths:=array_append(paths,a->>'path');
    end loop;
  end loop;
  if not(p_state ? 'taxRecords') then return true; end if;
  if jsonb_typeof(p_state->'taxRecords') is distinct from 'array' or jsonb_array_length(p_state->'taxRecords')>10000 then return false; end if;
  for r in select v from jsonb_array_elements(p_state->'taxRecords') v loop
    if jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'id') is distinct from 'string'
      or r->>'id' !~ uuid_pattern or r->>'id'=any(ids)
      or jsonb_typeof(r->'date') is distinct from 'string' or not orquivia_private.valid_date(r->>'date')
      or (r->>'date')::date>today or jsonb_typeof(r->'model') is distinct from 'string'
      or r->>'model' not in ('111','303') then return false; end if;
    ids:=array_append(ids,r->>'id');
    foreach field in array array['year','quarter','amount'] loop
      if jsonb_typeof(r->field) is distinct from 'number' then return false; end if;
      value:=(r->>field)::numeric;
      if field='year' and (value<1000 or value>9999 or value<>trunc(value)) then return false;
      elsif field='quarter' and (value<1 or value>4 or value<>trunc(value)) then return false;
      elsif field='amount' and (abs(value)>90071992547409.91 or value<>round(value,2)) then return false; end if;
    end loop;
    if (r->>'year')::integer>extract(year from (r->>'date')::date)::integer
      or ((r->>'year')::integer=extract(year from (r->>'date')::date)::integer
        and (r->>'quarter')::integer>extract(quarter from (r->>'date')::date)::integer) then return false; end if;
    foreach field in array array['reference','notes'] loop
      if r ? field and (jsonb_typeof(r->field) is distinct from 'string'
        or length(r->>field)>(case field when 'reference' then 240 else 10000 end)) then return false; end if;
    end loop;
    amount:=(r->>'amount')::numeric;
    if jsonb_typeof(r->'paymentStatus') is distinct from 'string'
      or r->>'paymentStatus' not in ('no-payment','unconfirmed','pending','paid','included')
      or (amount=0) is distinct from (r->>'paymentStatus'='no-payment')
      or (r->>'paymentStatus'='pending' and amount<=0) then return false; end if;
    if r->>'paymentStatus'='paid' then
      if jsonb_typeof(r->'paidDate') is distinct from 'string' or not orquivia_private.valid_date(r->>'paidDate')
        or (r->>'paidDate')::date>today then return false; end if;
    elsif coalesce(r->>'paidDate','')<>'' then return false; end if;
    if r->>'paymentStatus'='included' then
      if jsonb_typeof(r->'linkedExpenseId') is distinct from 'string' or amount<=0 then return false; end if;
      select candidate into linked from jsonb_array_elements(coalesce(p_state->'expenses','[]'::jsonb)) candidate
        where candidate->>'id'=r->>'linkedExpenseId';
      if linked is null or coalesce((linked->>'additionalAmount')::numeric,0)<amount then return false; end if;
      -- Two declarations cannot both claim the same already-paid suplido.
      if (select coalesce(sum((t->>'amount')::numeric),0) from jsonb_array_elements(p_state->'taxRecords') t
        where t->>'paymentStatus'='included' and t->>'linkedExpenseId'=r->>'linkedExpenseId')
          >coalesce((linked->>'additionalAmount')::numeric,0) then return false; end if;
    elsif coalesce(r->>'linkedExpenseId','')<>'' then return false; end if;
    if jsonb_typeof(r->'attachments') is distinct from 'array' or jsonb_array_length(r->'attachments')<1
      or jsonb_array_length(r->'attachments')>10 then return false; end if;
    for a in select v from jsonb_array_elements(r->'attachments') v loop
      if jsonb_typeof(a) is distinct from 'object' or jsonb_typeof(a->'id') is distinct from 'string'
        or a->>'id' !~ uuid_pattern or a->>'id'=any(receipt_ids)
        or jsonb_typeof(a->'name') is distinct from 'string' or btrim(a->>'name')='' or length(a->>'name')>240
        or a->>'name' ~ '[[:cntrl:]\\/]'
        or jsonb_typeof(a->'path') is distinct from 'string' or not orquivia_private.receipt_path_valid(a->>'path')
        or split_part(a->>'path','/',2)<>r->>'id' or a->>'path'=any(paths)
        or split_part(split_part(a->>'path','/',3),'.',1)<>a->>'id'
        or jsonb_typeof(a->'mimeType') is distinct from 'string'
        or a->>'mimeType' is distinct from orquivia_private.receipt_mime(split_part(split_part(a->>'path','/',3),'.',2))
        or jsonb_typeof(a->'size') is distinct from 'number' then return false; end if;
      value:=(a->>'size')::numeric;
      if value<1 or value>10485760 or value<>trunc(value) then return false; end if;
      receipt_ids:=array_append(receipt_ids,a->>'id'); paths:=array_append(paths,a->>'path');
    end loop;
  end loop;
  return true;
exception when others then return false;
end; $$;

alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

create or replace function orquivia_private.receipt_unreferenced(p_path text) returns boolean
language plpgsql volatile security definer set search_path='' as $$
declare state jsonb; org uuid:=orquivia_private.receipt_org(p_path);
begin
  if org is null or not orquivia_private.is_member(org) then return false; end if;
  -- Serialize deletion with all CAS saves and retain originals referenced by
  -- either a supplier expense or a filed tax declaration.
  select w.state into state from public.orquivia_team_workspaces w where w.organization_id=org for update;
  return state is not null and not exists(
    select 1 from jsonb_array_elements(coalesce(state->'expenses','[]'::jsonb)||coalesce(state->'taxRecords','[]'::jsonb)) e,
      jsonb_array_elements(coalesce(e->'attachments','[]'::jsonb)) a where a->>'path'=p_path);
end; $$;

create or replace function orquivia_private.check_receipts(p_org uuid,p_state jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare e jsonb; a jsonb;
begin
  for e in select v from jsonb_array_elements(coalesce(p_state->'expenses','[]'::jsonb)||coalesce(p_state->'taxRecords','[]'::jsonb)) v loop
    for a in select v from jsonb_array_elements(coalesce(e->'attachments','[]'::jsonb)) v loop
      if orquivia_private.receipt_org(a->>'path') is distinct from p_org or not exists(
        select 1 from storage.objects o where o.bucket_id='orquivia-receipts' and o.name=a->>'path'
          and (o.metadata->>'size')::numeric=(a->>'size')::numeric
          and o.metadata->>'mimetype'=a->>'mimeType') then
        raise exception 'INVALID_RECEIPT_REFERENCE' using errcode='22023';
      end if;
    end loop;
  end loop;
end; $$;

alter table public.orquivia_record_history drop constraint orquivia_record_history_entity_type_check;
alter table public.orquivia_record_history add constraint orquivia_record_history_entity_type_check
  check(entity_type in ('document','expense','tax','client','payment','company'));

-- The known-field record audit and history reader are extended below while
-- retaining the actor, MFA, organization and expected-user safeguards.

create or replace function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare allowed text[]; fields text[]; has_other boolean;
begin
  -- Only known business field names are exposed. Values, nested original
  -- metadata and personal-account/profile fields never enter this history.
  allowed:=case p_type
    when 'document' then array['kind','status','number','clientId','date','dueDate','title','items','vat','discount','withholding','total','notes','po','paymentMethod','contractExpectedDate','contractReceived','paymentReviewNeeded','quoteId','companySnapshot','clientSnapshot','sourceMetadata','importWarnings']
    when 'expense' then array['kind','date','supplier','supplierTaxId','description','category','reference','notes','base','vatAmount','vatRate','vatDeductibleAmount','additionalAmount','total','paymentStatus','paidDate','cashAmount','cashMovements','attachments','reviewNeeded','vatReviewNeeded','vatDocumentStatus','missingReceiptReason','sourceMetadata','importWarnings']
    when 'tax' then array['date','model','year','quarter','amount','reference','notes','paymentStatus','paidDate','linkedExpenseId','attachments']
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

create or replace function orquivia_private.record_changes(p_old jsonb,p_new jsonb)
returns table(entity_type text,entity_id text,action text,changed_fields text[],related_entity_type text,related_entity_id text)
language plpgsql immutable set search_path='' as $$
declare collection text; r record;
begin
  foreach collection in array array['documents','expenses','taxRecords','clients','payments'] loop
    entity_type:=case collection when 'documents' then 'document' when 'expenses' then 'expense' when 'taxRecords' then 'tax' when 'clients' then 'client' else 'payment' end;
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
      related_entity_type:=case when entity_type='payment' then 'document' when entity_type='tax' and coalesce(r.new_value->>'linkedExpenseId',r.old_value->>'linkedExpenseId') is not null then 'expense' else null end;
      related_entity_id:=case when entity_type='payment' then coalesce(r.new_value->>'documentId',r.old_value->>'documentId') when entity_type='tax' then coalesce(r.new_value->>'linkedExpenseId',r.old_value->>'linkedExpenseId') else null end;
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
    'taxRecordCount',jsonb_array_length(coalesce(p_new->'taxRecords','[]'::jsonb)),
    'taxRecordsChanged',p_old->'taxRecords' is distinct from p_new->'taxRecords',
    'companyChanged',p_old->'company' is distinct from p_new->'company','previousDigest',case when p_old is null then null else md5(p_old::text) end);
  insert into public.orquivia_audit_log(organization_id,actor_id,actor_email,event,workspace_version,changes,state_digest)
    values(p_org,actor,email,p_event,p_version,summary,md5(p_new::text)) returning id into audit_id;
  insert into public.orquivia_record_history(audit_id,organization_id,actor_id,actor_email,event,workspace_version,
      entity_type,entity_id,action,changed_fields,related_entity_type,related_entity_id)
    select audit_id,p_org,actor,email,p_event,p_version,c.entity_type,c.entity_id,c.action,c.changed_fields,c.related_entity_type,c.related_entity_id
      from orquivia_private.record_changes(p_old,p_new) c;
end; $$;

create or replace function public.load_orquivia_record_history(p_organization_id uuid,p_entity_type text,p_entity_id text,
    p_limit integer,p_expected_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  perform orquivia_private.require_member(p_organization_id);
  if p_entity_type is null or p_entity_type not in ('document','expense','tax','client','payment','company')
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

revoke all on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_vat_documents_v3(jsonb),
  orquivia_private.check_receipts(uuid,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_vat_documents_v3(jsonb),
  orquivia_private.check_receipts(uuid,jsonb) to service_role;
revoke all on function orquivia_private.receipt_unreferenced(text) from public,anon,authenticated;
grant execute on function orquivia_private.receipt_unreferenced(text) to authenticated,service_role;

commit;

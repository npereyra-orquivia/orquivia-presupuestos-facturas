-- Numbered quotes can be prepared before they are actually sent to a client.
-- Existing sent quotes, annual counters, originals and audit rows stay intact.
begin;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_tax_records_v4;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare validation_state jsonb;
begin
  -- Validate the actual payload limit before mapping the new quote-only status
  -- through the complete pre-existing document, expense and tax validators.
  if p_state is null or octet_length(p_state::text)>5000000 then return false; end if;
  if jsonb_typeof(p_state->'documents') is distinct from 'array' then
    return orquivia_private.valid_state_tax_records_v4(p_state);
  end if;
  select jsonb_set(p_state,'{documents}',coalesce(jsonb_agg(
    case when d->>'kind'='quote' and d->>'status'='ready'
      then d||jsonb_build_object('status','sent') else d end order by position),'[]'::jsonb))
    into validation_state from jsonb_array_elements(p_state->'documents') with ordinality entries(d,position);
  -- An invoice with status ready remains unchanged and is rejected. A prepared
  -- quote inherits all issued-date, number, amount and snapshot constraints.
  return orquivia_private.valid_state_tax_records_v4(validation_state);
exception when others then return false;
end; $$;

alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

create or replace function orquivia_private.issue_document(p_organization_id uuid,p_document_id text,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_state jsonb; next_state jsonb; old_version bigint; d jsonb; client jsonb; idx integer;
  v_year integer; seq bigint; num text; timestamp timestamptz:=now();
begin
  perform orquivia_private.require_member(p_organization_id);
  select state,version into old_state,old_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if old_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='40001'; end if;
  select value,ordinality::integer-1 into d,idx from jsonb_array_elements(old_state->'documents') with ordinality where value->>'id'=p_document_id;
  if d is null or d->>'status'<>'draft' then raise exception 'DOCUMENT_NOT_DRAFT' using errcode='22023'; end if;
  if (d->>'date')::date>(timestamp at time zone 'Europe/Madrid')::date then raise exception 'INVALID_ISSUE_DATE' using errcode='22023'; end if;
  v_year:=extract(year from (d->>'date')::date);
  insert into public.orquivia_number_counters(organization_id,kind,year,last_sequence) values(p_organization_id,d->>'kind',v_year,1)
    on conflict(organization_id,kind,year) do update set last_sequence=public.orquivia_number_counters.last_sequence+1 returning last_sequence into seq;
  num:=case when d->>'kind'='invoice' then 'F-' else 'PR-' end||v_year||'-'||lpad(seq::text,greatest(3,length(seq::text)),'0');
  select c into client from jsonb_array_elements(old_state->'clients') c where c->>'id'=d->>'clientId';
  d:=d||jsonb_build_object('number',num,'status',case when d->>'kind'='invoice' then 'issued' else 'ready' end,
    'companySnapshot',old_state->'company','clientSnapshot',client,'paymentReviewNeeded',false);
  next_state:=jsonb_set(old_state,array['documents',idx::text],d);
  if not orquivia_private.valid_state(next_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  insert into public.orquivia_document_numbers(organization_id,document_id,kind,year,sequence,number,issue_date,fiscal_data,source)
    values(p_organization_id,p_document_id,d->>'kind',v_year,seq,num,(d->>'date')::date,orquivia_private.fiscal_data(d),'issued');
  update public.orquivia_team_workspaces set state=next_state,version=version+1,updated_at=timestamp where organization_id=p_organization_id;
  perform orquivia_private.audit(p_organization_id,'issue',old_version+1,old_state,next_state);
  return jsonb_build_object('state',next_state,'version',old_version+1,'updated_at',timestamp,'document_number',num);
end; $$;

revoke all on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_tax_records_v4(jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_tax_records_v4(jsonb) to service_role;
revoke all on function orquivia_private.issue_document(uuid,text,bigint) from public,anon;
grant execute on function orquivia_private.issue_document(uuid,text,bigint) to authenticated;

commit;

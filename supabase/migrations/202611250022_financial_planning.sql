-- Shared simulations, kept apart from issued documents, expenses and payments.
-- Existing versions and ledgers are preserved; no operational records are created.
begin;

create function orquivia_private.planning_shape(p jsonb,keys text[]) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='object' and p ?& keys
    and not exists(select 1 from jsonb_object_keys(p) k where not(k=any(keys))),false);
$$;
create function orquivia_private.planning_number(p jsonb,minimum numeric default 0,maximum numeric default 1000000000,places integer default 2) returns boolean
language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
  if jsonb_typeof(p) is distinct from 'number' then return false; end if;
  n:=(p#>>'{}')::numeric;
  return n between minimum and maximum and n=round(n,places);
exception when others then return false;
end; $$;
create function orquivia_private.planning_text(p jsonb,maximum integer,required boolean default false) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and length(p#>>'{}')<=maximum
    and (not required or length(btrim(p#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0)
    and translate(p#>>'{}',E'\n\t\r','') !~ '[[:cntrl:]]',false);
$$;
create function orquivia_private.planning_id(p jsonb,maximum integer default 140) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and length(p#>>'{}') between 1 and maximum
    and btrim(p#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=p#>>'{}' and p#>>'{}' !~ '[[:cntrl:]]',false);
$$;
create function orquivia_private.planning_date(p jsonb) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and orquivia_private.valid_date(p#>>'{}')
    and substring(p#>>'{}',1,4)::integer between 1900 and 2200,false);
$$;

create function orquivia_private.valid_planning(p jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare s jsonb; person jsonb; item jsonb; scenario jsonb; allocation jsonb; entry record;
  field text; seen text[]; people text[]:=array[]::text[]; shares numeric:=0;
begin
  if not orquivia_private.planning_shape(p,array['version','settings','items','scenarios']) or p->'version'<>'1'::jsonb then return false; end if;
  s:=p->'settings';
  if not orquivia_private.planning_shape(s,array['asOf','horizon','taxYear','corporateTaxRate','corporateTaxConfirmed','legalReservePending','minimumCash','cashBalanceOverride','profitOverride','pendingCosts','people','collectionDates']) then return false; end if;
  if not orquivia_private.planning_date(s->'asOf') or not orquivia_private.planning_date(s->'horizon')
    or (s->>'horizon')::date<(s->>'asOf')::date or (s->>'horizon')::date-(s->>'asOf')::date>3653
    or not orquivia_private.planning_number(s->'taxYear',1900,2200,0)
    or not orquivia_private.planning_number(s->'corporateTaxRate',0,35)
    or jsonb_typeof(s->'corporateTaxConfirmed') is distinct from 'boolean'
    or not orquivia_private.planning_number(s->'legalReservePending')
    or not orquivia_private.planning_number(s->'minimumCash')
    or (s->'cashBalanceOverride'<>'null'::jsonb and not orquivia_private.planning_number(s->'cashBalanceOverride',-1000000000))
    or (s->'profitOverride'<>'null'::jsonb and not orquivia_private.planning_number(s->'profitOverride',-1000000000))
    or jsonb_typeof(s->'pendingCosts') is distinct from 'string'
    or s->>'pendingCosts' not in ('gross','exclude') then return false; end if;
  if jsonb_typeof(s->'people') is distinct from 'array' or jsonb_array_length(s->'people') not between 1 and 8 then return false; end if;
  for person in select value from jsonb_array_elements(s->'people') loop
    if not orquivia_private.planning_shape(person,array['id','name','taxProfileKnown','externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings','sharePercent','isShareholder','employerContributionRate','retaPeriod','retaYear'])
      or not orquivia_private.planning_id(person->'id') or person->>'id'=any(people)
      or not orquivia_private.planning_text(person->'name',120,true)
      or jsonb_typeof(person->'taxProfileKnown') is distinct from 'boolean'
      or jsonb_typeof(person->'isShareholder') is distinct from 'boolean'
      or not orquivia_private.planning_number(person->'sharePercent',0,100)
      or not orquivia_private.planning_number(person->'employerContributionRate',0,100)
      or jsonb_typeof(person->'retaPeriod') is distinct from 'string' or person->>'retaPeriod' not in ('initial','extension','ordinary')
      or not orquivia_private.planning_number(person->'retaYear',1900,2200,0) then return false; end if;
    foreach field in array array['externalSalary','employeeSS','retaAnnual','otherGeneralIncome','employmentExpense','otherSavings'] loop
      if not orquivia_private.planning_number(person->field) then return false; end if;
    end loop;
    people:=array_append(people,person->>'id');shares:=shares+(person->>'sharePercent')::numeric;
  end loop;
  if shares>100 then return false; end if;
  if jsonb_typeof(s->'collectionDates') is distinct from 'object' or (select count(*) from jsonb_object_keys(s->'collectionDates'))>500 then return false; end if;
  for entry in select key,value from jsonb_each(s->'collectionDates') loop
    if not orquivia_private.planning_id(to_jsonb(entry.key),160) or entry.key in ('__proto__','constructor','prototype') or not orquivia_private.planning_date(entry.value) then return false; end if;
  end loop;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items')>300 then return false; end if;
  seen:=array[]::text[];
  for item in select value from jsonb_array_elements(p->'items') loop
    if not orquivia_private.planning_shape(item,array['id','label','kind','amountGross','vatRate','vatDeductible','treatment','recurrence','startDate','endDate','active','linkedRecordIds'])
      or not orquivia_private.planning_id(item->'id') or item->>'id'=any(seen)
      or not orquivia_private.planning_text(item->'label',200,true)
      or jsonb_typeof(item->'kind') is distinct from 'string' or item->>'kind' not in ('expense','income') or not orquivia_private.planning_number(item->'amountGross')
      or (item->'vatRate'<>'null'::jsonb and not orquivia_private.planning_number(item->'vatRate',0,100))
      or jsonb_typeof(item->'vatDeductible') is distinct from 'boolean'
      or jsonb_typeof(item->'treatment') is distinct from 'string' or item->>'treatment' not in ('operating','asset','tax','transfer')
      or jsonb_typeof(item->'recurrence') is distinct from 'string' or item->>'recurrence' not in ('once','monthly','quarterly','yearly')
      or not orquivia_private.planning_date(item->'startDate')
      or (item->'endDate'<>'null'::jsonb and (not orquivia_private.planning_date(item->'endDate') or item->>'endDate'<item->>'startDate'))
      or jsonb_typeof(item->'active') is distinct from 'boolean'
      or jsonb_typeof(item->'linkedRecordIds') is distinct from 'array' or jsonb_array_length(item->'linkedRecordIds')>500 then return false; end if;
    if exists(select 1 from jsonb_array_elements(item->'linkedRecordIds') v where not orquivia_private.planning_id(v,160))
      or (select count(*)<>count(distinct value) from jsonb_array_elements(item->'linkedRecordIds')) then return false; end if;
    seen:=array_append(seen,item->>'id');
  end loop;
  if jsonb_typeof(p->'scenarios') is distinct from 'array' or jsonb_array_length(p->'scenarios')>50 then return false; end if;
  seen:=array[]::text[];
  for scenario in select value from jsonb_array_elements(p->'scenarios') loop
    if not orquivia_private.planning_shape(scenario,array['id','name','people','dividendDate','notes'])
      or not orquivia_private.planning_id(scenario->'id') or scenario->>'id'=any(seen)
      or not orquivia_private.planning_text(scenario->'name',120,true)
      or not orquivia_private.planning_text(scenario->'notes',2000)
      or (scenario->'dividendDate'<>'null'::jsonb and not orquivia_private.planning_date(scenario->'dividendDate'))
      or jsonb_typeof(scenario->'people') is distinct from 'array' or jsonb_array_length(scenario->'people')>8 then return false; end if;
    if (select count(*)<>count(distinct v->>'personId') from jsonb_array_elements(scenario->'people') v) then return false; end if;
    for allocation in select value from jsonb_array_elements(scenario->'people') loop
      if not orquivia_private.planning_shape(allocation,array['personId','workGross','dividendGross'])
        or jsonb_typeof(allocation->'personId') is distinct from 'string' or not(allocation->>'personId'=any(people))
        or not orquivia_private.planning_number(allocation->'workGross') or not orquivia_private.planning_number(allocation->'dividendGross') then return false; end if;
    end loop;
    seen:=array_append(seen,scenario->>'id');
  end loop;
  return octet_length(p::text)<=750000;
exception when others then return false;
end; $$;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_before_financial_planning;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
begin
  return orquivia_private.valid_state_before_financial_planning(p_state)
    and (not(p_state ? 'planning') or orquivia_private.valid_planning(p_state->'planning'));
exception when others then return false;
end; $$;
alter table public.orquivia_team_workspaces add constraint orquivia_workspace_planning_valid
  check(not(state ? 'planning') or orquivia_private.valid_planning(state->'planning'));

-- Older compatible clients omit unknown top-level data. Their normal saves must
-- not erase a forecast. An explicit present plan can still delete its own rows.
alter function orquivia_private.save_team(uuid,jsonb,bigint) rename to save_team_before_financial_planning;
create function orquivia_private.save_team(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous jsonb; previous_version bigint; next_state jsonb:=p_state; result jsonb; member_role text;
begin
  member_role:=orquivia_private.require_member(p_organization_id);
  -- Explicit even though the current membership table only admits these two
  -- roles: adding a future read-only role must never silently grant writes.
  if member_role not in ('admin','editor') then raise exception 'WRITE_ACCESS_REQUIRED' using errcode='42501'; end if;
  select state,version into previous,previous_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if previous_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='PT409'; end if;
  if not(p_state ? 'planning') and previous ? 'planning' then next_state:=jsonb_set(p_state,'{planning}',previous->'planning'); end if;
  if not orquivia_private.valid_state(next_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  result:=orquivia_private.save_team_before_financial_planning(p_organization_id,next_state,p_expected_version);
  select state into next_state from public.orquivia_team_workspaces where organization_id=p_organization_id;
  return result||jsonb_build_object('state',next_state);
end; $$;

alter table public.orquivia_record_history drop constraint orquivia_record_history_entity_type_check;
alter table public.orquivia_record_history add constraint orquivia_record_history_entity_type_check
  check(entity_type in ('document','expense','tax','client','payment','company','planning'));
alter function orquivia_private.record_change_fields(text,jsonb,jsonb) rename to record_change_fields_before_financial_planning;
create function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare fields text[]; allowed text[]:=array['asOf','horizon','taxYear','corporateTaxRate','corporateTaxConfirmed','legalReservePending','minimumCash','cashBalanceOverride','profitOverride','pendingCosts','people','collectionDates','label','kind','amountGross','vatRate','vatDeductible','treatment','recurrence','startDate','endDate','active','linkedRecordIds','name','dividendDate','notes'];
begin
  if p_type<>'planning' then return orquivia_private.record_change_fields_before_financial_planning(p_type,p_old,p_new); end if;
  select coalesce(array_agg(k order by k),array[]::text[]) into fields
    from jsonb_object_keys(coalesce(p_old,'{}'::jsonb)||coalesce(p_new,'{}'::jsonb)) k
    where k=any(allowed) and p_old->k is distinct from p_new->k;
  return fields;
end; $$;
alter function orquivia_private.record_changes(jsonb,jsonb) rename to record_changes_before_financial_planning;
create function orquivia_private.record_changes(p_old jsonb,p_new jsonb)
returns table(entity_type text,entity_id text,action text,changed_fields text[],related_entity_type text,related_entity_id text)
language plpgsql immutable set search_path='' as $$
declare collection text; r record;
begin
  return query select * from orquivia_private.record_changes_before_financial_planning(p_old,p_new);
  entity_type:='planning';related_entity_type:='planning';related_entity_id:='planning';
  if p_old->'planning'->'settings' is distinct from p_new->'planning'->'settings' then
    entity_id:='settings';action:=case when p_old->'planning'->'settings' is null then 'created' when p_new->'planning'->'settings' is null then 'deleted' else 'updated' end;
    changed_fields:=orquivia_private.record_change_fields('planning',p_old->'planning'->'settings',p_new->'planning'->'settings');
    return next;
  end if;
  foreach collection in array array['items','scenarios'] loop
    for r in select a.v old_value,b.v new_value,coalesce(a.v->>'id',b.v->>'id') record_id
      from jsonb_array_elements(coalesce(p_old->'planning'->collection,'[]'::jsonb)) a(v)
      full join jsonb_array_elements(coalesce(p_new->'planning'->collection,'[]'::jsonb)) b(v) on a.v->>'id'=b.v->>'id'
      where a.v is distinct from b.v loop
      entity_id:=case collection when 'items' then 'forecast:' else 'scenario:' end||r.record_id;
      action:=case when r.old_value is null then 'created' when r.new_value is null then 'deleted' else 'updated' end;
      changed_fields:=orquivia_private.record_change_fields('planning',r.old_value,r.new_value);
      return next;
    end loop;
  end loop;
end; $$;

create or replace function orquivia_private.audit(p_org uuid,p_event text,p_version bigint,p_old jsonb,p_new jsonb,p_actor uuid default null) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid:=coalesce(p_actor,auth.uid()); email text; summary jsonb; audit_id bigint;
begin
  select u.email into email from auth.users u where u.id=actor;
  summary:=jsonb_build_object('documentCount',jsonb_array_length(p_new->'documents'),'paymentCount',jsonb_array_length(p_new->'payments'),
    'expenseCount',jsonb_array_length(coalesce(p_new->'expenses','[]'::jsonb)),'expensesChanged',p_old->'expenses' is distinct from p_new->'expenses',
    'taxRecordCount',jsonb_array_length(coalesce(p_new->'taxRecords','[]'::jsonb)),'taxRecordsChanged',p_old->'taxRecords' is distinct from p_new->'taxRecords',
    'companyChanged',p_old->'company' is distinct from p_new->'company','planningChanged',p_old->'planning' is distinct from p_new->'planning',
    'previousDigest',case when p_old is null then null else md5(p_old::text) end);
  insert into public.orquivia_audit_log(organization_id,actor_id,actor_email,event,workspace_version,changes,state_digest)
    values(p_org,actor,email,p_event,p_version,summary,md5(p_new::text)) returning id into audit_id;
  insert into public.orquivia_record_history(audit_id,organization_id,actor_id,actor_email,event,workspace_version,
    entity_type,entity_id,action,changed_fields,related_entity_type,related_entity_id)
    select audit_id,p_org,actor,email,p_event,p_version,c.entity_type,c.entity_id,c.action,c.changed_fields,c.related_entity_type,c.related_entity_id
    from orquivia_private.record_changes(p_old,p_new) c;
end; $$;

create or replace function public.load_orquivia_record_history(p_organization_id uuid,p_entity_type text,p_entity_id text,p_limit integer,p_expected_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  perform orquivia_private.require_expected_personal_user(p_expected_user_id);
  perform orquivia_private.require_member(p_organization_id);
  if p_entity_type is null or p_entity_type not in ('document','expense','tax','client','payment','company','planning')
    or p_entity_id is null or length(btrim(p_entity_id))=0 or length(p_entity_id)>160 or p_entity_id ~ '[[:cntrl:]]'
    or (p_entity_type='company' and p_entity_id<>'company') then raise exception 'INVALID_HISTORY_RECORD' using errcode='22023'; end if;
  select coalesce(jsonb_agg(v order by history_id desc),'[]'::jsonb) into result from (
    select h.id history_id,jsonb_build_object('id',h.id,'actorId',h.actor_id,'actorEmail',h.actor_email,'event',h.event,'action',h.action,
      'entityType',h.entity_type,'entityId',h.entity_id,'workspaceVersion',h.workspace_version,'changedFields',to_jsonb(h.changed_fields),'createdAt',h.created_at) v
    from public.orquivia_record_history h where h.organization_id=p_organization_id
      and ((h.entity_type=p_entity_type and h.entity_id=p_entity_id) or (h.related_entity_type=p_entity_type and h.related_entity_id=p_entity_id))
    order by h.id desc limit greatest(1,least(coalesce(p_limit,50),100))
  ) entries;
  return result;
end; $$;

revoke all on function orquivia_private.planning_shape(jsonb,text[]),orquivia_private.planning_number(jsonb,numeric,numeric,integer),
  orquivia_private.planning_text(jsonb,integer,boolean),orquivia_private.planning_id(jsonb,integer),orquivia_private.planning_date(jsonb),
  orquivia_private.valid_planning(jsonb),orquivia_private.valid_state_before_financial_planning(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.save_team_before_financial_planning(uuid,jsonb,bigint),orquivia_private.save_team(uuid,jsonb,bigint),
  orquivia_private.record_change_fields_before_financial_planning(text,jsonb,jsonb),orquivia_private.record_change_fields(text,jsonb,jsonb),
  orquivia_private.record_changes_before_financial_planning(jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.planning_shape(jsonb,text[]),orquivia_private.planning_number(jsonb,numeric,numeric,integer),
  orquivia_private.planning_text(jsonb,integer,boolean),orquivia_private.planning_id(jsonb,integer),orquivia_private.planning_date(jsonb),
  orquivia_private.valid_planning(jsonb),orquivia_private.valid_state_before_financial_planning(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.save_team_before_financial_planning(uuid,jsonb,bigint),orquivia_private.save_team(uuid,jsonb,bigint),
  orquivia_private.record_change_fields_before_financial_planning(text,jsonb,jsonb),orquivia_private.record_change_fields(text,jsonb,jsonb),
  orquivia_private.record_changes_before_financial_planning(jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb) to service_role;
grant execute on function orquivia_private.save_team(uuid,jsonb,bigint) to authenticated;
commit;

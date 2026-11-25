-- Optional sidecar for distribution operations. planning v1 stays unchanged so
-- old clients can still load operational data and preserve unsupported details.
begin;

-- Match the JavaScript Unicode-control boundary independently of DB locale.
create or replace function orquivia_private.planning_text(p jsonb,maximum integer,required boolean default false) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and length(p#>>'{}')<=maximum
    and (not required or length(btrim(p#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0)
    and translate(p#>>'{}',E'\n\t\r','') !~ '[[:cntrl:]]' and p#>>'{}' !~ U&'[\0080-\009F]',false);
$$;
create or replace function orquivia_private.planning_id(p jsonb,maximum integer default 140) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(jsonb_typeof(p)='string' and length(p#>>'{}') between 1 and maximum
    and btrim(p#>>'{}',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')=p#>>'{}'
    and p#>>'{}' !~ '[[:cntrl:]]' and p#>>'{}' !~ U&'[\0080-\009F]',false);
$$;

create function orquivia_private.distribution_json_bytes(p jsonb) returns bigint
language plpgsql immutable set search_path='' as $$
declare result bigint; r record; n integer;
begin
  if jsonb_typeof(p)='object' then
    result:=2;n:=0;
    for r in select key,value from jsonb_each(p) loop
      result:=result+octet_length(to_jsonb(r.key)::text)+1+orquivia_private.distribution_json_bytes(r.value);n:=n+1;
    end loop;
    return result+greatest(n-1,0);
  elsif jsonb_typeof(p)='array' then
    result:=2;n:=0;
    for r in select value from jsonb_array_elements(p) loop result:=result+orquivia_private.distribution_json_bytes(r.value);n:=n+1; end loop;
    return result+greatest(n-1,0);
  end if;
  return octet_length(p::text);
end; $$;

create function orquivia_private.distribution_totals_match(p_entry jsonb,p_scenario jsonb) returns boolean
language sql immutable set search_path='' as $$
  select not exists(
    select 1 from (
      select op->>'personId' person_id from jsonb_array_elements(p_entry->'operations') op where op->>'kind'<>'expense'
      union select row->>'personId' from jsonb_array_elements(p_scenario->'people') row
    ) ids where
      coalesce((select sum((op->>'amount')::numeric) from jsonb_array_elements(p_entry->'operations') op
        where op->>'personId'=ids.person_id and op->>'kind' in ('salary','administrator','professional','legacy-work')),0)
      <>coalesce((select (row->>'workGross')::numeric from jsonb_array_elements(p_scenario->'people') row where row->>'personId'=ids.person_id),0)
      or coalesce((select sum((op->>'amount')::numeric) from jsonb_array_elements(p_entry->'operations') op
        where op->>'personId'=ids.person_id and op->>'kind'='dividend'),0)
      <>coalesce((select (row->>'dividendGross')::numeric from jsonb_array_elements(p_scenario->'people') row where row->>'personId'=ids.person_id),0));
$$;

create function orquivia_private.valid_planning_extensions(p jsonb,p_planning jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
declare profile jsonb; entry jsonb; operation jsonb; scenario jsonb; seen text[]; operation_ids text[]; field text;
begin
  if not orquivia_private.valid_planning(p_planning)
    or not orquivia_private.planning_shape(p,array['version','people','scenarios']) or p->'version'<>'1'::jsonb
    or jsonb_typeof(p->'people') is distinct from 'array' or jsonb_array_length(p->'people')>8
    or jsonb_typeof(p->'scenarios') is distinct from 'array' or jsonb_array_length(p->'scenarios')>50 then return false; end if;
  seen:=array[]::text[];
  for profile in select value from jsonb_array_elements(p->'people') loop
    if not orquivia_private.planning_shape(profile,array['personId','taxRegion'])
      or not orquivia_private.planning_id(profile->'personId') or profile->>'personId'=any(seen)
      or jsonb_typeof(profile->'taxRegion') is distinct from 'string' or profile->>'taxRegion' not in ('catalonia','other')
      or not exists(select 1 from jsonb_array_elements(p_planning->'settings'->'people') person where person->>'id'=profile->>'personId') then return false; end if;
    seen:=array_append(seen,profile->>'personId');
  end loop;
  seen:=array[]::text[];
  for entry in select value from jsonb_array_elements(p->'scenarios') loop
    if not orquivia_private.planning_shape(entry,array['scenarioId','operations'])
      or not orquivia_private.planning_id(entry->'scenarioId') or entry->>'scenarioId'=any(seen)
      or jsonb_typeof(entry->'operations') is distinct from 'array' or jsonb_array_length(entry->'operations')>50 then return false; end if;
    select value into scenario from jsonb_array_elements(p_planning->'scenarios') where value->>'id'=entry->>'scenarioId';
    if scenario is null then return false; end if;
    operation_ids:=array[]::text[];
    for operation in select value from jsonb_array_elements(entry->'operations') loop
      if not orquivia_private.planning_shape(operation,array['id','label','kind','personId','amount','deductible','employeeSSRate','employerSSRate','withholdingRate','vatRate','taxTreatmentConfirmed'])
        or not orquivia_private.planning_id(operation->'id') or operation->>'id'=any(operation_ids)
        or not orquivia_private.planning_text(operation->'label',200,true)
        or jsonb_typeof(operation->'kind') is distinct from 'string' or operation->>'kind' not in ('salary','administrator','professional','dividend','expense','legacy-work')
        or not orquivia_private.planning_number(operation->'amount')
        or jsonb_typeof(operation->'deductible') is distinct from 'boolean'
        or jsonb_typeof(operation->'taxTreatmentConfirmed') is distinct from 'boolean'
        or not orquivia_private.planning_number(operation->'employeeSSRate',0,100)
        or not orquivia_private.planning_number(operation->'employerSSRate',0,100)
        or (operation->'withholdingRate'<>'null'::jsonb and not orquivia_private.planning_number(operation->'withholdingRate',0,100))
        or (operation->'vatRate'<>'null'::jsonb and not orquivia_private.planning_number(operation->'vatRate',0,100)) then return false; end if;
      if operation->>'kind'='expense' then
        if operation->'personId'<>'null'::jsonb then return false; end if;
      elsif not orquivia_private.planning_id(operation->'personId') or not exists(
        select 1 from jsonb_array_elements(p_planning->'settings'->'people') person where person->>'id'=operation->>'personId') then return false; end if;
      operation_ids:=array_append(operation_ids,operation->>'id');
    end loop;
    if not orquivia_private.distribution_totals_match(entry,scenario) then return false; end if;
    seen:=array_append(seen,entry->>'scenarioId');
  end loop;
  return orquivia_private.distribution_json_bytes(p)<=1000000;
exception when others then return false;
end; $$;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_before_distribution_operations;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
begin
  return orquivia_private.valid_state_before_distribution_operations(p_state)
    and (not(p_state ? 'planningExtensions') or orquivia_private.valid_planning_extensions(p_state->'planningExtensions',p_state->'planning'));
exception when others then return false;
end; $$;
alter table public.orquivia_team_workspaces add constraint orquivia_workspace_distribution_valid
  check(not(state ? 'planningExtensions') or orquivia_private.valid_planning_extensions(state->'planningExtensions',state->'planning'));

alter function orquivia_private.save_team(uuid,jsonb,bigint) rename to save_team_before_distribution_operations;
create function orquivia_private.save_team(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous jsonb; previous_version bigint; next_state jsonb:=p_state; result jsonb; member_role text;
  old_entry jsonb; new_entry jsonb; old_scenario jsonb; new_scenario jsonb; extension jsonb; omitted boolean; unchanged boolean;
begin
  member_role:=orquivia_private.require_member(p_organization_id);
  if member_role not in ('admin','editor') then raise exception 'WRITE_ACCESS_REQUIRED' using errcode='42501'; end if;
  select state,version into previous,previous_version from public.orquivia_team_workspaces where organization_id=p_organization_id for update;
  if previous_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='PT409'; end if;
  if not(next_state ? 'planning') and previous ? 'planning' then next_state:=jsonb_set(next_state,'{planning}',previous->'planning'); end if;
  if not orquivia_private.valid_state_before_distribution_operations(next_state-'planningExtensions') then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  omitted:=not(p_state ? 'planningExtensions');
  if previous ? 'planningExtensions' then
    if omitted then next_state:=jsonb_set(next_state,'{planningExtensions}',previous->'planningExtensions'); end if;
    for old_entry in select value from jsonb_array_elements(previous->'planningExtensions'->'scenarios') loop
      select value into old_scenario from jsonb_array_elements(previous->'planning'->'scenarios') where value->>'id'=old_entry->>'scenarioId';
      select value into new_scenario from jsonb_array_elements(next_state->'planning'->'scenarios') where value->>'id'=old_entry->>'scenarioId';
      -- An explicit deletion of a simulated scenario may remove its sidecar.
      if new_scenario is null then continue; end if;
      select value into new_entry from jsonb_array_elements(case when jsonb_typeof(next_state->'planningExtensions'->'scenarios')='array' then next_state->'planningExtensions'->'scenarios' else '[]'::jsonb end) where value->>'scenarioId'=old_entry->>'scenarioId';
      if (omitted or new_entry->'operations' is not distinct from old_entry->'operations')
        and (not orquivia_private.distribution_totals_match(old_entry,new_scenario)
          or (omitted and new_scenario->'dividendDate' is distinct from old_scenario->'dividendDate')) then
        raise exception 'PLANNING_CLIENT_UPDATE_REQUIRED' using errcode='22023';
      end if;
      if omitted and exists(select 1 from jsonb_array_elements(old_entry->'operations') op where op->>'kind'<>'expense'
        and not exists(select 1 from jsonb_array_elements(next_state->'planning'->'settings'->'people') person where person->>'id'=op->>'personId')) then
        raise exception 'PLANNING_CLIENT_UPDATE_REQUIRED' using errcode='22023';
      end if;
    end loop;
    unchanged:=next_state->'planningExtensions' is not distinct from previous->'planningExtensions';
    if omitted or unchanged then
      extension:=next_state->'planningExtensions';
      extension:=jsonb_set(extension,'{people}',coalesce((select jsonb_agg(profile) from jsonb_array_elements(extension->'people') profile
        where exists(select 1 from jsonb_array_elements(next_state->'planning'->'settings'->'people') person where person->>'id'=profile->>'personId')),'[]'::jsonb));
      extension:=jsonb_set(extension,'{scenarios}',coalesce((select jsonb_agg(entry) from jsonb_array_elements(extension->'scenarios') entry
        where exists(select 1 from jsonb_array_elements(next_state->'planning'->'scenarios') scenario where scenario->>'id'=entry->>'scenarioId')),'[]'::jsonb));
      next_state:=jsonb_set(next_state,'{planningExtensions}',extension);
    end if;
  end if;
  if not orquivia_private.valid_state(next_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  result:=orquivia_private.save_team_before_distribution_operations(p_organization_id,next_state,p_expected_version);
  select state into next_state from public.orquivia_team_workspaces where organization_id=p_organization_id;
  return result||jsonb_build_object('state',next_state);
end; $$;

alter function orquivia_private.record_change_fields(text,jsonb,jsonb) rename to record_change_fields_before_distribution_operations;
create function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare fields text[]; extra text[];
begin
  fields:=orquivia_private.record_change_fields_before_distribution_operations(p_type,p_old,p_new);
  if p_type='planning' then
    select coalesce(array_agg(k order by k),array[]::text[]) into extra from jsonb_object_keys(coalesce(p_old,'{}'::jsonb)||coalesce(p_new,'{}'::jsonb)) k
      where k in ('operations','taxRegion') and p_old->k is distinct from p_new->k;
    fields:=fields||extra;
  end if;
  return fields;
end; $$;
alter function orquivia_private.record_changes(jsonb,jsonb) rename to record_changes_before_distribution_operations;
create function orquivia_private.record_changes(p_old jsonb,p_new jsonb)
returns table(entity_type text,entity_id text,action text,changed_fields text[],related_entity_type text,related_entity_id text)
language plpgsql immutable set search_path='' as $$
declare collection text; identity text; prefix text; r record;
begin
  return query select * from orquivia_private.record_changes_before_distribution_operations(p_old,p_new);
  entity_type:='planning';related_entity_type:='planning';related_entity_id:='planning';
  foreach collection in array array['scenarios','people'] loop
    identity:=case collection when 'scenarios' then 'scenarioId' else 'personId' end;
    prefix:=case collection when 'scenarios' then 'distribution:' else 'tax-profile:' end;
    for r in select a.v old_value,b.v new_value,coalesce(a.v->>identity,b.v->>identity) record_id
      from jsonb_array_elements(coalesce(p_old->'planningExtensions'->collection,'[]'::jsonb)) a(v)
      full join jsonb_array_elements(coalesce(p_new->'planningExtensions'->collection,'[]'::jsonb)) b(v) on a.v->>identity=b.v->>identity
      where a.v is distinct from b.v loop
      entity_id:=prefix||r.record_id;
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
    'planningExtensionsChanged',p_old->'planningExtensions' is distinct from p_new->'planningExtensions',
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
      and ((h.entity_type=p_entity_type and h.entity_id=p_entity_id) or (h.related_entity_type=p_entity_type and h.related_entity_id=p_entity_id)
        or (p_entity_type='planning' and h.entity_type='planning' and left(p_entity_id,9)='scenario:' and h.entity_id='distribution:'||substring(p_entity_id from 10))
        or (p_entity_type='planning' and p_entity_id='settings' and h.entity_type='planning' and left(h.entity_id,12)='tax-profile:'))
    order by h.id desc limit greatest(1,least(coalesce(p_limit,50),100))
  ) entries;
  return result;
end; $$;

revoke all on function orquivia_private.distribution_json_bytes(jsonb),orquivia_private.distribution_totals_match(jsonb,jsonb),
  orquivia_private.valid_planning_extensions(jsonb,jsonb),orquivia_private.valid_state_before_distribution_operations(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.save_team_before_distribution_operations(uuid,jsonb,bigint),orquivia_private.save_team(uuid,jsonb,bigint),
  orquivia_private.record_change_fields_before_distribution_operations(text,jsonb,jsonb),orquivia_private.record_change_fields(text,jsonb,jsonb),
  orquivia_private.record_changes_before_distribution_operations(jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.distribution_json_bytes(jsonb),orquivia_private.distribution_totals_match(jsonb,jsonb),
  orquivia_private.valid_planning_extensions(jsonb,jsonb),orquivia_private.valid_state_before_distribution_operations(jsonb),orquivia_private.valid_state(jsonb),
  orquivia_private.save_team_before_distribution_operations(uuid,jsonb,bigint),orquivia_private.save_team(uuid,jsonb,bigint),
  orquivia_private.record_change_fields_before_distribution_operations(text,jsonb,jsonb),orquivia_private.record_change_fields(text,jsonb,jsonb),
  orquivia_private.record_changes_before_distribution_operations(jsonb,jsonb),orquivia_private.record_changes(jsonb,jsonb) to service_role;
grant execute on function orquivia_private.save_team(uuid,jsonb,bigint) to authenticated;
commit;

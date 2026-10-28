begin;

-- Operational evidence is separate from company JSON, numbering and audit.
-- No browser or service token gets direct access to this private table.
create table if not exists orquivia_private.backup_health (
  organization_id uuid primary key references public.orquivia_organizations(id) on delete cascade,
  last_attempt_id uuid,
  last_attempt_status text check (last_attempt_status in ('started','succeeded','failed')),
  last_attempt_started_at timestamptz,
  last_attempt_finished_at timestamptz,
  last_error_code text,
  last_success_at timestamptz,
  last_success_commit text check (last_success_commit ~ '^[a-f0-9]{40}$'),
  last_success_encrypted_bytes bigint check (last_success_encrypted_bytes > 0 and last_success_encrypted_bytes <= 40000000000),
  last_success_storage_objects integer check (last_success_storage_objects >= 0 and last_success_storage_objects <= 100000),
  last_success_storage_bytes bigint check (last_success_storage_bytes >= 0 and last_success_storage_bytes <= 20000000000),
  last_success_archive_sha256 text check (last_success_archive_sha256 ~ '^[a-f0-9]{64}$'),
  restore_verified_at timestamptz,
  restore_source_commit text check (restore_source_commit ~ '^[a-f0-9]{40}$'),
  restore_report_sha256 text check (restore_report_sha256 ~ '^[a-f0-9]{64}$'),
  restore_scope text check (restore_scope in ('business-data-and-originals','full-system')),
  updated_at timestamptz not null default now()
);
alter table orquivia_private.backup_health enable row level security;
revoke all on table orquivia_private.backup_health from public,anon,authenticated,service_role;

create or replace function orquivia_private.operations_iso(p_value timestamptz) returns text
language sql stable set search_path='' as $$
  select pg_catalog.to_char(p_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;
revoke all on function orquivia_private.operations_iso(timestamptz) from public,anon,authenticated,service_role;

create or replace function public.load_orquivia_backup_health(p_organization_id uuid,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare member_role text; h orquivia_private.backup_health%rowtype;
begin
  if p_expected_user_id is null or auth.uid() is null or auth.uid()<>p_expected_user_id then
    raise exception 'AUTH_CHANGED' using errcode='42501';
  end if;
  member_role:=orquivia_private.require_member(p_organization_id);
  if coalesce(auth.jwt()->>'aal','aal1')<>'aal2' then raise exception 'MFA_REQUIRED' using errcode='42501'; end if;
  if member_role<>'admin' then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select * into h from orquivia_private.backup_health where organization_id=p_organization_id;
  return pg_catalog.jsonb_build_object(
    'serverTime',orquivia_private.operations_iso(now()),
    'lastAttempt',case when h.last_attempt_id is null then null else pg_catalog.jsonb_build_object(
      'status',h.last_attempt_status,'startedAt',orquivia_private.operations_iso(h.last_attempt_started_at),
      'finishedAt',orquivia_private.operations_iso(h.last_attempt_finished_at),'errorCode',h.last_error_code) end,
    'lastSuccess',case when h.last_success_at is null then null else pg_catalog.jsonb_build_object(
      'finishedAt',orquivia_private.operations_iso(h.last_success_at),'sourceCommit',h.last_success_commit,
      'encryptedBytes',h.last_success_encrypted_bytes,'storageObjects',h.last_success_storage_objects,
      'storageBytes',h.last_success_storage_bytes,'checksumVerified',true,'permissionsChecked',true) end,
    'lastRestore',case when h.restore_verified_at is null then null else pg_catalog.jsonb_build_object(
      'verifiedAt',orquivia_private.operations_iso(h.restore_verified_at),'sourceCommit',h.restore_source_commit,
      'reportSha256',h.restore_report_sha256,'scope',h.restore_scope) end
  );
end;
$$;
revoke all on function public.load_orquivia_backup_health(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.load_orquivia_backup_health(uuid,uuid) to authenticated;

create or replace function public.record_orquivia_backup_attempt(p_organization_id uuid,p_attempt_id uuid,p_phase text,p_report jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h orquivia_private.backup_health%rowtype; v_now timestamptz:=now();
  encrypted_bytes bigint; object_count integer; storage_bytes bigint;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  if p_organization_id is null or p_attempt_id is null or p_phase is null or p_phase not in ('started','succeeded','failed')
    or p_report is null or pg_catalog.jsonb_typeof(p_report)<>'object' then
    raise exception 'INVALID_BACKUP_EVIDENCE' using errcode='22023';
  end if;
  if not exists(select 1 from public.orquivia_organizations where id=p_organization_id) then
    raise exception 'INVALID_BACKUP_ORGANIZATION' using errcode='22023';
  end if;
  if p_phase='started' then
    if p_report<>'{}'::jsonb then raise exception 'INVALID_BACKUP_EVIDENCE' using errcode='22023'; end if;
  elsif p_phase='failed' then
    if (p_report-array['errorCode'])<>'{}'::jsonb or not p_report ? 'errorCode'
      or pg_catalog.jsonb_typeof(p_report->'errorCode')<>'string'
      or p_report->>'errorCode' not in ('SCHEDULED_BACKUP_DISABLED','SCHEDULED_BACKUP_CONTEXT_INVALID',
        'SCHEDULED_BACKUP_READINESS_REQUIRED','SCHEDULED_BACKUP_PROJECT_INVALID','SCHEDULED_BACKUP_DRIFT_CHECKS_REQUIRED',
        'SCHEDULED_BACKUP_TEMP_REQUIRED','SCHEDULED_BACKUP_CAPTURE_FAILED','SCHEDULED_BACKUP_CAPTURE_INVALID',
        'SCHEDULED_BACKUP_UPLOAD_FAILED','SCHEDULED_BACKUP_UPLOAD_INVALID','SCHEDULED_BACKUP_EVIDENCE_FAILED',
        'SCHEDULED_BACKUP_EVIDENCE_INVALID','SCHEDULED_BACKUP_FAILED') then
      raise exception 'INVALID_BACKUP_EVIDENCE' using errcode='22023';
    end if;
  else
    if (p_report-array['sourceCommit','encryptedBytes','storageObjects','storageBytes','checksumVerified','permissionsChecked','archiveSha256'])<>'{}'::jsonb
      or not p_report ?& array['sourceCommit','encryptedBytes','storageObjects','storageBytes','checksumVerified','permissionsChecked','archiveSha256']
      or pg_catalog.jsonb_typeof(p_report->'sourceCommit')<>'string' or p_report->>'sourceCommit' !~ '^[a-f0-9]{40}$'
      or p_report->'checksumVerified'<>'true'::jsonb or p_report->'permissionsChecked'<>'true'::jsonb
      or pg_catalog.jsonb_typeof(p_report->'encryptedBytes')<>'number' or p_report->>'encryptedBytes' !~ '^[0-9]{1,11}$'
      or pg_catalog.jsonb_typeof(p_report->'storageObjects')<>'number' or p_report->>'storageObjects' !~ '^[0-9]{1,6}$'
      or pg_catalog.jsonb_typeof(p_report->'storageBytes')<>'number' or p_report->>'storageBytes' !~ '^[0-9]{1,11}$'
      or pg_catalog.jsonb_typeof(p_report->'archiveSha256')<>'string' or p_report->>'archiveSha256' !~ '^[a-f0-9]{64}$' then
      raise exception 'INVALID_BACKUP_EVIDENCE' using errcode='22023';
    end if;
    encrypted_bytes:=(p_report->>'encryptedBytes')::bigint; object_count:=(p_report->>'storageObjects')::integer; storage_bytes:=(p_report->>'storageBytes')::bigint;
    if encrypted_bytes<1 or encrypted_bytes>40000000000 or object_count>100000 or storage_bytes>20000000000 then
      raise exception 'INVALID_BACKUP_EVIDENCE' using errcode='22023';
    end if;
  end if;
  insert into orquivia_private.backup_health(organization_id) values(p_organization_id) on conflict do nothing;
  select * into h from orquivia_private.backup_health where organization_id=p_organization_id for update;
  if p_phase='started' then
    if h.last_attempt_id=p_attempt_id then return pg_catalog.jsonb_build_object('recorded',true,'phase',h.last_attempt_status); end if;
    if h.last_attempt_status='started' and h.last_attempt_started_at>v_now-interval '3 hours' then
      raise exception 'BACKUP_ATTEMPT_CONFLICT' using errcode='PT409';
    end if;
    update orquivia_private.backup_health set last_attempt_id=p_attempt_id,last_attempt_status='started',
      last_attempt_started_at=v_now,last_attempt_finished_at=null,last_error_code=null,updated_at=v_now
      where organization_id=p_organization_id;
  else
    if h.last_attempt_id is distinct from p_attempt_id then raise exception 'BACKUP_ATTEMPT_CONFLICT' using errcode='PT409'; end if;
    if h.last_attempt_status=p_phase then
      if (p_phase='failed' and h.last_error_code is distinct from p_report->>'errorCode')
        or (p_phase='succeeded' and (h.last_success_commit is distinct from p_report->>'sourceCommit'
          or h.last_success_encrypted_bytes is distinct from encrypted_bytes or h.last_success_storage_objects is distinct from object_count
          or h.last_success_storage_bytes is distinct from storage_bytes or h.last_success_archive_sha256 is distinct from p_report->>'archiveSha256')) then
        raise exception 'BACKUP_ATTEMPT_CONFLICT' using errcode='PT409';
      end if;
      return pg_catalog.jsonb_build_object('recorded',true,'phase',p_phase);
    end if;
    if h.last_attempt_status<>'started' then raise exception 'BACKUP_ATTEMPT_CONFLICT' using errcode='PT409'; end if;
    if p_phase='failed' then
      update orquivia_private.backup_health set last_attempt_status='failed',last_attempt_finished_at=v_now,
        last_error_code=p_report->>'errorCode',updated_at=v_now where organization_id=p_organization_id;
    else
      update orquivia_private.backup_health set last_attempt_status='succeeded',last_attempt_finished_at=v_now,last_error_code=null,
        last_success_at=v_now,last_success_commit=p_report->>'sourceCommit',last_success_encrypted_bytes=encrypted_bytes,
        last_success_storage_objects=object_count,last_success_storage_bytes=storage_bytes,
        last_success_archive_sha256=p_report->>'archiveSha256',updated_at=v_now where organization_id=p_organization_id;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('recorded',true,'phase',p_phase);
end;
$$;
revoke all on function public.record_orquivia_backup_attempt(uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_orquivia_backup_attempt(uuid,uuid,text,jsonb) to service_role;

-- Deliberate operator attestation after reviewing a concrete, hashed report.
-- No capture/scheduler code calls this function or infers it from readiness flags.
create or replace function public.record_orquivia_restore_evidence(p_organization_id uuid,p_report jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare verified_at timestamptz; h orquivia_private.backup_health%rowtype;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_ROLE_REQUIRED' using errcode='42501'; end if;
  if p_organization_id is null or p_report is null or pg_catalog.jsonb_typeof(p_report)<>'object'
    or (p_report-array['sourceCommit','reportSha256','scope','verifiedAt'])<>'{}'::jsonb
    or not p_report ?& array['sourceCommit','reportSha256','scope','verifiedAt']
    or pg_catalog.jsonb_typeof(p_report->'sourceCommit')<>'string' or p_report->>'sourceCommit' !~ '^[a-f0-9]{40}$'
    or pg_catalog.jsonb_typeof(p_report->'reportSha256')<>'string' or p_report->>'reportSha256' !~ '^[a-f0-9]{64}$'
    or pg_catalog.jsonb_typeof(p_report->'scope')<>'string' or p_report->>'scope' not in ('business-data-and-originals','full-system')
    or pg_catalog.jsonb_typeof(p_report->'verifiedAt')<>'string' or p_report->>'verifiedAt' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$' then
    raise exception 'INVALID_RESTORE_EVIDENCE' using errcode='22023';
  end if;
  begin verified_at:=(p_report->>'verifiedAt')::timestamptz;
  exception when others then raise exception 'INVALID_RESTORE_EVIDENCE' using errcode='22023'; end;
  if not pg_catalog.isfinite(verified_at) or verified_at>now()+interval '5 minutes' then raise exception 'INVALID_RESTORE_EVIDENCE' using errcode='22023'; end if;
  if not exists(select 1 from public.orquivia_organizations where id=p_organization_id) then
    raise exception 'INVALID_BACKUP_ORGANIZATION' using errcode='22023';
  end if;
  insert into orquivia_private.backup_health(organization_id) values(p_organization_id) on conflict do nothing;
  select * into h from orquivia_private.backup_health where organization_id=p_organization_id for update;
  if h.restore_verified_at>verified_at or (h.restore_verified_at=verified_at and
    (h.restore_source_commit is distinct from p_report->>'sourceCommit' or h.restore_report_sha256 is distinct from p_report->>'reportSha256'
      or h.restore_scope is distinct from p_report->>'scope')) then
    raise exception 'RESTORE_EVIDENCE_CONFLICT' using errcode='PT409';
  end if;
  update orquivia_private.backup_health set restore_verified_at=verified_at,restore_source_commit=p_report->>'sourceCommit',
    restore_report_sha256=p_report->>'reportSha256',restore_scope=p_report->>'scope',updated_at=now()
    where organization_id=p_organization_id;
  return pg_catalog.jsonb_build_object('recorded',true);
end;
$$;
revoke all on function public.record_orquivia_restore_evidence(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.record_orquivia_restore_evidence(uuid,jsonb) to service_role;

commit;

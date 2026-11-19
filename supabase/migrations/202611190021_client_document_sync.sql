-- Client edits follow documents which are still being prepared. Numbered
-- invoices retain their fiscal snapshots and every existing ledger invariant.
begin;

create function orquivia_private.has_pending_document_mail(p_org uuid,p_document text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from orquivia_private.mail_jobs j where j.organization_id=p_org
    and j.status in ('sending','uncertain','archive_pending')
    and (j.document_id=p_document or j.related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',p_document)))));
$$;

create function orquivia_private.frozen_quote_client(p_org uuid,p_previous jsonb,p_document jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
  select coalesce(p_document->'clientSnapshot',
    (select case when j.document_id=p_document->>'id' then j.document_snapshot->'clientSnapshot'
      else (select coalesce(r->'document'->'clientSnapshot',r->'client') from jsonb_array_elements(j.related_documents) r
        where r->'document'->>'id'=p_document->>'id' limit 1) end
      from orquivia_private.mail_jobs j where j.organization_id=p_org
        and (j.document_id=p_document->>'id' or j.related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',p_document->>'id'))))
      order by j.created_at,j.id limit 1),
    (select c from jsonb_array_elements(p_previous->'clients') c where c->>'id'=p_document->>'clientId'));
$$;

create function orquivia_private.can_sync_quote_client(p_org uuid,p_previous jsonb,p_next jsonb,p_old jsonb,p_document jsonb) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(p_old->>'kind'='quote' and p_document->>'kind'='quote'
    and p_old->>'status'='ready' and p_document->>'status'='ready'
    and not exists(select 1 from orquivia_private.mail_jobs j where j.organization_id=p_org
      and (j.document_id=p_old->>'id' or j.related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',p_old->>'id')))))
    and not exists(select 1 from jsonb_array_elements((p_previous->'documents')||(p_next->'documents')) d
      where d->>'kind'='invoice' and d->>'status'<>'draft' and d->>'quoteId'=p_old->>'id')
    -- The history records field names, not their values. Any status correction
    -- after issue conservatively ends preparation, including sent -> ready.
    and not exists(select 1 from public.orquivia_record_history h where h.organization_id=p_org
      and h.entity_type='document' and h.entity_id=p_old->>'id' and h.action='updated'
      and h.event<>'issue' and h.changed_fields @> array['status']),false);
$$;

create function orquivia_private.can_sync_invoice_recipient(p_org uuid,p_old jsonb,p_document jsonb) returns boolean
language sql stable security definer set search_path='' as $$
  select coalesce(p_old->>'kind'='invoice' and p_document->>'kind'='invoice'
    and p_old->>'status'<>'draft' and p_document->>'status'<>'draft'
    and p_old->>'deliveryStatus'='ready' and p_document->>'deliveryStatus'='ready'
    and not exists(select 1 from orquivia_private.mail_jobs j where j.organization_id=p_org
      and (j.document_id=p_old->>'id' or j.related_documents @> jsonb_build_array(jsonb_build_object('document',jsonb_build_object('id',p_old->>'id')))))
    and not exists(select 1 from public.orquivia_record_history h where h.organization_id=p_org
      and h.entity_type='document' and h.entity_id=p_old->>'id' and h.action='updated'
      and h.event<>'issue' and h.changed_fields @> array['deliveryStatus']),false);
$$;

create function orquivia_private.sync_document_clients(p_org uuid,p_previous jsonb,p_next jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb:=p_next; d jsonb; prior jsonb; old_client jsonb; next_client jsonb;
  frozen_client jsonb; old_default text; snapshot_default text; next_default text; idx integer;
begin
  for d,idx in select value,ordinality::integer-1 from jsonb_array_elements(p_next->'documents') with ordinality loop
    select value into prior from jsonb_array_elements(p_previous->'documents') where value->>'id'=d->>'id';
    select value into old_client from jsonb_array_elements(p_previous->'clients') where value->>'id'=prior->>'clientId';
    select value into next_client from jsonb_array_elements(p_next->'clients') where value->>'id'=d->>'clientId';
    if d->>'status'='draft' then
      -- Historical imports and copied drafts may carry obsolete snapshots.
      -- Drafts always resolve the selected current client instead.
      d:=d-'clientSnapshot';
    elsif orquivia_private.can_sync_quote_client(p_org,p_previous,p_next,prior,d) then
      d:=jsonb_set(d,'{clientSnapshot}',next_client);
    elsif prior->>'kind'='quote' and prior->>'status'<>'draft' then
      frozen_client:=orquivia_private.frozen_quote_client(p_org,p_previous,prior);
      if d->>'clientId' is distinct from prior->>'clientId'
        or (d ? 'clientSnapshot' and d->'clientSnapshot' is distinct from frozen_client) then
        raise exception 'DOCUMENT_CLIENT_LOCKED' using errcode='22023';
      end if;
      -- Freeze the previous effective client for legacy quotes without a
      -- snapshot before their master record can change. This is audited by the
      -- same save; originals, mail job snapshots and ledgers are untouched.
      -- Restore omitted snapshots as well: older tabs may not have adopted the
      -- canonical state returned by their previous successful save.
      if not(prior ? 'clientSnapshot') and orquivia_private.has_pending_document_mail(p_org,prior->>'id') then
        -- Very old imported quotes may lack a party snapshot. Their exact JSON
        -- must survive an active delivery so completion can match the claim.
        if d ? 'clientSnapshot' then raise exception 'DOCUMENT_CLIENT_LOCKED' using errcode='22023'; end if;
      else d:=jsonb_set(d,'{clientSnapshot}',frozen_client); end if;
    end if;

    -- An explicit per-invoice recipient wins. Only inherited defaults follow
    -- an edited master, and delivery evidence permanently ends that behavior.
    if d->>'kind'='invoice' and prior->>'clientId'=d->>'clientId'
      and old_client is distinct from next_client
      and d->'billingEmail' is not distinct from prior->'billingEmail'
      and (d->>'status'='draft' or orquivia_private.can_sync_invoice_recipient(p_org,prior,d)) then
      old_default:=coalesce(nullif(old_client->>'billingEmail',''),nullif(old_client->>'email',''));
      snapshot_default:=coalesce(nullif(prior->'clientSnapshot'->>'billingEmail',''),nullif(prior->'clientSnapshot'->>'email',''));
      next_default:=coalesce(nullif(next_client->>'billingEmail',''),nullif(next_client->>'email',''));
      if next_default is not null and not orquivia_private.valid_billing_email(to_jsonb(next_default)) then next_default:=null; end if;
      if not(prior ? 'billingEmail') or prior->>'billingEmail'=old_default or prior->>'billingEmail'=snapshot_default then
        if next_default is null then d:=d-'billingEmail';
        else d:=jsonb_set(d,'{billingEmail}',to_jsonb(next_default)); end if;
      end if;
    end if;
    result:=jsonb_set(result,array['documents',idx::text],d);
  end loop;
  return result;
end; $$;

alter function orquivia_private.check_issued(uuid,jsonb,jsonb) rename to check_issued_before_client_document_sync;
create function orquivia_private.check_issued(p_org uuid,p_previous jsonb,p_next jsonb) returns void
language plpgsql set search_path='' as $$
declare prior jsonb; d jsonb; old_client jsonb; next_client jsonb; pending_legacy boolean;
begin
  perform orquivia_private.check_issued_before_client_document_sync(p_org,p_previous,p_next);
  for prior in select value from jsonb_array_elements(p_previous->'documents')
    where value->>'kind'='quote' and value->>'status'<>'draft' loop
    select value into d from jsonb_array_elements(p_next->'documents') where value->>'id'=prior->>'id';
    if d is not null and not orquivia_private.can_sync_quote_client(p_org,p_previous,p_next,prior,d) then
      old_client:=orquivia_private.frozen_quote_client(p_org,p_previous,prior);
      select value into next_client from jsonb_array_elements(p_next->'clients') where value->>'id'=d->>'clientId';
      pending_legacy:=not(prior ? 'clientSnapshot') and orquivia_private.has_pending_document_mail(p_org,prior->>'id');
      if d->>'clientId' is distinct from prior->>'clientId'
        or (prior ? 'clientSnapshot' and d->'clientSnapshot' is distinct from prior->'clientSnapshot')
        or (pending_legacy and d ? 'clientSnapshot')
        or (not(prior ? 'clientSnapshot') and not pending_legacy and coalesce(d->'clientSnapshot',next_client) is distinct from old_client) then
        raise exception 'DOCUMENT_CLIENT_LOCKED' using errcode='22023';
      end if;
    end if;
  end loop;
end; $$;

alter function orquivia_private.save_team(uuid,jsonb,bigint) rename to save_team_before_client_document_sync;
create function orquivia_private.save_team(p_organization_id uuid,p_state jsonb,p_expected_version bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare old_state jsonb; old_version bigint; next_state jsonb; result jsonb;
begin
  perform orquivia_private.require_member(p_organization_id);
  select state,version into old_state,old_version from public.orquivia_team_workspaces
    where organization_id=p_organization_id for update;
  if old_version is distinct from p_expected_version then raise exception 'VERSION_CONFLICT' using errcode='PT409'; end if;
  if not orquivia_private.valid_state(p_state) then raise exception 'INVALID_STATE' using errcode='22023'; end if;
  next_state:=orquivia_private.sync_document_clients(p_organization_id,old_state,p_state);
  -- Preserve the complete membership, company, issued-document, receipt,
  -- normalization and history checks in the original versioned save.
  result:=orquivia_private.save_team_before_client_document_sync(p_organization_id,next_state,p_expected_version);
  select state into next_state from public.orquivia_team_workspaces where organization_id=p_organization_id;
  return result||jsonb_build_object('state',next_state);
end; $$;

revoke all on function orquivia_private.has_pending_document_mail(uuid,text),
  orquivia_private.frozen_quote_client(uuid,jsonb,jsonb),
  orquivia_private.can_sync_quote_client(uuid,jsonb,jsonb,jsonb,jsonb),
  orquivia_private.can_sync_invoice_recipient(uuid,jsonb,jsonb),
  orquivia_private.sync_document_clients(uuid,jsonb,jsonb),
  orquivia_private.check_issued_before_client_document_sync(uuid,jsonb,jsonb),
  orquivia_private.check_issued(uuid,jsonb,jsonb),
  orquivia_private.save_team_before_client_document_sync(uuid,jsonb,bigint),
  orquivia_private.save_team(uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function orquivia_private.has_pending_document_mail(uuid,text),
  orquivia_private.frozen_quote_client(uuid,jsonb,jsonb),
  orquivia_private.can_sync_quote_client(uuid,jsonb,jsonb,jsonb,jsonb),
  orquivia_private.can_sync_invoice_recipient(uuid,jsonb,jsonb),
  orquivia_private.sync_document_clients(uuid,jsonb,jsonb),
  orquivia_private.check_issued_before_client_document_sync(uuid,jsonb,jsonb),
  orquivia_private.check_issued(uuid,jsonb,jsonb),
  orquivia_private.save_team_before_client_document_sync(uuid,jsonb,bigint),
  orquivia_private.save_team(uuid,jsonb,bigint) to service_role;
grant execute on function orquivia_private.save_team(uuid,jsonb,bigint) to authenticated;
commit;

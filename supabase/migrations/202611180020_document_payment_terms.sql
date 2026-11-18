-- Per-document payment conditions. Omitted fields retain the legacy company
-- fallback; existing documents, company defaults and issued ledgers are untouched.
begin;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_before_document_payment_terms;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare d jsonb; terms numeric;
begin
  if not orquivia_private.valid_state_before_document_payment_terms(p_state) then return false; end if;
  for d in select value from jsonb_array_elements(p_state->'documents') loop
    if d ? 'paymentTerms' then
      if jsonb_typeof(d->'paymentTerms') is distinct from 'number' then return false; end if;
      terms:=(d->>'paymentTerms')::numeric;
      if terms<0 or terms>365 or terms<>trunc(terms) then return false; end if;
    end if;
    if d ? 'paymentTermsText' then
      if jsonb_typeof(d->'paymentTermsText') is distinct from 'string'
        or length(d->>'paymentTermsText') not between 1 and 500
        or d->>'paymentTermsText' !~ '[^[:space:]]' then return false; end if;
    end if;
  end loop;
  return true;
exception when others then return false;
end; $$;

-- Rebind the table check to the new wrapper rather than its renamed predecessor.
alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

create or replace function orquivia_private.record_change_fields(p_type text,p_old jsonb,p_new jsonb) returns text[]
language plpgsql immutable set search_path='' as $$
declare fields text[]; additions text[]:=array[]::text[]; field text;
begin
  if p_type='document' then additions:=array['billingEmail','deliveryStatus','paymentTerms','paymentTermsText'];
  elsif p_type='client' then additions:=array['billingEmail']; end if;
  fields:=orquivia_private.record_change_fields_before_invoice_mail(p_type,p_old-additions,p_new-additions);
  foreach field in array additions loop
    if p_old->field is distinct from p_new->field then fields:=array_append(fields,field); end if;
  end loop;
  return fields;
end; $$;

-- fiscal_data already retains all fields except its explicit operational allowlist.
-- These payment conditions therefore remain immutable on issued invoices without
-- changing old fiscal snapshots or weakening any existing invoice safeguard.
revoke all on function orquivia_private.valid_state(jsonb),
  orquivia_private.valid_state_before_document_payment_terms(jsonb),
  orquivia_private.record_change_fields(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_state(jsonb),
  orquivia_private.valid_state_before_document_payment_terms(jsonb),
  orquivia_private.record_change_fields(text,jsonb,jsonb) to service_role;

commit;

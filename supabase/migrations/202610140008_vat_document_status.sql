-- Preserve document evidence when the total is known but VAT is not itemized.
-- These annotations do not confirm a tax base, VAT amount or deductibility.
begin;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_expenses_quick_v2;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare e jsonb;
begin
  -- Retain every previous document, expense amount, payment and receipt check.
  if not orquivia_private.valid_state_expenses_quick_v2(p_state) then return false; end if;
  if p_state ? 'expenses' then
    for e in select v from jsonb_array_elements(p_state->'expenses') v loop
      if e ? 'vatDocumentStatus' then
        if jsonb_typeof(e->'vatDocumentStatus') is distinct from 'string'
          or e->>'vatDocumentStatus' not in ('included-unitemized','not-stated')
          or e->'vatReviewNeeded' is distinct from 'true'::jsonb then return false; end if;
      end if;
    end loop;
  end if;
  return true;
exception when others then return false;
end; $$;

-- CHECK expressions keep their function identity after a rename. Rebind the
-- existing constraint to this wrapper without changing any historical state.
alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

revoke all on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_expenses_quick_v2(jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_expenses_quick_v2(jsonb) to service_role;
commit;

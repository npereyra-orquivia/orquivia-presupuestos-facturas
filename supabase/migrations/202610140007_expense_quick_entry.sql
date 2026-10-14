-- Quick receipt capture: the concept is required, supplier details are optional.
-- Unknown VAT is explicit; provisional gross amounts never confirm a tax base.
-- Supplier credits are negative; suplidos/tips remain separate from the VAT base.
begin;

alter function orquivia_private.valid_state(jsonb) rename to valid_state_expenses_v1;
create function orquivia_private.valid_state(p_state jsonb) returns boolean
language plpgsql stable set search_path='' as $$
declare e jsonb; checked_e jsonb; checked_expenses jsonb:='[]'::jsonb; checked_state jsonb:=p_state;
  field text; amount numeric; base numeric; vat numeric; additional numeric; total numeric; deductible numeric;
  credit boolean; movement jsonb; cash numeric; cash_sum numeric; movement_ids text[]:=array[]::text[];
  today date:=(now() at time zone 'Europe/Madrid')::date;
  uuid_pattern text:='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_state ? 'expenses' then
    if jsonb_typeof(p_state->'expenses') is distinct from 'array' or jsonb_array_length(p_state->'expenses')>10000 then return false; end if;
    for e in select v from jsonb_array_elements(p_state->'expenses') v loop
      if jsonb_typeof(e) is distinct from 'object' then return false; end if;
      if e ? 'supplier' and (jsonb_typeof(e->'supplier') is distinct from 'string' or length(e->>'supplier')>240) then return false; end if;
      if e ? 'kind' and (jsonb_typeof(e->'kind') is distinct from 'string' or e->>'kind' not in ('expense','credit')) then return false; end if;
      credit:=coalesce(e->>'kind','expense')='credit';
      foreach field in array array['base','vatAmount','total'] loop
        if jsonb_typeof(e->field) is distinct from 'number' then return false; end if;
        amount:=(e->>field)::numeric;
        if abs(amount)>90071992547409.91 or amount<>round(amount,2)
          or (credit and amount>0) or (not credit and amount<0) then return false; end if;
      end loop;
      additional:=0; deductible:=0;
      foreach field in array array['additionalAmount','vatDeductibleAmount'] loop
        if e ? field then
          if jsonb_typeof(e->field) is distinct from 'number' then return false; end if;
          amount:=(e->>field)::numeric;
          if abs(amount)>90071992547409.91 or amount<>round(amount,2)
            or (credit and amount>0) or (not credit and amount<0) then return false; end if;
          if field='additionalAmount' then additional:=amount; else deductible:=amount; end if;
        end if;
      end loop;
      base:=(e->>'base')::numeric; vat:=(e->>'vatAmount')::numeric; total:=(e->>'total')::numeric;
      if total=0 or total<>base+vat+additional or abs(deductible)>abs(vat) then return false; end if;
      cash:=total;
      if e ? 'cashAmount' then
        if jsonb_typeof(e->'cashAmount') is distinct from 'number' then return false; end if;
        cash:=(e->>'cashAmount')::numeric;
        if abs(cash)>90071992547409.91 or cash<>round(cash,2)
          or (credit and cash>0) or (not credit and cash<0) then return false; end if;
      end if;
      if e ? 'cashMovements' then
        if e->>'paymentStatus' is distinct from 'paid' or jsonb_typeof(e->'cashMovements') is distinct from 'array'
          or jsonb_array_length(e->'cashMovements')<1 or jsonb_array_length(e->'cashMovements')>100 then return false; end if;
        cash_sum:=0;
        for movement in select v from jsonb_array_elements(e->'cashMovements') v loop
          if jsonb_typeof(movement) is distinct from 'object' or jsonb_typeof(movement->'id') is distinct from 'string'
            or movement->>'id' !~ uuid_pattern or movement->>'id'=any(movement_ids)
            or not orquivia_private.valid_date(movement->>'date') or (movement->>'date')::date>today
            or jsonb_typeof(movement->'amount') is distinct from 'number' then return false; end if;
          if movement ? 'reference' and (jsonb_typeof(movement->'reference') is distinct from 'string'
            or length(movement->>'reference')>240) then return false; end if;
          amount:=(movement->>'amount')::numeric;
          if amount=0 or abs(amount)>90071992547409.91 or amount<>round(amount,2) then return false; end if;
          cash_sum:=cash_sum+amount;
          movement_ids:=array_append(movement_ids,movement->>'id');
        end loop;
        if cash_sum<>cash then return false; end if;
      end if;
      if e ? 'vatReviewNeeded' and jsonb_typeof(e->'vatReviewNeeded') is distinct from 'boolean' then return false; end if;
      if e->'vatReviewNeeded'='true'::jsonb and (
        jsonb_typeof(e->'vatAmount') is distinct from 'number'
        or (e->>'vatAmount')::numeric<>0
        or (e ? 'vatDeductibleAmount' and (jsonb_typeof(e->'vatDeductibleAmount') is distinct from 'number'
          or (e->>'vatDeductibleAmount')::numeric<>0))
        or e ? 'vatRate') then return false; end if;
      -- Only this validation copy is adapted to the previous positive-only
      -- amount checker. The real state retains the signed credit and separates
      -- additional amounts; documents, dates, payment and receipt checks stay intact.
      checked_e:=e||jsonb_build_object('base',abs(base)+abs(additional),'vatAmount',abs(vat),
        'total',abs(total),'vatDeductibleAmount',abs(deductible));
      if coalesce(btrim(e->>'supplier'),'')='' then checked_e:=checked_e||jsonb_build_object('supplier','Sin proveedor indicado'); end if;
      checked_expenses:=checked_expenses||jsonb_build_array(checked_e);
    end loop;
    checked_state:=jsonb_set(p_state,'{expenses}',checked_expenses);
  end if;
  return orquivia_private.valid_state_expenses_v1(checked_state);
exception when others then return false;
end; $$;

-- PostgreSQL stores the function identity in CHECK expressions. Rebind the
-- existing constraint to the new wrapper while retaining every prior check.
alter table public.orquivia_team_workspaces drop constraint orquivia_team_workspaces_state_check;
alter table public.orquivia_team_workspaces add constraint orquivia_team_workspaces_state_check check(orquivia_private.valid_state(state));

revoke all on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_expenses_v1(jsonb) from public,anon,authenticated;
grant execute on function orquivia_private.valid_state(jsonb),orquivia_private.valid_state_expenses_v1(jsonb) to service_role;
commit;

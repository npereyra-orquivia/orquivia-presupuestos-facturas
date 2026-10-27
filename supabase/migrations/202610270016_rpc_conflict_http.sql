-- Business version conflicts are final for this request, not serialization
-- failures to retry. Older PostgREST releases can retry SQLSTATE 40001 forever.
-- Preserve each installed definition and change only its known RAISE SQLSTATE.
-- https://supabase.com/kb/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions
begin;

do $migration$
declare
  target record;
  function_id oid;
  definition text;
  body text;
  conflict_pattern text;
  resolved_pattern text;
  replacement_count integer;
  resolved_count integer;
begin
  for target in select * from (values
    ('public.import_orquivia_state(uuid,jsonb,bigint)', 'VERSION_CONFLICT'),
    ('orquivia_private.save_state(jsonb,bigint)', 'VERSION_CONFLICT'),
    ('orquivia_private.save_team(uuid,jsonb,bigint)', 'VERSION_CONFLICT'),
    ('orquivia_private.issue_document(uuid,text,bigint)', 'VERSION_CONFLICT'),
    ('public.orquivia_mail_save_profile(uuid,uuid,bigint,jsonb,text,text,text,boolean)', 'PROFILE_CONFLICT'),
    ('public.orquivia_mail_claim(uuid,uuid,uuid,text,bigint,text,jsonb,text,jsonb,jsonb)', 'VERSION_CONFLICT')
  ) as expected(signature, message)
  loop
    function_id := pg_catalog.to_regprocedure(target.signature);
    if function_id is null then
      raise exception 'RPC_CONFLICT_MIGRATION_FUNCTION_MISSING';
    end if;
    select p.prosrc, pg_catalog.pg_get_functiondef(p.oid)
      into body, definition from pg_catalog.pg_proc p where p.oid = function_id;
    conflict_pattern := pg_catalog.format(
      $pattern$(raise[[:space:]]+exception[[:space:]]+'%s'[[:space:]]+using[[:space:]]+errcode[[:space:]]*=[[:space:]]*)'40001'$pattern$,
      target.message);
    resolved_pattern := pg_catalog.replace(conflict_pattern, '''40001''', '''PT409''');
    select count(*) into replacement_count from pg_catalog.regexp_matches(body, conflict_pattern, 'gi');
    select count(*) into resolved_count from pg_catalog.regexp_matches(body, resolved_pattern, 'gi');

    if replacement_count = 1 and resolved_count = 0
      and pg_catalog.regexp_count(body, '''40001''') = 1 then
      execute pg_catalog.regexp_replace(definition, conflict_pattern, $replacement$\1'PT409'$replacement$, 'gi');
    elsif replacement_count = 0 and resolved_count = 1 and pg_catalog.strpos(body, '''40001''') = 0 then
      -- Reapplying this migration is safe, including after a partial operator
      -- intervention. The complete transaction still requires all six targets.
      null;
    else
      -- Never silently rewrite an unfamiliar function or a second error site.
      raise exception 'RPC_CONFLICT_MIGRATION_UNEXPECTED_DEFINITION';
    end if;

    select p.prosrc into body from pg_catalog.pg_proc p where p.oid = function_id;
    select count(*) into resolved_count from pg_catalog.regexp_matches(body, resolved_pattern, 'gi');
    if resolved_count <> 1 or pg_catalog.strpos(body, '''40001''') <> 0 then
      raise exception 'RPC_CONFLICT_MIGRATION_VALIDATION_FAILED';
    end if;
  end loop;
end;
$migration$;

commit;

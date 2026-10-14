-- OPTIONAL. Activate only after deploying daily-reminders and configuring its secrets.
-- Enable pg_cron, pg_net and Vault in Supabase's Dashboard first.
-- Add these secrets via the Vault UI (avoid pasting real secrets into Git):
--   orquivia_project_url  = https://YOUR_PROJECT.supabase.co
--   orquivia_cron_secret = same long random value as ORQUIVIA_CRON_SECRET in Edge secrets
-- This job runs hourly; the function sends at most one summary per Madrid day.
-- Hourly retries cover temporary provider/network failures without extra summaries.

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'orquivia_project_url')
    or not exists (select 1 from vault.decrypted_secrets where name = 'orquivia_cron_secret') then
    raise exception 'Add orquivia_project_url and orquivia_cron_secret to Vault first.';
  end if;
end;
$$;

select cron.schedule(
  'orquivia-daily-reminders',
  '10 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'orquivia_project_url' limit 1)
      || '/functions/v1/daily-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-orquivia-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'orquivia_cron_secret' limit 1)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- To turn external reminders off again:
-- select cron.unschedule('orquivia-daily-reminders');

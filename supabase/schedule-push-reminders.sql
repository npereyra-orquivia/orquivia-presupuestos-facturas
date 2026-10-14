-- Run after deploying send-push-reminders and applying migration 005.
-- This independent cron job has no email-provider dependency.
-- The configuration/cron secret stays in a private, unexposed schema. No secret
-- literal is stored in cron.job or sent to the browser.
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$
begin
  if not exists(select 1 from orquivia_private.push_runtime_config where singleton and public_key is not null) then
    raise exception 'Deploy and initialize the push function first.';
  end if;
end;
$$;

-- Hourly delivery follows each user's Madrid hour, including daylight-saving time.
-- A transactional lease plus the device/date key prevents parallel cron retries.
select cron.schedule(
  'orquivia-push-reminders', '20 * * * *',
  $$select net.http_post(
    url := 'https://tfaglecwycbamibnhqmq.supabase.co/functions/v1/send-push-reminders',
    headers := jsonb_build_object('Content-Type','application/json',
      'x-orquivia-push-secret',(select cron_secret from orquivia_private.push_runtime_config where singleton)),
    body := '{}'::jsonb, timeout_milliseconds := 60000
  );$$
);
update orquivia_private.push_runtime_config set scheduled=true where singleton;

-- Disable: select cron.unschedule('orquivia-push-reminders');

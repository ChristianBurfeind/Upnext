-- Run after notifications-setup.sql and after creating these two Supabase Vault
-- secrets in the Dashboard:
--   notification_function_url = https://<project-ref>.supabase.co/functions/v1/notification-scheduler
--   notification_cron_secret = same long random value stored as the
--     NOTIFICATION_CRON_SECRET Edge Function secret
-- Running cron.schedule again with this job name updates the existing job.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'upnext-notification-scheduler',
  '* * * * *',
  $$
    select net.http_post(
      url := (select decrypted_secret
              from vault.decrypted_secrets
              where name = 'notification_function_url'),
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-notification-cron-secret',
          (select decrypted_secret
           from vault.decrypted_secrets
           where name = 'notification_cron_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);

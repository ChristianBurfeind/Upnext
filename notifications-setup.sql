-- Upnext email notification support.
-- This is additive: it does not change the existing tasks, events, Settings,
-- Auth verification, or account-deletion tables/functions.
-- Run once in the Supabase SQL Editor after the existing scheduler setup.

begin;

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email_enabled boolean not null default false,
  event_reminders_enabled boolean not null default true,
  event_lead_minutes integer not null default 15
    check (event_lead_minutes between 0 and 43200),
  task_reminders_enabled boolean not null default true,
  task_reminder_time time not null default time '18:00',
  daily_summary_enabled boolean not null default false,
  daily_summary_time time not null default time '08:00',
  time_zone text not null default 'America/Denver',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_item_settings (
  user_id uuid not null references auth.users(id) on delete cascade,
  item_type text not null check (item_type in ('event', 'task')),
  item_id text not null,
  reminder_enabled boolean not null default true,
  event_lead_minutes integer check (event_lead_minutes between 0 and 43200),
  task_reminder_date date,
  task_reminder_time time,
  updated_at timestamptz not null default now(),
  primary key (user_id, item_type, item_id),
  check (item_type <> 'event' or (task_reminder_date is null and task_reminder_time is null)),
  check (item_type <> 'task' or event_lead_minutes is null)
);

create table if not exists public.notification_delivery_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  dedupe_key text not null,
  notification_type text not null check (
    notification_type in ('event', 'task', 'daily_summary', 'test')
  ),
  source_id text,
  occurrence_date date,
  scheduled_for timestamptz,
  status text not null check (status in ('sending', 'sent', 'failed')),
  attempts integer not null default 1 check (attempts > 0),
  last_attempt_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  primary key (user_id, dedupe_key)
);

alter table public.notification_preferences enable row level security;
alter table public.notification_item_settings enable row level security;
alter table public.notification_delivery_log enable row level security;

revoke all on public.notification_preferences from anon, authenticated;
revoke all on public.notification_item_settings from anon, authenticated;
revoke all on public.notification_delivery_log from anon, authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.notification_item_settings to authenticated;
grant all on public.notification_preferences to service_role;
grant all on public.notification_item_settings to service_role;
grant all on public.notification_delivery_log to service_role;

drop policy if exists notification_preferences_owner on public.notification_preferences;
create policy notification_preferences_owner
  on public.notification_preferences for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists notification_item_settings_owner on public.notification_item_settings;
create policy notification_item_settings_owner
  on public.notification_item_settings for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Delivery records are private to the server-side worker. The website cannot
-- read or write them, which keeps sending state and deduplication authoritative.
revoke all on public.notification_delivery_log from public, anon, authenticated;

create or replace function public.notifications_create_preferences()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;
revoke all on function public.notifications_create_preferences()
  from public, anon, authenticated;

drop trigger if exists notifications_create_preferences_after_signup on auth.users;
create trigger notifications_create_preferences_after_signup
  after insert on auth.users
  for each row execute function public.notifications_create_preferences();

-- Existing accounts receive default preferences with email turned off.
insert into public.notification_preferences (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Atomically reserve a delivery key. Concurrent scheduler runs cannot send the
-- same email twice. Failed deliveries can be retried; stale workers are reclaimed
-- after ten minutes.
create or replace function public.claim_notification_delivery(
  p_user_id uuid,
  p_dedupe_key text,
  p_notification_type text,
  p_source_id text,
  p_occurrence_date date,
  p_scheduled_for timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  claimed boolean;
begin
  insert into public.notification_delivery_log as existing (
    user_id, dedupe_key, notification_type, source_id, occurrence_date,
    scheduled_for, status, attempts, last_attempt_at, last_error
  ) values (
    p_user_id, p_dedupe_key, p_notification_type, p_source_id,
    p_occurrence_date, p_scheduled_for, 'sending', 1, now(), null
  )
  on conflict (user_id, dedupe_key) do update
    set status = 'sending',
        attempts = existing.attempts + 1,
        last_attempt_at = now(),
        last_error = null
    where existing.status = 'failed'
       or (existing.status = 'sending'
           and existing.last_attempt_at < now() - interval '10 minutes')
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;
revoke all on function public.claim_notification_delivery(uuid, text, text, text, date, timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_notification_delivery(uuid, text, text, text, date, timestamptz)
  to service_role;

notify pgrst, 'reload schema';
commit;

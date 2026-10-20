-- 056: remember the IP address behind every sign-in / app open, so the Admin console can alert when several
-- accounts are used from the same IP. Written and read only by the server (service role) through
-- /api/login-event and /api/ip-alerts; browsers have no access to the table.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create table if not exists public.login_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  ip text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists login_events_ip_idx on public.login_events (ip, created_at desc);
create index if not exists login_events_user_idx on public.login_events (user_id, created_at desc);
create index if not exists login_events_created_idx on public.login_events (created_at desc);

alter table public.login_events enable row level security;
revoke all on public.login_events from anon, authenticated;

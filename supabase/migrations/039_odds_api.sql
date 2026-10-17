-- 039: Cricket odds from The Odds API (the-odds-api.com), replacing DiamondExch for cricket.
--   private_settings  server-only settings (no policies: only the service role, i.e. the Netlify API routes, can read)
--                     'odds_api_key' = the API key, used when the ODDS_API_KEY env var is not set
--   odds_cache        the last odds pull, shared by every server instance so the monthly request quota lasts
--                     (app/lib/server/oddsApi.ts decides how often to refresh)
-- Safe to run more than once. Run it in the Supabase SQL Editor, then add the key (see the message from Claude):
--   insert into public.private_settings (key, value) values ('odds_api_key', to_jsonb('YOUR_KEY'::text))
--     on conflict (key) do update set value = excluded.value;

create table if not exists public.private_settings (
  key text primary key,
  value jsonb not null
);
alter table public.private_settings enable row level security;
revoke all on public.private_settings from anon, authenticated;

create table if not exists public.odds_cache (
  key text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);
alter table public.odds_cache enable row level security;
revoke all on public.odds_cache from anon, authenticated;

-- 069: one device per account. Each sign-in claims a fresh session tag; every open app compares its own tag with
-- the one on the profile (every 15 s and when it comes back to the foreground) and signs out when it no longer
-- matches, i.e. when the account was signed in somewhere else. Players and staff alike.
-- Safe to run more than once. Run it in the Supabase SQL Editor.

alter table public.profiles add column if not exists session_tag text;

create or replace function public.claim_session(p_tag text) returns void
language sql security definer set search_path = public as $$
  update profiles set session_tag = p_tag where id = auth.uid();
$$;

create or replace function public.session_tag() returns text
language sql stable security definer set search_path = public as $$
  select session_tag from profiles where id = auth.uid();
$$;

revoke execute on function public.claim_session(text), public.session_tag() from public, anon;
grant execute on function public.claim_session(text), public.session_tag() to authenticated;

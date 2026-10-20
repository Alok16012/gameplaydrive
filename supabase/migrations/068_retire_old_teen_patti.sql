-- 068: retire the old (Postgres) Teen Patti.
-- Phones still running a cached build keep playing on tp_tables, with its bots and 2%-timeout bot timing, while
-- the new Classic engine (066) sits unused. From now on the old engine refuses new seats and deals no new hands —
-- a hand already under way finishes normally — and the old screen shows a message to refresh the app.
-- Undo: re-run 030 (tp_join), 057 (tp_create_private) and 067 (tp_start_hand).
-- Safe to run more than once. Run after 067 in the Supabase SQL Editor.

create or replace function public.tp_join(p_boot bigint, p_code text default null) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'New Teen Patti is live — close this screen and refresh the app (pull down) to play';
end;
$$;

create or replace function public.tp_create_private(p_boot bigint) returns text
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'New Teen Patti is live — refresh the app (pull down) to create a table';
end;
$$;

-- No new hands: the table stays as it is after the current hand ends.
create or replace function public.tp_start_hand(t public.tp_tables) returns public.tp_tables
language plpgsql security definer set search_path = public as $$
begin
  raise exception 'New Teen Patti is live — refresh the app (pull down) to keep playing';
end;
$$;

revoke execute on function public.tp_start_hand(public.tp_tables) from public, anon, authenticated;

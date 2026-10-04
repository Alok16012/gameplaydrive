-- 016: Private Teen Patti tables on the Supabase engine take any boot from 1 to 10,000 coins (same as the realtime
-- game server). The Supabase engine is the fallback the app uses when the game server is down.
-- Public tables keep their fixed boots. Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.tp_create_private(p_boot bigint) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_boot is null or p_boot < 1 or p_boot > 10000 then raise exception 'Pick a boot between 1 and 10,000 coins'; end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from tp_tables where code = c) and not exists (select 1 from rm_tables where code = c);
  end loop;
  insert into tp_tables (boot, code) values (p_boot, c);
  perform public.tp_join(p_boot, c);
  return c;
end;
$$;

revoke execute on function public.tp_create_private(bigint) from public, anon;
grant execute on function public.tp_create_private(bigint) to authenticated;

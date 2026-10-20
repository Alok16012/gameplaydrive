-- 057: Allow custom private Rummy table stakes without the 10,000 cap.
-- Players can set any custom stake according to their choice (min 1 for points, min 10 for pool/deals).
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create or replace function public.rm_valid_private_stake(p_mode text, p_stake bigint, p_deals int) returns boolean
language sql immutable as $$
  select case when p_mode = 'points' then p_stake >= 1
              when p_mode in ('pool101', 'pool201') then p_stake >= 10
              when p_mode = 'deals' then p_stake >= 10 and p_deals in (2, 3)
              else false end;
$$;

create or replace function public.rm_create_private(p_mode text, p_stake bigint, p_deals int default 0, p_cards int default 13) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_mode <> 'deals' then p_deals := 0; end if;
  if p_cards not in (13, 21) then raise exception 'Invalid table'; end if;
  if not public.rm_valid_private_stake(p_mode, p_stake, p_deals) then
    raise exception '%', case when p_mode = 'points' then 'Pick at least 1 coin per point' else 'Pick an entry of at least 10 coins' end;
  end if;
  loop
    c := public.new_code();
    exit when not exists (select 1 from tp_tables where code = c) and not exists (select 1 from rm_tables where code = c);
  end loop;
  insert into rm_tables (mode, stake, deals, cards, code) values (p_mode, p_stake, p_deals, p_cards, c);
  perform public.rm_join(p_mode, p_stake, p_deals, c, p_cards);
  return c;
end;
$$;

revoke execute on function public.rm_create_private(text, bigint, int, int) from public, anon;
grant execute on function public.rm_create_private(text, bigint, int, int) to authenticated;

-- Also allow custom boots for Teen Patti private tables
create or replace function public.tp_create_private(p_boot bigint) returns text
language plpgsql security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_boot is null or p_boot < 1 then raise exception 'Pick a boot of at least 1 coin'; end if;
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

-- 082: Rummy — a deal counts as abandoned after 2 minutes, not 10.
--
-- Teen Patti and Poker give a seat up after a minute away; Rummy (081) waited ten minutes before ending a deal
-- nobody was polling, so a player back after 3-4 minutes still found the old deal waiting. The limit is now
-- two minutes, in one place (rm_away_limit), used by both the poll and the join path.
--
-- Safe to run more than once.

begin;

create or replace function public.rm_away_limit() returns interval language sql immutable as $$ select interval '2 minutes' $$;

create or replace function public.rm_abandon(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare i int; x jsonb;
begin
  if t.status <> 'playing' or t.turn_ends is null or t.turn_ends > now() - public.rm_away_limit() then return t; end if;
  for i in 0 .. jsonb_array_length(t.seats) - 1 loop
    x := t.seats -> i;
    if not (x ->> 'bot')::boolean and coalesce((x ->> 'playing')::boolean, false)
       and not coalesce((x ->> 'dropped')::boolean, false) and not coalesce((x ->> 'wrong')::boolean, false) then
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('dropped', true, 'middle', coalesce((x ->> 'turns')::int, 0) > 0, 'action', 'Away • dropped'));
      if t.mode <> 'points' and coalesce((x ->> 'in_match')::boolean, false) then
        t.seats := public.rm_seat_set(t.seats, i, '{"out": true}');
      end if;
    end if;
  end loop;
  return public.rm_finish_abandoned(t);
end;
$$;

create or replace function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null, p_cards int default 13, p_avoid uuid default null) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare t rm_tables;
begin
  begin
    for t in select * from rm_tables where auth.uid() = any (members) and status = 'playing' and turn_ends < now() - public.rm_away_limit() for update skip locked loop
      t := public.rm_abandon(t);
      perform public.rm_save(t);
    end loop;
    perform public.rm_sweep(5);
  exception when others then
    null; -- housekeeping must never stop a join
  end;
  return public.rm_join_base(p_mode, p_stake, p_deals, p_code, p_cards, p_avoid);
end;
$$;

revoke execute on function public.rm_away_limit(), public.rm_abandon(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_join(text, bigint, int, text, int, uuid) from public, anon;
grant execute on function public.rm_join(text, bigint, int, text, int, uuid) to authenticated;

commit;

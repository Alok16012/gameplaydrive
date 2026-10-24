-- 081: Rummy — a deal left alone for 10+ minutes is over when the player comes back, not resumed.
--
-- A Rummy table only moves while someone at it polls (rm_tick). A player who backs out mid-deal and returns hours
-- later found the same deal waiting for them, at the same turn: nothing had happened in between. The 076 sweep
-- finishes such deals, but only runs on joins, five oldest tables at a time, and skips a table whose player is
-- back (their ping is fresh again). Now the first poll or rejoin of a deal whose turn clock ran out more than ten
-- minutes ago ends it first: every real player still in it takes a middle drop (what three timeouts would have
-- given them), the best bot wins, and the buy-ins are settled. The player then sees the result and a fresh deal.
--
-- Safe to run more than once.

begin;

-- End a deal nobody has touched for ten minutes: the real players still in it are dropped, then it is settled.
create or replace function public.rm_abandon(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare i int; x jsonb;
begin
  if t.status <> 'playing' or t.turn_ends is null or t.turn_ends > now() - interval '10 minutes' then return t; end if;
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

-- Polling: settle an abandoned deal before anything else happens on the table.
create or replace function public.rm_tick(p_table uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t rm_tables;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then raise exception 'You are not at this table'; end if;
  t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = auth.uid()::text then v || jsonb_build_object('ping', now()) else v end order by i), '[]')
              from jsonb_array_elements(t.seats) with ordinality x(v, i));
  t := public.rm_abandon(t);
  t := public.rm_advance(t);
  perform public.rm_save(t);
  return public.rm_view(t);
end;
$$;

-- Joining / rejoining: the player's own abandoned deals are settled first, then the usual small sweep and join.
create or replace function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null, p_cards int default 13, p_avoid uuid default null) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare t rm_tables;
begin
  begin
    for t in select * from rm_tables where auth.uid() = any (members) and status = 'playing' and turn_ends < now() - interval '10 minutes' for update skip locked loop
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

revoke execute on function public.rm_abandon(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_tick(uuid), public.rm_join(text, bigint, int, text, int, uuid) from public, anon;
grant execute on function public.rm_tick(uuid), public.rm_join(text, bigint, int, text, int, uuid) to authenticated;

commit;

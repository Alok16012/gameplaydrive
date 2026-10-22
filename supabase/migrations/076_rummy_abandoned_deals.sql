-- 076: Rummy deals that every real player has left are finished at once, so buy-ins are settled.
--
-- A Rummy table only moves when one of its members calls rm_tick. When the last real player leaves (rm_leave) or
-- just closes the app mid-deal, nobody ticks any more: the deal stays "playing" for ever, rm_end_deal never runs,
-- and in Points mode the player's buy-in (80 × stake, held at the start of the deal) is never settled — they lose
-- all of it instead of the 20/40-point drop the rules charge. 272 such tables had piled up by 2026-10-22.
--
-- Now:
--   * rm_finish_abandoned(t): a deal with no real player still in it ends immediately — the bot with the best hand
--     is the winner, rm_end_deal settles everyone (held − loss back to the dropped players' wallets).
--   * rm_leave runs it after marking the leaver dropped.
--   * rm_sweep(n): finds deals whose turn ran out 10+ minutes ago with no real player seen in 10 minutes, treats the
--     vanished players as a middle drop (what three timeouts would have done) and finishes the deal. rm_join runs it
--     for a few tables on every join, so old tables clear themselves; it can also be run by hand:
--     select public.rm_sweep(1000);
--
-- Safe to run more than once. Runs as one transaction.

begin;

-- ============================================================================ finish a deal nobody real is in

create or replace function public.rm_finish_abandoned(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  n int := jsonb_array_length(t.seats); i int; x jsonb; active int[]; wild text; best int; best_pts int; pts int; hand jsonb;
begin
  if t.status <> 'playing' then return t; end if;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if not (x ->> 'bot')::boolean and coalesce((x ->> 'playing')::boolean, false)
       and not coalesce((x ->> 'dropped')::boolean, false) and not coalesce((x ->> 'wrong')::boolean, false) then
      return t; -- a real player is still in the deal: it plays on as usual
    end if;
  end loop;
  if n = 0 then
    -- No seats at all: nothing to settle, just stop the clock.
    t.status := 'waiting'; t.match_over := true; t.turn := null; t.phase := null; t.turn_ends := null; t.bot_acts_at := null; t.next_at := null;
    return t;
  end if;
  active := public.rm_active(t.seats);
  -- array_length of an empty array is null, not 0.
  if coalesce(array_length(active, 1), 0) = 0 then
    -- Everyone dropped or showed wrong (a private table with no bots, say). Someone has to be the deal's winner for
    -- rm_end_deal to settle it: a bot if there is one, else the player who dropped cheapest. The others are charged
    -- their drop points and get the rest of their buy-in back.
    select i2 - 1 into best from jsonb_array_elements(t.seats) with ordinality z(v, i2)
      where coalesce((v ->> 'playing')::boolean, false)
      order by (v ->> 'bot')::boolean desc nulls last,
               case when coalesce((v ->> 'wrong')::boolean, false) then 999 else public.rm_drop_pts(t.mode, coalesce((v ->> 'middle')::boolean, false)) end
      limit 1;
    best := coalesce(best, 0);
  elsif array_length(active, 1) = 1 then
    best := active[1];
  else
    wild := public.rm_wk(t);
    foreach i in array active loop
      select h.cards into hand from rm_hands h where h.table_id = t.id and h.seat = i;
      pts := coalesce((public.rm_best(hand, wild) ->> 'points')::int, 999);
      if best is null or pts < best_pts then best := i; best_pts := pts; end if;
    end loop;
  end if;
  t.seats := public.rm_seat_set(t.seats, best, '{"action": "Declared!"}');
  return public.rm_end_deal(t, best);
end;
$$;

-- ============================================================================ rm_leave: finish the deal if the leaver was the last real player

create or replace function public.rm_leave(p_table uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t rm_tables; me int;
begin
  select * into t from rm_tables where id = p_table and auth.uid() = any (members) for update;
  if not found then return; end if;
  t.queue := (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(t.queue) q where q ->> 'uid' <> auth.uid()::text);
  select i - 1 into me from jsonb_array_elements(t.seats) with ordinality x(v, i) where v ->> 'uid' = auth.uid()::text;
  if me is not null then
    t.seats := public.rm_seat_set(t.seats, me, '{"left": true}');
    -- Leaving mid-deal counts as a drop (and forfeits a Pool/Deals match).
    if t.status = 'playing' and me = any (public.rm_active(t.seats)) then
      if t.turn = me then t := public.rm_drop(t, me);
      else
        t.seats := public.rm_seat_set(t.seats, me, jsonb_build_object('dropped', true, 'middle', (t.seats -> me ->> 'turns')::int > 0, 'action', 'Left'));
        if array_length(public.rm_active(t.seats), 1) = 1 then t := public.rm_end_deal(t, (public.rm_active(t.seats))[1]); end if;
      end if;
    end if;
    if t.mode <> 'points' and coalesce((t.seats -> me ->> 'in_match')::boolean, false) then
      t.seats := public.rm_seat_set(t.seats, me, '{"out": true}');
    end if;
    -- Nobody real left in the deal: settle it now instead of leaving it hanging.
    t := public.rm_finish_abandoned(t);
  end if;
  perform public.rm_save(t);
end;
$$;

-- ============================================================================ sweep: deals whose real players vanished

create or replace function public.rm_sweep(p_limit int default 20) returns int
language plpgsql volatile security definer set search_path = public as $$
declare t rm_tables; i int; x jsonb; done int := 0;
begin
  for t in
    select * from rm_tables
    where status = 'playing' and turn_ends < now() - interval '10 minutes'
      and not exists (select 1 from jsonb_array_elements(seats) s
                      where not (s ->> 'bot')::boolean and coalesce((s ->> 'playing')::boolean, false)
                        and not coalesce((s ->> 'dropped')::boolean, false)
                        and (s ->> 'ping')::timestamptz > now() - interval '10 minutes')
    order by updated_at limit p_limit
    for update skip locked
  loop
    -- Real players still "in" the deal but gone: a middle drop, as three timeouts would have given them.
    for i in 0 .. jsonb_array_length(t.seats) - 1 loop
      x := t.seats -> i;
      if not (x ->> 'bot')::boolean and coalesce((x ->> 'playing')::boolean, false)
         and not coalesce((x ->> 'dropped')::boolean, false) and not coalesce((x ->> 'wrong')::boolean, false) then
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('dropped', true, 'middle', coalesce((x ->> 'turns')::int, 0) > 0, 'action', 'Left'));
        if t.mode <> 'points' and coalesce((x ->> 'in_match')::boolean, false) then
          t.seats := public.rm_seat_set(t.seats, i, '{"out": true}');
        end if;
      end if;
    end loop;
    t := public.rm_finish_abandoned(t);
    perform public.rm_save(t);
    done := done + 1;
  end loop;
  return done;
end;
$$;

-- rm_join runs a small sweep so abandoned tables clear themselves over time.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rm_join_base') then
    alter function public.rm_join(text, bigint, int, text, int, uuid) rename to rm_join_base;
  end if;
end $$;

create or replace function public.rm_join(p_mode text, p_stake bigint, p_deals int default 0, p_code text default null, p_cards int default 13, p_avoid uuid default null) returns uuid
language plpgsql volatile security definer set search_path = public as $$
begin
  begin
    perform public.rm_sweep(5);
  exception when others then
    null; -- a sweep problem must never stop a join
  end;
  return public.rm_join_base(p_mode, p_stake, p_deals, p_code, p_cards, p_avoid);
end;
$$;

-- ============================================================================ permissions

revoke execute on function public.rm_finish_abandoned(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_sweep(int) from public, anon, authenticated;
revoke execute on function public.rm_join_base(text, bigint, int, text, int, uuid) from public, anon, authenticated;
revoke execute on function public.rm_join(text, bigint, int, text, int, uuid), public.rm_leave(uuid) from public, anon;
grant execute on function public.rm_join(text, bigint, int, text, int, uuid), public.rm_leave(uuid) to authenticated;

commit;

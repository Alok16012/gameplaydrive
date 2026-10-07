-- 029: Ludo with friends — a player who misses three turns in a row is out. The table plays a missed turn for
-- them (roll and the best move) the first two times; on the third miss in a row they give the game up, their
-- tokens leave the board, and if only one player is left that player wins the pot. Any roll or move of their
-- own resets the count. Safe to run more than once. Run after 028.

create or replace function public.ld_auto(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare s int := t.turn; m int; still int[];
begin
  m := coalesce((t.seats -> s ->> 'misses')::int, 0) + 1;
  t.seats := jsonb_set(t.seats, array[s::text, 'misses'], to_jsonb(m));
  if coalesce((t.seats -> s ->> 'left')::boolean, false) then return public.ld_next(t); end if;
  if m >= 3 then
    t.seats := jsonb_set(t.seats, array[s::text, 'left'], 'true');
    t.last := jsonb_build_object('kind', 'left', 'seat', s, 'why', 'missed 3 turns');
    select array_agg((i - 1)::int) into still from jsonb_array_elements(t.seats) with ordinality x(e, i)
      where not coalesce((e ->> 'left')::boolean, false);
    if cardinality(still) = 1 then return public.ld_finish(t, still[1]); end if;
    return public.ld_next(t);
  end if;
  if t.phase = 'roll' then t := public.ld_roll(t); end if;
  if t.status = 'playing' and t.phase = 'move' and t.turn = s then t := public.ld_move(t, public.ld_best(t)); end if;
  return t;
end;
$$;
revoke execute on function public.ld_auto(public.ld_tables) from public, anon, authenticated;

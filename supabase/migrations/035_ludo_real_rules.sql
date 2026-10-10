-- 035: Ludo with friends — play by the real rules, and a game left behind is over when you come back.
--   • Three 6s *in a row* lose the turn: any other number breaks the run (before, a 6, 6, then a capture bonus
--     roll and another 6 counted as three).
--   • When the table plays a turn for someone (their 20 s ran out), it picks a token the way a player would:
--     a capture, then getting a token home, then bringing a new token out on a 6, getting out of reach / onto a
--     safe square, and only then the token that is furthest along. Before, it always pushed the furthest token,
--     so on a 6 the one token already out kept moving and the others never left the yard.
--   • A game nobody was at: if everyone closed the app, the turns that ran out since are played one after another
--     on their own 20 s clocks when anyone comes back. Three missed turns put a player out (029), so a game left for
--     hours is finished by then (the last player in wins the pot) instead of carrying on where it stopped.
-- Safe to run more than once. Run after 029_ludo_three_misses.sql.

-- Is square a (absolute track index) one an opponent of seat s could land on with their next roll?
create or replace function public.ld_threat(t public.ld_tables, s int, a int) returns boolean language sql immutable as $$
  select a >= 0 and not public.ld_safe(a) and exists (
    select 1
    from generate_series(0, jsonb_array_length(t.seats) - 1) q, generate_series(0, 3) j,
      lateral (select (t.seats -> q ->> 'colour')::int c, (t.seats -> q -> 'tokens' ->> j)::int p) x,
      lateral (select (a - public.ld_abs(x.c, x.p) + 52) % 52 gap) g
    where q <> s and not coalesce((t.seats -> q ->> 'left')::boolean, false)
      and x.p between 0 and 50 and g.gap between 1 and 6 and x.p + g.gap <= 50);
$$;

-- Is there an opponent of seat s on square a that landing there would capture?
create or replace function public.ld_hit(t public.ld_tables, s int, a int) returns boolean language sql immutable as $$
  select a >= 0 and not public.ld_safe(a) and exists (
    select 1
    from generate_series(0, jsonb_array_length(t.seats) - 1) q, generate_series(0, 3) j
    where q <> s and not coalesce((t.seats -> q ->> 'left')::boolean, false)
      and public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a);
$$;

-- The move a sensible player makes for the player to move (see the notes at the top).
create or replace function public.ld_best(t public.ld_tables) returns int language plpgsql volatile as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; d int := t.dice;
        i int; p int; to_p int; a int; sc numeric; best int; best_sc numeric := -1e9; out_n int;
begin
  select count(*) into out_n from jsonb_array_elements_text(t.seats -> s -> 'tokens') x where x::int between 0 and 55;
  foreach i in array public.ld_movable(t, s, d) loop
    p := (t.seats -> s -> 'tokens' ->> i)::int;
    to_p := case when p = -1 then 0 else p + d end;
    a := public.ld_abs(c, to_p);
    sc := to_p / 10.0 + random() * 8;
    if public.ld_hit(t, s, a) then sc := sc + 100; end if;
    if to_p = 56 then sc := sc + 80; end if;
    if p = -1 then sc := sc + 60 - 10 * out_n; end if;
    if to_p between 51 and 55 then sc := sc + 30; end if;
    if a >= 0 and public.ld_safe(a) then sc := sc + 15; end if;
    if p between 0 and 50 and public.ld_threat(t, s, public.ld_abs(c, p)) and not public.ld_threat(t, s, a) then sc := sc + 40; end if;
    if public.ld_threat(t, s, a) then sc := sc - 45; end if;
    if sc > best_sc then best_sc := sc; best := i; end if;
  end loop;
  return best;
end;
$$;

-- Roll for the player to move. No move possible or a third 6 in a row: the turn passes. A single possible move is made.
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare d int := 1 + floor(random() * 6)::int; opts int[];
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;
  t.dice := d;
  if d = 6 then t.sixes := t.sixes + 1; else t.sixes := 0; end if;
  if t.sixes >= 3 then
    t.last := jsonb_build_object('kind', 'skip', 'seat', t.turn, 'dice', d, 'why', 'three sixes');
    return public.ld_next(t);
  end if;
  opts := public.ld_movable(t, t.turn, d);
  if cardinality(opts) = 0 then
    t.last := jsonb_build_object('kind', 'nomove', 'seat', t.turn, 'dice', d);
    return public.ld_next(t);
  end if;
  t.phase := 'move';
  t.last := jsonb_build_object('kind', 'roll', 'seat', t.turn, 'dice', d);
  t.turn_ends := greatest(t.turn_ends, now() + interval '10 seconds');
  if cardinality(opts) = 1 then return public.ld_move(t, opts[1]); end if;
  return t;
end;
$$;

-- Anyone at the table: run the clock and get the table. Each turn that ran out is played for that player, on the
-- clock it would have had — so after a long time away every missed turn is played, not just one.
create or replace function public.ld_tick(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; guard int := 0; due timestamptz;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  while t.status = 'playing' and t.turn_ends <= now() and guard < 60 loop
    due := t.turn_ends;
    t := public.ld_auto(t);
    if t.status = 'playing' and t.turn_ends is not null then t.turn_ends := least(t.turn_ends, due + interval '20 seconds'); end if;
    guard := guard + 1;
  end loop;
  if guard > 0 then perform public.ld_save(t); select * into t from ld_tables where id = p_table; end if;
  return public.ld_view(t);
end;
$$;

revoke execute on function public.ld_threat(public.ld_tables, int, int), public.ld_hit(public.ld_tables, int, int),
  public.ld_best(public.ld_tables), public.ld_roll(public.ld_tables) from public, anon, authenticated;
revoke execute on function public.ld_tick(uuid) from public, anon;
grant execute on function public.ld_tick(uuid) to authenticated;

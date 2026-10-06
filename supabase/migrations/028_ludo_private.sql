-- 028: Ludo private tables — play with friends by invite code, run entirely by the database.
--   • The host creates a table for 2 or 4 players with an entry (coins). Friends join with the 6-character code;
--     everyone's entry goes into the pot. The game starts as soon as the table is full. No bots.
--   • The database rolls every dice and checks every move. Rules are the app's Ludo rules: a 6 brings a token out,
--     three 6s in a row lose the turn, landing on an opponent (off the star squares) sends it home, and a 6, a
--     capture or reaching home earns another roll. First to bring all four tokens home wins the pot (less the
--     platform fee from Game Config → Ludo).
--   • Each turn has 20 s. When it runs out the table plays for that player (rolls, and makes the best move).
--   • Leaving before the start returns the entry. Leaving a running game gives it up; if only one player is left,
--     they win.
--   • Seats on the board: 2 players are red and yellow (across from each other); 4 players are red, green,
--     yellow, blue in the order they joined.
-- Safe to run more than once. Run it in the Supabase SQL Editor (after 018).

create table if not exists public.ld_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  entry bigint not null check (entry >= 0),
  max_players int not null check (max_players in (2, 4)),
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'done', 'cancelled')),
  seats jsonb not null default '[]',   -- [{uid, name, emoji, colour 0-3, tokens [4 × progress], left, misses}]
  turn int,                            -- index into seats
  phase text,                          -- 'roll' | 'move'
  dice int,
  sixes int not null default 0,
  turn_ends timestamptz,
  winner int,
  pot bigint not null default 0,
  prize bigint not null default 0,
  last jsonb,                          -- the last thing that happened, for the table to show
  seq int not null default 0,          -- bumps on every change
  members uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ld_tables_members_idx on public.ld_tables using gin (members);
alter table public.ld_tables enable row level security;
revoke all on public.ld_tables from anon, authenticated;
grant select on public.ld_tables to authenticated;
drop policy if exists "members see their ludo table" on public.ld_tables;
create policy "members see their ludo table" on public.ld_tables for select to authenticated using (auth.uid() = any (members));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ld_tables') then
    alter publication supabase_realtime add table public.ld_tables;
  end if;
exception when undefined_object then null; -- no realtime publication (local test database)
end $$;

-- progress per token: -1 yard, 0..50 common track, 51..55 home column, 56 home.
create or replace function public.ld_abs(p_colour int, p_prog int) returns int language sql immutable as $$
  select case when p_prog between 0 and 50 then ((array[0, 13, 26, 39])[p_colour + 1] + p_prog) % 52 else -1 end;
$$;
create or replace function public.ld_safe(p_abs int) returns boolean language sql immutable as $$
  select p_abs = any (array[0, 8, 13, 21, 26, 34, 39, 47]);
$$;

create or replace function public.ld_fee() returns numeric language sql stable security definer set search_path = public as $$
  select least(25, greatest(0, coalesce((public.game_cfg('ludo') ->> 'rake')::numeric, 10))) / 100;
$$;

-- Tokens of seat s that can move d squares.
create or replace function public.ld_movable(t public.ld_tables, s int, d int) returns int[] language sql immutable as $$
  select coalesce(array_agg(i order by i), '{}')
  from generate_series(0, 3) i, lateral (select (t.seats -> s -> 'tokens' ->> i)::int p) x
  where (x.p = -1 and d = 6) or (x.p >= 0 and x.p + d <= 56);
$$;

create or replace function public.ld_save(t public.ld_tables) returns void language sql volatile security definer set search_path = public as $$
  update ld_tables set status = t.status, seats = t.seats, turn = t.turn, phase = t.phase, dice = t.dice, sixes = t.sixes,
    turn_ends = t.turn_ends, winner = t.winner, pot = t.pot, prize = t.prize, last = t.last, members = t.members,
    seq = t.seq + 1, updated_at = now()
  where id = t.id;
$$;

create or replace function public.ld_view(t public.ld_tables) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me int;
begin
  select (i - 1)::int into me from jsonb_array_elements(t.seats) with ordinality x(s, i) where s ->> 'uid' = auth.uid()::text;
  return jsonb_build_object(
    'id', t.id, 'code', t.code, 'entry', t.entry, 'max_players', t.max_players, 'status', t.status,
    'seats', (select coalesce(jsonb_agg(s - 'uid' || jsonb_build_object('me', s ->> 'uid' = auth.uid()::text) order by i), '[]')
              from jsonb_array_elements(t.seats) with ordinality x(s, i)),
    'me', me, 'turn', t.turn, 'phase', t.phase, 'dice', t.dice, 'turn_ends', t.turn_ends, 'winner', t.winner,
    'pot', t.pot, 'prize', t.prize, 'fee', public.ld_fee(), 'last', t.last, 'seq', t.seq, 'server_now', now());
end;
$$;

-- Hand the turn to the next player still at the table.
create or replace function public.ld_next(t public.ld_tables) returns public.ld_tables language plpgsql volatile as $$
declare n int := jsonb_array_length(t.seats); k int;
begin
  for k in 1 .. n loop
    t.turn := (t.turn + 1) % n;
    exit when not coalesce((t.seats -> t.turn ->> 'left')::boolean, false);
  end loop;
  t.phase := 'roll'; t.dice := null; t.sixes := 0;
  t.turn_ends := now() + interval '20 seconds';
  return t;
end;
$$;

-- Pay the winner and close the table.
create or replace function public.ld_finish(t public.ld_tables, w int) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
begin
  t.status := 'done'; t.winner := w; t.phase := null; t.turn_ends := null;
  t.prize := floor(t.pot * (1 - public.ld_fee()));
  if t.prize > 0 then
    perform public.wallet_move((t.seats -> w ->> 'uid')::uuid, t.prize, 'win', 'Ludo • Private ' || t.code);
  end if;
  return t;
end;
$$;

-- Move token i of the player to move by the dice; captures, home, bonus roll or next turn.
create or replace function public.ld_move(t public.ld_tables, i int) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; d int := t.dice;
        from_p int := (t.seats -> t.turn -> 'tokens' ->> i)::int; to_p int; a int; q int; j int; caught jsonb := '[]'; bonus boolean;
begin
  if t.phase <> 'move' or not (i = any (public.ld_movable(t, s, d))) then raise exception 'That token can''t move'; end if;
  to_p := case when from_p = -1 then 0 else from_p + d end;
  t.seats := jsonb_set(t.seats, array[s::text, 'tokens', i::text], to_jsonb(to_p));
  a := public.ld_abs(c, to_p);
  if a >= 0 and not public.ld_safe(a) then
    for q in 0 .. jsonb_array_length(t.seats) - 1 loop
      continue when q = s or coalesce((t.seats -> q ->> 'left')::boolean, false);
      for j in 0 .. 3 loop
        if public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a then
          t.seats := jsonb_set(t.seats, array[q::text, 'tokens', j::text], '-1');
          caught := caught || jsonb_build_array(jsonb_build_object('seat', q, 'token', j));
        end if;
      end loop;
    end loop;
  end if;
  t.last := jsonb_build_object('kind', 'move', 'seat', s, 'token', i, 'from', from_p, 'to', to_p, 'dice', d, 'caught', caught);
  if (select bool_and(x::int = 56) from jsonb_array_elements_text(t.seats -> s -> 'tokens') x) then
    return public.ld_finish(t, s);
  end if;
  bonus := d = 6 or jsonb_array_length(caught) > 0 or to_p = 56;
  if bonus then
    t.phase := 'roll'; t.dice := null; t.turn_ends := now() + interval '20 seconds';
  else
    t := public.ld_next(t);
  end if;
  return t;
end;
$$;

-- The best move for the player to move: a capture if there is one, otherwise the most advanced token.
create or replace function public.ld_best(t public.ld_tables) returns int language plpgsql stable as $$
declare s int := t.turn; c int := (t.seats -> t.turn ->> 'colour')::int; i int; p int; a int; best int; bestp int := -2; q int; j int;
begin
  foreach i in array public.ld_movable(t, s, t.dice) loop
    p := (t.seats -> s -> 'tokens' ->> i)::int;
    a := public.ld_abs(c, case when p = -1 then 0 else p + t.dice end);
    if a >= 0 and not public.ld_safe(a) then
      for q in 0 .. jsonb_array_length(t.seats) - 1 loop
        continue when q = s or coalesce((t.seats -> q ->> 'left')::boolean, false);
        for j in 0 .. 3 loop
          if public.ld_abs((t.seats -> q ->> 'colour')::int, (t.seats -> q -> 'tokens' ->> j)::int) = a then return i; end if;
        end loop;
      end loop;
    end if;
    if p > bestp then bestp := p; best := i; end if;
  end loop;
  return best;
end;
$$;

-- Roll for the player to move. No move possible or a third 6: the turn passes. A single possible move is made.
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare d int := 1 + floor(random() * 6)::int; opts int[];
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;
  t.dice := d;
  if d = 6 then t.sixes := t.sixes + 1; end if;
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

-- Time ran out for the player to move: the table plays for them.
create or replace function public.ld_auto(t public.ld_tables) returns public.ld_tables language plpgsql volatile security definer set search_path = public as $$
declare s int := t.turn;
begin
  t.seats := jsonb_set(t.seats, array[s::text, 'misses'], to_jsonb(coalesce((t.seats -> s ->> 'misses')::int, 0) + 1));
  if coalesce((t.seats -> s ->> 'left')::boolean, false) then return public.ld_next(t); end if;
  if t.phase = 'roll' then t := public.ld_roll(t); end if;
  if t.status = 'playing' and t.phase = 'move' and t.turn = s then t := public.ld_move(t, public.ld_best(t)); end if;
  return t;
end;
$$;

create or replace function public.ld_code() returns text language plpgsql volatile as $$
declare c text; chars text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    c := (select string_agg(substr(chars, 1 + floor(random() * length(chars))::int, 1), '') from generate_series(1, 6));
    exit when not exists (select 1 from ld_tables where code = c);
  end loop;
  return c;
end;
$$;

create or replace function public.ld_seat(me profiles, colour int) returns jsonb language sql stable as $$
  select jsonb_build_object('uid', me.id, 'name', me.name, 'emoji', '🧑🏽', 'colour', colour, 'tokens', '[-1,-1,-1,-1]'::jsonb, 'left', false, 'misses', 0);
$$;

-- Host: create a private table and pay the entry. Returns the invite code.
create or replace function public.ld_create_private(p_entry bigint, p_players int default 4) returns text
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); c text := public.ld_code(); t ld_tables;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_players not in (2, 4) then raise exception 'A table is for 2 or 4 players'; end if;
  if p_entry < 10 or p_entry > 100000 then raise exception 'Entry between 10 and 1,00,000 coins'; end if;
  insert into ld_tables (code, entry, max_players, seats, members, pot)
    values (c, p_entry, p_players, jsonb_build_array(public.ld_seat(me, 0)), array[me.id], p_entry) returning * into t;
  if public.wallet_move(me.id, -p_entry, 'bet', 'Ludo • Private ' || c || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  return c;
end;
$$;

-- Join a table by code (or come back to the one you're at). Returns the table id. A full table starts.
create or replace function public.ld_join(p_code text) returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); t ld_tables; n int; colours int[];
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into t from ld_tables where code = upper(trim(p_code)) and status <> 'cancelled' order by created_at desc limit 1 for update;
  if t.id is null then raise exception 'No table with that code'; end if;
  if me.id = any (t.members) then return t.id; end if;
  if t.status <> 'waiting' then raise exception 'This game has already started'; end if;
  n := jsonb_array_length(t.seats);
  if n >= t.max_players then raise exception 'This table is full'; end if;
  if public.wallet_move(me.id, -t.entry, 'bet', 'Ludo • Private ' || t.code || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  colours := case when t.max_players = 2 then array[0, 2] else array[0, 1, 2, 3] end;
  t.seats := t.seats || jsonb_build_array(public.ld_seat(me, colours[n + 1]));
  t.members := t.members || me.id;
  t.pot := t.pot + t.entry;
  if n + 1 = t.max_players then
    t.status := 'playing';
    t.turn := floor(random() * t.max_players)::int; -- who starts is drawn at random
    t.phase := 'roll'; t.dice := null; t.sixes := 0;
    t.turn_ends := now() + interval '23 seconds';
    t.last := jsonb_build_object('kind', 'start', 'seat', t.turn);
  else
    t.last := jsonb_build_object('kind', 'joined', 'seat', n);
  end if;
  perform public.ld_save(t);
  return t.id;
end;
$$;

-- Roll, or move a token (p_token 0-3), on your turn.
create or replace function public.ld_act(p_table uuid, p_action text, p_token int default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  if t.status <> 'playing' then raise exception 'The game is not running'; end if;
  if t.seats -> t.turn ->> 'uid' <> auth.uid()::text then raise exception 'Not your turn'; end if;
  t.seats := jsonb_set(t.seats, array[t.turn::text, 'misses'], '0');
  if p_action = 'roll' then t := public.ld_roll(t);
  elsif p_action = 'move' then t := public.ld_move(t, p_token);
  else raise exception 'Unknown action'; end if;
  perform public.ld_save(t);
  return public.ld_view(t);
end;
$$;

-- Anyone at the table: run the clock (a turn that has run out is played for that player) and get the table.
create or replace function public.ld_tick(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; guard int := 0;
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  while t.status = 'playing' and t.turn_ends <= now() and guard < 8 loop
    t := public.ld_auto(t);
    guard := guard + 1;
  end loop;
  if guard > 0 then perform public.ld_save(t); select * into t from ld_tables where id = p_table; end if;
  return public.ld_view(t);
end;
$$;

create or replace function public.ld_state(p_table uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t ld_tables;
begin
  select * into t from ld_tables where id = p_table;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  return public.ld_view(t);
end;
$$;

-- Leave: before the start the entry comes back; during a game it is given up (the last one left wins).
create or replace function public.ld_leave(p_table uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare t ld_tables; s int; still int[];
begin
  select * into t from ld_tables where id = p_table for update;
  if t.id is null or not (auth.uid() = any (t.members)) then raise exception 'Not your table'; end if;
  select (i - 1)::int into s from jsonb_array_elements(t.seats) with ordinality x(e, i) where e ->> 'uid' = auth.uid()::text;
  if t.status = 'waiting' then
    perform public.wallet_move(auth.uid(), t.entry, 'refund', 'Ludo • Private ' || t.code || ' • Entry returned');
    t.seats := t.seats - s;
    -- keep colours in join order for the seats that are left
    t.seats := (select coalesce(jsonb_agg(e || jsonb_build_object('colour', (case when t.max_players = 2 then array[0, 2] else array[0, 1, 2, 3] end)[i]) order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(e, i));
    t.members := array_remove(t.members, auth.uid());
    t.pot := t.pot - t.entry;
    if jsonb_array_length(t.seats) = 0 then t.status := 'cancelled'; end if;
    t.last := jsonb_build_object('kind', 'left', 'name', (select name from profiles where id = auth.uid()));
  elsif t.status = 'playing' then
    t.seats := jsonb_set(t.seats, array[s::text, 'left'], 'true');
    t.last := jsonb_build_object('kind', 'left', 'seat', s);
    select array_agg((i - 1)::int) into still from jsonb_array_elements(t.seats) with ordinality x(e, i) where not coalesce((e ->> 'left')::boolean, false);
    if cardinality(still) = 1 then t := public.ld_finish(t, still[1]);
    elsif t.turn = s then t := public.ld_next(t); end if;
  end if;
  perform public.ld_save(t);
  return public.ld_view(t);
end;
$$;

revoke execute on function public.ld_save(public.ld_tables), public.ld_view(public.ld_tables), public.ld_next(public.ld_tables),
  public.ld_finish(public.ld_tables, int), public.ld_move(public.ld_tables, int), public.ld_best(public.ld_tables),
  public.ld_roll(public.ld_tables), public.ld_auto(public.ld_tables), public.ld_seat(public.profiles, int) from public, anon, authenticated;
revoke execute on function public.ld_create_private(bigint, int), public.ld_join(text), public.ld_act(uuid, text, int),
  public.ld_tick(uuid), public.ld_state(uuid), public.ld_leave(uuid) from public, anon;
grant execute on function public.ld_create_private(bigint, int), public.ld_join(text), public.ld_act(uuid, text, int),
  public.ld_tick(uuid), public.ld_state(uuid), public.ld_leave(uuid) to authenticated;

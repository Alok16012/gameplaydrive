-- 109: Chess with a friend — private tables played between two real players.
--
-- The host creates a table with an entry (charged now) and gets a 6-character code; the friend joins with the code
-- (entry charged), colours are drawn at random and the game starts: 10 minutes a side. Moves are checked on our
-- server (/api/chess/move, the same chess rules as the computer games) and written with ch_apply; the server also
-- ends a game when a clock runs out (/api/chess/state). The winner gets both entries less the platform fee (Game
-- Config → Chess, default 10%); a draw returns each entry. Leaving before the friend joins returns the entry;
-- leaving a game in progress resigns it.

create table if not exists public.ch_tables (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  entry bigint not null,
  status text not null default 'waiting' check (status in ('waiting', 'playing', 'done', 'cancelled')),
  host uuid not null references public.profiles (id),
  guest uuid references public.profiles (id),
  white uuid,
  black uuid,
  names jsonb not null default '{}',
  pos jsonb,
  moves jsonb not null default '[]',
  hist jsonb not null default '[]',
  last jsonb,
  clock_w integer not null default 600000,
  clock_b integer not null default 600000,
  turn_since timestamptz,
  winner uuid,
  result text,
  reason text,
  prize bigint,
  seq integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ch_tables_code_idx on public.ch_tables (code, created_at desc);
alter table public.ch_tables enable row level security;
revoke all on public.ch_tables from anon, authenticated;

create or replace function public.ch_label(t ch_tables) returns text language sql immutable as $$
  select 'Chess • Private ' || t.code;
$$;

/** Ends a game: the winner takes both entries less the fee; no winner = a draw, each entry back. */
create or replace function public.ch_settle(t ch_tables, p_winner uuid, p_reason text)
returns ch_tables
language plpgsql
security definer
set search_path to 'public'
as $$
declare fee numeric := least(25, greatest(0, coalesce((public.game_cfg('chess') ->> 'rake')::numeric, 10)));
begin
  if t.status <> 'playing' then return t; end if;
  if p_winner is null then
    perform public.wallet_move(t.white, t.entry, 'refund', public.ch_label(t) || ' • Draw — entry returned');
    perform public.wallet_move(t.black, t.entry, 'refund', public.ch_label(t) || ' • Draw — entry returned');
    t.result := 'draw'; t.prize := 0;
  else
    t.prize := floor(2 * t.entry * (1 - fee / 100));
    perform public.wallet_move(p_winner, t.prize, 'win', public.ch_label(t) || ' • Won');
    t.result := 'win';
  end if;
  t.winner := p_winner; t.reason := p_reason; t.status := 'done';
  t.seq := t.seq + 1; t.updated_at := now();
  update ch_tables set status = t.status, winner = t.winner, result = t.result, reason = t.reason, prize = t.prize, seq = t.seq, updated_at = t.updated_at,
    clock_w = t.clock_w, clock_b = t.clock_b
  where id = t.id;
  return t;
end;
$$;

create or replace function public.ch_create_private(p_entry bigint)
returns text
language plpgsql
security definer
set search_path to 'public'
as $$
declare me profiles := public.current_profile(); c text;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can create tables'; end if;
  if p_entry < 10 or p_entry > 100000 then raise exception 'Entry between 10 and 1,00,000 coins'; end if;
  perform public.game_guard('chess', p_entry, false);
  perform public.check_bet_room(me.id, p_entry);
  loop
    c := public.new_code();
    exit when not exists (select 1 from ch_tables where code = c and status in ('waiting', 'playing'));
  end loop;
  if public.wallet_move(me.id, -p_entry, 'bet', 'Chess • Private ' || c || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  insert into ch_tables (code, entry, host, names) values (c, p_entry, me.id, jsonb_build_object(me.id::text, me.name));
  return c;
end;
$$;

create or replace function public.ch_join(p_code text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare me profiles := public.current_profile(); t ch_tables;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into t from ch_tables where code = upper(trim(p_code)) and status <> 'cancelled' order by created_at desc limit 1 for update;
  if t.id is null then raise exception 'No table with that code'; end if;
  if me.id in (t.host, t.guest) then return t.id; end if;
  if t.status <> 'waiting' or t.guest is not null then raise exception 'This game has already started'; end if;
  perform public.check_bet_room(me.id, t.entry);
  if public.wallet_move(me.id, -t.entry, 'bet', public.ch_label(t) || ' • Entry') is null then raise exception 'Not enough coins for the entry'; end if;
  if random() < 0.5 then t.white := t.host; t.black := me.id; else t.white := me.id; t.black := t.host; end if;
  update ch_tables set guest = me.id, white = t.white, black = t.black, status = 'playing',
    names = names || jsonb_build_object(me.id::text, me.name),
    pos = '{"board":[["r","n","b","q","k","b","n","r"],["p","p","p","p","p","p","p","p"],[".",".",".",".",".",".",".","."],[".",".",".",".",".",".",".","."],[".",".",".",".",".",".",".","."],[".",".",".",".",".",".",".","."],["P","P","P","P","P","P","P","P"],["R","N","B","Q","K","B","N","R"]],"turn":"w","castle":{"K":true,"Q":true,"k":true,"q":true},"ep":null,"half":0}',
    turn_since = now() + interval '3 seconds', -- a moment to see the board before White's clock runs
    seq = seq + 1, updated_at = now()
  where id = t.id;
  return t.id;
end;
$$;

/** Leave: before the friend joins, the table closes and the entry comes back; during a game, you resign. */
create or replace function public.ch_leave(p_table uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare t ch_tables;
begin
  select * into t from ch_tables where id = p_table for update;
  if t.id is null or auth.uid() not in (t.host, coalesce(t.guest, t.host)) then raise exception 'Not your table'; end if;
  if t.status = 'waiting' then
    perform public.wallet_move(t.host, t.entry, 'refund', public.ch_label(t) || ' • Entry returned');
    update ch_tables set status = 'cancelled', seq = seq + 1, updated_at = now() where id = t.id;
  elsif t.status = 'playing' then
    perform public.ch_settle(t, case when auth.uid() = t.white then t.black else t.white end, 'resigned');
  end if;
end;
$$;

/** A checked move from the server (service role): written only if nobody moved in between (seq), and the game
 *  ended in the same step when the move finished it (p_end: 'win' for the mover, 'draw', or null). */
create or replace function public.ch_apply(p_table uuid, p_seq integer, p_pos jsonb, p_moves jsonb, p_hist jsonb, p_last jsonb,
                                           p_clock_w integer, p_clock_b integer, p_end text default null, p_reason text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare t ch_tables; mover uuid;
begin
  select * into t from ch_tables where id = p_table for update;
  if t.id is null or t.status <> 'playing' or t.seq <> p_seq then return false; end if;
  mover := case when (t.pos ->> 'turn') = 'w' then t.white else t.black end;
  update ch_tables set pos = p_pos, moves = p_moves, hist = p_hist, last = p_last, clock_w = p_clock_w, clock_b = p_clock_b,
    turn_since = now(), seq = seq + 1, updated_at = now()
  where id = t.id returning * into t;
  if p_end = 'win' then perform public.ch_settle(t, mover, p_reason);
  elsif p_end = 'draw' then perform public.ch_settle(t, null, p_reason); end if;
  return true;
end;
$$;

/** A clock ran out (checked by the server): the side to move loses. */
create or replace function public.ch_timeout(p_table uuid, p_seq integer)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare t ch_tables;
begin
  select * into t from ch_tables where id = p_table for update;
  if t.id is null or t.status <> 'playing' or t.seq <> p_seq then return; end if;
  if (t.pos ->> 'turn') = 'w' then t.clock_w := 0; else t.clock_b := 0; end if;
  perform public.ch_settle(t, case when (t.pos ->> 'turn') = 'w' then t.black else t.white end, 'time');
end;
$$;

revoke all on function public.ch_settle(ch_tables, uuid, text) from public, anon, authenticated;
revoke all on function public.ch_apply(uuid, integer, jsonb, jsonb, jsonb, jsonb, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.ch_timeout(uuid, integer) from public, anon, authenticated;
revoke all on function public.ch_create_private(bigint) from public, anon;
revoke all on function public.ch_join(text) from public, anon;
revoke all on function public.ch_leave(uuid) from public, anon;
grant execute on function public.ch_create_private(bigint) to authenticated;
grant execute on function public.ch_join(text) to authenticated;
grant execute on function public.ch_leave(uuid) to authenticated;
notify pgrst, 'reload schema';

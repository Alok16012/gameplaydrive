-- 023: Stock Market (Up / Down), run on the database clock. Replaces Carrom in the app.
--
-- One shared round at a time for everyone:
--   betting  10 s before starts_at — put chips on UP and / or DOWN (or clear them)
--   live     20 s from starts_at; the market moves one tick every 0.25 s (80 ticks)
--   closed   at ends_at; open positions are paid at the closing price and the next round opens 4 s later
-- The whole price path is drawn when the round is created and kept secret: players only ever receive the
-- ticks up to the database clock (the tables have row-level security on and no policies).
--
-- Price: P starts at 1.00 (shown as 0%). Each tick moves it by ±s with equal odds, s ≈ 5% (sometimes a jump),
-- shrunk near the edges so P stays inside (0, 2). That makes P a fair martingale: no cash-out timing changes the
-- expected value.
--   UP   position is worth  stake × P
--   DOWN position is worth  stake × (2 − P)
-- Cash out any time while the market is live (the whole portfolio, at the current tick), or let it ride to the
-- close. Every payout keeps the platform fee (admin "Platform fee %", default 1%).
--
-- Safe to run more than once. Run it in the Supabase SQL Editor after 022.

create table if not exists public.sm_rounds (
  id bigint generated always as identity primary key,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  path numeric(8, 4)[] not null, -- 81 prices: tick 0 (= 1.0000) … tick 80 (close)
  settled boolean not null default false
);
create index if not exists sm_rounds_open_idx on public.sm_rounds (settled) where not settled;

create table if not exists public.sm_bets (
  id bigint generated always as identity primary key,
  round_id bigint not null references public.sm_rounds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  side text not null check (side in ('up', 'down')),
  amount bigint not null check (amount > 0),
  cash_tick int,          -- tick the position was closed at (80 = held to the close)
  payout bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (round_id, user_id, side)
);
create index if not exists sm_bets_round_idx on public.sm_bets (round_id);

alter table public.sm_rounds enable row level security;
alter table public.sm_bets enable row level security;
revoke all on public.sm_rounds, public.sm_bets from anon, authenticated;

-- Fee kept from every payout, as a fraction.
create or replace function public.sm_fee() returns numeric language sql stable security definer set search_path = public as $$
  select least(25, greatest(0, coalesce((public.game_cfg('stock-market') ->> 'rake')::numeric, 1))) / 100;
$$;

-- Current tick of a round (0 before the open, 80 after the close).
create or replace function public.sm_tick(r public.sm_rounds) returns int language sql stable as $$
  select least(80, greatest(0, floor(extract(epoch from (now() - r.starts_at)) / 0.25)::int));
$$;

-- What a player's positions are worth at price p (before the fee).
create or replace function public.sm_value(p_side text, p_amount bigint, p numeric) returns numeric language sql immutable as $$
  select case when p_side = 'up' then p_amount * p else p_amount * (2 - p) end;
$$;

-- Current round; opens the next one once the last has closed and its 4 s pause is over.
create or replace function public.sm_round() returns public.sm_rounds
language plpgsql volatile security definer set search_path = public as $$
declare r sm_rounds; p numeric := 1; s numeric; v_path numeric[] := array[1.0]; i int;
begin
  perform pg_advisory_xact_lock(7788023);
  select * into r from sm_rounds order by id desc limit 1;
  if r.id is null or now() > r.ends_at + interval '4 seconds' then
    for i in 1..80 loop
      s := 0.035 * (0.3 + 1.4 * random());
      if random() < 0.08 then s := s * 2.5; end if;   -- the odd sharp move
      s := least(s, 0.5 * p, 0.5 * (2 - p));           -- never reaches 0 or 2, still fair
      if random() < 0.5 then p := p + s; else p := p - s; end if;
      v_path := v_path || round(p, 4);
    end loop;
    insert into sm_rounds (starts_at, ends_at, path)
      values (now() + interval '10 seconds', now() + interval '30 seconds', v_path)
      returning * into r;
  end if;
  return r;
end;
$$;

-- Pay every position still open in rounds that have closed (anyone's call settles everyone's bets).
create or replace function public.sm_settle() returns void
language plpgsql volatile security definer set search_path = public as $$
declare r sm_rounds; u record; fee numeric := public.sm_fee(); pay bigint; p numeric;
begin
  for r in select * from sm_rounds where not settled and ends_at <= now() order by id for update skip locked loop
    p := r.path[81];
    for u in select distinct user_id from sm_bets where round_id = r.id and cash_tick is null loop
      -- Paid from the rows this call actually closes, so a cash-out racing the close can't be paid twice.
      with c as (update sm_bets set cash_tick = 80, payout = floor(public.sm_value(side, amount, p) * (1 - fee))
                 where round_id = r.id and user_id = u.user_id and cash_tick is null returning payout)
        select sum(payout) into pay from c;
      if pay > 0 then
        perform public.wallet_move(u.user_id, pay, 'win', 'Stock Market • Round #' || r.id || ' • closed ' || to_char((p - 1) * 100, 'FMS990') || '%');
      end if;
    end loop;
    update sm_rounds set settled = true where id = r.id;
  end loop;
end;
$$;

create or replace function public.sm_state() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r sm_rounds;
  t int;
  bal bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  perform public.sm_settle();
  r := public.sm_round();
  t := public.sm_tick(r);
  select coins into bal from wallets where user_id = me.id;
  return jsonb_build_object(
    'id', r.id,
    'starts_at', r.starts_at,
    'ends_at', r.ends_at,
    'phase', case when now() < r.starts_at then 'betting' when now() < r.ends_at then 'live' else 'closed' end,
    'path', case when now() < r.starts_at then '[]'::jsonb when now() >= r.ends_at then to_jsonb(r.path) else to_jsonb(r.path[1 : t + 1]) end,
    'server_now', now(),
    'balance', bal,
    'fee', public.sm_fee(),
    'history', coalesce((select jsonb_agg(round((x.path[81] - 1) * 100) order by x.id desc) from (
      select id, path from sm_rounds where ends_at <= now() and id <> r.id order by id desc limit 20) x), '[]'),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('side', b.side, 'amount', b.amount, 'cash_tick', b.cash_tick, 'payout', b.payout) order by b.side desc)
      from sm_bets b where b.round_id = r.id and b.user_id = me.id), '[]'),
    'crowd', jsonb_build_object(
      'up', coalesce((select sum(amount) from sm_bets where round_id = r.id and side = 'up' and user_id <> me.id), 0),
      'down', coalesce((select sum(amount) from sm_bets where round_id = r.id and side = 'down' and user_id <> me.id), 0),
      'up_n', (select count(*) from sm_bets where round_id = r.id and side = 'up' and user_id <> me.id),
      'down_n', (select count(*) from sm_bets where round_id = r.id and side = 'down' and user_id <> me.id))
  );
end;
$$;

-- Add a chip to UP or DOWN while bets are open.
create or replace function public.sm_bet(p_side text, p_amount bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r sm_rounds; cur bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_side not in ('up', 'down') then raise exception 'Invalid bet'; end if;
  if p_amount < 10 or p_amount > 100000 then raise exception 'Bet between 10 and 100,000 coins'; end if;
  r := public.sm_round();
  if now() >= r.starts_at then raise exception 'Bets are closed — wait for the next round'; end if;
  select amount into cur from sm_bets where round_id = r.id and user_id = me.id and side = p_side for update;
  if coalesce(cur, 0) + p_amount > 100000 then raise exception 'Up to 100,000 coins on each side'; end if;
  if public.wallet_move(me.id, -p_amount, 'bet', 'Stock Market • Round #' || r.id || ' • ' || upper(p_side)) is null then
    raise exception 'Not enough coins';
  end if;
  insert into sm_bets (round_id, user_id, side, amount) values (r.id, me.id, p_side, p_amount)
    on conflict (round_id, user_id, side) do update set amount = sm_bets.amount + excluded.amount;
  return public.sm_state();
end;
$$;

-- Take every chip back while bets are open.
create or replace function public.sm_clear() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r sm_rounds; total bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  r := public.sm_round();
  if now() >= r.starts_at then raise exception 'The market is open — bets can''t be taken back now'; end if;
  with d as (delete from sm_bets where round_id = r.id and user_id = me.id returning amount)
    select sum(amount) into total from d;
  if total > 0 then perform public.wallet_move(me.id, total, 'refund', 'Stock Market • Round #' || r.id || ' • cleared'); end if;
  return public.sm_state();
end;
$$;

-- Sell the whole portfolio at the current tick.
create or replace function public.sm_cashout() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r sm_rounds; t int; p numeric; fee numeric := public.sm_fee(); pay bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into r from sm_rounds order by id desc limit 1;
  if r.id is null or now() < r.starts_at then raise exception 'The market has not opened yet'; end if;
  if now() >= r.ends_at then raise exception 'The market has closed — positions are paid at the close'; end if;
  t := public.sm_tick(r);
  p := r.path[t + 1];
  with c as (update sm_bets set cash_tick = t, payout = floor(public.sm_value(side, amount, p) * (1 - fee))
             where round_id = r.id and user_id = me.id and cash_tick is null returning payout)
    select sum(payout) into pay from c;
  if pay is null then raise exception 'Nothing to cash out'; end if;
  if pay > 0 then
    perform public.wallet_move(me.id, pay, 'win', 'Stock Market • Round #' || r.id || ' • cashed out ' || to_char((p - 1) * 100, 'FMS990') || '%');
  end if;
  return public.sm_state() || jsonb_build_object('cashed', jsonb_build_object('tick', t, 'payout', pay));
end;
$$;

revoke execute on function public.sm_round(), public.sm_settle(), public.sm_fee(), public.sm_tick(public.sm_rounds), public.sm_value(text, bigint, numeric) from public, anon, authenticated;
revoke execute on function public.sm_state(), public.sm_bet(text, bigint), public.sm_clear(), public.sm_cashout() from public, anon;
grant execute on function public.sm_state(), public.sm_bet(text, bigint), public.sm_clear(), public.sm_cashout() to authenticated;

-- Game Config: Stock Market takes Carrom's place in the Super Admin's list.
create or replace function public.set_game_settings(p_game text, p_cfg jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare old jsonb := public.game_cfg(p_game); new jsonb := public.game_cfg(p_game); k text; v jsonb; n numeric;
        games text[] := array['teen-patti','rummy','andar-bahar','dragon-tiger','lucky-7','aviator','roulette','plinko','blackjack','poker','ludo','chess','stock-market'];
begin
  if not public.is_superadmin() then raise exception 'Only the Super Admin can change game settings'; end if;
  if not (p_game = any (games)) then raise exception 'Unknown game'; end if;
  for k, v in select * from jsonb_each(coalesce(p_cfg, '{}')) loop
    if k = 'enabled' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'enabled must be true or false'; end if;
      new := new || jsonb_build_object(k, v);
    elsif k in ('min_bet', 'max_bet') then
      if v = 'null'::jsonb or v = '""'::jsonb then new := new - k; continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 1000000 or n <> floor(n) then raise exception 'Bets must be whole coins from 1 to 1,000,000'; end if;
      new := new || jsonb_build_object(k, n::bigint);
    elsif k = 'rake' then
      n := (v #>> '{}')::numeric;
      if n < 0 or n > 25 then raise exception 'Platform fee must be between 0 and 25%%'; end if;
      new := new || jsonb_build_object(k, n);
    elsif k = 'turn' then
      if p_game not in ('teen-patti', 'rummy') then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 10 or n > 90 then raise exception 'Turn time must be between 10 and 90 seconds'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'blind_limit' then
      if p_game <> 'teen-patti' then continue; end if;
      n := (v #>> '{}')::numeric;
      if n < 1 or n > 10 then raise exception 'Blind limit must be between 1 and 10'; end if;
      new := new || jsonb_build_object(k, n::int);
    elsif k = 'bot_speed' then
      if p_game not in ('ludo', 'chess', 'poker') then continue; end if;
      if v #>> '{}' not in ('slow', 'normal', 'fast') then raise exception 'Bot speed must be slow, normal or fast'; end if;
      new := new || jsonb_build_object(k, v #>> '{}');
    else
      raise exception 'Unknown setting %', k;
    end if;
  end loop;
  if (new ->> 'min_bet') is not null and (new ->> 'max_bet') is not null and (new ->> 'min_bet')::bigint > (new ->> 'max_bet')::bigint then
    raise exception 'Minimum bet can''t be above the maximum';
  end if;
  insert into app_settings (key, value) values ('games', '{}') on conflict (key) do nothing;
  update app_settings set value = jsonb_set(coalesce(value, '{}'), array[p_game], new) where key = 'games';
  perform public.write_audit('Game settings • ' || p_game, old::text, new::text);
  return new;
end;
$$;

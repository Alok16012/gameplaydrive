-- 010: Aviator (crash game), run on the database clock.
--
-- One shared round at a time for everyone:
--   betting  7 s before starts_at — place / cancel bets (two bet slots per player)
--   flying   from starts_at; multiplier m(t) = e^(0.1·t), t = seconds since take-off
--   crashed  at crash_at = starts_at + ln(crash)/0.1; the next round opens 3 s later
-- The crash point is drawn when the round is created and is never sent to players until the round has crashed
-- (the tables have row-level security on and no policies, so they can only be read through these functions).
-- Cash-out is checked against the database clock. Auto cash-out pays at its target if the plane got there.
-- Crash distribution: P(crash ≥ x) = 0.97 / x (3% house edge), capped at 500×.
--
-- Safe to run more than once. Run it in the Supabase SQL Editor.

create table if not exists public.av_rounds (
  id bigint generated always as identity primary key,
  starts_at timestamptz not null,
  crash numeric(10, 2) not null,
  crash_at timestamptz not null,
  settled boolean not null default false
);
create index if not exists av_rounds_open_idx on public.av_rounds (settled) where not settled;

create table if not exists public.av_bets (
  id bigint generated always as identity primary key,
  round_id bigint not null references public.av_rounds (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  slot int not null check (slot in (0, 1)),
  amount bigint not null check (amount > 0),
  auto numeric(10, 2) check (auto is null or auto >= 1.01),
  cash_mult numeric(10, 2),
  payout bigint not null default 0,
  created_at timestamptz not null default now(),
  unique (round_id, user_id, slot)
);
create index if not exists av_bets_round_idx on public.av_bets (round_id);

alter table public.av_rounds enable row level security;
alter table public.av_bets enable row level security;
revoke all on public.av_rounds, public.av_bets from anon, authenticated;

-- Current round; opens the next one once the last has crashed and its 3 s pause is over.
create or replace function public.av_round() returns public.av_rounds
language plpgsql volatile security definer set search_path = public as $$
declare r av_rounds; u float8; c numeric;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    u := random();
    c := least(500, greatest(1.00, floor(97.0 / (1 - u)) / 100.0));
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

-- Pay auto cash-outs of rounds that have crashed (anyone's call settles everyone's bets).
create or replace function public.av_settle() returns void
language plpgsql volatile security definer set search_path = public as $$
declare r av_rounds; b av_bets;
begin
  for r in select * from av_rounds where not settled and crash_at <= now() order by id for update skip locked loop
    for b in select * from av_bets where round_id = r.id and cash_mult is null and auto is not null and auto <= r.crash for update loop
      update av_bets set cash_mult = b.auto, payout = floor(b.amount * b.auto) where id = b.id;
      perform public.wallet_move(b.user_id, floor(b.amount * b.auto)::bigint, 'win', 'Aviator • Round #' || r.id || ' • auto ' || to_char(b.auto, 'FM9990.00') || 'x');
    end loop;
    update av_rounds set settled = true where id = r.id;
  end loop;
end;
$$;

create or replace function public.av_state() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r av_rounds;
  crashed boolean;
  bal bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  perform public.av_settle();
  r := public.av_round();
  crashed := now() >= r.crash_at;
  select coins into bal from wallets where user_id = me.id;
  return jsonb_build_object(
    'id', r.id,
    'starts_at', r.starts_at,
    'phase', case when now() < r.starts_at then 'betting' when not crashed then 'flying' else 'crashed' end,
    'crash', case when crashed then r.crash end,
    'server_now', now(),
    'balance', bal,
    'history', coalesce((select jsonb_agg(x.crash order by x.id desc) from (
      select id, crash from av_rounds where crash_at <= now() and id <> r.id order by id desc limit 20) x), '[]'),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('slot', b.slot, 'amount', b.amount, 'auto', b.auto, 'cash_mult', b.cash_mult, 'payout', b.payout) order by b.slot)
      from av_bets b where b.round_id = r.id and b.user_id = me.id), '[]'),
    'bets', coalesce((select jsonb_agg(jsonb_build_object('name', left(p.name, 2) || '***', 'amount', b.amount,
        'cash_mult', case when b.cash_mult is not null and (crashed or b.auto is null) then b.cash_mult end) order by b.amount desc)
      from av_bets b join profiles p on p.id = b.user_id where b.round_id = r.id and b.user_id <> me.id), '[]')
  );
end;
$$;

create or replace function public.av_bet(p_slot int, p_amount bigint, p_auto numeric default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r av_rounds;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_slot not in (0, 1) then raise exception 'Invalid bet'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  if p_auto is not null and (p_auto < 1.01 or p_auto > 500) then raise exception 'Auto cash-out between 1.01x and 500x'; end if;
  r := public.av_round();
  if now() >= r.starts_at then raise exception 'Bets are closed — wait for the next round'; end if;
  if exists (select 1 from av_bets where round_id = r.id and user_id = me.id and slot = p_slot) then raise exception 'You already have this bet'; end if;
  if public.wallet_move(me.id, -p_amount, 'bet', 'Aviator • Round #' || r.id) is null then raise exception 'Not enough coins'; end if;
  insert into av_bets (round_id, user_id, slot, amount, auto) values (r.id, me.id, p_slot, p_amount, round(p_auto, 2));
  return public.av_state();
end;
$$;

create or replace function public.av_cancel(p_slot int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r av_rounds; b av_bets;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  r := public.av_round();
  if now() >= r.starts_at then raise exception 'The round has started'; end if;
  delete from av_bets where round_id = r.id and user_id = me.id and slot = p_slot returning * into b;
  if b.id is not null then perform public.wallet_move(me.id, b.amount, 'refund', 'Aviator • Round #' || r.id || ' • cancelled'); end if;
  return public.av_state();
end;
$$;

create or replace function public.av_cashout(p_slot int) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); r av_rounds; b av_bets; m numeric; pay bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() < r.starts_at then raise exception 'The plane has not taken off yet'; end if;
  if now() >= r.crash_at then raise exception 'Too late — the plane flew away at %x', r.crash; end if;
  select * into b from av_bets where round_id = r.id and user_id = me.id and slot = p_slot for update;
  if b.id is null then raise exception 'No bet to cash out'; end if;
  if b.cash_mult is not null then raise exception 'Already cashed out'; end if;
  m := floor(exp(0.1 * extract(epoch from (now() - r.starts_at))) * 100) / 100;
  if b.auto is not null and m >= b.auto then m := b.auto; end if;
  m := least(m, r.crash);
  pay := floor(b.amount * m);
  update av_bets set cash_mult = m, payout = pay where id = b.id;
  perform public.wallet_move(me.id, pay, 'win', 'Aviator • Round #' || r.id || ' • ' || to_char(m, 'FM9990.00') || 'x');
  return public.av_state();
end;
$$;

revoke execute on function public.av_round(), public.av_settle() from public, anon, authenticated;
revoke execute on function public.av_state(), public.av_bet(int, bigint, numeric), public.av_cancel(int), public.av_cashout(int) from public, anon;
grant execute on function public.av_state(), public.av_bet(int, bigint, numeric), public.av_cancel(int), public.av_cashout(int) to authenticated;

-- 012: Roulette, Blackjack and Plinko, dealt and settled by the database. Run after 011. Safe to run more than once.
--
-- Roulette (European, single zero). One spin per call; every bet is checked and paid here.
--   Odds are the total return per coin staked (stake included):
--   n_0 … n_36          straight number          ×36
--   red / black, even / odd, low (1-18) / high (19-36)   ×2   (0 loses them all)
--   d1 / d2 / d3        dozen 1-12 / 13-24 / 25-36        ×3
--   c1 / c2 / c3        column (1,4,7… / 2,5,8… / 3,6,9…) ×3
--
-- Blackjack. Six decks shuffled fresh for every hand; dealer stands on all 17s; blackjack pays 3:2; the dealer
--   checks for blackjack straight away (you only lose your first bet to a dealer blackjack). Double on any first
--   two cards (also after a split); split one pair once; split aces get one card each. The shoe and the dealer's
--   hole card stay in the database until the hand is over. An unfinished hand is still there when you come back.
--
-- Plinko. The ball falls through 8, 12 or 16 rows of pegs, going left or right at each one (50/50, drawn here).
--   The slot it lands in pays the multiplier for that row count and risk level; every table returns ~99%.

-- ---------------------------------------------------------------- Roulette

create table if not exists public.rl_spins (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  num int not null check (num between 0 and 36),
  stake bigint not null,
  payout bigint not null,
  created_at timestamptz not null default now()
);
create index if not exists rl_spins_user_idx on public.rl_spins (user_id, id desc);
alter table public.rl_spins enable row level security;
revoke all on public.rl_spins from anon, authenticated;

-- Total return multiple of a bet on number n; null if the bet doesn't exist.
create or replace function public.rl_pay(p_side text, n int) returns int
language plpgsql immutable set search_path = public as $$
declare red boolean := n = any (array[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
begin
  if p_side ~ '^n_([0-9]|[12][0-9]|3[0-6])$' then return case when substr(p_side, 3)::int = n then 36 else 0 end; end if;
  return case p_side
    when 'red' then case when red then 2 else 0 end
    when 'black' then case when n > 0 and not red then 2 else 0 end
    when 'even' then case when n > 0 and n % 2 = 0 then 2 else 0 end
    when 'odd' then case when n % 2 = 1 then 2 else 0 end
    when 'low' then case when n between 1 and 18 then 2 else 0 end
    when 'high' then case when n between 19 and 36 then 2 else 0 end
    when 'd1' then case when n between 1 and 12 then 3 else 0 end
    when 'd2' then case when n between 13 and 24 then 3 else 0 end
    when 'd3' then case when n between 25 and 36 then 3 else 0 end
    when 'c1' then case when n > 0 and n % 3 = 1 then 3 else 0 end
    when 'c2' then case when n > 0 and n % 3 = 2 then 3 else 0 end
    when 'c3' then case when n > 0 and n % 3 = 0 then 3 else 0 end
  end;
end;
$$;

create or replace function public.rl_history() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select jsonb_agg(x.num order by x.id desc) from (
    select id, num from rl_spins where user_id = (public.current_profile()).id order by id desc limit 20) x), '[]');
$$;

create or replace function public.roulette_spin(p_bets jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  b jsonb; stake bigint := 0; ret bigint := 0; n int; bal bigint; spin_id bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then raise exception 'Place a bet first'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', 0) is null or coalesce((b ->> 'v')::bigint, 0) <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per spin'; end if;

  n := floor(random() * 37)::int;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', n) > 0 then
      ret := ret + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', n);
    end if;
  end loop;

  insert into rl_spins (user_id, num, stake, payout) values (me.id, n, stake, ret) returning id into spin_id;
  bal := public.wallet_move(me.id, -stake, 'bet', 'Roulette • Spin #' || spin_id);
  if bal is null then raise exception 'Not enough coins'; end if;
  if ret > 0 then bal := public.wallet_move(me.id, ret, 'win', 'Roulette • Spin #' || spin_id || ' • ' || n); end if;
  return jsonb_build_object('id', spin_id, 'number', n, 'stake', stake, 'payout', ret, 'balance', bal, 'history', public.rl_history());
end;
$$;

-- ---------------------------------------------------------------- Plinko

create or replace function public.plinko_table(p_rows int, p_risk text) returns numeric[]
language sql immutable as $$
  select case p_rows::text || p_risk
    when '8low' then array[5.6,2.1,1.1,1,0.5,1,1.1,2.1,5.6]
    when '8medium' then array[13,3,1.3,0.7,0.4,0.7,1.3,3,13]
    when '8high' then array[29,4,1.5,0.3,0.2,0.3,1.5,4,29]
    when '12low' then array[10,3,1.6,1.4,1.1,1,0.5,1,1.1,1.4,1.6,3,10]
    when '12medium' then array[33,11,4,2,1.1,0.6,0.3,0.6,1.1,2,4,11,33]
    when '12high' then array[170,24,8.1,2,0.7,0.2,0.2,0.2,0.7,2,8.1,24,170]
    when '16low' then array[16,9,2,1.4,1.4,1.2,1.1,1,0.5,1,1.1,1.2,1.4,1.4,2,9,16]
    when '16medium' then array[110,41,10,5,3,1.5,1,0.5,0.3,0.5,1,1.5,3,5,10,41,110]
    when '16high' then array[1000,130,26,9,4,2,0.2,0.2,0.2,0.2,0.2,2,4,9,26,130,1000]
  end::numeric[];
$$;

create or replace function public.plinko_drop(p_amount bigint, p_rows int, p_risk text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  mults numeric[] := public.plinko_table(p_rows, p_risk);
  path int[] := '{}'; slot int := 0; step int; m numeric; pay bigint; bal bigint; note text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if mults is null then raise exception 'Invalid board'; end if;
  if p_amount < 10 or p_amount > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  for i in 1 .. p_rows loop
    step := case when random() < 0.5 then 0 else 1 end;
    path := path || step;
    slot := slot + step;
  end loop;
  m := mults[slot + 1];
  pay := floor(p_amount * m);
  note := 'Plinko • ' || p_rows || ' rows • ' || p_risk || ' • ' || m || 'x';
  bal := public.wallet_move(me.id, -p_amount, 'bet', note);
  if bal is null then raise exception 'Not enough coins'; end if;
  if pay > 0 then bal := public.wallet_move(me.id, pay, case when pay >= p_amount then 'win' else 'refund' end, note); end if;
  return jsonb_build_object('path', to_jsonb(path), 'slot', slot, 'mult', m, 'payout', pay, 'balance', bal);
end;
$$;

-- ---------------------------------------------------------------- Blackjack

create table if not exists public.bj_hands (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  bet bigint not null check (bet > 0),
  shoe jsonb not null,               -- cards still to come (never sent to the player)
  dealer jsonb not null,             -- dealer's cards; the second one is hidden until the hand is over
  hands jsonb not null,              -- [{cards, bet, done, doubled, split, result, payout}]
  active int not null default 0,
  status text not null default 'playing' check (status in ('playing', 'done')),
  payout bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists bj_hands_open_idx on public.bj_hands (user_id) where status = 'playing';
create index if not exists bj_hands_user_idx on public.bj_hands (user_id, id desc);
alter table public.bj_hands enable row level security;
revoke all on public.bj_hands from anon, authenticated;

create or replace function public.bj_value(r text) returns int language sql immutable as $$
  select case when r = 'A' then 1 when r in ('J', 'Q', 'K') then 10 else r::int end;
$$;

-- Best total of a set of cards (an ace counts 11 when that doesn't bust).
create or replace function public.bj_total(cards jsonb) returns int
language sql immutable set search_path = public as $$
  select s + case when a and s + 10 <= 21 then 10 else 0 end
  from (select coalesce(sum(public.bj_value(c ->> 'r')), 0)::int s, coalesce(bool_or(c ->> 'r' = 'A'), false) a
        from jsonb_array_elements(cards) c) x;
$$;

create or replace function public.bj_natural(cards jsonb) returns boolean language sql immutable set search_path = public as $$
  select jsonb_array_length(cards) = 2 and public.bj_total(cards) = 21;
$$;

create or replace function public.bj_view(h public.bj_hands) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  is_open boolean := h.status = 'playing';
  cur jsonb := h.hands -> h.active;
  bal bigint;
begin
  select coins into bal from wallets where user_id = h.user_id;
  return jsonb_build_object(
    'id', h.id,
    'bet', h.bet,
    'status', h.status,
    'active', h.active,
    'payout', h.payout,
    'balance', bal,
    'dealer', case when is_open then jsonb_build_array(h.dealer -> 0) else h.dealer end,
    'dealer_total', case when is_open then public.bj_total(jsonb_build_array(h.dealer -> 0)) else public.bj_total(h.dealer) end,
    'hands', (select jsonb_agg(x || jsonb_build_object('total', public.bj_total(x -> 'cards')) order by i)
              from jsonb_array_elements(h.hands) with ordinality t(x, i)),
    'can_double', is_open and jsonb_array_length(cur -> 'cards') = 2 and coalesce(bal, 0) >= (cur ->> 'bet')::bigint,
    'can_split', is_open and jsonb_array_length(h.hands) = 1 and jsonb_array_length(cur -> 'cards') = 2
                 and public.bj_value(cur -> 'cards' -> 0 ->> 'r') = public.bj_value(cur -> 'cards' -> 1 ->> 'r')
                 and coalesce(bal, 0) >= h.bet
  );
end;
$$;

-- Dealer plays out (if any hand is still live), then every hand is settled and paid.
create or replace function public.bj_finish(h public.bj_hands) returns public.bj_hands
language plpgsql volatile security definer set search_path = public as $$
declare
  x jsonb; i int; pt int; dt int; res text; pay bigint; total bigint := 0; staked bigint := 0; any_win boolean := false;
  live boolean := false; dealer_bj boolean := public.bj_natural(h.dealer); settled jsonb := '[]';
begin
  for x in select * from jsonb_array_elements(h.hands) loop
    if public.bj_total(x -> 'cards') <= 21 and not (public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean) then live := true; end if;
  end loop;
  if live and not dealer_bj then
    while public.bj_total(h.dealer) < 17 loop
      h.dealer := h.dealer || jsonb_build_array(h.shoe -> 0);
      h.shoe := h.shoe - 0;
    end loop;
  end if;
  dt := public.bj_total(h.dealer);

  for i in 0 .. jsonb_array_length(h.hands) - 1 loop
    x := h.hands -> i;
    pt := public.bj_total(x -> 'cards');
    if pt > 21 then res := 'bust'; pay := 0;
    elsif public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean then
      if dealer_bj then res := 'push'; pay := (x ->> 'bet')::bigint;
      else res := 'blackjack'; pay := floor((x ->> 'bet')::bigint * 2.5); end if;
    elsif dealer_bj then res := 'lose'; pay := 0;
    elsif dt > 21 or pt > dt then res := 'win'; pay := (x ->> 'bet')::bigint * 2;
    elsif pt = dt then res := 'push'; pay := (x ->> 'bet')::bigint;
    else res := 'lose'; pay := 0; end if;
    if res in ('win', 'blackjack') then any_win := true; end if;
    total := total + pay;
    staked := staked + (x ->> 'bet')::bigint;
    settled := settled || jsonb_build_array(x || jsonb_build_object('done', true, 'result', res, 'payout', pay));
  end loop;

  h.hands := settled;
  h.status := 'done';
  h.payout := total;
  h.updated_at := now();
  if total > 0 then
    perform public.wallet_move(h.user_id, total, case when any_win then 'win' else 'refund' end, 'Blackjack • Hand #' || h.id);
  end if;
  return h;
end;
$$;

-- Move to the next unfinished hand, or finish the round.
create or replace function public.bj_next(h public.bj_hands) returns public.bj_hands
language plpgsql volatile security definer set search_path = public as $$
begin
  while h.active < jsonb_array_length(h.hands) and (h.hands -> h.active ->> 'done')::boolean loop
    h.active := h.active + 1;
  end loop;
  if h.active >= jsonb_array_length(h.hands) then
    h.active := jsonb_array_length(h.hands) - 1;
    h := public.bj_finish(h);
  end if;
  return h;
end;
$$;

create or replace function public.bj_save(h public.bj_hands) returns void
language sql volatile security definer set search_path = public as $$
  update bj_hands set shoe = h.shoe, dealer = h.dealer, hands = h.hands, active = h.active, status = h.status,
    payout = h.payout, updated_at = now() where id = h.id;
$$;

create or replace function public.bj_state() returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); h bj_hands; bal bigint;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into h from bj_hands where user_id = me.id and status = 'playing';
  if h.id is not null then return public.bj_view(h); end if;
  select coins into bal from wallets where user_id = me.id;
  return jsonb_build_object('status', 'idle', 'balance', bal);
end;
$$;

create or replace function public.bj_deal(p_bet bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); h bj_hands; s jsonb; p jsonb; d jsonb;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  if exists (select 1 from bj_hands where user_id = me.id and status = 'playing') then raise exception 'Finish your current hand first'; end if;
  select jsonb_agg(jsonb_build_object('r', r, 's', su) order by random()) into s
    from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
    cross join unnest(array['♠','♥','♦','♣']) su
    cross join generate_series(1, 6);
  p := jsonb_build_array(s -> 0, s -> 2);
  d := jsonb_build_array(s -> 1, s -> 3);
  insert into bj_hands (user_id, bet, shoe, dealer, hands)
    values (me.id, p_bet, s - 0 - 0 - 0 - 0, d,
            jsonb_build_array(jsonb_build_object('cards', p, 'bet', p_bet, 'done', false, 'doubled', false, 'split', false)))
    returning * into h;
  if public.wallet_move(me.id, -p_bet, 'bet', 'Blackjack • Hand #' || h.id) is null then raise exception 'Not enough coins'; end if;

  if public.bj_natural(p) or public.bj_natural(d) then
    h := public.bj_finish(h);
    perform public.bj_save(h);
  end if;
  return public.bj_view(h);
end;
$$;

create or replace function public.bj_act(p_action text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare me profiles := public.current_profile(); h bj_hands; cur jsonb; a jsonb; b jsonb; ace boolean;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  select * into h from bj_hands where user_id = me.id and status = 'playing' for update;
  if h.id is null then raise exception 'No hand in play — place a bet'; end if;
  cur := h.hands -> h.active;

  if p_action = 'hit' then
    cur := jsonb_set(cur, '{cards}', (cur -> 'cards') || jsonb_build_array(h.shoe -> 0));
    h.shoe := h.shoe - 0;
    if public.bj_total(cur -> 'cards') >= 21 then cur := jsonb_set(cur, '{done}', 'true'); end if;
    h.hands := jsonb_set(h.hands, array[h.active::text], cur);

  elsif p_action = 'stand' then
    h.hands := jsonb_set(h.hands, array[h.active::text, 'done'], 'true');

  elsif p_action = 'double' then
    if jsonb_array_length(cur -> 'cards') <> 2 then raise exception 'You can only double on your first two cards'; end if;
    if public.wallet_move(me.id, -(cur ->> 'bet')::bigint, 'bet', 'Blackjack • Hand #' || h.id || ' • double') is null then raise exception 'Not enough coins to double'; end if;
    cur := cur || jsonb_build_object('bet', (cur ->> 'bet')::bigint * 2, 'doubled', true, 'done', true,
                                     'cards', (cur -> 'cards') || jsonb_build_array(h.shoe -> 0));
    h.shoe := h.shoe - 0;
    h.hands := jsonb_set(h.hands, array[h.active::text], cur);

  elsif p_action = 'split' then
    if jsonb_array_length(h.hands) <> 1 or jsonb_array_length(cur -> 'cards') <> 2
       or public.bj_value(cur -> 'cards' -> 0 ->> 'r') <> public.bj_value(cur -> 'cards' -> 1 ->> 'r') then
      raise exception 'You can only split a pair, once';
    end if;
    if public.wallet_move(me.id, -h.bet, 'bet', 'Blackjack • Hand #' || h.id || ' • split') is null then raise exception 'Not enough coins to split'; end if;
    ace := cur -> 'cards' -> 0 ->> 'r' = 'A';
    a := jsonb_build_object('cards', jsonb_build_array(cur -> 'cards' -> 0, h.shoe -> 0), 'bet', h.bet, 'doubled', false, 'split', true);
    b := jsonb_build_object('cards', jsonb_build_array(cur -> 'cards' -> 1, h.shoe -> 1), 'bet', h.bet, 'doubled', false, 'split', true);
    h.shoe := h.shoe - 0 - 0;
    a := a || jsonb_build_object('done', ace or public.bj_total(a -> 'cards') = 21);
    b := b || jsonb_build_object('done', ace or public.bj_total(b -> 'cards') = 21);
    h.hands := jsonb_build_array(a, b);

  else
    raise exception 'Unknown action';
  end if;

  h := public.bj_next(h);
  perform public.bj_save(h);
  return public.bj_view(h);
end;
$$;

revoke execute on function public.rl_pay(text, int), public.plinko_table(int, text), public.bj_view(public.bj_hands),
  public.bj_finish(public.bj_hands), public.bj_next(public.bj_hands), public.bj_save(public.bj_hands)
  from public, anon, authenticated;
revoke execute on function public.rl_history(), public.roulette_spin(jsonb), public.plinko_drop(bigint, int, text),
  public.bj_state(), public.bj_deal(bigint), public.bj_act(text) from public, anon;
grant execute on function public.rl_history(), public.roulette_spin(jsonb), public.plinko_drop(bigint, int, text),
  public.bj_state(), public.bj_deal(bigint), public.bj_act(text) to authenticated;

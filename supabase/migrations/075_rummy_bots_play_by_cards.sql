-- 075: Rummy bots play by their cards, and outcome control is decided once per deal.
--
-- What was wrong (production, before this migration):
--   * get_outcome_mode() rolls the dice on every call, and rm_draw / rm_bot_move called it on every draw and every
--     bot turn. With the "fair" setting (60% loss / 30% win / 10% fair per call) the bots' behaviour flipped turn by
--     turn within one deal: some turns no bot could drop, some turns any bot one card short was handed the card.
--   * force_win did nothing: the human won about 1 deal in 5, like a fair game, and a deal could run for hundreds of
--     rounds. force_loss bots sometimes declared in round 1-2.
--   * Bots dropped at random (points threshold + dice), not by their hand. rm_start_deal from 074 is never called
--     (rm_start deals), so its fixed rigged hands never reached a table.
--
-- Now:
--   * At the start of every deal each human's outcome mode is looked up once and kept on their seat ("om"), and one
--     bot — the one dealt the best hand — is the deal's "closer" (it never drops), with a target round ("aim"). The
--     player the outcome favours (the closer under force_loss, the human under force_win) is dealt a pure sequence.
--   * force_loss: from round 2 the closer draws useful cards from the closed pile now and then, and the winning card
--     from its target round (5-9, different every deal); the human is never handed a closed card that completes
--     their hand, and bots never throw them the card that would.
--   * force_win: from round 2 the human draws useful cards now and then; bots never declare and are never handed a
--     completing card, so the human finishes the deal.
--   * Bots drop by their hand: a bad first hand often drops at once, a hand that stays bad may drop in the middle;
--     the closer never drops, so a human can't win a deal just because every bot dropped.
--
-- Safe to run more than once. Runs as one transaction: if anything fails, nothing changes.

begin;

-- ============================================================================ helpers

-- The best a hand can do after taking `card` and throwing its best discard: {valid, points}.
create or replace function public.rm_after_draw(hand jsonb, card jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare h jsonb := hand || jsonb_build_array(card); c jsonb; r jsonb; best jsonb;
begin
  for c in select * from jsonb_array_elements(h) loop
    r := public.rm_best(public.rm_minus(h, jsonb_build_array(c)), wild);
    if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
      best := r;
    end if;
  end loop;
  return jsonb_build_object('valid', coalesce((best ->> 'valid')::boolean, false), 'points', coalesce((best ->> 'points')::int, 999));
end;
$$;

-- The deal's outcome mode from the seats: force_loss if any playing human has it, else force_win if any has it.
create or replace function public.rm_mode(seats jsonb) returns text
language sql immutable as $$
  select case
    when exists (select 1 from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and coalesce((v ->> 'playing')::boolean, false) and v ->> 'om' = 'force_loss') then 'force_loss'
    when exists (select 1 from jsonb_array_elements(seats) v where not (v ->> 'bot')::boolean and coalesce((v ->> 'playing')::boolean, false) and v ->> 'om' = 'force_win') then 'force_win'
    else 'fair' end;
$$;

-- Index of the most useful card among the first `n` of the closed pile for `hand` (null when none improves it).
-- With allow_valid = false a card that would complete the hand is passed over.
create or replace function public.rm_pick_card(hand jsonb, stock jsonb, wild text, n int, allow_valid boolean) returns int
language plpgsql immutable as $$
declare cur int := (public.rm_best(hand, wild) ->> 'points')::int; i int; r jsonb; best_i int; best jsonb;
begin
  for i in 0 .. least(n, jsonb_array_length(stock)) - 1 loop
    r := public.rm_after_draw(hand, stock -> i, wild);
    continue when (r ->> 'valid')::boolean and not allow_valid;
    if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
      best := r; best_i := i;
    end if;
  end loop;
  if best is null or (not (best ->> 'valid')::boolean and (best ->> 'points')::int >= cur) then return null; end if;
  return best_i;
end;
$$;

-- Index of the first of the closed pile's top cards that does NOT complete `hand` (0 when the top card is fine).
create or replace function public.rm_safe_card(hand jsonb, stock jsonb, wild text) returns int
language plpgsql immutable as $$
declare i int;
begin
  for i in 0 .. least(8, jsonb_array_length(stock)) - 1 loop
    if not (public.rm_after_draw(hand, stock -> i, wild) ->> 'valid')::boolean then return i; end if;
  end loop;
  return 0;
end;
$$;

-- Make sure `seat` holds a pure sequence of three: the run it is closest to (most of its cards already in hand), with
-- the missing cards swapped in from the closed pile for the hand's highest loose cards. Hands are private, so nobody
-- can see this; it only gives the player the outcome favours a fair start.
create or replace function public.rm_give_pure(t public.rm_tables, seat int) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  wild text := public.rm_wk(t);
  v_hand jsonb; v_stock jsonb; run record; want text[]; c jsonb; need jsonb; give jsonb; out_card jsonb; k int; i int;
begin
  select h.cards into v_hand from rm_hands h where h.table_id = t.id and h.seat = rm_give_pure.seat;
  select p.stock into v_stock from rm_private p where p.table_id = t.id;
  if v_hand is null or v_stock is null then return; end if;
  -- Every run of three in every suit (A-2-3 … J-Q-K and Q-K-A): how many of its cards the hand already has, and
  -- whether the closed pile has the rest.
  select s, st, have into run from (
    select s, st,
      (select count(distinct r) from jsonb_array_elements(v_hand) c2, unnest(array[ranks[st], ranks[st % 13 + 1], ranks[(st + 1) % 13 + 1]]) r
         where c2 ->> 's' = s and c2 ->> 'r' = r) have,
      (select bool_and(exists (select 1 from jsonb_array_elements(v_stock) c3 where c3 ->> 's' = s and c3 ->> 'r' = r)
                       or exists (select 1 from jsonb_array_elements(v_hand) c4 where c4 ->> 's' = s and c4 ->> 'r' = r))
         from unnest(array[ranks[st], ranks[st % 13 + 1], ranks[(st + 1) % 13 + 1]]) r) possible
    from unnest(array['♠','♥','♦','♣']) s, generate_series(1, 12) st
  ) z where possible order by have desc, random() limit 1;
  if run is null or run.have >= 3 then return; end if;
  want := array[ranks[run.st], ranks[run.st % 13 + 1], ranks[(run.st + 1) % 13 + 1]];
  for i in 1 .. 3 loop
    continue when exists (select 1 from jsonb_array_elements(v_hand) c5 where c5 ->> 's' = run.s and c5 ->> 'r' = want[i]);
    select k2 - 1 into k from jsonb_array_elements(v_stock) with ordinality y(c6, k2) where c6 ->> 's' = run.s and c6 ->> 'r' = want[i] limit 1;
    continue when k is null;
    give := v_stock -> k;
    -- Out goes the highest loose card that isn't part of the run and isn't a joker.
    select c7 into out_card from jsonb_array_elements(v_hand) c7
      where not (c7 ->> 's' = run.s and c7 ->> 'r' = any (want)) and not public.rm_isj(c7, wild)
      order by public.rm_pts(c7, wild) desc, random() limit 1;
    continue when out_card is null;
    v_hand := public.rm_minus(v_hand, jsonb_build_array(out_card)) || jsonb_build_array(give);
    v_stock := jsonb_set(v_stock, array[k::text], out_card);
  end loop;
  update rm_hands set cards = v_hand where table_id = t.id and rm_hands.seat = rm_give_pure.seat;
  update rm_private set stock = v_stock where table_id = t.id;
end;
$$;

-- When the closed pile has nothing useful for a player the outcome favours, the card they need may be stuck in a
-- bot's hand. Find the most useful card held by any bot other than `seat` and swap it with the closed pile's top card
-- (the bot gets that card instead). Bot hands are private, so this is invisible at the table. Returns the new stock.
create or replace function public.rm_pull_from_bots(t public.rm_tables, seat int, v_stock jsonb, wild text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_hand jsonb; cur int; h record; c jsonb; r jsonb; best jsonb; best_c jsonb; best_seat int;
  ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
begin
  if jsonb_array_length(v_stock) = 0 then return v_stock; end if;
  select h2.cards into v_hand from rm_hands h2 where h2.table_id = t.id and h2.seat = rm_pull_from_bots.seat;
  cur := (public.rm_best(v_hand, wild) ->> 'points')::int;
  for h in select h3.seat, h3.cards from rm_hands h3
           where h3.table_id = t.id and h3.seat <> rm_pull_from_bots.seat and coalesce((t.seats -> h3.seat ->> 'bot')::boolean, false)
             and coalesce((t.seats -> h3.seat ->> 'playing')::boolean, false) loop
    -- Only cards that can join something in the hand: a joker, the same rank, or a near card of the same suit.
    for c in select c2 from jsonb_array_elements(h.cards) c2
             where public.rm_isj(c2, wild) or exists (
               select 1 from jsonb_array_elements(v_hand) x
               where x ->> 'r' = c2 ->> 'r'
                  or (x ->> 's' = c2 ->> 's' and abs(array_position(ranks, x ->> 'r') - array_position(ranks, c2 ->> 'r')) in (1, 2, 11, 12))) loop
      r := public.rm_after_draw(v_hand, c, wild);
      if best is null or ((r ->> 'valid')::boolean and not (best ->> 'valid')::boolean)
         or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and (r ->> 'points')::int < (best ->> 'points')::int) then
        best := r; best_c := c; best_seat := h.seat;
      end if;
    end loop;
  end loop;
  if best is null or (not (best ->> 'valid')::boolean and (best ->> 'points')::int >= cur) then return v_stock; end if;
  update rm_hands set cards = public.rm_minus(cards, jsonb_build_array(best_c)) || jsonb_build_array(v_stock -> 0)
    where table_id = t.id and rm_hands.seat = best_seat;
  return jsonb_set(v_stock, '{0}', best_c);
end;
$$;

-- ============================================================================ deal setup

-- After a deal is dealt: each human's outcome mode, once; the closer bot and the round it aims to declare in.
create or replace function public.rm_deal_setup(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare n int := jsonb_array_length(t.seats); i int; x jsonb; pts int; best_pts int; closer int; wild text := public.rm_wk(t); hand jsonb;
begin
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    continue when not coalesce((x ->> 'playing')::boolean, false);
    if (x ->> 'bot')::boolean then
      select h.cards into hand from rm_hands h where h.table_id = t.id and h.seat = i;
      pts := (public.rm_best(hand, wild) ->> 'points')::int;
      if best_pts is null or pts < best_pts then best_pts := pts; closer := i; end if;
      t.seats := public.rm_seat_set(t.seats, i, '{"closer": false}');
    else
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('om', coalesce(public.get_outcome_mode((x ->> 'uid')::uuid, 'rummy'), 'fair')));
    end if;
  end loop;
  if closer is not null then
    t.seats := public.rm_seat_set(t.seats, closer, jsonb_build_object('closer', true, 'aim', 5 + floor(random() * 5)::int));
  end if;
  -- The player the outcome favours starts with a pure sequence: the closer under force_loss, the human under
  -- force_win.
  if public.rm_mode(t.seats) = 'force_loss' and closer is not null then
    perform public.rm_give_pure(t, closer);
  elsif public.rm_mode(t.seats) = 'force_win' then
    select i2 - 1 into i from jsonb_array_elements(t.seats) with ordinality z(v, i2)
      where not (v ->> 'bot')::boolean and coalesce((v ->> 'playing')::boolean, false) and v ->> 'om' = 'force_win' limit 1;
    if i is not null then perform public.rm_give_pure(t, i); end if;
  end if;
  return t;
end;
$$;

-- rm_start deals; keep it as rm_start_base and run the setup after every deal it starts.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'rm_start_base') then
    alter function public.rm_start(public.rm_tables) rename to rm_start_base;
  end if;
end $$;

create or replace function public.rm_start(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
begin
  t := public.rm_start_base(t);
  if t.status = 'playing' then t := public.rm_deal_setup(t); end if;
  return t;
end;
$$;

-- ============================================================================ drawing

create or replace function public.rm_draw(t public.rm_tables, seat int, src text) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  p rm_private;
  card jsonb;
  top jsonb;
  reshuffled boolean := false;
  me jsonb := t.seats -> seat;
  is_bot boolean := coalesce((t.seats -> seat ->> 'bot')::boolean, false);
  wild text := public.rm_wk(t);
  mode text := public.rm_mode(t.seats);
  hand jsonb;
  k int;
  aim int;
  n_cand int := case when t.cards = 21 then 8 else 16 end;
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

    if mode <> 'fair' and jsonb_array_length(p.stock) > 1 then
      select h.cards into hand from rm_hands h where h.table_id = t.id and h.seat = rm_draw.seat;
      k := null;
      if mode = 'force_loss' and is_bot and coalesce((me ->> 'closer')::boolean, false) and t.round >= 2 then
        -- The closer gets a useful card now and then, and the winning one from its target round. Still stuck a few
        -- rounds later: the card it needs comes out of another bot's hand.
        aim := coalesce((me ->> 'aim')::int, 6);
        if t.round >= aim or random() < 0.5 then
          k := public.rm_pick_card(hand, p.stock, wild, n_cand, t.round >= aim);
          if k is null and t.round >= aim + 3 then p.stock := public.rm_pull_from_bots(t, seat, p.stock, wild); end if;
        end if;
      elsif mode = 'force_loss' and not is_bot and me ->> 'om' = 'force_loss' then
        -- Never hand a force_loss player the card that completes their hand.
        k := public.rm_safe_card(hand, p.stock, wild);
      elsif mode = 'force_win' and not is_bot and me ->> 'om' = 'force_win' and t.round >= 2 and (t.round >= 8 or random() < 0.6) then
        -- A force_win player gets a useful card now and then (the winning one included); from round 8 on every time,
        -- out of a bot's hand when the closed pile has nothing.
        k := public.rm_pick_card(hand, p.stock, wild, n_cand, true);
        if k is null and t.round >= 8 then p.stock := public.rm_pull_from_bots(t, seat, p.stock, wild); end if;
      elsif mode = 'force_win' and is_bot then
        -- Bots are never handed the card that completes their hand.
        k := public.rm_safe_card(hand, p.stock, wild);
      end if;
      if k is not null and k > 0 then
        p.stock := jsonb_set(jsonb_set(p.stock, '{0}', p.stock -> k), array[k::text], p.stock -> 0);
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

-- ============================================================================ bot turn

create or replace function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  st int := t.turn;
  me jsonb := t.seats -> t.turn;
  wild text := public.rm_wk(t);
  mode text := public.rm_mode(t.seats);
  closer boolean := coalesce((t.seats -> t.turn ->> 'closer')::boolean, false);
  big int := case when t.cards = 21 then 95 else 60 end;   -- a bad hand
  mid int := case when t.cards = 21 then 75 else 45 end;   -- a poor hand
  hand jsonb; cur jsonb; alt jsonb; r jsonb; c jsonb; o jsonb; opts jsonb; chosen jsonb;
  top jsonb := t.open_top;
  pts int; others int; drop_chance float8 := 0; blocked boolean; h record;
begin
  if t.bot_acts_at >= t.turn_ends then return public.rm_timeout(t); end if;
  select h2.cards into hand from rm_hands h2 where h2.table_id = t.id and h2.seat = st;

  if t.phase = 'draw' then
    cur := public.rm_best(hand, wild);
    pts := (cur ->> 'points')::int;
    -- Drop by the hand, never the closer, and never the last bot left in the deal.
    select count(*) into others from jsonb_array_elements(t.seats) with ordinality z(v, i)
      where (v ->> 'bot')::boolean and i - 1 <> st and coalesce((v ->> 'playing')::boolean, false)
        and not coalesce((v ->> 'dropped')::boolean, false) and not coalesce((v ->> 'wrong')::boolean, false);
    if not closer and others >= 1 then
      if (me ->> 'turns')::int = 0 then
        drop_chance := case when pts >= big then 0.45 when pts >= mid then 0.12 else 0 end;
      elsif t.round >= 4 then
        drop_chance := case when pts >= big then 0.15 when pts >= mid and t.round >= 7 then 0.08 else 0 end;
      end if;
      if random() < drop_chance then return public.rm_drop(t, st); end if;
    end if;

    -- Take the open card when it clearly helps.
    if top is not null and not public.rm_isj(top, wild) then
      alt := public.rm_after_draw(hand, top, wild);
      if (alt ->> 'points')::int <= pts - 4 or ((alt ->> 'valid')::boolean and mode <> 'force_win') then
        t := public.rm_draw(t, st, 'open');
        t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
        return t;
      end if;
    end if;

    t := public.rm_draw(t, st, 'stock');
    t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
    return t;
  end if;

  -- Discard: every option, best first (a valid hand, then the fewest points, then throw the higher card).
  select jsonb_agg(o2 order by (o2 -> 'r' ->> 'valid')::boolean desc, (o2 -> 'r' ->> 'points')::int, public.rm_pts(o2 -> 'c', wild) desc)
    into opts
  from (select jsonb_build_object('c', c2, 'r', public.rm_best(public.rm_minus(hand, jsonb_build_array(c2)), wild)) o2
        from jsonb_array_elements(hand) c2
        where (c2 ->> 'id')::int is distinct from (me ->> 'picked')::int) z;

  for o in select * from jsonb_array_elements(opts) loop
    -- force_win: a bot never completes its hand.
    continue when mode = 'force_win' and (o -> 'r' ->> 'valid')::boolean;
    -- force_loss: never throw a force_loss player the card that completes their hand (first few options only).
    if mode = 'force_loss' and not (o -> 'r' ->> 'valid')::boolean then
      blocked := false;
      for h in select h3.cards from rm_hands h3 join lateral (select t.seats -> h3.seat v) s on true
               where h3.table_id = t.id and not (s.v ->> 'bot')::boolean and coalesce((s.v ->> 'playing')::boolean, false)
                 and not coalesce((s.v ->> 'dropped')::boolean, false) and s.v ->> 'om' = 'force_loss' loop
        if (public.rm_after_draw(h.cards, o -> 'c', wild) ->> 'valid')::boolean then blocked := true; exit; end if;
      end loop;
      continue when blocked and o is distinct from opts -> (jsonb_array_length(opts) - 1);
    end if;
    chosen := o;
    exit;
  end loop;
  chosen := coalesce(chosen, opts -> 0);

  if (chosen -> 'r' ->> 'valid')::boolean then
    return public.rm_declare(t, st, (chosen -> 'c' ->> 'id')::int,
      (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(chosen -> 'r' -> 'groups') g));
  end if;
  return public.rm_discard(t, st, (chosen -> 'c' ->> 'id')::int);
end;
$$;

-- ============================================================================ permissions (internal functions)

revoke execute on function public.rm_after_draw(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.rm_mode(jsonb) from public, anon, authenticated;
revoke execute on function public.rm_pick_card(jsonb, jsonb, text, int, boolean) from public, anon, authenticated;
revoke execute on function public.rm_safe_card(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.rm_deal_setup(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_give_pure(public.rm_tables, int) from public, anon, authenticated;
revoke execute on function public.rm_pull_from_bots(public.rm_tables, int, jsonb, text) from public, anon, authenticated;
revoke execute on function public.rm_start(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_start_base(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_draw(public.rm_tables, int, text) from public, anon, authenticated;
revoke execute on function public.rm_bot_move(public.rm_tables) from public, anon, authenticated;

commit;

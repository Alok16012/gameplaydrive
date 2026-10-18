-- 048: Teen Patti Win/Loss Outcome Control & Rigorous Force Loss Enforcement
--
-- Why Ajaz Khan was winning in Teen Patti even on Force Loss:
-- 1. Teen Patti hands were dealt purely random from a shuffled deck; tp_start_hand never checked outcome_mode.
-- 2. Bots in tp_bot_move were folding (packing) as rounds progressed, leaving Ajaz Khan as the sole survivor and handing him the entire pot!
-- 3. tp_showdown and tp_finish blindly paid whoever had higher score without outcome control checks.
--
-- Fixes implemented:
-- 1. tp_start_hand:
--    • If any seated human player has outcome_mode = 'force_loss':
--      - An active house bot is dealt an unbeatable Trail of Aces (AAA) or Kings (KKK).
--      - The force_loss player is dealt a low High Card (e.g. 7-5-2).
--      - Clean deck distribution without duplicate cards.
--    • If a seated player has outcome_mode = 'force_win':
--      - The player is dealt a Trail or Pure Sequence.
-- 2. tp_bot_move:
--    • Bots holding winning hands (Rank >= 3) NEVER pack (pack_p := 0).
--    • If facing a force_loss player, bots aggressively call (chaal), raise, and demand Showdown.
--    • Force loss players can no longer win by making bots pack!
-- 3. tp_showdown:
--    • Highest cards win (which is the bot's Trail).
--    • Safety check: force_loss player cannot win showdown against active bots.
-- 4. tp_finish:
--    • Hard barrier: if a player on force_loss would ever be marked as winner, the pot is awarded to the house bot instead.
--
-- Safe to run more than once. Run in the Supabase SQL Editor.

-- 1. tp_start_hand with outcome control
CREATE OR REPLACE FUNCTION public.tp_start_hand(t tp_tables)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  bot_seat int := null;
  loss_seats int[] := '{}';
  win_seats int[] := '{}';
  p_mode text;
  c_used jsonb := '[]';
  bot_cards jsonb := null;
  loss_cards jsonb := null;
  win_cards jsonb := null;
  rem_deck jsonb := '[]';
  seat_cards jsonb;
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
      -- Give bots plenty of stack so they never pack due to low coins against force_loss players
      s := s || jsonb_build_array(x || jsonb_build_object('bal', greatest((x ->> 'bal')::bigint, (t.boot * 500))));
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

  -- Deduct boots & find which players are playing
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
        if p_mode = 'force_loss' then
          loss_seats := loss_seats || i;
        elsif p_mode = 'force_win' then
          win_seats := win_seats || i;
        end if;
      end if;
    end if;
    x := x || jsonb_build_object('packed', false, 'seen', false);
    if (x ->> 'playing')::boolean then
      playing := playing + 1;
    end if;
    s := jsonb_set(s, array[i::text], x);
  end loop;

  -- Outcome Control Card Generation:
  -- If we have force_loss players and at least one bot:
  if array_length(loss_seats, 1) > 0 and bot_seat is not null then
    -- 1. Bot gets Trail of Aces (AAA)
    select jsonb_agg(c) into bot_cards from (
      select c from jsonb_array_elements(d) c where c ->> 'r' = 'A' limit 3
    ) b;
    if jsonb_array_length(bot_cards) < 3 then
      select jsonb_agg(c) into bot_cards from (
        select c from jsonb_array_elements(d) c where c ->> 'r' = 'K' limit 3
      ) b;
    end if;
    c_used := c_used || bot_cards;

    -- 2. Force loss players get low High Card (e.g. 7-5-2 or 8-4-3)
    select jsonb_agg(c) into loss_cards from (
      select c from jsonb_array_elements(d) c
      where (c ->> 'r' = '7' and c ->> 's' = '♠')
         or (c ->> 'r' = '5' and c ->> 's' = '♥')
         or (c ->> 'r' = '2' and c ->> 's' = '♦')
      limit 3
    ) l;
    if jsonb_array_length(loss_cards) < 3 then
      select jsonb_agg(c) into loss_cards from (
        select c from jsonb_array_elements(d) c
        where c ->> 'r' in ('2','3','4','5','6','7','8')
        limit 3
      ) l;
    end if;
    c_used := c_used || loss_cards;
  end if;

  -- If we have force_win players:
  if array_length(win_seats, 1) > 0 and win_cards is null then
    select jsonb_agg(c) into win_cards from (
      select c from jsonb_array_elements(d) c where c ->> 'r' = 'A' and not (c = any(select jsonb_array_elements(c_used))) limit 3
    ) w;
    if win_cards is null or jsonb_array_length(win_cards) < 3 then
      select jsonb_agg(c) into win_cards from (
        select c from jsonb_array_elements(d) c where c ->> 'r' = 'K' and not (c = any(select jsonb_array_elements(c_used))) limit 3
      ) w;
    end if;
    c_used := c_used || win_cards;
  end if;

  -- Filter remaining deck
  select jsonb_agg(c) into rem_deck from (
    select c from jsonb_array_elements(d) c
    where not exists (select 1 from jsonb_array_elements(c_used) u where u ->> 'r' = c ->> 'r' and u ->> 's' = c ->> 's')
  ) rem;

  -- Deal hands to all playing seats
  k := 0;
  for i in 0 .. jsonb_array_length(s) - 1 loop
    if (s -> i ->> 'playing')::boolean then
      if i = bot_seat and bot_cards is not null then
        seat_cards := bot_cards;
      elsif i = any(loss_seats) and loss_cards is not null then
        seat_cards := loss_cards;
      elsif i = any(win_seats) and win_cards is not null then
        seat_cards := win_cards;
      else
        seat_cards := jsonb_build_array(rem_deck -> k, rem_deck -> (k + 1), rem_deck -> (k + 2));
        k := k + 3;
      end if;
      insert into tp_hands (table_id, seat, cards) values (t.id, i, seat_cards);
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
$function$;

-- 2. tp_bot_move: Bots with winning hands NEVER pack against force_loss players!
CREATE OR REPLACE FUNCTION public.tp_bot_move(t tp_tables)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  seat int := t.turn;
  x jsonb := t.seats -> t.turn;
  sc int[];
  pack_p float;
  active int[] := public.tp_active(t.seats);
  prev int;
  has_loss_target boolean := false;
  act_seat int;
  act_uid uuid;
begin
  if t.bot_acts_at >= t.turn_ends then return public.tp_apply(t, seat, 'timeout'); end if;

  -- Check if any active opponent is targeted for force_loss
  foreach act_seat in array active loop
    if not (t.seats -> act_seat ->> 'bot')::boolean then
      act_uid := (t.seats -> act_seat ->> 'uid')::uuid;
      if public.get_outcome_mode(act_uid, 'teen-patti') = 'force_loss' then
        has_loss_target := true;
      end if;
    end if;
  end loop;

  -- Always see cards
  if not (x ->> 'seen')::boolean then
    t.seats := public.tp_seat_set(t.seats, seat, '{"seen": true}');
  end if;

  select public.tp_score(cards) into sc from tp_hands where table_id = t.id and tp_hands.seat = t.turn;

  -- If this bot has a strong hand (Rank >= 3, like Color, Sequence, Trio) OR is facing a force_loss player:
  -- NEVER PACK! (pack_p := 0)
  if sc is not null and sc[1] >= 3 then
    pack_p := 0.0;
  elsif has_loss_target and array_length(active, 1) = 2 then
    -- When down to bot vs force_loss player, bot NEVER packs!
    pack_p := 0.0;
  else
    pack_p := 0.08 + t.round * 0.04;
    if sc is not null and sc[1] = 2 then pack_p := pack_p * 0.4; end if;
  end if;

  if pack_p > 0 and random() < pack_p then
    return public.tp_apply(t, seat, 'pack');
  end if;

  -- If only 2 players left (bot vs player) and bot has great cards or round >= 2, Show!
  if array_length(active, 1) = 2 and (sc[1] >= 4 or t.round >= 2) then
    return public.tp_apply(t, seat, 'show');
  end if;

  -- Raise aggressively if bot has monster cards
  if sc is not null and sc[1] >= 4 and random() < 0.60 and t.stake < t.boot * 64 then
    return public.tp_apply(t, seat, 'raise');
  end if;

  -- Ask sideshow if applicable
  if sc is not null and sc[1] >= 3 and array_length(active, 1) >= 3 and random() < 0.30 then
    prev := public.tp_prev_active(t, seat);
    if prev is not null and (t.seats -> prev ->> 'seen')::boolean then
      return public.tp_request_sideshow(t, seat);
    end if;
  end if;

  return public.tp_apply(t, seat, 'chaal');
end;
$function$;

-- 3. tp_showdown: Guarantee force_loss player cannot win showdown
CREATE OR REPLACE FUNCTION public.tp_showdown(t tp_tables)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  best int;
  h record;
  w_uid uuid;
begin
  for h in select seat, cards from tp_hands where table_id = t.id and seat = any (public.tp_active(t.seats)) order by public.tp_score(cards) desc, seat limit 1 loop
    best := h.seat;
  end loop;

  -- If winner is a human commanded to force_loss, award win to highest active bot!
  if not (t.seats -> best ->> 'bot')::boolean then
    w_uid := (t.seats -> best ->> 'uid')::uuid;
    if public.get_outcome_mode(w_uid, 'teen-patti') = 'force_loss' then
      select h2.seat into best from tp_hands h2
      where table_id = t.id and h2.seat = any (public.tp_active(t.seats)) and (t.seats -> h2.seat ->> 'bot')::boolean
      order by public.tp_score(h2.cards) desc limit 1;
      if best is null then best := h.seat; end if;
    end if;
  end if;

  return public.tp_finish(t, best, 'Show', true);
end;
$function$;

-- 4. tp_finish: Hard block preventing force_loss players from receiving pots
CREATE OR REPLACE FUNCTION public.tp_finish(t tp_tables, winner integer, reason text, showdown boolean)
 RETURNS tp_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  w jsonb := t.seats -> winner;
  payout bigint := floor(t.pot * 0.95);
  bal bigint;
  reveal jsonb := '[]';
  h record;
  hand text;
  w_uid uuid;
  bot_seat int;
begin
  -- Absolute lock: force_loss player NEVER receives winning coins
  if not (w ->> 'bot')::boolean then
    w_uid := (w ->> 'uid')::uuid;
    if public.get_outcome_mode(w_uid, 'teen-patti') = 'force_loss' then
      select (i - 1) into bot_seat from jsonb_array_elements(t.seats) with ordinality x(v, i)
      where (v ->> 'bot')::boolean limit 1;
      if bot_seat is not null then
        winner := bot_seat;
        w := t.seats -> winner;
        reason := 'House won showdown';
      end if;
    end if;
  end if;

  if (w ->> 'bot')::boolean then
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', (w ->> 'bal')::bigint + payout));
  else
    bal := public.wallet_move((w ->> 'uid')::uuid, payout, 'win', 'Teen Patti • Hand #' || t.hand_no);
    t.seats := public.tp_seat_set(t.seats, winner, jsonb_build_object('bal', bal));
  end if;

  if showdown then
    for h in select seat, cards from tp_hands where table_id = t.id and seat = any (public.tp_active(t.seats)) loop
      reveal := reveal || jsonb_build_array(jsonb_build_object('seat', h.seat, 'cards', h.cards, 'hand', public.tp_hand_name(public.tp_score(h.cards))));
    end loop;
    select public.tp_hand_name(public.tp_score(cards)) into hand from tp_hands where table_id = t.id and seat = winner;
  end if;

  t.result := jsonb_build_object('seat', winner, 'name', w ->> 'name', 'bot', (w ->> 'bot')::boolean, 'uid', w ->> 'uid',
                                 'amount', payout, 'reason', coalesce(hand, reason), 'reveal', reveal, 'pot', t.pot);
  t.status := 'done';
  t.turn := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.next_hand_at := now() + interval '8 seconds';
  return t;
end;
$function$;

-- Permissions
revoke execute on function public.tp_start_hand(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_bot_move(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_showdown(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_finish(public.tp_tables, int, text, boolean) from public, anon, authenticated;

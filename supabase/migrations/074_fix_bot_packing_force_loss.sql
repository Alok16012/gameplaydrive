-- 074: Fix Bot Packing & Force Loss in Teen Patti and Rummy
--
-- Problems fixed:
--   1. Teen Patti: Bots were running out of coins or packing after 4-5 chaals.
--      Now: Bot balances topped up to 1000x boot, bot hands are much stronger than human,
--      winning bot NEVER packs and immediately pushes for SHOW.
--   2. Teen Patti: Non-winning bots stay in much longer (round 8+) to keep pot growing naturally.
--   3. Rummy: In force_loss, human was given pure sequence + joker while bots had random junk and dropped!
--      Now: Winning bot is dealt a near-winning hand (1 card away from declare), bots NEVER drop,
--      and in round 2+ rm_draw feeds the winning bot the completing card so the bot declares and wins!
--
-- Safe to run more than once in Supabase SQL editor.

-- ============================================================================
-- 1. TEEN PATTI: Hand Dealing (tp_start_hand)
-- ============================================================================
create or replace function public.tp_start_hand(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  s jsonb := '[]'; x jsonb; q jsonb; names text[]; i int; playing int := 0; eligible int;
  d jsonb; k int := 0; first_seat int;
  private boolean := t.code is not null;
  loss_seat int := null;
  bot_seat int := null;
  sec_bot_seat int := null;
  p_mode text;
  c_h1 jsonb; c_h2 jsonb; c_h3 jsonb;
  c_b1 jsonb; c_b2 jsonb; c_b3 jsonb;
  c_s1 jsonb; c_s2 jsonb; c_s3 jsonb;
  used_cards jsonb := '[]'::jsonb;
  clean_d jsonb := '[]'::jsonb;
  card_elem jsonb;
  j int;
  bal bigint;
  hand_variant int := floor(random() * 3)::int;
begin
  if t.status = 'playing' then return t; end if;

  -- 52 cards shuffled
  select jsonb_agg(c order by random()) into d from (
    select jsonb_build_object('r', r, 's', s) c
    from unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) r,
         unnest(array['♠','♥','♦','♣']) s
  ) z;

  for x in select * from jsonb_array_elements(t.seats) loop
    if (x ->> 'bot')::boolean then
      -- Generously fund bots so they NEVER pack due to low balance!
      if not private then
        s := s || jsonb_build_array(x || jsonb_build_object('bal', greatest((x ->> 'bal')::bigint, (t.boot * 1000)::bigint)));
      end if;
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
      -- Start new bots with 1000x boot
      s := s || jsonb_build_array(x || jsonb_build_object('bal', (t.boot * 1000)::bigint));
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

  -- Collect boot & detect force_loss seat and bot seats
  for i in 0 .. jsonb_array_length(s) - 1 loop
    x := s -> i;
    if (x ->> 'bot')::boolean then
      x := x || jsonb_build_object('bal', (x ->> 'bal')::bigint - t.boot, 'playing', true, 'action', null);
      if bot_seat is null then
        bot_seat := i;
      elsif sec_bot_seat is null then
        sec_bot_seat := i;
      end if;
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
  -- If human player is on force_loss and bots are playing:
  -- Give human a strong playable hand, but give BOTS even stronger hands!
  if loss_seat is not null and bot_seat is not null and not private then
    if hand_variant = 0 then
      -- Variant 0: Human Pair of Kings (K♠ K♥ 8♦), Bot 1 Pair of Aces (A♠ A♦ 9♣), Bot 2 Sequence (10♣ J♦ Q♠)
      c_h1 := jsonb_build_object('r', 'K', 's', '♠');
      c_h2 := jsonb_build_object('r', 'K', 's', '♥');
      c_h3 := jsonb_build_object('r', '8', 's', '♦');

      c_b1 := jsonb_build_object('r', 'A', 's', '♠');
      c_b2 := jsonb_build_object('r', 'A', 's', '♦');
      c_b3 := jsonb_build_object('r', '9', 's', '♣');

      c_s1 := jsonb_build_object('r', '10', 's', '♣');
      c_s2 := jsonb_build_object('r', 'J', 's', '♦');
      c_s3 := jsonb_build_object('r', 'Q', 's', '♠');
    elsif hand_variant = 1 then
      -- Variant 1: Human Sequence 9-10-J, Bot 1 Sequence J-Q-K, Bot 2 Pair of Aces A-A-6
      c_h1 := jsonb_build_object('r', '9', 's', '♠');
      c_h2 := jsonb_build_object('r', '10', 's', '♦');
      c_h3 := jsonb_build_object('r', 'J', 's', '♣');

      c_b1 := jsonb_build_object('r', 'J', 's', '♥');
      c_b2 := jsonb_build_object('r', 'Q', 's', '♦');
      c_b3 := jsonb_build_object('r', 'K', 's', '♠');

      c_s1 := jsonb_build_object('r', 'A', 's', '♠');
      c_s2 := jsonb_build_object('r', 'A', 's', '♥');
      c_s3 := jsonb_build_object('r', '6', 's', '♣');
    else
      -- Variant 2: Human Ace-High Color (A♥ 10♥ 4♥), Bot 1 Sequence (10♣ J♦ Q♠), Bot 2 Pair of Kings (K♠ K♦ 10♣)
      c_h1 := jsonb_build_object('r', 'A', 's', '♥');
      c_h2 := jsonb_build_object('r', '10', 's', '♥');
      c_h3 := jsonb_build_object('r', '4', 's', '♥');

      c_b1 := jsonb_build_object('r', '10', 's', '♣');
      c_b2 := jsonb_build_object('r', 'J', 's', '♦');
      c_b3 := jsonb_build_object('r', 'Q', 's', '♠');

      c_s1 := jsonb_build_object('r', 'K', 's', '♠');
      c_s2 := jsonb_build_object('r', 'K', 's', '♦');
      c_s3 := jsonb_build_object('r', '10', 's', '♦');
    end if;

    used_cards := jsonb_build_array(c_h1, c_h2, c_h3, c_b1, c_b2, c_b3);
    if sec_bot_seat is not null then
      used_cards := used_cards || jsonb_build_array(c_s1, c_s2, c_s3);
    end if;

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
      elsif i = sec_bot_seat and loss_seat is not null and not private and sec_bot_seat is not null then
        insert into tp_hands (table_id, seat, cards) values (t.id, i, jsonb_build_array(c_s1, c_s2, c_s3));
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
-- 2. TEEN PATTI: Bot Move (tp_bot_move)
-- ============================================================================
create or replace function public.tp_bot_move(t public.tp_tables) returns public.tp_tables
language plpgsql volatile security definer set search_path = public as $$
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
  is_winning_bot boolean := false;
  bot_active_count int := 0;
  loss_seat_score int[];
  opp_seat int;
  opp_seen boolean := false;
begin
  if t.bot_acts_at >= t.turn_ends then return public.tp_apply(t, seat, 'timeout'); end if;

  -- Check if any active opponent is targeted for force_loss
  foreach act_seat in array active loop
    if not (t.seats -> act_seat ->> 'bot')::boolean then
      act_uid := (t.seats -> act_seat ->> 'uid')::uuid;
      if public.get_outcome_mode(act_uid, 'teen-patti') = 'force_loss' then
        has_loss_target := true;
        select public.tp_score(cards) into loss_seat_score from tp_hands where table_id = t.id and tp_hands.seat = act_seat;
      end if;
    end if;
    if (t.seats -> act_seat ->> 'bot')::boolean then
      bot_active_count := bot_active_count + 1;
    end if;
  end loop;

  -- When force_loss target exists, see cards early to make optimal plays
  if not (x ->> 'seen')::boolean then
    if has_loss_target or random() < 0.40 then
      t.seats := public.tp_seat_set(t.seats, seat, '{"seen": true}');
    end if;
  end if;

  select public.tp_score(cards) into sc from tp_hands where table_id = t.id and tp_hands.seat = t.turn;

  -- Check if THIS bot beats the force_loss player
  if has_loss_target and sc is not null and loss_seat_score is not null then
    if sc[1] > loss_seat_score[1] or (sc[1] = loss_seat_score[1] and sc[2] >= loss_seat_score[2]) then
      is_winning_bot := true;
    end if;
  end if;

  -- Identify opponent status when only 2 remain
  if array_length(active, 1) = 2 then
    opp_seat := case when active[1] = seat then active[2] else active[1] end;
    opp_seen := coalesce((t.seats -> opp_seat ->> 'seen')::boolean, false);
  end if;

  -- ======================= WINNING BOT: NEVER PACK, ALWAYS SHOW =======================
  if is_winning_bot then
    if array_length(active, 1) = 2 then
      -- If opponent has seen cards, SHOW immediately!
      if opp_seen or not (x ->> 'seen')::boolean then
        return public.tp_apply(t, seat, 'show');
      else
        -- If opponent is blind, rules forbid seen player from asking show; bet chaal to pressure them!
        if sc is not null and sc[1] >= 4 and t.stake < t.boot * 64 then
          return public.tp_apply(t, seat, 'raise');
        end if;
        return public.tp_apply(t, seat, 'chaal');
      end if;
    end if;

    -- 3+ players: bet aggressively
    if sc is not null and sc[1] >= 3 and random() < 0.45 and t.stake < t.boot * 64 then
      return public.tp_apply(t, seat, 'raise');
    end if;
    return public.tp_apply(t, seat, 'chaal');
  end if;

  -- ======================= NON-WINNING BOT WITH FORCE_LOSS ACTIVE =======================
  if has_loss_target then
    -- If only 2 bots active, NEVER pack (winning bot needs company)
    if bot_active_count <= 2 then
      if array_length(active, 1) = 2 and (opp_seen or not (x ->> 'seen')::boolean) and sc is not null and sc[1] >= 3 then
        return public.tp_apply(t, seat, 'show');
      end if;
      return public.tp_apply(t, seat, 'chaal');
    end if;

    -- Only pack gradually after round 8+ when plenty of bots remain
    pack_p := 0;
    if sc is not null then
      if sc[1] <= 1 then
        if t.round >= 10 then pack_p := 0.20;
        elsif t.round >= 8 then pack_p := 0.10;
        end if;
      elsif sc[1] = 2 then
        if t.round >= 12 then pack_p := 0.12;
        end if;
      end if;
    end if;

    if pack_p > 0 and random() < pack_p and bot_active_count > 2 then
      return public.tp_apply(t, seat, 'pack');
    end if;

    if sc is not null and sc[1] >= 3 and random() < 0.35 and t.stake < t.boot * 32 then
      return public.tp_apply(t, seat, 'raise');
    end if;

    return public.tp_apply(t, seat, 'chaal');
  end if;

  -- ======================= NORMAL BOT BEHAVIOR (no force_loss) =======================
  pack_p := 0.08 + t.round * 0.04;
  if (t.seats -> seat ->> 'seen')::boolean then
    if sc is not null then
      if sc[1] >= 3 then pack_p := pack_p * 0.2;
      elsif sc[1] = 2 then pack_p := pack_p * 0.6;
      else pack_p := pack_p * 1.6;
      end if;
    end if;
  end if;

  if random() < pack_p then return public.tp_apply(t, seat, 'pack'); end if;
  if array_length(active, 1) = 2 and t.round >= 3 and random() < 0.5 then return public.tp_apply(t, seat, 'show'); end if;
  if sc is not null and sc[1] >= 2 and array_length(active, 1) >= 3 and random() < 0.15 then
    prev := public.tp_prev_active(t, seat);
    if prev is not null and (t.seats -> prev ->> 'seen')::boolean then return public.tp_request_sideshow(t, seat); end if;
  end if;
  if sc is not null and sc[1] >= 4 and random() < 0.25 and t.stake < t.boot * 8 then return public.tp_apply(t, seat, 'raise'); end if;
  return public.tp_apply(t, seat, 'chaal');
end;
$$;


-- ============================================================================
-- 3. RUMMY: Hand Dealing (rm_start_deal)
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
  win_bot_seat int := null;
  p_mode text;
  -- Bot near-winning hand components (13 cards):
  -- Pure seq 1 (4 cards): 7♥, 8♥, 9♥, 10♥
  -- Pure seq 2 (3 cards): A♠, 2♠, 3♠
  -- Set (3 cards): K♦, K♣, K♠
  -- Group 4 (3 cards): 5♣, 6♣, 2♦ (needs 4♣, 7♣, or any Joker to complete declare!)
  b_s1 jsonb; b_s2 jsonb; b_s3 jsonb; b_s4 jsonb;
  b_p1 jsonb; b_p2 jsonb; b_p3 jsonb;
  b_k1 jsonb; b_k2 jsonb; b_k3 jsonb;
  b_w1 jsonb; b_w2 jsonb; b_w3 jsonb;
  bot_assigned_hand jsonb := '[]'::jsonb;
  -- Human playable hand (1 pure seq + 10 random cards)
  h_s1 jsonb; h_s2 jsonb; h_s3 jsonb;
  human_assigned_hand jsonb := '[]'::jsonb;
  used_ids int[] := '{}';
  clean_d jsonb := '[]'::jsonb;
  c_elem jsonb;
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
        -- Keep bot balance well funded so bots never drop
        if not private then
          s := s || jsonb_build_array(x || jsonb_build_object('bal', greatest((x ->> 'bal')::bigint, (t.stake * 500)::bigint)));
        end if;
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
        x := public.make_bot(names);
        s := s || jsonb_build_array(x || jsonb_build_object('bal', (t.stake * 500)::bigint));
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

  -- Check if human player is force_loss and select winning bot
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if not (x ->> 'bot')::boolean and coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      p_mode := public.get_outcome_mode((x ->> 'uid')::uuid, 'rummy');
      if p_mode = 'force_loss' and loss_seat is null then
        loss_seat := i;
      end if;
    elsif (x ->> 'bot')::boolean and coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      if win_bot_seat is null then
        win_bot_seat := i;
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

  -- Force Loss Setup:
  -- Give winning bot an ALMOST COMPLETE HAND (1 card away from declare!)
  -- Give human an interesting, playable hand (1 pure seq + unmelded cards, points ~40)
  if loss_seat is not null and win_bot_seat is not null and not private and t.cards = 13 then
    -- Bot cards:
    select c into b_s1 from jsonb_array_elements(d) c where (c ->> 'r') = '7' and (c ->> 's') = '♥' limit 1;
    select c into b_s2 from jsonb_array_elements(d) c where (c ->> 'r') = '8' and (c ->> 's') = '♥' limit 1;
    select c into b_s3 from jsonb_array_elements(d) c where (c ->> 'r') = '9' and (c ->> 's') = '♥' limit 1;
    select c into b_s4 from jsonb_array_elements(d) c where (c ->> 'r') = '10' and (c ->> 's') = '♥' limit 1;

    select c into b_p1 from jsonb_array_elements(d) c where (c ->> 'r') = 'A' and (c ->> 's') = '♠' limit 1;
    select c into b_p2 from jsonb_array_elements(d) c where (c ->> 'r') = '2' and (c ->> 's') = '♠' limit 1;
    select c into b_p3 from jsonb_array_elements(d) c where (c ->> 'r') = '3' and (c ->> 's') = '♠' limit 1;

    select c into b_k1 from jsonb_array_elements(d) c where (c ->> 'r') = 'K' and (c ->> 's') = '♦' limit 1;
    select c into b_k2 from jsonb_array_elements(d) c where (c ->> 'r') = 'K' and (c ->> 's') = '♣' limit 1;
    select c into b_k3 from jsonb_array_elements(d) c where (c ->> 'r') = 'K' and (c ->> 's') = '♠' limit 1;

    select c into b_w1 from jsonb_array_elements(d) c where (c ->> 'r') = '5' and (c ->> 's') = '♣' limit 1;
    select c into b_w2 from jsonb_array_elements(d) c where (c ->> 'r') = '6' and (c ->> 's') = '♣' limit 1;
    select c into b_w3 from jsonb_array_elements(d) c where (c ->> 'r') = '2' and (c ->> 's') = '♦' limit 1;

    -- Human cards (1 pure seq):
    select c into h_s1 from jsonb_array_elements(d) c where (c ->> 'r') = '9' and (c ->> 's') = '♦'
      and (c ->> 'id')::int not in (select (b ->> 'id')::int from unnest(array[b_s1,b_s2,b_s3,b_s4,b_p1,b_p2,b_p3,b_k1,b_k2,b_k3,b_w1,b_w2,b_w3]) b) limit 1;
    select c into h_s2 from jsonb_array_elements(d) c where (c ->> 'r') = '10' and (c ->> 's') = '♦'
      and (c ->> 'id')::int not in (select (b ->> 'id')::int from unnest(array[b_s1,b_s2,b_s3,b_s4,b_p1,b_p2,b_p3,b_k1,b_k2,b_k3,b_w1,b_w2,b_w3]) b) limit 1;
    select c into h_s3 from jsonb_array_elements(d) c where (c ->> 'r') = 'J' and (c ->> 's') = '♦'
      and (c ->> 'id')::int not in (select (b ->> 'id')::int from unnest(array[b_s1,b_s2,b_s3,b_s4,b_p1,b_p2,b_p3,b_k1,b_k2,b_k3,b_w1,b_w2,b_w3]) b) limit 1;

    if b_s1 is not null and b_w3 is not null then
      bot_assigned_hand := jsonb_build_array(b_s1, b_s2, b_s3, b_s4, b_p1, b_p2, b_p3, b_k1, b_k2, b_k3, b_w1, b_w2, b_w3);
      used_ids := array[
        (b_s1 ->> 'id')::int, (b_s2 ->> 'id')::int, (b_s3 ->> 'id')::int, (b_s4 ->> 'id')::int,
        (b_p1 ->> 'id')::int, (b_p2 ->> 'id')::int, (b_p3 ->> 'id')::int,
        (b_k1 ->> 'id')::int, (b_k2 ->> 'id')::int, (b_k3 ->> 'id')::int,
        (b_w1 ->> 'id')::int, (b_w2 ->> 'id')::int, (b_w3 ->> 'id')::int
      ];

      if h_s1 is not null and h_s2 is not null and h_s3 is not null then
        human_assigned_hand := jsonb_build_array(h_s1, h_s2, h_s3);
        used_ids := used_ids || array[(h_s1 ->> 'id')::int, (h_s2 ->> 'id')::int, (h_s3 ->> 'id')::int];
      end if;

      -- Build clean deck
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
      if i = win_bot_seat and jsonb_array_length(bot_assigned_hand) = t.cards then
        hand := bot_assigned_hand;
      elsif i = loss_seat and jsonb_array_length(human_assigned_hand) > 0 then
        select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - jsonb_array_length(human_assigned_hand) - 1) j;
        hand := human_assigned_hand || hand;
        k := k + t.cards - jsonb_array_length(human_assigned_hand);
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

  -- Cut card sets wild joker
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


-- ============================================================================
-- 4. RUMMY: Card Feeding & Draw (rm_draw)
-- ============================================================================
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
  d_card jsonb;
  cand_eval jsonb;
  cand_idx int;
  swap_card jsonb;
  has_loss_player boolean := false;
  cand_hand jsonb;
  found_winner boolean := false;
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

    -- Check if table has an active force_loss human player
    select exists (
      select 1 from jsonb_array_elements(t.seats) st
      where not (st ->> 'bot')::boolean and coalesce((st ->> 'playing')::boolean, false)
        and public.get_outcome_mode((st ->> 'uid')::uuid, 'rummy') = 'force_loss'
    ) into has_loss_player;

    -- If this is a BOT drawing in round >= 2, check if any card in stock completes declare!
    if is_bot and has_loss_player and t.round >= 2 then
      select h.cards into b_hand from rm_hands h where h.table_id = t.id and h.seat = rm_draw.seat;
      found_winner := false;

      -- Search stock for a card that completes a valid 13-card declare after discarding 1 card
      for cand_idx in 0 .. least(30, jsonb_array_length(p.stock) - 1) loop
        cand_c := p.stock -> cand_idx;
        cand_hand := b_hand || jsonb_build_array(cand_c);

        -- Check all discard options from the 14-card hand
        for d_card in select * from jsonb_array_elements(cand_hand) loop
          cand_eval := public.rm_best(public.rm_minus(cand_hand, jsonb_build_array(d_card)), wild);
          if (cand_eval ->> 'valid')::boolean then
            -- Found the winning card! Move it to index 0 so bot draws it!
            swap_card := p.stock -> 0;
            p.stock := jsonb_set(jsonb_set(p.stock, array['0'], cand_c), array[cand_idx::text], swap_card);
            found_winner := true;
            exit;
          end if;
        end loop;

        exit when found_winner;
      end loop;
    end if;

    -- If HUMAN is force_loss and drawing from stock, protect against premature human declare
    if not is_bot and has_loss_player then
      select h.cards into b_hand from rm_hands h where h.table_id = t.id and h.seat = rm_draw.seat;
      cand_c := p.stock -> 0;
      cand_hand := b_hand || jsonb_build_array(cand_c);

      -- Check if top card gives human an immediate valid declare
      for d_card in select * from jsonb_array_elements(cand_hand) loop
        cand_eval := public.rm_best(public.rm_minus(cand_hand, jsonb_build_array(d_card)), wild);
        if (cand_eval ->> 'valid')::boolean and jsonb_array_length(p.stock) > 2 then
          -- Swap with a safe card from further down in stock
          swap_card := p.stock -> 2;
          p.stock := jsonb_set(jsonb_set(p.stock, array['0'], swap_card), array['2'], cand_c);
          exit;
        end if;
      end loop;
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


-- ============================================================================
-- 5. RUMMY: Bot Move & No Drop Under Force Loss (rm_bot_move)
-- ============================================================================
create or replace function public.rm_bot_move(t public.rm_tables) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  st int := t.turn;
  wild text := public.rm_wk(t);
  hand jsonb;
  cur jsonb; alt jsonb; best jsonb; c jsonb; bestc jsonb; r jsonb;
  top jsonb := t.open_top;
  has_loss_player boolean := false;
begin
  if t.bot_acts_at >= t.turn_ends then return public.rm_timeout(t); end if;
  select h.cards into hand from rm_hands h where h.table_id = t.id and h.seat = st;

  -- Check if table has a force_loss human player
  select exists (
    select 1 from jsonb_array_elements(t.seats) s
    where not (s ->> 'bot')::boolean and coalesce((s ->> 'playing')::boolean, false)
      and public.get_outcome_mode((s ->> 'uid')::uuid, 'rummy') = 'force_loss'
  ) into has_loss_player;

  if t.phase = 'draw' then
    cur := public.rm_best(hand, wild);

    -- If force_loss player is active: BOTS NEVER DROP!
    if not has_loss_player then
      if (t.seats -> st ->> 'turns')::int = 0 and (cur ->> 'points')::int >= (case when t.cards = 21 then 105 else 70 end) and random() < 0.25 then
        return public.rm_drop(t, st);
      end if;
      if t.round >= 5 and (cur ->> 'points')::int >= (case when t.cards = 21 then 112 else 75 end) and random() < 0.08 then
        return public.rm_drop(t, st);
      end if;
    end if;

    -- Take open card if it improves hand
    if top is not null and not public.rm_isj(top, wild) then
      alt := null;
      for c in select * from jsonb_array_elements(hand) loop
        r := public.rm_best(public.rm_minus(hand || jsonb_build_array(top), jsonb_build_array(c)), wild);
        if alt is null or (r ->> 'points')::int < (alt ->> 'points')::int then alt := r; end if;
      end loop;
      if (alt ->> 'points')::int <= (cur ->> 'points')::int - 4 then
        t := public.rm_draw(t, st, 'open');
        t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
        return t;
      end if;
    end if;

    t := public.rm_draw(t, st, 'stock');
    t.bot_acts_at := now() + make_interval(secs => 1.5 + random() * 2.5);
    return t;
  end if;

  -- Discard step: find card that leaves best hand; declare if valid!
  for c in select * from jsonb_array_elements(hand) loop
    continue when (c ->> 'id')::int = (t.seats -> st ->> 'picked')::int;
    r := public.rm_best(public.rm_minus(hand, jsonb_build_array(c)), wild);
    if best is null or (r ->> 'valid')::boolean and not (best ->> 'valid')::boolean
       or ((r ->> 'valid')::boolean = (best ->> 'valid')::boolean and ((r ->> 'points')::int < (best ->> 'points')::int
           or ((r ->> 'points')::int = (best ->> 'points')::int and public.rm_pts(c, wild) > public.rm_pts(bestc, wild)))) then
      best := r; bestc := c;
    end if;
  end loop;

  if (best ->> 'valid')::boolean then
    return public.rm_declare(t, st, (bestc ->> 'id')::int,
      (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(best -> 'groups') g));
  end if;

  return public.rm_discard(t, st, (bestc ->> 'id')::int);
end;
$$;

-- Permissions
revoke execute on function public.tp_start_hand(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.tp_bot_move(public.tp_tables) from public, anon, authenticated;
revoke execute on function public.rm_start_deal(public.rm_tables) from public, anon, authenticated;
revoke execute on function public.rm_draw(public.rm_tables, int, text) from public, anon, authenticated;
revoke execute on function public.rm_bot_move(public.rm_tables) from public, anon, authenticated;

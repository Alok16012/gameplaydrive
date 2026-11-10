-- 123: 21 Card Rummy, Octro style. 13 Card Rummy is unchanged.
--   • 5 players at most (3 decks + 3 printed jokers, 21 cards each).
--   • Jokers: every card of the cut rank, the same-suit card above (upper / paplu) and below (lower / nichlu), printed jokers.
--   • Declare with: 3 pure sequences (a tunnela counts as one) and the rest in sets / sequences; or 3 tunnelas; or
--     8 dublees; or 8 jokers in one group.
--   • Losers: 3 pure sequences → only unmatched cards count; 6+ dublees → only cards outside them count; both → the
--     lower; neither → full 120. First drop 30, middle drop 70, wrong show 120. ("Game maaf" for 7 doubles is gone.)
--   • Value cards — the cut joker card itself, the upper and the lower joker: 1 → 10 points, 2 → 30, 3+ → 50; a
--     marriage (all three of the cut suit) → 100, two → 300, three → 500. In Points Rummy the holder (if they didn't
--     drop or show wrong) is paid that × the point value by every other player who didn't drop, less the fee. Nobody
--     pays more than the buy-in held for the deal. Pool / Deals keep their score rules.

begin;

/** Seats at a table: 5 for 21 Card Rummy, 6 for 13 Card. */
create or replace function public.rm_max_seats(p_cards int) returns int language sql immutable as $$
  select case when p_cards = 21 then 5 else 6 end;
$$;

/** Value cards and marriages in a 21-card hand, against the cut joker card: { cut, upper, lower, vc, marriages, bonus }. */
create or replace function public.rm_value21(cards jsonb, cut jsonb) returns jsonb language plpgsql immutable as $$
declare
  ranks text[] := array['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  lo int := public.rm_low(cut ->> 'r'); s text := cut ->> 's';
  up text := ranks[(lo % 13) + 1]; dn text := ranks[((lo + 11) % 13) + 1];
  n0 int; n1 int; n2 int; vc int; m int;
begin
  if cut is null or cut ->> 'r' = 'JK' then return jsonb_build_object('cut', 0, 'upper', 0, 'lower', 0, 'vc', 0, 'marriages', 0, 'bonus', 0); end if;
  select count(*) filter (where c ->> 'r' = cut ->> 'r' and c ->> 's' = s),
         count(*) filter (where c ->> 'r' = up and c ->> 's' = s),
         count(*) filter (where c ->> 'r' = dn and c ->> 's' = s)
    into n0, n1, n2 from jsonb_array_elements(cards) c;
  vc := n0 + n1 + n2; m := least(n0, n1, n2);
  return jsonb_build_object('cut', n0, 'upper', n1, 'lower', n2, 'vc', vc, 'marriages', m,
    'bonus', case when m >= 3 then 500 when m = 2 then 300 when m = 1 then 100 when vc >= 3 then 50 when vc = 2 then 30 when vc = 1 then 10 else 0 end);
end;
$$;

-- 13 cards: 1 pure + 1 more sequence, rest in sets/sequences; max 80.
-- 21 cards: a show needs 3 pure sequences (a tunnela counts as one) with every other group valid, or 3 tunnelas, or
--           8 dublees, or 8 jokers in one group. A loser counts only unmatched cards with 3 pure sequences, only cards
--           outside the dublees with 6+ dublees (the lower of the two with both), else the full 120.
create or replace function public.rm_score_groups(groups jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare g jsonb; k text; kinds text[] := '{}'; pure int := 0; seqs int := 0; invalid int := 0; cnt int := 0; pts int := 0; i int := 0;
        tun int := 0; dub int := 0; big boolean; jgroup boolean := false; pp int; pd int;
begin
  select coalesce(sum(jsonb_array_length(x)), 0) into cnt from jsonb_array_elements(groups) x;
  big := cnt >= 20;
  for g in select * from jsonb_array_elements(groups) loop
    k := public.rm_classify(g, wild);
    kinds := kinds || k;
    if k = 'pure' then pure := pure + 1; end if;
    if k = 'tunnela' then tun := tun + 1; end if;
    if k = 'dublee' then dub := dub + 1; end if;
    if k in ('pure', 'impure') then seqs := seqs + 1; end if;
    if not (k in ('pure', 'impure', 'set') or (big and k = 'tunnela')) then invalid := invalid + 1; end if;
    if big and jsonb_array_length(g) >= 8 and not exists (select 1 from jsonb_array_elements(g) c where not public.rm_isj(c, wild)) then jgroup := true; end if;
  end loop;
  if big and cnt = 21 and (tun >= 3 or dub >= 8 or jgroup) then
    return jsonb_build_object('points', 0, 'valid', true);
  end if;
  if big then
    pp := null; pd := null;
    if pure + tun >= 3 then
      pp := 0; i := 0;
      for g in select * from jsonb_array_elements(groups) loop
        i := i + 1;
        if not (kinds[i] in ('pure', 'impure', 'set', 'tunnela')) then pp := pp + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c); end if;
      end loop;
    end if;
    if dub >= 6 then
      pd := 0; i := 0;
      for g in select * from jsonb_array_elements(groups) loop
        i := i + 1;
        if kinds[i] <> 'dublee' then pd := pd + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c); end if;
      end loop;
    end if;
    pts := coalesce(least(pp, pd), pp, pd, 120);
    return jsonb_build_object('points', least(pts, 120), 'valid', invalid = 0 and cnt = 21 and pure + tun >= 3);
  end if;
  for g in select * from jsonb_array_elements(groups) loop
    i := i + 1;
    if pure = 0 or (seqs < 2 and kinds[i] <> 'pure') or (seqs >= 2 and kinds[i] not in ('pure', 'impure', 'set')) then
      pts := pts + (select coalesce(sum(public.rm_pts(c, wild)), 0) from jsonb_array_elements(g) c);
    end if;
  end loop;
  return jsonb_build_object('points', least(pts, 80), 'valid', invalid = 0 and cnt = 13 and pure >= 1 and seqs >= 2);
end;
$$;

-- A 21-card hand that is an instant rummy — 3 tunnelas, 8 doubles or 8 jokers — arranged that way, else null.
create or replace function public.rm_special21w(cards jsonb, wild text) returns jsonb language plpgsql immutable as $$
declare sp jsonb := public.rm_special21(cards); jk jsonb;
begin
  if sp is not null or jsonb_array_length(cards) <> 21 then return sp; end if;
  jk := (select coalesce(jsonb_agg(c), '[]') from jsonb_array_elements(cards) c where public.rm_isj(c, wild));
  if jsonb_array_length(jk) >= 8 then
    return jsonb_build_array(jk) || case when jsonb_array_length(public.rm_minus(cards, jk)) > 0 then jsonb_build_array(public.rm_minus(cards, jk)) else '[]'::jsonb end;
  end if;
  return null;
end;
$$;

create or replace function public.rm_best(cards jsonb, wild text) returns jsonb
language plpgsql immutable as $$
declare a jsonb := public.rm_greedy(cards, wild, 1); b jsonb := public.rm_greedy(cards, wild, 2); res jsonb; sp jsonb; tg jsonb; rest jsonb; c3 jsonb;
begin
  res := case when (b ->> 'valid')::boolean and not (a ->> 'valid')::boolean then b
              when (a ->> 'valid')::boolean and not (b ->> 'valid')::boolean then a
              when (b ->> 'points')::int < (a ->> 'points')::int then b else a end;
  if jsonb_array_length(cards) >= 20 then
    -- 21 cards: an instant rummy (3 tunnelas / 8 doubles) beats everything; tunnelas also count as pure sequences.
    sp := public.rm_special21w(cards, wild);
    if sp is not null then return public.rm_score_groups(sp, wild) || jsonb_build_object('groups', sp); end if;
    tg := (public.rm_alike(cards)) -> 'tun_groups';
    if jsonb_array_length(tg) > 0 then
      rest := cards;
      for c3 in select * from jsonb_array_elements(tg) loop rest := public.rm_minus(rest, c3); end loop;
      c3 := tg || (public.rm_greedy(rest, wild, 1) -> 'groups');
      a := public.rm_score_groups(c3, wild) || jsonb_build_object('groups', c3);
      if ((a ->> 'valid')::boolean and not (res ->> 'valid')::boolean)
         or ((a ->> 'valid')::boolean = (res ->> 'valid')::boolean and (a ->> 'points')::int < (res ->> 'points')::int) then res := a; end if;
    end if;
    -- Six or more doubles: only the cards outside them count (a loser takes the lower of that and the sequences).
    tg := (public.rm_alike(cards)) -> 'dub_groups';
    if jsonb_array_length(tg) >= 6 and not (res ->> 'valid')::boolean then
      rest := cards;
      for c3 in select * from jsonb_array_elements(tg) loop rest := public.rm_minus(rest, c3); end loop;
      c3 := tg || case when jsonb_array_length(rest) > 0 then jsonb_build_array(rest) else '[]'::jsonb end;
      a := public.rm_score_groups(c3, wild) || jsonb_build_object('groups', c3);
      if (a ->> 'points')::int < (res ->> 'points')::int then res := a; end if;
    end if;
  end if;
  return res;
end;
$$;

create or replace function public.rm_declare(t public.rm_tables, seat int, card_id int, p_groups jsonb) returns public.rm_tables
language plpgsql volatile security definer set search_path = public as $$
declare
  cards jsonb;
  groups jsonb;
  sc jsonb;
  ids int[];
  want int[];
begin
  if t.phase <> 'discard' then raise exception 'Draw a card before declaring'; end if;
  t := public.rm_throw(t, seat, card_id);
  select h.cards into cards from rm_hands h where h.table_id = t.id and h.seat = rm_declare.seat;
  select array_agg((y #>> '{}')::int order by (y #>> '{}')::int) into ids from jsonb_array_elements(coalesce(p_groups, '[]')) g, jsonb_array_elements(g) y;
  select array_agg((c ->> 'id')::int order by (c ->> 'id')::int) into want from jsonb_array_elements(cards) c;
  if ids is distinct from want then raise exception 'Your groups must contain exactly your % cards', t.cards; end if;
  groups := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(p_groups) g);
  update rm_hands set groups = p_groups where table_id = t.id and rm_hands.seat = rm_declare.seat;

  -- Scored on actual cards: fair evaluation
  sc := public.rm_score_groups(groups, public.rm_wk(t));

  -- 21 cards: 3 tunnelas, 8 doubles or 8 jokers in hand is a rummy however they are arranged.
  if not (sc ->> 'valid')::boolean and t.cards = 21 and public.rm_special21w(cards, public.rm_wk(t)) is not null then
    update rm_hands set groups = (select jsonb_agg((select jsonb_agg(y -> 'id') from jsonb_array_elements(g) y)) from jsonb_array_elements(public.rm_special21w(cards, public.rm_wk(t))) g)
      where table_id = t.id and rm_hands.seat = rm_declare.seat;
    sc := '{"valid": true, "points": 0}';
  end if;

  if (sc ->> 'valid')::boolean then
    t.seats := public.rm_seat_set(t.seats, seat, '{"action": "Declared!"}');
    return public.rm_end_deal(t, seat);
  end if;

  -- Wrong declaration: full points (80, or 120 with 21 cards) and out of this deal; the others play on.
  t.seats := public.rm_seat_set(t.seats, seat, '{"wrong": true, "action": "Wrong show"}');
  return public.rm_pass(t, seat);
end;
$$;

CREATE OR REPLACE FUNCTION public.rm_end_deal(t rm_tables, winner integer)
 RETURNS rm_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n int := jsonb_array_length(t.seats);
  wild text := public.rm_wk(t);
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  limit_pts int := case t.mode when 'pool101' then 101 when 'pool201' then 201 end;
  x jsonb; h record; pts int; own jsonb; best jsonb; grouped jsonb;
  total_pts int := 0; win bigint; bal bigint; loss bigint;
  rows jsonb := '[]'; hands jsonb := '{}';
  left_in int; champ int; top bigint;
  i int;
  cap int := case when t.cards = 21 then 120 else 80 end;
  -- Points: penalty owed to the winner and value-card / marriage bonus owed to holders, per seat (21 Card)
  vb int; vinfo jsonb; owe_pen numeric[]; owe_bon numeric[]; paid numeric[]; recv numeric[]; held numeric; f numeric; j int; tot numeric;
begin
  -- The person who declared or was determined as winner IS the winner.
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    continue when not coalesce((x ->> 'playing')::boolean, false);
    select * into h from rm_hands where table_id = t.id and seat = i;
    best := public.rm_best(h.cards, wild);
    grouped := best -> 'groups';
    if i = winner then
      pts := 0;
      if h.groups is not null then grouped := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(h.cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(h.groups) g); end if;
    elsif (x ->> 'wrong')::boolean then pts := cap;
    elsif (x ->> 'dropped')::boolean then
      pts := case when t.cards = 21 then (case when (x ->> 'middle')::boolean then 70 else 30 end) else public.rm_drop_pts(t.mode, (x ->> 'middle')::boolean) end;
    else
      pts := (best ->> 'points')::int;
      if h.groups is not null then
        own := (select jsonb_agg((select jsonb_agg(c) from jsonb_array_elements(h.cards) c where (c ->> 'id')::int in (select (y #>> '{}')::int from jsonb_array_elements(g) y))) from jsonb_array_elements(h.groups) g);
        if (select count(*) from jsonb_array_elements(h.groups) g, jsonb_array_elements(g) y) = jsonb_array_length(h.cards)
           and (select count(*) from jsonb_array_elements(own) g, jsonb_array_elements(g) c) = jsonb_array_length(h.cards)
           and (public.rm_score_groups(own, wild) ->> 'points')::int < pts then
          pts := (public.rm_score_groups(own, wild) ->> 'points')::int;
          grouped := own;
        end if;
      end if;
    end if;
    pts := least(pts, cap);
    total_pts := total_pts + pts;
    -- 21 Card: value cards (the cut joker card, upper and lower jokers) and marriages pay a bonus from every player who
    -- didn't drop — to a holder who didn't drop or show wrong.
    vb := 0; vinfo := null;
    if t.cards = 21 then
      vinfo := public.rm_value21(h.cards, t.wild);
      if t.mode = 'points' and not coalesce((x ->> 'dropped')::boolean, false) and not coalesce((x ->> 'wrong')::boolean, false) then vb := (vinfo ->> 'bonus')::int; end if;
    end if;
    t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('deal_pts', pts, 'vbonus', vb, 'vinfo', vinfo));
    hands := hands || jsonb_build_object(i::text, grouped);
  end loop;

  if t.mode = 'points' then
    -- Who owes what: each loser their points × the point value to the winner; every player who didn't drop the
    -- value-card / marriage bonus × the point value to each other holder. A human never pays more than the buy-in held
    -- for the deal (every payment scaled down alike); a bot pays from its stack. Receivers get it less the fee.
    owe_pen := array_fill(0::numeric, array[n]); owe_bon := array_fill(0::numeric, array[n * n]);
    paid := array_fill(0::numeric, array[n]); recv := array_fill(0::numeric, array[n]);
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      if i <> winner then owe_pen[i + 1] := round((x ->> 'deal_pts')::int * t.stake); end if;
      if not coalesce((x ->> 'dropped')::boolean, false) then
        for j in 0 .. n - 1 loop
          continue when j = i or not coalesce((t.seats -> j ->> 'playing')::boolean, false);
          if coalesce((t.seats -> j ->> 'vbonus')::int, 0) > 0 then owe_bon[i * n + j + 1] := round((t.seats -> j ->> 'vbonus')::int * t.stake); end if;
        end loop;
      end if;
      tot := owe_pen[i + 1] + (select coalesce(sum(owe_bon[k]), 0) from generate_series(i * n + 1, i * n + n) k);
      held := case when (x ->> 'bot')::boolean then greatest(coalesce((x ->> 'bal')::numeric, 0), 0) else coalesce((x ->> 'held')::numeric, 0) end;
      f := case when tot > held and tot > 0 then held / tot else 1 end;
      owe_pen[i + 1] := floor(owe_pen[i + 1] * f);
      paid[i + 1] := owe_pen[i + 1];
      recv[winner + 1] := recv[winner + 1] + owe_pen[i + 1];
      for j in 0 .. n - 1 loop
        continue when owe_bon[i * n + j + 1] = 0;
        owe_bon[i * n + j + 1] := floor(owe_bon[i * n + j + 1] * f);
        paid[i + 1] := paid[i + 1] + owe_bon[i * n + j + 1];
        recv[j + 1] := recv[j + 1] + owe_bon[i * n + j + 1];
      end loop;
    end loop;
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      win := floor(recv[i + 1] * (1 - rake / 100.0));
      loss := paid[i + 1];
      if (x ->> 'bot')::boolean then
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('bal', (x ->> 'bal')::bigint - loss + win, 'net', win - loss));
      else
        bal := public.wallet_move((x ->> 'uid')::uuid, (x ->> 'held')::bigint - loss, 'refund', rm_label(t) || ' • Buy-in returned');
        if win > 0 then
          bal := public.wallet_move((x ->> 'uid')::uuid, win, 'win', rm_label(t) || case when i = winner then ' • Deal won' when coalesce((t.seats -> i -> 'vinfo' ->> 'marriages')::int, 0) > 0 then ' • Marriage bonus' else ' • Value cards' end);
        end if;
        t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('bal', bal, 'held', 0, 'net', win - loss));
      end if;
    end loop;
    t.match_over := true;
    champ := winner;
  elsif limit_pts is not null then
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('score', (x ->> 'score')::int + (x ->> 'deal_pts')::int,
                   'out', (x ->> 'score')::int + (x ->> 'deal_pts')::int >= limit_pts or coalesce((x ->> 'left')::boolean, false)));
    end loop;
    select count(*) into left_in from jsonb_array_elements(t.seats) v where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'out')::boolean, false);
    if left_in <= 1 then
      select i2 - 1 into champ from jsonb_array_elements(t.seats) with ordinality y(v, i2)
        where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'out')::boolean, false) limit 1;
      champ := coalesce(champ, winner);
      t.match_over := true;
    end if;
  else
    for i in 0 .. n - 1 loop
      x := t.seats -> i;
      continue when not coalesce((x ->> 'playing')::boolean, false);
      t.seats := public.rm_seat_set(t.seats, i, jsonb_build_object('score', (x ->> 'score')::int - (x ->> 'deal_pts')::int + case when i = winner then total_pts else 0 end));
    end loop;
    if t.deal_no >= t.deals then
      select max((v ->> 'score')::bigint) into top from jsonb_array_elements(t.seats) v where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'left')::boolean, false);
      select i2 - 1 into champ from jsonb_array_elements(t.seats) with ordinality y(v, i2)
        where coalesce((v ->> 'in_match')::boolean, false) and not coalesce((v ->> 'left')::boolean, false) and (v ->> 'score')::bigint = top
        order by (i2 - 1 = winner) desc limit 1;
      champ := coalesce(champ, winner);
      t.match_over := true;
    end if;
  end if;

  -- Pool / Deals prize to the match winner
  if t.mode <> 'points' and t.match_over then
    x := t.seats -> champ;
    if (x ->> 'bot')::boolean then
      t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', (x ->> 'bal')::bigint + t.prize));
    else
      bal := public.wallet_move((x ->> 'uid')::uuid, t.prize, 'win', rm_label(t) || ' • Match won');
      t.seats := public.rm_seat_set(t.seats, champ, jsonb_build_object('bal', bal));
    end if;
  end if;

  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    continue when not coalesce((x ->> 'playing')::boolean, false) and not coalesce((x ->> 'in_match')::boolean, false);
    rows := rows || jsonb_build_array(jsonb_build_object(
      'seat', i, 'name', x ->> 'name', 'bot', (x ->> 'bot')::boolean, 'uid', x ->> 'uid',
      'pts', case when coalesce((x ->> 'playing')::boolean, false) then (x ->> 'deal_pts')::int end,
      'score', (x ->> 'score')::int,
      'note', case when i = winner then 'Declared' when not coalesce((x ->> 'playing')::boolean, false) then 'Out'
                   when (x ->> 'wrong')::boolean then 'Wrong show' when (x ->> 'dropped')::boolean then case when (x ->> 'middle')::boolean then 'Middle drop' else 'Drop' end
                   else 'Lost' end,
      'out', coalesce((x ->> 'out')::boolean, false),
      'coins', case when t.mode = 'points' and coalesce((x ->> 'playing')::boolean, false) then (x ->> 'net')::bigint end,
      'bonus', nullif((x ->> 'vbonus')::int, 0),
      'value', case when t.cards = 21 and coalesce((x ->> 'playing')::boolean, false) then x -> 'vinfo' end,
      'hand', hands -> i::text));
  end loop;
  t.result := jsonb_build_object('winner', winner, 'winner_name', t.seats -> winner ->> 'name', 'rows', rows, 'match_over', t.match_over,
    'champion', champ, 'champion_name', case when champ is not null then t.seats -> champ ->> 'name' end,
    'prize', case when t.mode = 'points' then (t.seats -> winner ->> 'net')::bigint else t.prize end,
    'deal_no', t.deal_no, 'wild', t.wild, 'rake', rake);
  t.status := 'dealdone';
  t.turn := null;
  t.phase := null;
  t.turn_ends := null;
  t.bot_acts_at := null;
  t.next_at := now() + interval '10 seconds';
  return t;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rm_join_base(p_mode text, p_stake numeric, p_deals integer DEFAULT 0, p_code text DEFAULT NULL::text, p_cards integer DEFAULT 13, p_avoid uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare me profiles := public.current_profile(); t rm_tables; who jsonb; emo text; need bigint;
begin
  if me.id is null or me.role <> 'player' then raise exception 'Only active players can join tables'; end if;
  perform pg_advisory_xact_lock(hashtext('table-join:' || me.id::text));
  if not coalesce((public.game_cfg('rummy') ->> 'enabled')::boolean, true) then raise exception 'Rummy is closed for maintenance'; end if;
  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code));
    if not found then raise exception 'No table with that code'; end if;
    p_mode := t.mode; p_stake := t.stake; p_deals := t.deals; p_cards := t.cards;
  else
    if p_cards not in (13, 21) then raise exception 'Invalid table'; end if;
    if p_mode <> 'deals' then p_deals := 0; end if;
    if not public.rm_valid_stake(p_mode, p_stake, p_deals) then raise exception 'Invalid table'; end if;
  end if;
  need := case when p_mode = 'points' then (case when p_cards = 21 then 120 else 80 end) * p_stake else p_stake end;
  if (select coins from wallets where user_id = me.id) < need then raise exception 'Not enough coins (you need %)', need; end if;
  perform public.check_bet_room(me.id, need);

  select * into t from rm_tables where me.id = any (members) and (p_avoid is null or id <> p_avoid) and mode = p_mode and stake = p_stake and deals = p_deals and cards = p_cards
    and (p_code is null and code is null or code = upper(trim(p_code))) limit 1 for update;
  if found then
    t.seats := (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || jsonb_build_object('left', false, 'ping', now()) else v end order by i), '[]')
                from jsonb_array_elements(t.seats) with ordinality x(v, i));
    if t.status = 'waiting' and t.next_at is null then t.next_at := now() + public.rm_join_wait(t); end if;
    perform public.rm_save(t);
    return t.id;
  end if;
  update rm_tables set seats = (select coalesce(jsonb_agg(case when v ->> 'uid' = me.id::text then v || '{"left": true}' else v end order by i), '[]') from jsonb_array_elements(seats) with ordinality x(v, i)),
                       queue = (select coalesce(jsonb_agg(q), '[]') from jsonb_array_elements(queue) q where q ->> 'uid' <> me.id::text)
    where me.id = any (members);
  update rm_tables set members = public.rm_members(seats, queue) where me.id = any (members);

  emo := (array['🧑🏽','👩🏽','👨🏻','👩🏾','🧑🏻','👨🏾'])[1 + abs(hashtext(me.id::text)) % 6];
  who := jsonb_build_object('uid', me.id, 'name', me.name, 'emoji', emo, 'bot', false, 'bal', (select coins from wallets where user_id = me.id), 'ping', now());

  if p_code is not null then
    select * into t from rm_tables where code = upper(trim(p_code)) for update;
    if (select count(*) from jsonb_array_elements(t.seats) v where not coalesce((v ->> 'left')::boolean, false)) + jsonb_array_length(t.queue) >= public.rm_max_seats(t.cards) then
      raise exception 'This table is full';
    end if;
  else
    select * into t from rm_tables tt
      where tt.mode = p_mode and tt.stake = p_stake and tt.deals = p_deals and tt.cards = p_cards and tt.code is null
        and (p_avoid is null or tt.id <> p_avoid)
        and (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false))
            + jsonb_array_length(tt.queue) < public.rm_max_seats(tt.cards)
        and tt.updated_at > now() - interval '5 minutes'
      order by (select count(*) from jsonb_array_elements(tt.seats) v where not (v ->> 'bot')::boolean and not coalesce((v ->> 'left')::boolean, false)) desc
      limit 1 for update skip locked;
    if not found then
      insert into rm_tables (mode, stake, deals, cards, queue, members, next_at) values (p_mode, p_stake, p_deals, p_cards, jsonb_build_array(who), array[me.id], now() + interval '3 seconds')
        returning * into t;
      return t.id;
    end if;
  end if;
  t.queue := t.queue || jsonb_build_array(who);
  if t.status = 'waiting' then t.next_at := now() + public.rm_join_wait(t); end if;
  perform public.rm_save(t);
  return t.id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.rm_start_base(t rm_tables)
 RETURNS rm_tables
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s jsonb := '[]'; x jsonb; q jsonb; names text[]; i int; bal bigint; hold bigint;
  private boolean := t.code is not null;
  new_match boolean := t.mode = 'points' or t.match_over or t.match_no = 0
    -- A Pool/Deals match with no real player left in it is abandoned; start a fresh one.
    or not exists (select 1 from jsonb_array_elements(t.seats) v where not (v ->> 'bot')::boolean and coalesce((v ->> 'in_match')::boolean, false)
                   and not coalesce((v ->> 'out')::boolean, false) and not coalesce((v ->> 'left')::boolean, false));
  in_match int := 0; humans int := 0; eligible int;
  rake numeric := coalesce((public.game_cfg('rummy') ->> 'rake')::numeric, 10);
  d jsonb; k int := 0; hand jsonb; first_seat int; n int;
begin
  if new_match then
    for x in select * from jsonb_array_elements(t.seats) loop
      if (x ->> 'bot')::boolean then
        if not private and random() > 0.15 then s := s || jsonb_build_array(x); end if;
      elsif not coalesce((x ->> 'left')::boolean, false) and (x ->> 'ping')::timestamptz > now() - interval '90 seconds' then
        s := s || jsonb_build_array(x);
      end if;
    end loop;
    for q in select * from jsonb_array_elements(t.queue) loop
      if jsonb_array_length(s) >= public.rm_max_seats(t.cards) then
        select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
        exit when i < 0;
        s := s - i;
      end if;
      s := s || jsonb_build_array(q || jsonb_build_object('bot', false, 'ping', now()));
    end loop;
    t.queue := '[]';
    -- A table that sat 6 before 21 Card went to 5 seats: the extra bots stand up.
    while jsonb_array_length(s) > public.rm_max_seats(t.cards) loop
      select coalesce(max(i2) - 1, -1) into i from jsonb_array_elements(s) with ordinality y(v, i2) where (v ->> 'bot')::boolean;
      exit when i < 0;
      s := s - i;
    end loop;
    if not private then
      while jsonb_array_length(s) < public.rm_max_seats(t.cards) loop
        select coalesce(array_agg(v ->> 'name'), '{}') into names from jsonb_array_elements(s) v;
        s := s || jsonb_build_array(public.make_bot(names));
      end loop;
    end if;
    hold := case when t.mode = 'points' then (case when t.cards = 21 then 120 else 80 end) * t.stake else t.stake end;
    select count(*) into eligible from jsonb_array_elements(s) v
      where not (v ->> 'bot')::boolean and not coalesce((v ->> 'sitout')::boolean, false)
        and (select coins from wallets where user_id = (v ->> 'uid')::uuid) >= hold;
    if eligible = 0 or (private and eligible < 2) then
      t.seats := (select coalesce(jsonb_agg(v || jsonb_build_object('in_match', false, 'playing', false,
                    'action', case when coalesce((v ->> 'sitout')::boolean, false) then 'Sitting out'
                                   when not (v ->> 'bot')::boolean and (select coins from wallets where user_id = (v ->> 'uid')::uuid) < hold then 'Not enough coins' end) order by nn), '[]')
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
      elsif coalesce((x ->> 'sitout')::boolean, false) then
        x := x || jsonb_build_object('in_match', false, 'action', 'Sitting out'); -- keeps the seat, isn't dealt in
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

  -- Deal: 13 cards each from two shuffled decks (21 cards each from three); next card sets the wild joker; one card starts the open pile.
  n := jsonb_array_length(t.seats);
  select jsonb_agg(c order by random()) into d from (
    select jsonb_build_object('id', (k2 - 1) * 52 + (row_number() over (partition by k2 order by cr, cs)) - 1, 'r', cr, 's', cs) c
    from generate_series(1, case when t.cards = 21 then 3 else 2 end) k2,
         unnest(array['A','2','3','4','5','6','7','8','9','10','J','Q','K']) cr,
         unnest(array['♠','♥','♦','♣']) cs
    -- 21 cards: one printed joker per deck.
    union all select jsonb_build_object('id', 155 + j, 'r', 'JK', 's', '★') from generate_series(1, case when t.cards = 21 then 3 else 0 end) j) z;
  delete from rm_hands where table_id = t.id;
  for i in 0 .. n - 1 loop
    x := t.seats -> i;
    if coalesce((x ->> 'in_match')::boolean, false) and not coalesce((x ->> 'out')::boolean, false) then
      select jsonb_agg(d -> j) into hand from generate_series(k, k + t.cards - 1) j;
      insert into rm_hands (table_id, seat, cards) values (t.id, i, hand);
      k := k + t.cards;
      x := x || '{"playing": true, "dropped": false, "middle": false, "wrong": false, "maaf": false, "turns": 0, "timeouts": 0, "picked": null, "action": null, "deal_pts": 0}';
    else
      x := x || '{"playing": false}';
    end if;
    t.seats := jsonb_set(t.seats, array[i::text], x);
  end loop;
  -- The cut card sets the wild joker; a printed joker is never the cut card (move the next ordinary card up).
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
$function$;

revoke execute on function public.rm_join_base(text, numeric, int, text, int, uuid) from public, anon, authenticated;

commit;
notify pgrst, 'reload schema';
